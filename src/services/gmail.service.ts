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

// Stage 1.2 request-pressure safeguards. Gmail remains authoritative;
// every known mutation/history change invalidates these short-lived snapshots.
const MAIL_LIST_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.MAIL_LIST_CACHE_TTL_MS || 15_000),
);
const MAIL_SUMMARY_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.MAIL_SUMMARY_CACHE_TTL_MS || 10_000),
);
const MAIL_LABEL_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.MAIL_LABEL_CACHE_TTL_MS || 10_000),
);
const MAIL_METADATA_CONCURRENCY = Math.min(
  10,
  Math.max(2, Number(process.env.MAIL_METADATA_CONCURRENCY || 4)),
);

// Stage 1.3 mailbox-summary deadlines. Summary metadata must never hold the
// One Desk UI hostage. The last good summary is kept and returned immediately
// while a single background refresh reconciles it.
const MAIL_SUMMARY_GMAIL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.MAIL_SUMMARY_GMAIL_TIMEOUT_MS || 3_500),
);
const MAIL_SUMMARY_MAILBOX_DEADLINE_MS = Math.max(
  MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
  Number(process.env.MAIL_SUMMARY_MAILBOX_DEADLINE_MS || 5_000),
);

// Stage 1.4 bounded mailbox reads. These limits keep Inbox / Starred / Sent /
// Drafts / Trash / Labels from occupying an HTTP request for 30–60 seconds when
// Gmail is slow. This is a guardrail only; Stage 2 will provide the fast local
// mailbox/thread index.
const MAIL_READ_GMAIL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.MAIL_READ_GMAIL_TIMEOUT_MS || 3_500),
);
const MAIL_LIST_DEADLINE_MS = Math.max(
  MAIL_READ_GMAIL_TIMEOUT_MS,
  Number(process.env.MAIL_LIST_DEADLINE_MS || 12_000),
);
const MAIL_DRAFT_METADATA_CONCURRENCY = Math.min(
  10,
  Math.max(
    2,
    Number(
      process.env.MAIL_DRAFT_METADATA_CONCURRENCY ||
        MAIL_METADATA_CONCURRENCY,
    ),
  ),
);

// Stage 1.4.1 true wall-clock guards. Stage 1.4 bounded individual Gmail
// calls, but the full service operation could still outlive the intended
// deadline while OAuth/token refresh or already-started metadata calls were
// pending. These outer deadlines include client acquisition + Gmail work.
const MAIL_LABEL_DEADLINE_MS = Math.max(
  MAIL_READ_GMAIL_TIMEOUT_MS,
  Number(process.env.MAIL_LABEL_DEADLINE_MS || 6_000),
);
const MAIL_SUMMARY_TOTAL_DEADLINE_MS = Math.max(
  MAIL_SUMMARY_MAILBOX_DEADLINE_MS,
  Number(process.env.MAIL_SUMMARY_TOTAL_DEADLINE_MS || 6_500),
);
const MAIL_OPERATION_GMAIL_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.MAIL_OPERATION_GMAIL_TIMEOUT_MS || 8_000),
);
const MAIL_OPERATION_DEADLINE_MS = Math.max(
  MAIL_OPERATION_GMAIL_TIMEOUT_MS,
  Number(process.env.MAIL_OPERATION_DEADLINE_MS || 12_000),
);
const MAIL_DRAFT_DETAIL_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.MAIL_DRAFT_DETAIL_CACHE_TTL_MS || 30_000),
);

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

export type SystemMailboxId =
  | 'INBOX'
  | 'STARRED'
  | 'SENT'
  | 'DRAFTS'
  | 'TRASH';

