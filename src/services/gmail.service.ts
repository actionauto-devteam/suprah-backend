import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';

/**
 * gmail.service — everything Suprah Mail needs from the Gmail API.
 *
 * Responsibilities:
 *  - OAuth connect/disconnect with HMAC-signed state (no CSRF)
 *  - Per-user OAuth2 clients with automatic refresh-token persistence
 *  - Inbox operations: labels, list/search, full message parse, attachments
 *  - Sending: raw RFC 2822 MIME builder (multipart, attachments, threading
 *    headers so replies stay in the same Gmail thread)
 *  - Drafts: list / create / update / delete / send
 *  - Incremental sync via users.history.list (historyId cursor stored on the
 *    CrmUser). A stale cursor (Gmail 404) is self-healed by resetting to the
 *    profile's current historyId — no crash, no duplicate storms.
 *
 * Required env:
 *   GOOGLE_MAIL_CLIENT_ID / GOOGLE_MAIL_CLIENT_SECRET  (or falls back to
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 *   GOOGLE_MAIL_REDIRECT_URI  e.g. https://api.suprah-app.com/api/mail/oauth/callback
 */

const CLIENT_ID = process.env.GOOGLE_MAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_MAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_MAIL_REDIRECT_URI || '';
const STATE_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify', // read + send + label changes (not full delete)
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface ParsedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId?: string;
  internalDate: number;
  subject: string;
  from: { name: string; email: string };
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  rfc822MessageId?: string;
  references?: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments: ParsedAttachment[];
  isUnread: boolean;
  isStarred: boolean;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendEmailInput {
  fromEmail: string;
  fromName?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  // Threading — keeps replies inside the original Gmail thread.
  threadId?: string;
  inReplyTo?: string;   // rfc822 Message-ID of the message being replied to
  references?: string;  // References chain
}

