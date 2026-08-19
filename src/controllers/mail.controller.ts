import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import MailConversation from '../models/MailConversation.model';
import MailMessage from '../models/MailMessage.model';
import gmailService, { OutgoingAttachment } from '../services/gmail.service';
import mailSyncService from '../services/mailSync.service';
import gmailMailboxIndexService from '../services/gmailMailboxIndex.service';
import { storageService, BucketType } from '../services/storage.service';

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000';
const MAIL_PAGE_PATH = '/crm/suprah-mail';
const INDEXED_MESSAGE_MAILBOXES = new Set(['INBOX', 'STARRED', 'SENT', 'TRASH']);

const filesFromReq = (req: Request): Express.Multer.File[] =>
  ((req as any).files as Express.Multer.File[] | undefined) || [];

const toOutgoingAttachments = (files: Express.Multer.File[]): OutgoingAttachment[] =>
  files.map((f) => ({ filename: f.originalname, mimeType: f.mimetype, content: f.buffer }));

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Stage 2 index is a read accelerator, never the source of truth. A local
 * indexing failure must not turn an already-successful Gmail send/mutation
 * into an HTTP failure that encourages the user to repeat the Gmail action.
 */
const mirrorIndexBestEffort = async (
  userId: string,
  label: string,
  operation: () => Promise<unknown>,
) => {
  try {
    await operation();
  } catch (error: any) {
    console.error(`[MailIndex] ${label} for ${userId} failed:`, error?.message);
    void gmailMailboxIndexService.ensureUserIndexed(userId);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Connection / status
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/mail/status */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const fresh = await CrmUser.findById(user._id).select('googleMail email').lean();
  const gm = fresh?.googleMail;
  res.json(
    new ApiResponse(200, {
      connected: !!gm?.connected,
      gmailAddress: gm?.gmailAddress || null,
      lastSyncAt: gm?.lastSyncAt || null,
      lastSyncError: gm?.lastSyncError || null,
      accountEmail: fresh?.email,
    }, 'Mail status fetched'),
  );
});

/** GET /api/mail/connect — returns the Google consent URL for this user */
const getConnectUrl = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const url = gmailService.getAuthUrl(user._id.toString());
  res.json(new ApiResponse(200, { url }, 'Gmail authorization URL created'));
});

/**
 * GET /api/mail/oauth/callback — PUBLIC (Google redirects the browser here).
 * State is HMAC-verified inside gmail.service, so no session is required.
 */
const oauthCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error) return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=denied`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=error`);

  try {
    const { userId } = await gmailService.handleOAuthCallback(code, state);
    // Warm both Gmail history and the Stage 2 local mailbox index. Neither
    // background task blocks the OAuth redirect.
    mailSyncService.requestImmediateSync(userId).catch(() => { });
    void gmailMailboxIndexService
      .bootstrapUser(userId, { force: true })
      .catch((err: any) =>
        console.error(`[MailIndex] OAuth bootstrap for ${userId} failed:`, err?.message),
      );
    return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=connected`);
  } catch (err: any) {
    console.error('[Mail] OAuth callback failed:', err?.message);
    return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=error`);
  }
});

/** POST /api/mail/disconnect */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id.toString();
  await gmailService.disconnect(userId);
  // Local metadata belongs to that Gmail connection. Removing it prevents a
  // later re-connect from ever displaying rows from the previous account.
  await mirrorIndexBestEffort(userId, 'disconnect cleanup', () =>
    gmailMailboxIndexService.clearUser(userId),
  );
  res.json(new ApiResponse(200, null, 'Gmail disconnected'));
});

/** POST /api/mail/sync — manual refresh (also runs automatically) */
const triggerSync = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await mailSyncService.requestImmediateSync(user._id.toString());
  res.json(new ApiResponse(200, null, 'Sync triggered'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbox (Gmail mirror)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/mail/labels */
const getLabels = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const labels = await gmailService.listLabels(user._id.toString());
  res.json(new ApiResponse(200, { labels }, 'Labels fetched'));
});

/**
 * GET /api/mail/mailbox-summary
 *
 * Lightweight system-mailbox metadata for the Suprah One Desk left rail.
 * This deliberately does not preload the first 25 messages of every folder.
 */
const getMailboxSummary = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const mailboxes = await gmailService.getMailboxSummaries(
    user._id.toString(),
  );

  res.json(
    new ApiResponse(
      200,
      {
        mailboxes,
        generatedAt: Date.now(),
      },
      'Mailbox summary fetched',
    ),
  );
});