export interface MailboxSummary {
  id: SystemMailboxId;
  latestMessageAt: number | null;
  unreadCount: number | null;
  totalCount: number | null;
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

type MessageListResult = {
  messages: ParsedMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type DraftListResult = {
  drafts: Array<{
    draftId: string;
    message: ParsedMessage;
  }>;
  nextPageToken?: string;
};

type TimedValue<T> = {
  value: T;
  expiresAt: number;
};

class GmailService {
  private readonly messageListCache = new Map<
    string,
    TimedValue<MessageListResult>
  >();
  private readonly messageListInFlight = new Map<
    string,
    Promise<MessageListResult>
  >();
  private readonly draftListCache = new Map<
    string,
    TimedValue<DraftListResult>
  >();
  private readonly draftListInFlight = new Map<
    string,
    Promise<DraftListResult>
  >();
  private readonly mailboxSummaryCache = new Map<
    string,
    TimedValue<MailboxSummary[]>
  >();
  private readonly mailboxSummaryInFlight = new Map<
    string,
    Promise<MailboxSummary[]>
  >();
  private readonly labelListCache = new Map<
    string,
    TimedValue<any[]>
  >();
  private readonly labelListInFlight = new Map<
    string,
    Promise<any[]>
  >();
  private readonly draftDetailCache = new Map<
    string,
    TimedValue<{ draftId: string; message: ParsedMessage }>
  >();
  private readonly draftDetailInFlight = new Map<
    string,
    Promise<{ draftId: string; message: ParsedMessage }>
  >();
  private readonly readRevision = new Map<string, number>();

  private currentReadRevision(userId: string): number {
    return this.readRevision.get(userId) || 0;
  }

  private bumpReadRevision(userId: string): void {
    this.readRevision.set(
      userId,
      this.currentReadRevision(userId) + 1,
    );
  }

  private getFreshCacheValue<T>(
    cache: Map<string, TimedValue<T>>,
    key: string,
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    fallback: T,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        operation,
        new Promise<T>((resolve) => {
          timer = setTimeout(
            () => resolve(fallback),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }


  private async withHardTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ApiError(504, message)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Provider/network failures that are safe to expose as a controlled 504.
   *
   * Gaxios implements request timeouts with AbortController. Depending on the
   * gaxios/google-auth version, the resulting timeout may surface as
   * ECONNABORTED/ABORT_ERR/AbortError or only as the message
   * "The operation was aborted." Stage 1.4.2 normalizes all of those forms so
   * an expected Gmail timeout never leaks through the generic Express handler
   * as HTTP 500.
   */
  private isTransientGmailError(error: any): boolean {
    const numericStatus = Number(
      error?.response?.status ??
      error?.status ??
      (typeof error?.code === 'number' ? error.code : NaN),
    );
    const code = String(error?.code || '').toUpperCase();
    const causeCode = String(error?.cause?.code || '').toUpperCase();
    const name = String(error?.name || '').toUpperCase();
    const causeName = String(error?.cause?.name || '').toUpperCase();
    const text = [
      error?.message,
      error?.cause?.message,
      error?.response?.data?.error,
      error?.response?.data?.error_description,
      error?.response?.data?.error?.message,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return (
      [408, 429, 500, 502, 503, 504].includes(numericStatus) ||
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNABORTED',
        'EAI_AGAIN',
        'ENETUNREACH',
        'ABORT_ERR',
        'ERR_ABORTED',
      ].includes(code) ||
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNABORTED',
        'EAI_AGAIN',
        'ENETUNREACH',
        'ABORT_ERR',
        'ERR_ABORTED',
      ].includes(causeCode) ||
      name === 'ABORTERROR' ||
      causeName === 'ABORTERROR' ||
      text.includes('timeout') ||
      text.includes('timed out') ||
      text.includes('operation was aborted') ||
      text.includes('request was aborted') ||
      text.includes('rate limit') ||
      text.includes('temporarily unavailable')
    );
  }

  private normalizeGmailReadError(error: any, message: string): never {
    // Preserve deliberate application/auth errors such as 400/401/403/412.
    // Only provider/network transients are converted to a controlled 504.
    if (error instanceof ApiError) throw error;
    if (this.isTransientGmailError(error)) {
      throw new ApiError(504, message);
    }
    throw error;
  }

  private emptyMailboxSummaries(): MailboxSummary[] {
    return (['INBOX', 'STARRED', 'SENT', 'DRAFTS', 'TRASH'] as SystemMailboxId[])
      .map((id) => ({
        id,
        latestMessageAt: null,
        unreadCount: null,
        totalCount: null,
      }));
  }

  /**
   * Invalidates only read accelerators. Already-running requests are not
   * forcibly cancelled; revisioned keys make later reads start fresh and stop
   * pre-mutation responses from becoming the next server cache snapshot.
   */
  invalidateReadCaches(userId: string): void {
    const prefix = `${userId}|`;

    for (const key of this.messageListCache.keys()) {
      if (key.startsWith(prefix)) {
        this.messageListCache.delete(key);
      }
    }

    for (const key of this.draftListCache.keys()) {
      if (key.startsWith(prefix)) {
        this.draftListCache.delete(key);
      }
    }

    for (const key of this.draftDetailCache.keys()) {
      if (key.startsWith(prefix)) {
        this.draftDetailCache.delete(key);
      }
    }

    // Stage 1.3: preserve the last good summary as a stale snapshot. The next
    // summary request returns it immediately and triggers one background Gmail
    // refresh instead of blocking the UI on live Gmail fan-out.
    const summary = this.mailboxSummaryCache.get(userId);
    if (summary) {
      this.mailboxSummaryCache.set(userId, {
        ...summary,
        expiresAt: 0,
      });
    }

    // Stage 1.4: labels are also safe to serve stale while one background
    // refresh reconciles them. This prevents a slow labels.list call from
    // blocking folder changes after read/star/archive/trash mutations.
    const labels = this.labelListCache.get(userId);
    if (labels) {
      this.labelListCache.set(userId, {
        ...labels,
        expiresAt: 0,
      });
    }

    this.bumpReadRevision(userId);
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];

    const results = new Array<R>(items.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker(),
      ),
    );

    return results;
  }

  private async mapWithConcurrencyUntil<T, R>(
    items: T[],
    concurrency: number,
    deadlineAt: number,
    mapper: (
      item: T,
      index: number,
      remainingMs: number,
    ) => Promise<R>,
  ): Promise<Array<R | undefined>> {
    if (items.length === 0) return [];

    const results = new Array<R | undefined>(
      items.length,
    );
    let cursor = 0;

    const worker = async () => {
      while (true) {
        if (Date.now() >= deadlineAt) return;

        const index = cursor++;
        if (index >= items.length) return;

        const remainingMs = Math.max(
          250,
          deadlineAt - Date.now(),
        );

        try {
          results[index] = await mapper(
            items[index],
            index,
            remainingMs,
          );
        } catch {
          // Per-item failures are intentionally isolated. A single slow or
          // unavailable Gmail message must not hold the entire mailbox open.
          results[index] = undefined;
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            concurrency,
            items.length,
          ),
        },
        () => worker(),
      ),
    );

    return results;
  }

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

  private async refreshLabels(userId: string) {
    const existing =
      this.labelListInFlight.get(userId);
    if (existing) return existing;

    const revisionAtStart =
      this.currentReadRevision(userId);
    const previous =
      this.labelListCache.get(userId)?.value;

    const rawRequest = (async () => {
      try {
        const { gmail } =
          await this.getClientForUser(userId);

        const res = await gmail.users.labels.list(
          {
            userId: 'me',
          },
          {
            timeout: MAIL_READ_GMAIL_TIMEOUT_MS,
          },
        );

        const labels = (res.data.labels || []).map(
          (label) => ({
            id: label.id,
            name: label.name,
            type: label.type,
            messagesUnread:
              label.messagesUnread,
          }),
        );

        if (
          this.currentReadRevision(userId) ===
          revisionAtStart
        ) {
          this.labelListCache.set(userId, {
            value: labels,
            expiresAt:
              Date.now() + MAIL_LABEL_CACHE_TTL_MS,
          });
        }

        return labels;
      } catch (error) {
        // Warm/stale navigation keeps the last usable labels. A truly cold
        // transient failure is normalized below to a controlled 504.
        if (previous) return previous;
        this.normalizeGmailReadError(
          error,
          'Gmail labels are temporarily taking too long. Please retry.',
        );
      }
    })();

    const request = this.withHardTimeout(
      rawRequest,
      MAIL_LABEL_DEADLINE_MS,
      'Gmail labels are temporarily taking too long. Please retry.',
    ).catch((error) => {
      if (previous) return previous;
      throw error;
    });

    // Keep the bounded promise in the coalescing map until the underlying
    // provider call actually settles. If the hard deadline fires first,
    // subsequent requests get the already-settled bounded result instead of
    // starting another Gmail call and recreating a request storm.
    rawRequest.then(
      () => {
        if (this.labelListInFlight.get(userId) === request) {
          this.labelListInFlight.delete(userId);
        }
      },
      () => {
        if (this.labelListInFlight.get(userId) === request) {
          this.labelListInFlight.delete(userId);
        }
      },
    );

    this.labelListInFlight.set(userId, request);
    return request;
  }

  async listLabels(userId: string) {
    const cached = this.labelListCache.get(userId);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value;
      }

      void this.refreshLabels(userId).catch(
        (error: any) => {
          console.error(
            `[Gmail] label refresh for ${userId} failed:`,
            error?.message,
          );
        },
      );

      return cached.value;
    }