class GmailService {
  private isConfigured(): boolean {
    return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ApiError(
        503,
        'Suprah Mail is not configured. Set GOOGLE_MAIL_CLIENT_ID, GOOGLE_MAIL_CLIENT_SECRET and GOOGLE_MAIL_REDIRECT_URI.',
      );
    }
  }

  private newOAuthClient(): OAuth2Client {
    return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  }

  // ── OAuth state (HMAC-signed userId, same pattern as LinkedAccount) ──────

  signState(userId: string): string {
    const payload = `${userId}.${Date.now()}`;
    const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
  }

  verifyState(state: string): string {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const [userId, ts, sig] = decoded.split('.');
      const expected = crypto.createHmac('sha256', STATE_SECRET).update(`${userId}.${ts}`).digest('hex');
      const valid = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
      // 15-minute window for completing the consent screen.
      if (!valid || Date.now() - Number(ts) > 15 * 60 * 1000) {
        throw new Error('invalid');
      }
      return userId;
    } catch {
      throw new ApiError(400, 'Invalid or expired OAuth state');
    }
  }

  // ── Connect / disconnect ─────────────────────────────────────────────────

  getAuthUrl(userId: string): string {
    this.assertConfigured();
    return this.newOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // guarantees a refresh_token even on re-connect
      scope: GMAIL_SCOPES,
      state: this.signState(userId),
    });
  }

  async handleOAuthCallback(code: string, state: string): Promise<{ userId: string; gmailAddress: string }> {
    this.assertConfigured();
    const userId = this.verifyState(state);
    const client = this.newOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailAddress = profile.data.emailAddress || '';

    const user = await CrmUser.findById(userId).select('+googleMail.refreshToken');
    if (!user) throw new ApiError(404, 'CRM user not found');

    // Preserve an existing refresh token if Google didn't return a new one.
    const existingRefresh = (user.googleMail as any)?.refreshToken;

    user.googleMail = {
      connected: true,
      gmailAddress,
      accessToken: tokens.access_token || undefined,
      refreshToken: tokens.refresh_token || existingRefresh || undefined,
      expiryDate: tokens.expiry_date || undefined,
      historyId: profile.data.historyId ? String(profile.data.historyId) : undefined,
      lastSyncAt: new Date(),
      lastSyncError: undefined,
      connectedAt: new Date(),
    };
    user.markModified('googleMail');
    await user.save({ validateModifiedOnly: true });

    return { userId, gmailAddress };
  }

  async disconnect(userId: string): Promise<void> {
    const user = await CrmUser.findById(userId).select(
      '+googleMail.accessToken +googleMail.refreshToken',
    );
    if (!user?.googleMail?.connected) return;

    const token = (user.googleMail as any).refreshToken || (user.googleMail as any).accessToken;
    if (token) {
      try { await this.newOAuthClient().revokeToken(token); } catch { /* best-effort */ }
    }

    user.googleMail = { connected: false };
    user.markModified('googleMail');
    await user.save({ validateModifiedOnly: true });
  }

  // ── Per-user authenticated client ────────────────────────────────────────

  async getClientForUser(userId: string): Promise<{ gmail: gmail_v1.Gmail; gmailAddress: string }> {
    this.assertConfigured();
    const user = await CrmUser.findById(userId).select(
      '+googleMail.accessToken +googleMail.refreshToken +googleMail.expiryDate',
    );
    const gm: any = user?.googleMail;
    if (!user || !gm?.connected || !gm?.refreshToken) {
      throw new ApiError(412, 'Gmail is not connected for this account. Connect it from Suprah Mail settings.');
    }

    const client = this.newOAuthClient();
    client.setCredentials({
      access_token: gm.accessToken,
      refresh_token: gm.refreshToken,
      expiry_date: gm.expiryDate,
    });

    // Persist rotated tokens so restarts never lose the session.
    client.on('tokens', (tokens) => {
      const set: Record<string, unknown> = {};
      if (tokens.access_token) set['googleMail.accessToken'] = tokens.access_token;
      if (tokens.refresh_token) set['googleMail.refreshToken'] = tokens.refresh_token;
      if (tokens.expiry_date) set['googleMail.expiryDate'] = tokens.expiry_date;
      if (Object.keys(set).length) {
        CrmUser.updateOne({ _id: user._id }, { $set: set }).catch((err) =>
          console.error('[GmailService] Failed to persist refreshed tokens:', err?.message),
        );
      }
    });

    return { gmail: google.gmail({ version: 'v1', auth: client }), gmailAddress: gm.gmailAddress || user.email };
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  async listLabels(userId: string) {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.labels.list({ userId: 'me' });
    return (res.data.labels || []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      messagesUnread: l.messagesUnread,
    }));
  }

  // ── Listing / reading messages ───────────────────────────────────────────

  async listMessages(
    userId: string,
    opts: { labelIds?: string[]; q?: string; pageToken?: string; maxResults?: number } = {},
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string; resultSizeEstimate?: number }> {
    const { gmail } = await this.getClientForUser(userId);
    const list = await gmail.users.messages.list({
      userId: 'me',
      labelIds: opts.labelIds,
      q: opts.q,
      pageToken: opts.pageToken,
      maxResults: Math.min(opts.maxResults || 25, 50),
    });

    const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
    const messages = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'],
          });
          return this.parseMessage(res.data, { metadataOnly: true });
        } catch {
          return null; // message deleted mid-flight — skip, don't fail the page
        }
      }),
    );

    return {
      messages: messages.filter((m): m is ParsedMessage => m !== null),
      nextPageToken: list.data.nextPageToken || undefined,
      resultSizeEstimate: list.data.resultSizeEstimate || undefined,
    };
  }

  async getMessage(userId: string, messageId: string): Promise<ParsedMessage> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    return this.parseMessage(res.data);
  }

  async getThread(userId: string, threadId: string): Promise<ParsedMessage[]> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return (res.data.messages || []).map((m) => this.parseMessage(m));
  }

  async getAttachment(
    userId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    return Buffer.from(res.data.data || '', 'base64url');
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  async modifyMessage(
    userId: string,
    messageId: string,
    addLabelIds: string[] = [],
    removeLabelIds: string[] = [],
  ) {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    return res.data;
  }

  async trashMessage(userId: string, messageId: string) {
    const { gmail } = await this.getClientForUser(userId);
    await gmail.users.messages.trash({ userId: 'me', id: messageId });
  }

  async untrashMessage(userId: string, messageId: string) {
    const { gmail } = await this.getClientForUser(userId);
    await gmail.users.messages.untrash({ userId: 'me', id: messageId });
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async sendEmail(userId: string, input: SendEmailInput): Promise<ParsedMessage> {
    const { gmail } = await this.getClientForUser(userId);
    const raw = this.buildRawEmail(input);
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: input.threadId },
    });
    // Re-fetch so the caller gets the canonical headers (Message-ID etc.).
    const sent = await gmail.users.messages.get({
      userId: 'me',
      id: res.data.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'References'],
    });
    return this.parseMessage(sent.data, { metadataOnly: true });
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  async listDrafts(userId: string, pageToken?: string) {
    const { gmail } = await this.getClientForUser(userId);
    const list = await gmail.users.drafts.list({ userId: 'me', maxResults: 25, pageToken });
    const drafts = await Promise.all(
      (list.data.drafts || []).map(async (d) => {
        try {
          const res = await gmail.users.drafts.get({ userId: 'me', id: d.id!, format: 'metadata' });
          const msg = res.data.message ? this.parseMessage(res.data.message, { metadataOnly: true }) : null;
          return msg ? { draftId: d.id!, message: msg } : null;
        } catch { return null; }
      }),
    );
    return {
      drafts: drafts.filter(Boolean) as Array<{ draftId: string; message: ParsedMessage }>,
      nextPageToken: list.data.nextPageToken || undefined,
    };
  }

  async createDraft(userId: string, input: SendEmailInput): Promise<string> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: this.buildRawEmail(input), threadId: input.threadId } },
    });
    return res.data.id!;
  }

  async updateDraft(userId: string, draftId: string, input: SendEmailInput): Promise<string> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: { message: { raw: this.buildRawEmail(input), threadId: input.threadId } },
    });
    return res.data.id!;
  }

  async deleteDraft(userId: string, draftId: string): Promise<void> {
    const { gmail } = await this.getClientForUser(userId);
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });
  }

  async sendDraft(userId: string, draftId: string): Promise<ParsedMessage> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    const sent = await gmail.users.messages.get({
      userId: 'me',
      id: res.data.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'],
    });
    return this.parseMessage(sent.data, { metadataOnly: true });
  }

  // ── Incremental sync ─────────────────────────────────────────────────────

  /**
   * Runs users.history.list from the stored historyId cursor. Returns the ids
   * of newly-added messages plus label changes, and advances the cursor.
   * A 404 from Gmail means the cursor expired — we self-heal by resetting the
   * cursor to "now" and reporting a fullResync so clients refresh their lists.
   */
  async syncHistory(userId: string): Promise<{
    addedMessageIds: string[];
    labelChangedMessageIds: string[];
    deletedMessageIds: string[];
    fullResync: boolean;
  }> {
    const { gmail } = await this.getClientForUser(userId);
    const user = await CrmUser.findById(userId);
    const startHistoryId = user?.googleMail?.historyId;

    const result = {
      addedMessageIds: [] as string[],
      labelChangedMessageIds: [] as string[],
      deletedMessageIds: [] as string[],
      fullResync: false,
    };

    const persistCursor = async (historyId?: string | null, error?: string) => {
      const set: Record<string, unknown> = { 'googleMail.lastSyncAt': new Date() };
      if (historyId) set['googleMail.historyId'] = String(historyId);
      set['googleMail.lastSyncError'] = error || null;
      await CrmUser.updateOne({ _id: userId }, { $set: set });
    };

    if (!startHistoryId) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      await persistCursor(profile.data.historyId ? String(profile.data.historyId) : undefined);
      result.fullResync = true;
      return result;
    }

    try {
      let pageToken: string | undefined;
      let newestHistoryId: string | undefined;
      do {
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          pageToken,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
        });
        newestHistoryId = res.data.historyId ? String(res.data.historyId) : newestHistoryId;
        for (const h of res.data.history || []) {
          (h.messagesAdded || []).forEach((m) => m.message?.id && result.addedMessageIds.push(m.message.id));
          (h.messagesDeleted || []).forEach((m) => m.message?.id && result.deletedMessageIds.push(m.message.id));
          (h.labelsAdded || []).forEach((m) => m.message?.id && result.labelChangedMessageIds.push(m.message.id));
          (h.labelsRemoved || []).forEach((m) => m.message?.id && result.labelChangedMessageIds.push(m.message.id));
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);

      result.addedMessageIds = [...new Set(result.addedMessageIds)];
      result.labelChangedMessageIds = [...new Set(result.labelChangedMessageIds)]
        .filter((id) => !result.addedMessageIds.includes(id));
      result.deletedMessageIds = [...new Set(result.deletedMessageIds)];

      await persistCursor(newestHistoryId || startHistoryId);
      return result;
    } catch (err: any) {
      if (err?.code === 404 || err?.response?.status === 404) {
        // Expired cursor — reset to the current head and ask clients to refresh.
        const profile = await gmail.users.getProfile({ userId: 'me' });
        await persistCursor(
          profile.data.historyId ? String(profile.data.historyId) : undefined,
          'History cursor expired — performed full resync',
        );
        result.fullResync = true;
        return result;
      }
      await persistCursor(undefined, err?.message || 'Sync failed');
      throw err;
    }
  }

  // ── MIME building / parsing ──────────────────────────────────────────────

  buildRawEmail(input: SendEmailInput): string {
    const boundaryMixed = `mixed_${crypto.randomBytes(12).toString('hex')}`;
    const boundaryAlt = `alt_${crypto.randomBytes(12).toString('hex')}`;
    const encodeHeaderWord = (s: string) =>
      /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

    const from = input.fromName
      ? `${encodeHeaderWord(input.fromName)} <${input.fromEmail}>`
      : input.fromEmail;

    const headers: string[] = [
      `From: ${from}`,
      `To: ${input.to}`,
    ];
    if (input.cc) headers.push(`Cc: ${input.cc}`);
    if (input.bcc) headers.push(`Bcc: ${input.bcc}`);
    headers.push(`Subject: ${encodeHeaderWord(input.subject || '(no subject)')}`);
    if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references || input.inReplyTo) {
      headers.push(`References: ${[input.references, input.inReplyTo].filter(Boolean).join(' ')}`);
    }
    headers.push('MIME-Version: 1.0');

    const text = input.text ?? this.htmlToText(input.html || '');
    const html = input.html ?? `<div>${this.escapeHtml(text).replace(/\n/g, '<br/>')}</div>`;

    const altPart = [
      `--${boundaryAlt}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
      `--${boundaryAlt}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      `--${boundaryAlt}--`,
    ].join('\r\n');

    let mime: string;
    if (input.attachments && input.attachments.length > 0) {
      const parts: string[] = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
        '',
        `--${boundaryMixed}`,
        `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
        '',
        altPart,
      ];
      for (const att of input.attachments) {
        parts.push(
          `--${boundaryMixed}`,
          `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename.replace(/"/g, '')}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${att.filename.replace(/"/g, '')}"`,
          '',
          att.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
        );
      }
      parts.push(`--${boundaryMixed}--`);
      mime = parts.join('\r\n');
    } else {
      mime = [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
        '',
        altPart,
      ].join('\r\n');
    }

    return Buffer.from(mime, 'utf8').toString('base64url');
  }

  parseMessage(msg: gmail_v1.Schema$Message, opts: { metadataOnly?: boolean } = {}): ParsedMessage {
    const headerMap = new Map<string, string>();
    (msg.payload?.headers || []).forEach((h) => {
      if (h.name && h.value) headerMap.set(h.name.toLowerCase(), h.value);
    });
    const header = (name: string) => headerMap.get(name.toLowerCase()) || '';

    const parsed: ParsedMessage = {
      id: msg.id || '',
      threadId: msg.threadId || '',
      labelIds: msg.labelIds || [],
      snippet: msg.snippet || '',
      historyId: msg.historyId ? String(msg.historyId) : undefined,
      internalDate: Number(msg.internalDate || Date.now()),
      subject: header('Subject') || '(no subject)',
      from: this.parseAddress(header('From')),
      to: header('To'),
      cc: header('Cc') || undefined,
      bcc: header('Bcc') || undefined,
      date: header('Date'),
      rfc822MessageId: header('Message-ID') || undefined,
      references: header('References') || undefined,
      attachments: [],
      isUnread: (msg.labelIds || []).includes('UNREAD'),
      isStarred: (msg.labelIds || []).includes('STARRED'),
    };

    if (!opts.metadataOnly && msg.payload) {
      const bodies = { html: '', text: '' };
      this.walkPayload(msg.payload, bodies, parsed.attachments);
      parsed.bodyHtml = bodies.html || undefined;
      parsed.bodyText = bodies.text || (bodies.html ? this.htmlToText(bodies.html) : undefined);
    }

    return parsed;
  }

  private walkPayload(
    part: gmail_v1.Schema$MessagePart,
    bodies: { html: string; text: string },
    attachments: ParsedAttachment[],
  ) {
    const mimeType = part.mimeType || '';
    const filename = part.filename || '';
    const contentId = (part.headers || []).find((h) => h.name?.toLowerCase() === 'content-id')?.value;
    const disposition = (part.headers || []).find((h) => h.name?.toLowerCase() === 'content-disposition')?.value || '';

    if (part.body?.attachmentId && filename) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename,
        mimeType,
        size: part.body.size || 0,
        contentId: contentId?.replace(/[<>]/g, ''),
        isInline: disposition.toLowerCase().startsWith('inline'),
      });
    } else if (mimeType === 'text/html' && part.body?.data && !bodies.html) {
      bodies.html = Buffer.from(part.body.data, 'base64url').toString('utf8');
    } else if (mimeType === 'text/plain' && part.body?.data && !bodies.text) {
      bodies.text = Buffer.from(part.body.data, 'base64url').toString('utf8');
    }

    (part.parts || []).forEach((p) => this.walkPayload(p, bodies, attachments));
  }

  parseAddress(raw: string): { name: string; email: string } {
    if (!raw) return { name: '', email: '' };
    const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    if (match) return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
    return { name: '', email: raw.trim().toLowerCase() };
  }

  htmlToText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

export const gmailService = new GmailService();
export default gmailService;