/** GET /api/mail/messages?label=INBOX&q=&pageToken= */
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id.toString();
  const { label = 'INBOX', q, pageToken } = req.query as Record<string, string>;

  // Stage 2 fast path: ordinary system-mailbox browsing reads lightweight
  // MongoDB metadata. Gmail remains authoritative for advanced q= search,
  // custom labels and any mailbox whose initial index is not ready yet.
  if (!q && INDEXED_MESSAGE_MAILBOXES.has(label)) {
    try {
      const indexed = await gmailMailboxIndexService.listMessages(userId, {
        label: label as 'INBOX' | 'STARRED' | 'SENT' | 'TRASH',
        pageToken: pageToken || undefined,
        maxResults: 25,
      });

      if (indexed) {
        res.setHeader('X-Suprah-Mail-Source', 'local-index');
        res.json(new ApiResponse(200, indexed, 'Messages fetched'));
        return;
      }
    } catch (error: any) {
      console.error(`[MailIndex] local ${label} read failed:`, error?.message);
    }

    // Do not make the user wait for bootstrap. The frozen Stage 1 path remains
    // a correctness fallback while the local index warms in the background.
    void gmailMailboxIndexService.ensureUserIndexed(userId);
  }

  const result = await gmailService.listMessages(userId, {
    labelIds: label ? [label] : undefined,
    q: q || undefined,
    pageToken: pageToken || undefined,
    maxResults: 25,
  });
  res.setHeader('X-Suprah-Mail-Source', q ? 'gmail-search' : 'gmail-fallback');
  res.json(new ApiResponse(200, result, 'Messages fetched'));
});

/** GET /api/mail/messages/:id — full message with parsed body + attachments */
const getMessageDetail = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const message = await gmailService.getMessage(user._id.toString(), req.params.id);
  res.json(new ApiResponse(200, { message }, 'Message fetched'));
});

/** GET /api/mail/threads/:id — every message in the thread (reading pane) */
const getThreadDetail = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const messages = await gmailService.getThread(user._id.toString(), req.params.id);
  res.json(new ApiResponse(200, { messages }, 'Thread fetched'));
});

/** GET /api/mail/messages/:id/attachments/:attachmentId?filename=&mimeType= */
const downloadAttachment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id, attachmentId } = req.params;
  const { filename = 'attachment', mimeType = 'application/octet-stream' } =
    req.query as Record<string, string>;

  const buffer = await gmailService.getAttachment(user._id.toString(), id, attachmentId);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename).replace(/['()]/g, '')}"`,
  );
  res.send(buffer);
});

/**
 * POST /api/mail/messages/send  (multipart: files[] + fields)
 * body: to, cc, bcc, subject, text, html, threadId, inReplyTo, references
 * Handles compose, reply, and forward — reply/forward just pass threading
 * fields and the client-prepared subject/body.
 */
const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { to, cc, bcc, subject, text, html, threadId, inReplyTo, references } = req.body;

  if (!to?.trim()) throw new ApiError(400, 'Recipient (to) is required');
  const invalid = String(to).split(',').map((s: string) => s.trim()).filter(Boolean)
    .find((addr: string) => !isValidEmail(addr));
  if (invalid) throw new ApiError(400, `Invalid recipient address: ${invalid}`);
  if (!text?.trim() && !html?.trim() && filesFromReq(req).length === 0) {
    throw new ApiError(400, 'Message body or attachments are required');
  }

  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const fromEmail = fresh?.googleMail?.gmailAddress || fresh?.email || user.email;

  const sent = await gmailService.sendEmail(user._id.toString(), {
    fromEmail,
    fromName: fresh?.fullName || user.fullName,
    to: to.trim(),
    cc: cc?.trim() || undefined,
    bcc: bcc?.trim() || undefined,
    subject: subject?.trim() || '(no subject)',
    text: text || undefined,
    html: html || undefined,
    attachments: toOutgoingAttachments(filesFromReq(req)),
    threadId: threadId || undefined,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  });

  // Stage 2 instant local echo: Sent can display this row immediately without
  // waiting for the next Gmail history poll.
  await mirrorIndexBestEffort(user._id.toString(), 'sent-message mirror', () =>
    gmailMailboxIndexService.upsertParsedMessage(user._id.toString(), sent),
  );
  mailSyncService.requestImmediateSync(user._id.toString()).catch(() => { });

  res.status(201).json(new ApiResponse(201, { message: sent }, 'Email sent'));
});