    return this.refreshLabels(userId);
  }

  /**
   * Lightweight metadata for the five Suprah One Desk system mailboxes.
   *
   * This deliberately does NOT call listMessages() for each folder. That path
   * fans out into up to 25 Gmail metadata requests per mailbox. Here we only
   * fetch each mailbox's label counts and its single newest message/draft.
   */
  private async refreshMailboxSummaries(
    userId: string,
  ): Promise<MailboxSummary[]> {
    const existing =
      this.mailboxSummaryInFlight.get(userId);
    if (existing) return existing;

    const revisionAtStart =
      this.currentReadRevision(userId);
    const previous =
      this.mailboxSummaryCache.get(userId)?.value || [];
    const previousById = new Map(
      previous.map((item) => [item.id, item]),
    );

    const rawRequest = (async () => {
      const { gmail } = await this.getClientForUser(userId);

      type MailboxConfig = {
        id: SystemMailboxId;
        gmailLabelId: string;
        kind: 'message' | 'draft';
        includeSpamTrash?: boolean;
      };

      const configs: MailboxConfig[] = [
        {
          id: 'INBOX',
          gmailLabelId: 'INBOX',
          kind: 'message',
        },
        {
          id: 'STARRED',
          gmailLabelId: 'STARRED',
          kind: 'message',
        },
        {
          id: 'SENT',
          gmailLabelId: 'SENT',
          kind: 'message',
        },
        {
          id: 'DRAFTS',
          gmailLabelId: 'DRAFT',
          kind: 'draft',
        },
        {
          id: 'TRASH',
          gmailLabelId: 'TRASH',
          kind: 'message',
          includeSpamTrash: true,
        },
      ];

      const readLabelStats = async (
        gmailLabelId: string,
        fallback: {
          unreadCount: number | null;
          totalCount: number | null;
        },
      ) => {
        try {
          const response = await gmail.users.labels.get(
            {
              userId: 'me',
              id: gmailLabelId,
            },
            {
              timeout: MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
            },
          );

          return {
            unreadCount:
              typeof response.data.messagesUnread ===
              'number'
                ? response.data.messagesUnread
                : fallback.unreadCount,
            totalCount:
              typeof response.data.messagesTotal ===
              'number'
                ? response.data.messagesTotal
                : fallback.totalCount,
          };
        } catch {
          return fallback;
        }
      };

      const readLatestMessageAt = async (
        config: MailboxConfig,
        fallback: number | null,
      ): Promise<number | null> => {
        try {
          if (config.kind === 'draft') {
            const list = await gmail.users.drafts.list(
              {
                userId: 'me',
                maxResults: 1,
              },
              {
                timeout: MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
              },
            );

            const draftId = list.data.drafts?.[0]?.id;
            if (!draftId) return null;

            const draft = await gmail.users.drafts.get(
              {
                userId: 'me',
                id: draftId,
                format: 'metadata',
              },
              {
                timeout: MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
              },
            );

            const rawInternalDate = Number(
              draft.data.message?.internalDate || 0,
            );

            return Number.isFinite(rawInternalDate) &&
              rawInternalDate > 0
              ? rawInternalDate
              : fallback;
          }

          const list = await gmail.users.messages.list(
            {
              userId: 'me',
              labelIds: [config.gmailLabelId],
              maxResults: 1,
              includeSpamTrash: Boolean(
                config.includeSpamTrash,
              ),
            },
            {
              timeout: MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
            },
          );

          const messageId = list.data.messages?.[0]?.id;
          if (!messageId) return null;

          const message = await gmail.users.messages.get(
            {
              userId: 'me',
              id: messageId,
              format: 'metadata',
              metadataHeaders: ['Date'],
            },
            {
              timeout: MAIL_SUMMARY_GMAIL_TIMEOUT_MS,
            },
          );

          const rawInternalDate = Number(
            message.data.internalDate || 0,
          );

          if (
            Number.isFinite(rawInternalDate) &&
            rawInternalDate > 0
          ) {
            return rawInternalDate;
          }

          const dateHeader =
            message.data.payload?.headers?.find(
              (header) =>
                header.name?.toLowerCase() === 'date',
            )?.value;

          const parsedHeaderDate = dateHeader
            ? Date.parse(dateHeader)
            : NaN;

          return Number.isFinite(parsedHeaderDate)
            ? parsedHeaderDate
            : fallback;
        } catch {
          return fallback;
        }
      };

      const mailboxes = await Promise.all(
        configs.map(async (config) => {
          const previousMailbox =
            previousById.get(config.id);

          const fallback: MailboxSummary = {
            id: config.id,
            latestMessageAt:
              previousMailbox?.latestMessageAt ?? null,
            unreadCount:
              previousMailbox?.unreadCount ?? null,
            totalCount:
              previousMailbox?.totalCount ?? null,
          };

          return this.withDeadline(
            (async (): Promise<MailboxSummary> => {
              const [stats, latestMessageAt] =
                await Promise.all([
                  readLabelStats(
                    config.gmailLabelId,
                    {
                      unreadCount:
                        fallback.unreadCount,
                      totalCount:
                        fallback.totalCount,
                    },
                  ),
                  readLatestMessageAt(
                    config,
                    fallback.latestMessageAt,
                  ),
                ]);

              return {
                id: config.id,
                latestMessageAt,
                unreadCount: stats.unreadCount,
                totalCount: stats.totalCount,
              };
            })(),
            fallback,
            MAIL_SUMMARY_MAILBOX_DEADLINE_MS,
          );
        }),
      );

      if (
        this.currentReadRevision(userId) ===
        revisionAtStart
      ) {
        this.mailboxSummaryCache.set(userId, {
          value: mailboxes,
          expiresAt:
            Date.now() + MAIL_SUMMARY_CACHE_TTL_MS,
        });
      }

      return mailboxes;
    })();

    const coldFallback = previous.length
      ? previous
      : this.emptyMailboxSummaries();
    const request = this.withDeadline(
      rawRequest,
      coldFallback,
      MAIL_SUMMARY_TOTAL_DEADLINE_MS,
    );

    rawRequest.then(
      () => {
        if (
          this.mailboxSummaryInFlight.get(userId) ===
          request
        ) {
          this.mailboxSummaryInFlight.delete(userId);
        }
      },
      () => {
        if (
          this.mailboxSummaryInFlight.get(userId) ===
          request
        ) {
          this.mailboxSummaryInFlight.delete(userId);
        }
      },
    );

    this.mailboxSummaryInFlight.set(userId, request);
    return request;
  }

  /**
   * Stage 1.3 stale-while-revalidate mailbox metadata.
   *
   * Fresh cache: return immediately.
   * Stale cache: return the last good values immediately and start exactly one
   * background Gmail refresh.
   * Cold cache: wait only for the bounded refresh; each mailbox falls back to
   * null metadata after the configured deadline instead of blocking for 30s.
   */
  async getMailboxSummaries(
    userId: string,
  ): Promise<MailboxSummary[]> {
    const cached =
      this.mailboxSummaryCache.get(userId);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value;
      }

      /**
       * Badge-count correctness:
       *
       * invalidateReadCaches() expires this summary whenever Gmail history or
       * a mailbox mutation changes state. Previously the first request after
       * that invalidation returned the old count immediately and only refreshed
       * Gmail in the background. If no second summary request happened, the
       * sidebar could keep showing that old unread count.
       *
       * Await the SAME existing bounded/coalesced refresh instead. This does
       * not add another Gmail refresh; it only makes this caller receive the
       * refreshed Gmail label counts when Gmail responds within the existing
       * deadlines.
       */
      try {
        return await this.refreshMailboxSummaries(
          userId,
        );
      } catch (error: any) {
        console.error(
          `[Gmail] mailbox summary refresh for ${userId} failed:`,
          error?.message,
        );

        return cached.value;
      }
    }

    return this.refreshMailboxSummaries(userId);
  }

  // ── Listing / reading messages ───────────────────────────────────────────

  async listMessages(
    userId: string,
    opts: {
      labelIds?: string[];
      q?: string;
      pageToken?: string;
      maxResults?: number;
    } = {},
  ): Promise<MessageListResult> {
    const labelIds = [
      ...(opts.labelIds || []),
    ].sort();
    const maxResults = Math.min(
      opts.maxResults || 25,
      50,
    );
    const revision =
      this.currentReadRevision(userId);

    const key = [
      userId,
      revision,
      labelIds.join(','),
      opts.q || '',
      opts.pageToken || '',
      maxResults,
    ].join('|');

    // Keep an expired entry available as a same-revision fallback. Mutation /
    // history invalidation deletes old revision entries, so a stale result can
    // never resurrect pre-mutation Inbox/Trash state.
    const cachedEntry =
      this.messageListCache.get(key);
    if (
      cachedEntry &&
      cachedEntry.expiresAt > Date.now()
    ) {
      return cachedEntry.value;
    }

    const existing =
      this.messageListInFlight.get(key);
    if (existing) return existing;

    const rawRequest = (async (): Promise<MessageListResult> => {
      const deadlineAt =
        Date.now() + MAIL_LIST_DEADLINE_MS;

      let gmail: gmail_v1.Gmail;
      try {
        ({ gmail } =
          await this.getClientForUser(userId));
      } catch (error) {
        if (cachedEntry) return cachedEntry.value;
        throw error;
      }

      let list: gmail_v1.Schema$ListMessagesResponse;
      try {
        const response =
          await gmail.users.messages.list(
            {
              userId: 'me',
              labelIds:
                labelIds.length
                  ? labelIds
                  : undefined,
              q: opts.q,
              pageToken: opts.pageToken,
              maxResults,
            },
            {
              timeout: Math.min(
                MAIL_READ_GMAIL_TIMEOUT_MS,
                MAIL_LIST_DEADLINE_MS,
              ),
            },
          );

        list = response.data;
      } catch (error) {
        if (cachedEntry) return cachedEntry.value;
        throw error;
      }

      const ids = (list.messages || [])
        .map((message) => message.id!)
        .filter(Boolean);

      const parsed = await this.mapWithConcurrencyUntil(
        ids,
        MAIL_METADATA_CONCURRENCY,
        deadlineAt,
        async (
          id,
          _index,
          remainingMs,
        ) => {
          const response =
            await gmail.users.messages.get(
              {
                userId: 'me',
                id,
                format: 'metadata',
                metadataHeaders: [
                  'From',
                  'To',
                  'Cc',
                  'Subject',
                  'Date',
                  'Message-ID',
                ],
              },
              {
                timeout: Math.min(
                  MAIL_READ_GMAIL_TIMEOUT_MS,
                  remainingMs,
                ),
              },
            );

          return this.parseMessage(
            response.data,
            {
              metadataOnly: true,
            },
          );
        },
      );

      const messages = parsed.filter(
        (
          message,
        ): message is ParsedMessage =>
          message !== undefined,
      );

      const complete =
        messages.length === ids.length;

      // If Gmail became slow during metadata fan-out and this exact
      // same-revision request has a prior good value, prefer the complete
      // snapshot over a truncated mailbox.
      if (!complete && cachedEntry) {
        return cachedEntry.value;
      }

      const result: MessageListResult = {
        messages,
        nextPageToken:
          list.nextPageToken || undefined,
        resultSizeEstimate:
          list.resultSizeEstimate || undefined,
      };

      // Never promote a partial timeout result into the canonical cache.
      if (
        complete &&
        this.currentReadRevision(userId) ===
          revision
      ) {
        this.messageListCache.set(key, {
          value: result,
          expiresAt:
            Date.now() + MAIL_LIST_CACHE_TTL_MS,
        });
      }

      if (!complete) {
        console.warn(
          `[Gmail] bounded mailbox read returned ${messages.length}/${ids.length} metadata rows for ${userId} (${labelIds.join(',') || 'ALL'})`,
        );
      }

      return result;
    })();

    const request = this.withHardTimeout(
      rawRequest,
      MAIL_LIST_DEADLINE_MS,
      'Gmail is temporarily taking too long to load this mailbox. Please retry.',
    ).catch((error) => {
      // A complete same-revision snapshot is always safer than surfacing a
      // provider delay. Old revisions are deleted on mutations/history sync.
      if (cachedEntry) return cachedEntry.value;
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to load this mailbox. Please retry.',
      );
    });

    // Do not drop the coalescing entry merely because the user-facing hard
    // deadline fired. The underlying provider call may still be settling.
    // Keeping the already-settled bounded promise here prevents immediate
    // retries from spawning another 30–60 second Gmail request in parallel.
    rawRequest.then(
      () => {
        if (
          this.messageListInFlight.get(key) === request
        ) {
          this.messageListInFlight.delete(key);
        }
      },
      () => {
        if (
          this.messageListInFlight.get(key) === request
        ) {
          this.messageListInFlight.delete(key);
        }
      },
    );

    this.messageListInFlight.set(key, request);
    return request;
  }

  async getMessage(userId: string, messageId: string): Promise<ParsedMessage> {
    const { gmail } = await this.getClientForUser(userId);
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    return this.parseMessage(res.data);
  }

  /**
   * Stage 2 lightweight metadata fetch used by the local mailbox index.
   * Full bodies remain Gmail-only and are still loaded through getMessage /
   * getThread when the user opens a message.
   */
  async getMessageMetadata(
    userId: string,
    messageId: string,
  ): Promise<ParsedMessage> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      const res = await gmail.users.messages.get(
        {
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: [
            'From',
            'To',
            'Cc',
            'Bcc',
            'Subject',
            'Date',
            'Message-ID',
            'References',
          ],
        },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      return this.parseMessage(res.data, { metadataOnly: true });
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to reconcile this message. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to reconcile this message. Please retry.',
      );
    }
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
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      const res = await gmail.users.messages.modify(
        {
          userId: 'me',
          id: messageId,
          requestBody: { addLabelIds, removeLabelIds },
        },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      this.invalidateReadCaches(userId);
      return res.data;
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to update this message. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to update this message. Please retry.',
      );
    }
  }

  async trashMessage(userId: string, messageId: string) {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      await gmail.users.messages.trash(
        { userId: 'me', id: messageId },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      this.invalidateReadCaches(userId);
    })();

    try {
      await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to move this message to Trash. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to move this message to Trash. Please retry.',
      );
    }
  }

  async untrashMessage(userId: string, messageId: string) {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      await gmail.users.messages.untrash(
        { userId: 'me', id: messageId },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      this.invalidateReadCaches(userId);
    })();

    try {
      await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to restore this message. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to restore this message. Please retry.',
      );
    }
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
    const parsed = this.parseMessage(
      sent.data,
      { metadataOnly: true },
    );
    this.invalidateReadCaches(userId);
    return parsed;
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  async listDrafts(
    userId: string,
    pageToken?: string,
  ): Promise<DraftListResult> {
    const revision =
      this.currentReadRevision(userId);
    const key = [
      userId,
      revision,
      pageToken || '',
    ].join('|');

    const cachedEntry =
      this.draftListCache.get(key);
    if (
      cachedEntry &&
      cachedEntry.expiresAt > Date.now()
    ) {
      return cachedEntry.value;
    }

    const existing =
      this.draftListInFlight.get(key);
    if (existing) return existing;

    const rawRequest = (async (): Promise<DraftListResult> => {
      const deadlineAt =
        Date.now() + MAIL_LIST_DEADLINE_MS;

      let gmail: gmail_v1.Gmail;
      try {
        ({ gmail } =
          await this.getClientForUser(userId));
      } catch (error) {
        if (cachedEntry) return cachedEntry.value;
        throw error;
      }

      let list: gmail_v1.Schema$ListDraftsResponse;
      try {
        const response =
          await gmail.users.drafts.list(
            {
              userId: 'me',
              maxResults: 25,
              pageToken,
            },
            {
              timeout: Math.min(
                MAIL_READ_GMAIL_TIMEOUT_MS,
                MAIL_LIST_DEADLINE_MS,
              ),
            },
          );

        list = response.data;
      } catch (error) {
        if (cachedEntry) return cachedEntry.value;
        throw error;
      }

      const draftRefs = (
        list.drafts || []
      ).filter(
        (
          draft,
        ): draft is gmail_v1.Schema$Draft & {
          id: string;
        } => Boolean(draft.id),
      );

      const parsed =
        await this.mapWithConcurrencyUntil(
          draftRefs,
          MAIL_DRAFT_METADATA_CONCURRENCY,
          deadlineAt,
          async (
            draft,
            _index,
            remainingMs,
          ) => {
            const response =
              await gmail.users.drafts.get(
                {
                  userId: 'me',
                  id: draft.id,
                  format: 'metadata',
                },
                {
                  timeout: Math.min(
                    MAIL_READ_GMAIL_TIMEOUT_MS,
                    remainingMs,
                  ),
                },
              );

            const message =
              response.data.message
                ? this.parseMessage(
                    response.data.message,
                    {
                      metadataOnly: true,
                    },
                  )
                : null;

            return message
              ? {
                  draftId: draft.id,
                  message,
                }
              : undefined;
          },
        );

      const drafts = parsed.filter(
        (
          draft,
        ): draft is {
          draftId: string;
          message: ParsedMessage;
        } => draft !== undefined,
      );

      const complete =
        drafts.length === draftRefs.length;

      if (!complete && cachedEntry) {
        return cachedEntry.value;
      }

      const result: DraftListResult = {
        drafts,
        nextPageToken:
          list.nextPageToken || undefined,
      };

      if (
        complete &&
        this.currentReadRevision(userId) ===
          revision
      ) {
        this.draftListCache.set(key, {
          value: result,
          expiresAt:
            Date.now() + MAIL_LIST_CACHE_TTL_MS,
        });
      }

      if (!complete) {
        console.warn(
          `[Gmail] bounded draft read returned ${drafts.length}/${draftRefs.length} drafts for ${userId}`,
        );
      }

      return result;
    })();

    const request = this.withHardTimeout(
      rawRequest,
      MAIL_LIST_DEADLINE_MS,
      'Gmail is temporarily taking too long to load Drafts. Please retry.',
    ).catch((error) => {
      if (cachedEntry) return cachedEntry.value;
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to load Drafts. Please retry.',
      );
    });

    rawRequest.then(
      () => {
        if (
          this.draftListInFlight.get(key) === request
        ) {
          this.draftListInFlight.delete(key);
        }
      },
      () => {
        if (
          this.draftListInFlight.get(key) === request
        ) {
          this.draftListInFlight.delete(key);
        }
      },
    );

    this.draftListInFlight.set(key, request);
    return request;
  }

  /**
   * Fetch one complete draft only when the user opens it for editing.
   * The draft list remains metadata-only so the mailbox stays lightweight.
   * Stage 1.4.1 adds a short full-detail cache + true wall-clock deadline so
   * Edit cannot sit behind the shared frontend 30-second Axios timeout.
   */
  async getDraft(
    userId: string,
    draftId: string,
  ): Promise<{ draftId: string; message: ParsedMessage }> {
    const revision = this.currentReadRevision(userId);
    const key = `${userId}|${revision}|${draftId}`;
    const cachedEntry = this.draftDetailCache.get(key);

    if (
      cachedEntry &&
      cachedEntry.expiresAt > Date.now()
    ) {
      return cachedEntry.value;
    }

    const existing = this.draftDetailInFlight.get(key);
    if (existing) return existing;

    const rawRequest = (async () => {
      const { gmail } = await this.getClientForUser(userId);

      try {
        const res = await gmail.users.drafts.get(
          {
            userId: 'me',
            id: draftId,
            format: 'full',
          },
          { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
        );

        if (!res.data.message) {
          throw new ApiError(404, 'Draft not found');
        }

        const result = {
          draftId: res.data.id || draftId,
          message: this.parseMessage(res.data.message),
        };

        if (
          this.currentReadRevision(userId) === revision
        ) {
          this.draftDetailCache.set(key, {
            value: result,
            expiresAt:
              Date.now() + MAIL_DRAFT_DETAIL_CACHE_TTL_MS,
          });
        }

        return result;
      } catch (err: any) {
        const status =
          err?.response?.status ?? err?.code ?? err?.status;
        if (status === 404) {
          throw new ApiError(404, 'Draft not found');
        }
        throw err;
      }
    })();

    const request = this.withHardTimeout(
      rawRequest,
      MAIL_OPERATION_DEADLINE_MS,
      'Gmail is temporarily taking too long to open this draft. Please retry.',
    ).catch((error) => {
      if (cachedEntry) return cachedEntry.value;
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to open this draft. Please retry.',
      );
    });

    rawRequest.then(
      () => {
        if (this.draftDetailInFlight.get(key) === request) {
          this.draftDetailInFlight.delete(key);
        }
      },
      () => {
        if (this.draftDetailInFlight.get(key) === request) {
          this.draftDetailInFlight.delete(key);
        }
      },
    );

    this.draftDetailInFlight.set(key, request);
    return request;
  }

  /** Lightweight Draft metadata fetch for the Stage 2 local index. */
  async getDraftMetadata(
    userId: string,
    draftId: string,
  ): Promise<{ draftId: string; message: ParsedMessage }> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);

      try {
        const res = await gmail.users.drafts.get(
          {
            userId: 'me',
            id: draftId,
            format: 'metadata',
          },
          { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
        );

        if (!res.data.message) {
          throw new ApiError(404, 'Draft not found');
        }

        return {
          draftId: res.data.id || draftId,
          message: this.parseMessage(res.data.message, { metadataOnly: true }),
        };
      } catch (err: any) {
        const status = err?.response?.status ?? err?.code ?? err?.status;
        if (status === 404) throw new ApiError(404, 'Draft not found');
        throw err;
      }
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to reconcile this draft. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to reconcile this draft. Please retry.',
      );
    }
  }

  async createDraft(userId: string, input: SendEmailInput): Promise<string> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      const res = await gmail.users.drafts.create(
        {
          userId: 'me',
          requestBody: {
            message: {
              raw: this.buildRawEmail(input),
              threadId: input.threadId,
            },
          },
        },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      this.invalidateReadCaches(userId);
      return res.data.id!;
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to save this draft. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to save this draft. Please retry.',
      );
    }
  }

  async updateDraft(userId: string, draftId: string, input: SendEmailInput): Promise<string> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      const res = await gmail.users.drafts.update(
        {
          userId: 'me',
          id: draftId,
          requestBody: {
            message: {
              raw: this.buildRawEmail(input),
              threadId: input.threadId,
            },
          },
        },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      this.invalidateReadCaches(userId);
      return res.data.id!;
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to update this draft. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to update this draft. Please retry.',
      );
    }
  }

  async deleteDraft(userId: string, draftId: string): Promise<void> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);

      try {
        await gmail.users.drafts.delete(
          { userId: 'me', id: draftId },
          { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
        );
        this.invalidateReadCaches(userId);
      } catch (err: any) {
        const status =
          err?.response?.status ?? err?.code ?? err?.status;

        // Deleting a draft is idempotent from Suprah One Desk's perspective.
        // If Gmail says it is already gone, the desired final state has already
        // been reached. Do not convert this known condition into a misleading 500.
        if (status === 404) {
          this.invalidateReadCaches(userId);
          return;
        }

        throw err;
      }
    })();

    try {
      await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to delete this draft. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to delete this draft. Please retry.',
      );
    }
  }

  async sendDraft(userId: string, draftId: string): Promise<ParsedMessage> {
    const operation = (async () => {
      const { gmail } = await this.getClientForUser(userId);
      const res = await gmail.users.drafts.send(
        { userId: 'me', requestBody: { id: draftId } },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      const sent = await gmail.users.messages.get(
        {
          userId: 'me',
          id: res.data.id!,
          format: 'metadata',
          metadataHeaders: [
            'From',
            'To',
            'Subject',
            'Date',
            'Message-ID',
          ],
        },
        { timeout: MAIL_OPERATION_GMAIL_TIMEOUT_MS },
      );
      const parsed = this.parseMessage(
        sent.data,
        { metadataOnly: true },
      );
      this.invalidateReadCaches(userId);
      return parsed;
    })();

    try {
      return await this.withHardTimeout(
        operation,
        MAIL_OPERATION_DEADLINE_MS,
        'Gmail is temporarily taking too long to send this draft. Please retry.',
      );
    } catch (error) {
      this.normalizeGmailReadError(
        error,
        'Gmail is temporarily taking too long to send this draft. Please retry.',
      );
    }
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
      this.invalidateReadCaches(userId);
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

      if (
        result.addedMessageIds.length > 0 ||
        result.labelChangedMessageIds.length > 0 ||
        result.deletedMessageIds.length > 0
      ) {
        this.invalidateReadCaches(userId);
      }

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
        this.invalidateReadCaches(userId);
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