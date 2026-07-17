import type { ModifyResult } from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import MailConversation from '../models/MailConversation.model';
import MailMessage, { IMailMessage } from '../models/MailMessage.model';
import gmailService from './gmail.service';
import { getSocketIO } from '../utils/socketEmitter';

/**
 * mailSync.service — keeps Suprah Mail in lock-step with Gmail.
 *
 * How it works:
 *  - Every SYNC_INTERVAL_MS the engine runs gmail history sync for each
 *    connected user (staggered, one user at a time, per-user in-flight lock —
 *    a slow user never blocks or double-runs).
 *  - Inbox changes fan out over the main Socket.io server to `user:{id}` as
 *    `mail:inbox:update` — the frontend refreshes the affected list instead
 *    of hard-polling.
 *  - New Gmail messages whose threadId belongs to a MailConversation are
 *    materialized into MailMessage documents and pushed as
 *    `mail:conversation:message` — that's what makes the Conversation tab
 *    feel like chat.
 *  - Callers can also `requestImmediateSync(userId)` (e.g. right after the
 *    user sends something) so echoes show up instantly instead of on the
 *    next tick.
 *
 * Failure model: every user sync is isolated in try/catch; errors are stored
 * on googleMail.lastSyncError and surfaced in /api/mail/status. An expired
 * history cursor triggers a self-healing full resync signal (see
 * gmail.service.syncHistory). Nothing here can take the server down.
 */

const SYNC_INTERVAL_MS = Number(process.env.MAIL_SYNC_INTERVAL_MS || 20_000);

class MailSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.tick(), SYNC_INTERVAL_MS);
    console.log(`[MailSync] Started — polling Gmail history every ${SYNC_INTERVAL_MS / 1000}s`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async tick() {
    try {
      const users = await CrmUser.find({ 'googleMail.connected': true, isActive: true })
        .select('_id')
        .lean();
      for (const u of users) {
        // Fire-and-forget per user; the lock prevents overlap between ticks.
        this.syncUser(String(u._id)).catch(() => { /* logged inside */ });
      }
    } catch (err: any) {
      console.error('[MailSync] tick failed:', err?.message);
    }
  }

  async requestImmediateSync(userId: string) {
    return this.syncUser(userId);
  }

  async syncUser(userId: string): Promise<void> {
    if (this.inFlight.has(userId)) return;
    this.inFlight.add(userId);
    try {
      const result = await gmailService.syncHistory(userId);

      if (result.fullResync) {
        this.emitToUser(userId, 'mail:inbox:update', { fullResync: true });
        return;
      }

      const hasInboxChanges =
        result.addedMessageIds.length > 0 ||
        result.labelChangedMessageIds.length > 0 ||
        result.deletedMessageIds.length > 0;

      // Route new messages into Conversation-tab threads.
      for (const messageId of result.addedMessageIds) {
        try {
          await this.ingestConversationMessage(userId, messageId);
        } catch (err: any) {
          console.error(`[MailSync] ingest ${messageId} for ${userId} failed:`, err?.message);
        }
      }

      if (hasInboxChanges) {
        this.emitToUser(userId, 'mail:inbox:update', {
          added: result.addedMessageIds,
          changed: result.labelChangedMessageIds,
          deleted: result.deletedMessageIds,
        });
      }
    } catch (err: any) {
      // Already persisted to googleMail.lastSyncError by gmail.service.
      console.error(`[MailSync] sync for ${userId} failed:`, err?.message);
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /**
   * If a newly-arrived Gmail message belongs to one of the user's
   * MailConversations, store it as a chat message and push it in real time.
   * Duplicate-safe: the unique (ownerCrmUserId, gmailMessageId) index plus an
   * upsert guarantees one bubble per Gmail message no matter how many code
   * paths see it (send echo, history sync, manual refresh).
   */
  async ingestConversationMessage(userId: string, gmailMessageId: string): Promise<void> {
    // Cheap pre-check: skip messages we've already stored.
    const exists = await MailMessage.exists({ ownerCrmUserId: userId, gmailMessageId });
    if (exists) return;

    let parsed;
    try {
      parsed = await gmailService.getMessage(userId, gmailMessageId);
    } catch {
      return; // deleted between history event and fetch — nothing to do
    }
    if (!parsed.threadId) return;

    const user = await CrmUser.findById(userId).select('email googleMail.gmailAddress').lean();
    const selfEmail = (user?.googleMail?.gmailAddress || user?.email || '').toLowerCase();
    const senderEmail = (parsed.from.email || '').toLowerCase();
    const direction = senderEmail === selfEmail ? 'outbound' : 'inbound';

    // ── Route the message to a conversation ────────────────────────────────
    // Primary: exact Gmail thread match (strongest signal, never mis-routes).
    let conversation = await MailConversation.findOne({
      ownerCrmUserId: userId,
      gmailThreadId: parsed.threadId,
    });

    // Fallback: some mail clients break threading (fresh compose, stripped
    // References headers, forwards). Recover those by matching a known
    // participant on the same normalized subject among the owner's open
    // conversations. Only inbound mail is recovered this way — our own sends
    // always carry the correct threadId already.
    if (!conversation && direction === 'inbound' && senderEmail) {
      const normSubject = this.normalizeSubject(parsed.subject || '');
      const candidates = await MailConversation.find({
        ownerCrmUserId: userId,
        isArchived: false,
        'participants.email': senderEmail,
      }).sort({ lastMessageAt: -1 }).limit(10);

      conversation = candidates.find(
        (c) => this.normalizeSubject(c.subject) === normSubject,
      ) || null;

      // Adopt this thread so subsequent replies match on the fast path.
      if (conversation && !conversation.gmailThreadId) {
        conversation.gmailThreadId = parsed.threadId;
      }
    }

    if (!conversation) return; // regular inbox mail, not a Conversation thread

    // In a group, an inbound message may come from any participant. Make sure
    // the sender is actually part of this conversation (or it's our own send);
    // otherwise treat it as ordinary inbox mail, not a group bubble.
    const isParticipant = conversation.participants.some((p) => p.email === senderEmail);
    if (direction === 'inbound' && !isParticipant) return;

    const bodyText = (parsed.bodyText || parsed.snippet || '').trim();

    try {
      const message = await MailMessage.findOneAndUpdate(
        { ownerCrmUserId: userId, gmailMessageId },
        {
          $setOnInsert: {
            conversationId: conversation._id,
            organizationId: conversation.organizationId,
            ownerCrmUserId: conversation.ownerCrmUserId,
            direction,
            fromEmail: parsed.from.email,
            fromName: parsed.from.name || undefined,
            toEmail: direction === 'inbound' ? selfEmail : conversation.externalEmail,
            bodyText: this.stripQuotedReply(bodyText),
            bodyHtml: parsed.bodyHtml,
            attachments: parsed.attachments.map((a) => ({
              originalName: a.filename,
              mimeType: a.mimeType,
              size: a.size,
              gmailMessageId,
              gmailAttachmentId: a.attachmentId,
            })),
            gmailThreadId: parsed.threadId,
            rfc822MessageId: parsed.rfc822MessageId,
            status: 'delivered',
            readByOwner: direction === 'outbound',
            sentAt: new Date(parsed.internalDate),
          },
        },
        { upsert: true, new: true, includeResultMetadata: true },
      ) as unknown as ModifyResult<IMailMessage>;

      // With includeResultMetadata the driver returns { value, lastErrorObject, ok }.
      // updatedExisting is false only when this upsert actually inserted a new doc —
      // that's our guard against re-emitting a message the sync already ingested.
      const wasInserted = !message.lastErrorObject?.updatedExisting;
      const doc = message.value;
      if (!wasInserted || !doc) return;

      conversation.lastMessageAt = doc.sentAt;
      conversation.lastMessagePreview = doc.bodyText.slice(0, 140);
      conversation.lastMessageDirection = direction;
      conversation.lastMessageFromName = doc.fromName || parsed.from.name || senderEmail;
      if (direction === 'inbound') {
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        // Backfill a participant's display name once we learn it from headers.
        if (parsed.from.name) {
          const p = conversation.participants.find((x) => x.email === senderEmail);
          if (p && !p.name) p.name = parsed.from.name;
        }
      }
      await conversation.save({ validateModifiedOnly: true });

      this.emitToUser(userId, 'mail:conversation:message', {
        conversationId: conversation._id.toString(),
        message: doc,
      });
    } catch (err: any) {
      if (err?.code === 11000) return; // duplicate-key race — another path won
      throw err;
    }
  }

  /**
   * Strip Re:/Fwd: prefixes and collapse whitespace so a reply's subject
   * matches the conversation's stored subject in the fallback matcher.
   */
  private normalizeSubject(subject: string): string {
    return (subject || '')
      .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Chat bubbles should show only the new content, not the entire quoted
   * history that mail clients append. Conservative: only trims well-known
   * quote markers; the untouched original is preserved in bodyHtml.
   */
  private stripQuotedReply(text: string): string {
    const markers = [
      /^On .+ wrote:$/m,           // Gmail / Apple Mail
      /^-{2,}\s*Original Message\s*-{2,}$/im,
      /^From:\s.+$/m,              // Outlook top-quote block
      /^>{1}\s?/m,                 // plain quoted lines
    ];
    let cut = text.length;
    for (const re of markers) {
      const m = text.match(re);
      if (m && m.index !== undefined && m.index > 0 && m.index < cut) cut = m.index;
    }
    const trimmed = text.slice(0, cut).trim();
    return trimmed || text.trim();
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    try {
      const io = getSocketIO();
      if (io) io.to(`user:${userId}`).emit(event, payload);
    } catch (err: any) {
      console.error('[MailSync] socket emit failed:', err?.message);
    }
  }
}

export const mailSyncService = new MailSyncService();
export default mailSyncService;