/** PATCH /api/mail/messages/:id  body: { action } */
const updateMessage = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const { action } = req.body as { action: string };
  const userId = user._id.toString();

  switch (action) {
    case 'read':    await gmailService.modifyMessage(userId, id, [], ['UNREAD']); break;
    case 'unread':  await gmailService.modifyMessage(userId, id, ['UNREAD'], []); break;
    case 'star':    await gmailService.modifyMessage(userId, id, ['STARRED'], []); break;
    case 'unstar':  await gmailService.modifyMessage(userId, id, [], ['STARRED']); break;
    case 'archive': await gmailService.modifyMessage(userId, id, [], ['INBOX']); break;
    case 'trash':   await gmailService.trashMessage(userId, id); break;
    case 'untrash': await gmailService.untrashMessage(userId, id); break;
    default:
      throw new ApiError(400, 'action must be one of: read, unread, star, unstar, archive, trash, untrash');
  }

  // Gmail succeeded first; now mirror the known label/state change locally.
  // History sync later reconciles the exact Gmail label set.
  await mirrorIndexBestEffort(userId, `message ${action} mirror`, () =>
    gmailMailboxIndexService.applyMessageAction(userId, id, action),
  );

  res.json(new ApiResponse(200, { id, action }, 'Message updated'));
});

// ── Drafts ───────────────────────────────────────────────────────────────────

/** GET /api/mail/drafts */
const getDrafts = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id.toString();
  const { pageToken } = req.query as Record<string, string>;

  try {
    const indexed = await gmailMailboxIndexService.listDrafts(
      userId,
      pageToken || undefined,
    );

    if (indexed) {
      res.setHeader('X-Suprah-Mail-Source', 'local-index');
      res.json(new ApiResponse(200, indexed, 'Drafts fetched'));
      return;
    }
  } catch (error: any) {
    console.error('[MailIndex] local DRAFTS read failed:', error?.message);
  }

  void gmailMailboxIndexService.ensureUserIndexed(userId);
  const result = await gmailService.listDrafts(userId, pageToken || undefined);
  res.setHeader('X-Suprah-Mail-Source', 'gmail-fallback');
  res.json(new ApiResponse(200, result, 'Drafts fetched'));
});

/** GET /api/mail/drafts/:draftId — full draft body loaded only on edit */
const getDraftDetail = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const draft = await gmailService.getDraft(
    user._id.toString(),
    req.params.draftId,
  );
  res.json(new ApiResponse(200, { draft }, 'Draft fetched'));
});

/** POST /api/mail/drafts  (multipart) */
const createDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { to = '', cc, bcc, subject = '', text = '', html, threadId } = req.body;
  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const userId = user._id.toString();
  const draftId = await gmailService.createDraft(userId, {
    fromEmail: fresh?.googleMail?.gmailAddress || fresh?.email || user.email,
    fromName: fresh?.fullName || user.fullName,
    to, cc, bcc, subject, text, html,
    attachments: toOutgoingAttachments(filesFromReq(req)),
    threadId: threadId || undefined,
  });
  await mirrorIndexBestEffort(userId, 'draft-create mirror', () =>
    gmailMailboxIndexService.refreshDraftById(userId, draftId),
  );
  res.status(201).json(new ApiResponse(201, { draftId }, 'Draft saved'));
});

/** PATCH /api/mail/drafts/:draftId  (multipart) */
const updateDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { to = '', cc, bcc, subject = '', text = '', html, threadId } = req.body;
  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const userId = user._id.toString();
  const draftId = await gmailService.updateDraft(userId, req.params.draftId, {
    fromEmail: fresh?.googleMail?.gmailAddress || fresh?.email || user.email,
    fromName: fresh?.fullName || user.fullName,
    to, cc, bcc, subject, text, html,
    attachments: toOutgoingAttachments(filesFromReq(req)),
    threadId: threadId || undefined,
  });
  await mirrorIndexBestEffort(userId, 'draft-update mirror', () =>
    gmailMailboxIndexService.refreshDraftById(userId, draftId),
  );
  res.json(new ApiResponse(200, { draftId }, 'Draft updated'));
});

