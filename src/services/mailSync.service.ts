import type { ModifyResult } from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import MailConversation from '../models/MailConversation.model';
import MailMessage, { IMailMessage } from '../models/MailMessage.model';
import gmailService from './gmail.service';
import gmailMailboxIndexService from './gmailMailboxIndex.service';
import mailActivityService from './mailActivity.service';
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

// Existing universal safety-net interval. Stage 2.1 deliberately preserves
// the proven 20-second fallback for every connected account so Email Chat,
// background mail and missed active signals do not regress.
const SYNC_INTERVAL_MS = Number(
  process.env.MAIL_SYNC_INTERVAL_MS || 20_000,
);

const ACTIVE_SYNC_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.MAIL_ACTIVE_SYNC_INTERVAL_MS || 8_000),
);

const ACTIVE_MAILBOX_WINDOW_MS = Math.max(
  ACTIVE_SYNC_INTERVAL_MS * 2,
  Number(process.env.MAIL_ACTIVE_MAILBOX_WINDOW_MS || 150_000),
);

const ACTIVE_SCHEDULER_TICK_MS = Math.max(
  1_000,
  Math.min(
    ACTIVE_SYNC_INTERVAL_MS,
    Number(process.env.MAIL_ACTIVE_SCHEDULER_TICK_MS || 2_000),
  ),
);

const SYNC_MAX_CONCURRENT_USERS = Math.min(
  8,
  Math.max(
    1,
    Number(process.env.MAIL_SYNC_MAX_CONCURRENT_USERS || 3),
  ),
);
const INVALID_GRANT_BACKOFF_MS = Math.max(
  60_000,
  Number(
    process.env.MAIL_SYNC_INVALID_GRANT_BACKOFF_MS ||
      15 * 60_000,
  ),
);

class MailSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private backgroundBackoffUntil = new Map<string, number>();
  private lastSyncFinishedAt = new Map<string, number>();
  private tickInFlight = false;
  private activeTickInFlight = false;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;

    this.timer = setInterval(() => this.tick(), SYNC_INTERVAL_MS);
    this.activeTimer = setInterval(
      () => this.activeTick(),
      ACTIVE_SCHEDULER_TICK_MS,
    );

    console.log(
      `[MailSync] Started — adaptive Gmail history sync: ` +
        `active mailbox ~${ACTIVE_SYNC_INTERVAL_MS / 1000}s, ` +
        `fallback ${SYNC_INTERVAL_MS / 1000}s`,
    );

    // Stage 2 — build the lightweight local mailbox index only after the
    // server bootstrap has already confirmed MongoDB is connected. This work
    // is deliberately background-only and never delays the HTTP listener.
    void gmailMailboxIndexService
      .bootstrapConnectedUsers()
      .catch((err: any) => {
        console.error('[MailIndex] startup bootstrap failed:', err?.message);
      });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.timer = null;
    this.activeTimer = null;
    this.lastSyncFinishedAt.clear();
    this.started = false;
  }

  private isInvalidGrant(error: any): boolean {
    const responseError =
      error?.response?.data?.error;
    const responseDescription =
      error?.response?.data?.error_description;

    const text = [
      error?.message,
      typeof responseError === 'string'
        ? responseError
        : responseError?.message,
      responseDescription,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return text.includes('invalid_grant');
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;

    const runWorker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            concurrency,
            Math.max(1, items.length),
          ),
        },
        () => runWorker(),
      ),
    );
  }

  private async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      const users = await CrmUser.find({
        'googleMail.connected': true,
        isActive: true,
      })
        .select('_id')
        .lean();

      const now = Date.now();
      const connectedIds = new Set(
        users.map((user) => String(user._id)),
      );

      for (const userId of this.lastSyncFinishedAt.keys()) {
        if (!connectedIds.has(userId)) {
          this.lastSyncFinishedAt.delete(userId);
        }
      }

      const userIds = [...connectedIds].filter((userId) => {
        const retryAt =
          this.backgroundBackoffUntil.get(userId) || 0;

        if (retryAt > now) return false;

        if (retryAt > 0) {
          this.backgroundBackoffUntil.delete(userId);
        }

        if (
          mailActivityService.isMailboxActive(
            userId,
            ACTIVE_MAILBOX_WINDOW_MS,
          )
        ) {
          const lastFinishedAt =
            this.lastSyncFinishedAt.get(userId) || 0;

          if (
            now - lastFinishedAt <
            ACTIVE_SYNC_INTERVAL_MS
          ) {
            return false;
          }
        }

        return true;
      });

      await this.runWithConcurrency(
        userIds,
        SYNC_MAX_CONCURRENT_USERS,
        async (userId) => {
          await this.syncUserInternal(
            userId,
            true,
          );
        },
      );
    } catch (err: any) {
      console.error(
        '[MailSync] tick failed:',
        err?.message,
      );
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Stage 2.1 adaptive fast lane.
   *
   * A normal Stage 2 local-index mailbox read marks that CRM user active.
   * While that signal stays fresh, Gmail history is checked approximately
   * every ACTIVE_SYNC_INTERVAL_MS. No extra HTTP endpoint, browser heartbeat,
   * cloud notification service or alternate mail protocol is involved.
   *
   * The existing 20-second tick() remains active for every account and is
   * therefore still the recovery path if the activity signal expires.
   */
  private async activeTick() {
    if (this.activeTickInFlight) return;
    this.activeTickInFlight = true;

    try {
      const now = Date.now();
      const candidates =
        mailActivityService.getActiveMailboxUserIds(
          ACTIVE_MAILBOX_WINDOW_MS,
        );

      const dueUserIds = candidates.filter((userId) => {
        const retryAt =
          this.backgroundBackoffUntil.get(userId) || 0;
        if (retryAt > now) return false;

        const lastFinishedAt =
          this.lastSyncFinishedAt.get(userId) || 0;

        return (
          now - lastFinishedAt >=
          ACTIVE_SYNC_INTERVAL_MS
        );
      });

      await this.runWithConcurrency(
        dueUserIds,
        SYNC_MAX_CONCURRENT_USERS,
        async (userId) => {
          await this.syncUserInternal(
            userId,
            true,
          );
        },
      );
    } catch (err: any) {
      console.error(
        '[MailSync] active tick failed:',
        err?.message,
      );
    } finally {
      this.activeTickInFlight = false;
    }
  }

  async requestImmediateSync(userId: string) {
    // User-driven/manual operations must not be held behind a background
    // invalid_grant backoff. Reconnect/manual sync can immediately prove that
    // the account credentials are healthy again.
    this.backgroundBackoffUntil.delete(userId);
    return this.syncUserInternal(userId, false);
  }

  /**
   * Public direct sync remains immediate for compatibility with any existing
   * callers. The scheduled ticker is the only path that observes backoff.
   */
  async syncUser(userId: string): Promise<void> {
    this.backgroundBackoffUntil.delete(userId);
    return this.syncUserInternal(userId, false);
  }

  private async syncUserInternal(
    userId: string,
    background: boolean,
  ): Promise<void> {
    if (this.inFlight.has(userId)) return;

    if (background) {
      const retryAt =
        this.backgroundBackoffUntil.get(userId) || 0;
      if (retryAt > Date.now()) return;
    }

    this.inFlight.add(userId);

    try {
      const result =
        await gmailService.syncHistory(userId);

      if (result.fullResync) {
        // The history cursor no longer proves local index completeness. Mark
        // the index unavailable immediately and rebuild it in the background;
        // API reads safely fall back to the frozen Stage 1 Gmail path meanwhile.
        await gmailMailboxIndexService.scheduleRebuild(userId);
        this.emitToUser(
          userId,
          'mail:inbox:update',
          { fullResync: true },
        );
        return;
      }

      const hasInboxChanges =
        result.addedMessageIds.length > 0 ||
        result.labelChangedMessageIds.length > 0 ||
        result.deletedMessageIds.length > 0;

      if (hasInboxChanges) {
        // Reconcile the local metadata BEFORE the socket event. When the
        // browser reacts to mail:inbox:update, /messages can therefore return
        // the already-updated MongoDB rows instead of hitting Gmail again.
        try {
          await gmailMailboxIndexService.reconcileMessageIds(
            userId,
            [
              ...result.addedMessageIds,
              ...result.labelChangedMessageIds,
            ],
          );
          await gmailMailboxIndexService.removeMessages(
            userId,
            result.deletedMessageIds,
          );
        } catch (err: any) {
          console.error(
            `[MailIndex] incremental reconcile for ${userId} failed:`,
            err?.message,
          );
          // Keep mail delivery functional. The next bootstrap/history cycle
          // can repair the index, while the HTTP layer can still fall back to
          // Gmail if a mailbox is not marked ready.
          void gmailMailboxIndexService.ensureUserIndexed(userId);
        }
      } else {
        // First deploy / first reconnect may have no history delta at all.
        // Ensure the index still begins warming for this connected account.
        void gmailMailboxIndexService.ensureUserIndexed(userId);
      }

      for (const messageId of result.addedMessageIds) {
        try {
          await this.ingestConversationMessage(
            userId,
            messageId,
          );
        } catch (err: any) {
          console.error(
            `[MailSync] ingest ${messageId} for ${userId} failed:`,
            err?.message,
          );
        }
      }

      if (hasInboxChanges) {
        this.emitToUser(
          userId,
          'mail:inbox:update',
          {
            added: result.addedMessageIds,
            changed:
              result.labelChangedMessageIds,
            deleted:
              result.deletedMessageIds,
          },
        );
      }
    } catch (err: any) {
      if (
        background &&
        this.isInvalidGrant(err)
      ) {
        const retryAt =
          Date.now() + INVALID_GRANT_BACKOFF_MS;

        this.backgroundBackoffUntil.set(
          userId,
          retryAt,
        );

        console.error(
          `[MailSync] sync for ${userId} failed: invalid_grant; background retries paused for ${Math.round(
            INVALID_GRANT_BACKOFF_MS / 60_000,
          )} minute(s)`,
        );
      } else {
        console.error(
          `[MailSync] sync for ${userId} failed:`,
          err?.message,
        );
      }
    } finally {
      this.lastSyncFinishedAt.set(userId, Date.now());
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