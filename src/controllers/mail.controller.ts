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
import { storageService, BucketType } from '../services/storage.service';

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000';
const MAIL_PAGE_PATH = '/crm/suprah-mail';

const filesFromReq = (req: Request): Express.Multer.File[] =>
  ((req as any).files as Express.Multer.File[] | undefined) || [];

const toOutgoingAttachments = (files: Express.Multer.File[]): OutgoingAttachment[] =>
  files.map((f) => ({ filename: f.originalname, mimeType: f.mimetype, content: f.buffer }));

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

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
    // Warm the first sync so the inbox is populated the moment the tab loads.
    mailSyncService.requestImmediateSync(userId).catch(() => { });
    return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=connected`);
  } catch (err: any) {
    console.error('[Mail] OAuth callback failed:', err?.message);
    return res.redirect(`${FRONTEND_URL}${MAIL_PAGE_PATH}?mail=error`);
  }
});

/** POST /api/mail/disconnect */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await gmailService.disconnect(user._id.toString());
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

/** GET /api/mail/messages?label=INBOX&q=&pageToken= */
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { label = 'INBOX', q, pageToken } = req.query as Record<string, string>;
  const result = await gmailService.listMessages(user._id.toString(), {
    labelIds: label ? [label] : undefined,
    q: q || undefined,
    pageToken: pageToken || undefined,
    maxResults: 25,
  });
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

  // Instant echo — sent mail appears in the Sent list without waiting a tick.
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

  res.json(new ApiResponse(200, { id, action }, 'Message updated'));
});

// ── Drafts ───────────────────────────────────────────────────────────────────

/** GET /api/mail/drafts */
const getDrafts = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { pageToken } = req.query as Record<string, string>;
  const result = await gmailService.listDrafts(user._id.toString(), pageToken || undefined);
  res.json(new ApiResponse(200, result, 'Drafts fetched'));
});

/** POST /api/mail/drafts  (multipart) */
const createDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { to = '', cc, bcc, subject = '', text = '', html, threadId } = req.body;
  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const draftId = await gmailService.createDraft(user._id.toString(), {
    fromEmail: fresh?.googleMail?.gmailAddress || fresh?.email || user.email,
    fromName: fresh?.fullName || user.fullName,
    to, cc, bcc, subject, text, html,
    attachments: toOutgoingAttachments(filesFromReq(req)),
    threadId: threadId || undefined,
  });
  res.status(201).json(new ApiResponse(201, { draftId }, 'Draft saved'));
});

/** PATCH /api/mail/drafts/:draftId  (multipart) */
const updateDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { to = '', cc, bcc, subject = '', text = '', html, threadId } = req.body;
  const fresh = await CrmUser.findById(user._id).select('fullName email googleMail.gmailAddress').lean();
  const draftId = await gmailService.updateDraft(user._id.toString(), req.params.draftId, {
    fromEmail: fresh?.googleMail?.gmailAddress || fresh?.email || user.email,
    fromName: fresh?.fullName || user.fullName,
    to, cc, bcc, subject, text, html,
    attachments: toOutgoingAttachments(filesFromReq(req)),
    threadId: threadId || undefined,
  });
  res.json(new ApiResponse(200, { draftId }, 'Draft updated'));
});

/** DELETE /api/mail/drafts/:draftId */
const deleteDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await gmailService.deleteDraft(user._id.toString(), req.params.draftId);
  res.json(new ApiResponse(200, null, 'Draft deleted'));
});

/** POST /api/mail/drafts/:draftId/send */
const sendDraft = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const sent = await gmailService.sendDraft(user._id.toString(), req.params.draftId);
  mailSyncService.requestImmediateSync(user._id.toString()).catch(() => { });
  res.json(new ApiResponse(200, { message: sent }, 'Draft sent'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversations (email-powered chat with external contacts)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/mail/conversations */
const getConversations = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { archived } = req.query as Record<string, string>;
  const conversations = await MailConversation.find({
    ownerCrmUserId: user._id,
    isArchived: archived === 'true',
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(200)
    .lean();
  res.json(new ApiResponse(200, { conversations }, 'Conversations fetched'));
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
  if (!isGroup) {
    const existing = await MailConversation.findOne({
      ownerCrmUserId: user._id,
      type: 'direct',
      'participants.email': cleaned[0].email,
      subject: finalSubject,
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
  getMessages,
  getMessageDetail,
  getThreadDetail,
  downloadAttachment,
  sendMessage,
  updateMessage,
  // drafts
  getDrafts,
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
  downloadConversationAttachment,
};