/** DELETE /api/mail/drafts/:draftId */
const deleteDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id.toString();
  await gmailService.deleteDraft(userId, req.params.draftId);
  await mirrorIndexBestEffort(userId, 'draft-delete mirror', () =>
    gmailMailboxIndexService.removeDraft(userId, req.params.draftId),
  );
  res.json(new ApiResponse(200, null, 'Draft deleted'));
});

/** POST /api/mail/drafts/:draftId/send */
const sendDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id.toString();
  const sent = await gmailService.sendDraft(userId, req.params.draftId);
  await mirrorIndexBestEffort(userId, 'draft-send mirror', async () => {
    await gmailMailboxIndexService.removeDraft(userId, req.params.draftId);
    await gmailMailboxIndexService.upsertParsedMessage(userId, sent);
  });
  mailSyncService.requestImmediateSync(userId).catch(() => { });
  res.json(new ApiResponse(200, { message: sent }, 'Draft sent'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversations (email-powered chat with external contacts)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/mail/conversations */
const getConversations = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { archived, q = '' } = req.query as Record<string, string>;
  const archivedValue = archived === 'true';
  const searchQuery = String(q || '').trim();

  // Keep the normal Email Chat list path exactly as before.
  if (!searchQuery) {
    const conversations = await MailConversation.find({
      ownerCrmUserId: user._id,
      isArchived: archivedValue,
    })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(200)
      .lean();

    res.json(
      new ApiResponse(
        200,
        { conversations, messageMatches: [] },
        'Conversations fetched',
      ),
    );
    return;
  }

  // Avoid broad one-character scans while the user is still typing.
  if (searchQuery.length < 2) {
    res.json(
      new ApiResponse(
        200,
        { conversations: [], messageMatches: [] },
        'Conversation search requires at least 2 characters',
      ),
    );
    return;
  }

  const regex = new RegExp(escapeRegex(searchQuery), 'i');

  /**
   * Search Email Chat's LOCAL persisted MailMessage collection rather than
   * Gmail. This keeps Gmail/API quota completely out of this UI search.
   *
   * Group by conversation and retain the newest matching bubble from each
   * conversation so one very active thread cannot consume the entire result
   * set with dozens of duplicate hits.
   */
  const messageMatchesRaw = await MailMessage.aggregate([
    {
      $match: {
        ownerCrmUserId: user._id,
        $or: [
          { bodyText: regex },
          { fromName: regex },
          { fromEmail: regex },
          { 'attachments.originalName': regex },
        ],
      },
    },
    { $sort: { sentAt: -1 } },
    {
      $group: {
        _id: '$conversationId',
        messageId: { $first: '$_id' },
        bodyText: { $first: '$bodyText' },
        fromName: { $first: '$fromName' },
        fromEmail: { $first: '$fromEmail' },
        sentAt: { $first: '$sentAt' },
        attachmentNames: { $first: '$attachments.originalName' },
      },
    },
    { $limit: 200 },
  ]);

  const messageConversationIds = messageMatchesRaw.map(
    (match: any) => match._id,
  );

  // A single search field now covers:
  // - contact / group name
  // - subject
  // - participant email/name
  // - latest preview/sender
  // - any persisted Email Chat message text / attachment filename
  const conversations = await MailConversation.find({
    ownerCrmUserId: user._id,
    isArchived: archivedValue,
    $or: [
      ...(messageConversationIds.length > 0
        ? [{ _id: { $in: messageConversationIds } }]
        : []),
      { title: regex },
      { subject: regex },
      { 'participants.name': regex },
      { 'participants.email': regex },
      { lastMessagePreview: regex },
      { lastMessageFromName: regex },
    ],
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(200)
    .lean();

  const allowedConversationIds = new Set(
    conversations.map((conversation: any) =>
      String(conversation._id),
    ),
  );

  const messageMatches = messageMatchesRaw
    .filter((match: any) =>
      allowedConversationIds.has(String(match._id)),
    )
    .map((match: any) => {
      const attachmentNames = Array.isArray(match.attachmentNames)
        ? match.attachmentNames.map((name: unknown) => String(name || ''))
        : [];
      const attachmentMatch = attachmentNames.find((name: string) =>
        regex.test(name),
      );

      return {
        conversationId: String(match._id),
        messageId: String(match.messageId),
        snippet:
          String(match.bodyText || '').trim().slice(0, 240) ||
          (attachmentMatch
            ? `Attachment: ${attachmentMatch}`
            : 'Matching message'),
        fromName: match.fromName || undefined,
        fromEmail: match.fromEmail || undefined,
        sentAt: match.sentAt,
      };
    });

  res.json(
    new ApiResponse(
      200,
      { conversations, messageMatches },
      'Conversation search fetched',
    ),
  );
});

/**
 * POST /api/mail/conversations
 * body (direct): { email, name?, subject? }
 * body (group):  { participants: [{ email, name? }, ...], title?, subject? }
 *
 * Accepts either shape. `participants` (2+) creates a GROUP; a single `email`
 * (or a single-item participants array) creates/reuses a DIRECT conversation.
 */
const createConversation = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { email, name, participants, title, subject } = req.body;

  // Normalize both request shapes into one participant list.
  type RawP = { email?: string; name?: string };
  const raw: RawP[] = Array.isArray(participants) && participants.length
    ? participants
    : (email ? [{ email, name }] : []);

  if (raw.length === 0) {
    throw new ApiError(400, 'At least one external email address is required');
  }

  // Validate + de-duplicate (case-insensitive) while preserving order.
  const seen = new Set<string>();
  const cleaned: { email: string; name?: string; addedAt: Date }[] = [];
  for (const p of raw) {
    const e = (p.email || '').trim().toLowerCase();
    if (!e) continue;
    if (!isValidEmail(e)) throw new ApiError(400, `Invalid email address: ${p.email}`);
    if (seen.has(e)) continue;
    seen.add(e);
    cleaned.push({ email: e, name: p.name?.trim() || undefined, addedAt: new Date() });
  }
  if (cleaned.length === 0) throw new ApiError(400, 'No valid email addresses provided');

  const isGroup = cleaned.length > 1;
  const finalSubject = subject?.trim() || `Conversation with ${user.fullName}`;

  // Only DIRECT conversations are de-duplicated/reused. Groups are always new,
  // since two groups can legitimately share a subject with different members.
  // Matched by participant only (not subject) — a direct conversation with
  // someone is one ongoing thread regardless of what subject line either
  // attempt happened to use.
  if (!isGroup) {
    const existing = await MailConversation.findOne({
      ownerCrmUserId: user._id,
      type: 'direct',
      'participants.email': cleaned[0].email,
      isArchived: false,
    });
    if (existing) {
      res.status(200).json(new ApiResponse(200, existing, 'Conversation ready'));
      return;
    }
  }

  const conversation = await MailConversation.create({
    organizationId: user.organizationId,
    ownerCrmUserId: user._id,
    type: isGroup ? 'group' : 'direct',
    participants: cleaned,
    title: isGroup ? (title?.trim() || undefined) : undefined,
    subject: finalSubject,
    unreadCount: 0,
    isArchived: false,
  });

  res.status(201).json(new ApiResponse(201, conversation, 'Conversation ready'));
});

/** POST /api/mail/conversations/:id/participants  body: { email, name? } */
const addParticipant = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const { email, name } = req.body;

  const e = (email || '').trim().toLowerCase();
  if (!e || !isValidEmail(e)) throw new ApiError(400, 'A valid email address is required');

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  if (conversation.participants.some((p) => p.email === e)) {
    throw new ApiError(409, 'That address is already in this conversation');
  }

  conversation.participants.push({ email: e, name: name?.trim() || undefined, addedAt: new Date() });
  // Adding a second member promotes a direct chat to a group.
  if (conversation.participants.length > 1) conversation.type = 'group';
  await conversation.save({ validateModifiedOnly: true });

  mailSyncService.emitToUser(user._id.toString(), 'mail:conversation:updated', { conversation });
  res.json(new ApiResponse(200, conversation, 'Participant added'));
});

/** DELETE /api/mail/conversations/:id/participants/:email */
const removeParticipant = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id, email } = req.params;
  const e = decodeURIComponent(email || '').trim().toLowerCase();

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  const before = conversation.participants.length;
  conversation.participants = conversation.participants.filter((p) => p.email !== e);
  if (conversation.participants.length === before) {
    throw new ApiError(404, 'That address is not in this conversation');
  }
  if (conversation.participants.length === 0) {
    throw new ApiError(400, 'A conversation must keep at least one participant');
  }
  if (conversation.participants.length === 1) conversation.type = 'direct';
  await conversation.save({ validateModifiedOnly: true });

  mailSyncService.emitToUser(user._id.toString(), 'mail:conversation:updated', { conversation });
  res.json(new ApiResponse(200, conversation, 'Participant removed'));
});

/** GET /api/mail/conversations/:id/messages?before=&limit= */
const getConversationMessages = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const { before, limit = '50' } = req.query as Record<string, string>;

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  const filter: any = { conversationId: conversation._id };
  if (before) filter.sentAt = { $lt: new Date(before) };

  const messages = await MailMessage.find(filter)
    .sort({ sentAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 50, 100))
    .lean();

  res.json(
    new ApiResponse(200, {
      conversation,
      messages: messages.reverse(),
      hasMore: messages.length === (Math.min(parseInt(limit, 10) || 50, 100)),
    }, 'Conversation messages fetched'),
  );
});

/**
 * POST /api/mail/conversations/:id/messages  (multipart: files[] + { text })
 *
 * Sends the message as a real email on the conversation's Gmail thread
 * (creating the thread on first send), persists a chat-bubble MailMessage,
 * uploads attachments to R2 through the shared storageService, and pushes
 * the bubble over the socket so every open session updates instantly.
 */
const sendConversationMessage = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const { text = '' } = req.body;
  const files = filesFromReq(req);

  if (!text.trim() && files.length === 0) {
    throw new ApiError(400, 'Message text or attachments are required');
  }

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const fromEmail = (fresh?.googleMail?.gmailAddress || fresh?.email || user.email).toLowerCase();

  // Threading context — reply to the latest message so Gmail keeps one thread.
  const lastThreaded = await MailMessage.findOne({
    conversationId: conversation._id,
    rfc822MessageId: { $exists: true, $ne: null },
  }).sort({ sentAt: -1 }).lean();

  // 1) Persist attachments to R2 first (never lose files if Gmail hiccups).
  const storedAttachments = await Promise.all(
    files.map(async (f) => ({
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      storageUrl: await storageService.upload(f, 'mail-conversations', BucketType.PUBLIC, {
        allowLocalFallback: true,
      }),
    })),
  );

  // Address every participant (reply-all group behaviour). Direct chats simply
  // have a single participant, so the same code path covers both.
  const recipientList = conversation.participants
    .map((p) => (p.name ? `${p.name} <${p.email}>` : p.email))
    .join(', ');
  const toEmailField = conversation.participants.map((p) => p.email).join(', ');
  const senderName = fresh?.fullName || user.fullName;

  // 2) Optimistic local message so the sender's UI is instant even before
  //    Gmail confirms; status flips to 'sent' (or 'failed') below.
  const message = await MailMessage.create({
    conversationId: conversation._id,
    organizationId: conversation.organizationId,
    ownerCrmUserId: conversation.ownerCrmUserId,
    direction: 'outbound',
    fromEmail,
    fromName: senderName,
    toEmail: toEmailField,
    bodyText: text.trim(),
    attachments: storedAttachments,
    gmailThreadId: conversation.gmailThreadId,
    status: 'sending',
    readByOwner: true,
    sentAt: new Date(),
  });

  try {
    // 3) Send the real email to all participants.
    const sent = await gmailService.sendEmail(user._id.toString(), {
      fromEmail,
      fromName: senderName,
      to: recipientList,
      subject: lastThreaded ? `Re: ${conversation.subject.replace(/^Re:\s*/i, '')}` : conversation.subject,
      text: text.trim() || '(attachment)',
      attachments: toOutgoingAttachments(files),
      threadId: conversation.gmailThreadId || undefined,
      inReplyTo: lastThreaded?.rfc822MessageId || undefined,
      references: lastThreaded?.rfc822MessageId || undefined,
    });

    await mirrorIndexBestEffort(user._id.toString(), 'conversation-sent mirror', () =>
      gmailMailboxIndexService.upsertParsedMessage(user._id.toString(), sent),
    );

    message.status = 'sent';
    message.gmailMessageId = sent.id;
    message.gmailThreadId = sent.threadId;
    message.rfc822MessageId = sent.rfc822MessageId;
    await message.save({ validateModifiedOnly: true });

    conversation.gmailThreadId = conversation.gmailThreadId || sent.threadId;
    conversation.lastMessageAt = message.sentAt;
    conversation.lastMessagePreview = message.bodyText.slice(0, 140) || '📎 Attachment';
    conversation.lastMessageDirection = 'outbound';
    conversation.lastMessageFromName = senderName;
    await conversation.save({ validateModifiedOnly: true });
  } catch (err: any) {
    message.status = 'failed';
    message.errorMessage = err?.message || 'Failed to send email';
    await message.save({ validateModifiedOnly: true });
    mailSyncService.emitToUser(user._id.toString(), 'mail:conversation:message', {
      conversationId: conversation._id.toString(),
      message,
    });
    throw new ApiError(502, `Email failed to send: ${message.errorMessage}`);
  }

  // 4) Real-time fan-out to all of the sender's sessions/devices.
  mailSyncService.emitToUser(user._id.toString(), 'mail:conversation:message', {
    conversationId: conversation._id.toString(),
    message,
  });

  res.status(201).json(new ApiResponse(201, { message, conversation }, 'Message sent'));
});

/** POST /api/mail/conversations/:id/read */
const markConversationRead = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  conversation.unreadCount = 0;
  await conversation.save({ validateModifiedOnly: true });
  await MailMessage.updateMany(
    { conversationId: conversation._id, readByOwner: false },
    { $set: { readByOwner: true } },
  );

  res.json(new ApiResponse(200, null, 'Conversation marked as read'));
});

/** PATCH /api/mail/conversations/:id  body: { isArchived } */
const updateConversation = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;
  const { isArchived } = req.body;

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  if (typeof isArchived === 'boolean') conversation.isArchived = isArchived;
  await conversation.save({ validateModifiedOnly: true });

  res.json(new ApiResponse(200, conversation, 'Conversation updated'));
});

/**
 * DELETE /api/mail/conversations/:id
 * Permanently removes the conversation wrapper and its persisted chat
 * bubbles from Suprah — the underlying Gmail thread/messages are untouched.
 */
const deleteConversation = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id } = req.params;

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  await MailMessage.deleteMany({ conversationId: conversation._id });
  await conversation.deleteOne();

  res.json(new ApiResponse(200, null, 'Conversation deleted'));
});

/**
 * GET /api/mail/conversations/:id/attachments/:messageId/:index
 * Streams a conversation attachment: R2-stored files come straight from
 * storage; inbound Gmail attachments are fetched on demand and cached to R2
 * so the second download never hits Gmail again.
 */
const downloadConversationAttachment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { id, messageId, index } = req.params;

  const conversation = await MailConversation.findOne({ _id: id, ownerCrmUserId: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');

  const message = await MailMessage.findOne({ _id: messageId, conversationId: conversation._id });
  if (!message) throw new ApiError(404, 'Message not found');

  const att = message.attachments[Number(index)];
  if (!att) throw new ApiError(404, 'Attachment not found');

  if (att.storageUrl) {
    return res.redirect(att.storageUrl);
  }

  if (att.gmailMessageId && att.gmailAttachmentId) {
    const buffer = await gmailService.getAttachment(
      user._id.toString(),
      att.gmailMessageId,
      att.gmailAttachmentId,
    );

    // Cache to R2 (best-effort) so repeat opens are instant.
    storageService
      .upload(
        { buffer, originalname: att.originalName, mimetype: att.mimeType },
        'mail-conversations',
        BucketType.PUBLIC,
      )
      .then((url) =>
        MailMessage.updateOne(
          { _id: message._id, [`attachments.${index}.gmailAttachmentId`]: att.gmailAttachmentId },
          { $set: { [`attachments.${index}.storageUrl`]: url } },
        ),
      )
      .catch(() => { });

    res.setHeader('Content-Type', att.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(att.originalName).replace(/['()]/g, '')}"`,
    );
    return res.send(buffer);
  }

  throw new ApiError(404, 'Attachment content is unavailable');
});

export default {
  // connection
  getStatus,
  getConnectUrl,
  oauthCallback,
  disconnect,
  triggerSync,
  // inbox
  getLabels,
  getMailboxSummary,
  getMessages,
  getMessageDetail,
  getThreadDetail,
  downloadAttachment,
  sendMessage,
  updateMessage,
  // drafts
  getDrafts,
  getDraftDetail,
  createDraft,
  updateDraft,
  deleteDraft,
  sendDraft,
  // conversations
  getConversations,
  createConversation,
  addParticipant,
  removeParticipant,
  getConversationMessages,
  sendConversationMessage,
  markConversationRead,
  updateConversation,
  deleteConversation,
  downloadConversationAttachment,
};