import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import GmailMailboxItem from '../models/GmailMailboxItem.model';
import GmailMailboxIndexState, {
  IndexedMailboxId,
} from '../models/GmailMailboxIndexState.model';
import gmailService, { ParsedMessage } from './gmail.service';
import mailActivityService from './mailActivity.service';

const INDEX_VERSION = 1;
const PAGE_SIZE = 25;
const BOOTSTRAP_PAGES_PER_MAILBOX = Math.min(
  4,
  Math.max(
    1,
    Number(process.env.MAIL_INDEX_BOOTSTRAP_PAGES_PER_MAILBOX || 1),
  ),
);
const BOOTSTRAP_CONCURRENCY = Math.min(
  3,
  Math.max(1, Number(process.env.MAIL_INDEX_BOOTSTRAP_CONCURRENCY || 1)),
);
const RECONCILE_CONCURRENCY = Math.min(
  8,
  Math.max(1, Number(process.env.MAIL_INDEX_RECONCILE_CONCURRENCY || 4)),
);

type MessageMailboxId = Exclude<IndexedMailboxId, 'DRAFTS'>;

const MESSAGE_MAILBOXES: MessageMailboxId[] = [
  'INBOX',
  'STARRED',
  'SENT',
  'TRASH',
];
const ALL_MAILBOXES: IndexedMailboxId[] = [
  ...MESSAGE_MAILBOXES,
  'DRAFTS',
];

type LocalMessageListResult = {
  messages: ParsedMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type LocalDraftListResult = {
  drafts: Array<{ draftId: string; message: ParsedMessage }>;
  nextPageToken?: string;
};

type LocalCursor = {
  internalDate: number;
  id: string;
};

class GmailMailboxIndexService {
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private readonly bootstrapInFlight = new Map<string, Promise<void>>();
  private readonly hydrateInFlight = new Map<string, Promise<void>>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      // These are new Stage 2 collections. Creating their indexes explicitly
      // makes the rollout deterministic even when production has autoIndex off.
      await Promise.all([
        GmailMailboxItem.createIndexes(),
        GmailMailboxIndexState.createIndexes(),
      ]);
      this.initialized = true;
      console.log('[MailIndex] MongoDB indexes ready');
    })().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
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
        { length: Math.min(concurrency, Math.max(1, items.length)) },
        () => runWorker(),
      ),
    );
  }

  private defaultCoverage() {
    return {
      ready: false,
      fullyIndexed: false,
      nextGmailPageToken: undefined as string | undefined,
      lastIndexedAt: undefined as Date | undefined,
    };
  }

  private async ensureState(userId: string) {
    await GmailMailboxIndexState.updateOne(
      { ownerCrmUserId: userId },
      {
        $setOnInsert: {
          ownerCrmUserId: userId,
          version: INDEX_VERSION,
          status: 'pending',
          mailboxes: {
            INBOX: this.defaultCoverage(),
            STARRED: this.defaultCoverage(),
            SENT: this.defaultCoverage(),
            DRAFTS: this.defaultCoverage(),
            TRASH: this.defaultCoverage(),
          },
        },
      },
      { upsert: true },
    );
  }

  private async setMailboxCoverage(
    userId: string,
    mailbox: IndexedMailboxId,
    values: {
      ready: boolean;
      fullyIndexed: boolean;
      nextGmailPageToken?: string;
    },
  ) {
    const prefix = `mailboxes.${mailbox}`;
    const set: Record<string, unknown> = {
      [`${prefix}.ready`]: values.ready,
      [`${prefix}.fullyIndexed`]: values.fullyIndexed,
      [`${prefix}.lastIndexedAt`]: new Date(),
      lastSyncAt: new Date(),
    };
    const unset: Record<string, 1> = {};

    if (values.nextGmailPageToken) {
      set[`${prefix}.nextGmailPageToken`] = values.nextGmailPageToken;
    } else {
      unset[`${prefix}.nextGmailPageToken`] = 1;
    }

    await GmailMailboxIndexState.updateOne(
      { ownerCrmUserId: userId },
      Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set },
    );
  }

  private async markStateStatus(
    userId: string,
    status: 'pending' | 'running' | 'ready' | 'error',
    error?: string,
  ) {
    const update: Record<string, unknown> = {
      status,
      version: INDEX_VERSION,
    };

    if (status === 'ready') {
      update.lastBootstrapAt = new Date();
      update.lastError = null;
    } else if (error) {
      update.lastError = error;
    }

    await GmailMailboxIndexState.updateOne(
      { ownerCrmUserId: userId },
      { $set: update },
      { upsert: true },
    );
  }

  private async isAllMailboxesReady(userId: string): Promise<boolean> {
    const state = await GmailMailboxIndexState.findOne({ ownerCrmUserId: userId })
      .lean();
    if (!state || state.version !== INDEX_VERSION) return false;

    const mailboxes: any = state.mailboxes || {};
    return ALL_MAILBOXES.every((mailbox) => Boolean(mailboxes?.[mailbox]?.ready));
  }

  async isMailboxReady(
    userId: string,
    mailbox: IndexedMailboxId,
  ): Promise<boolean> {
    const state = await GmailMailboxIndexState.findOne({ ownerCrmUserId: userId })
      .select(`version mailboxes.${mailbox}`)
      .lean();
    if (!state || state.version !== INDEX_VERSION) return false;
    return Boolean((state.mailboxes as any)?.[mailbox]?.ready);
  }

  async bootstrapConnectedUsers(): Promise<void> {
    await this.initialize();

    const users = await CrmUser.find({
      'googleMail.connected': true,
      isActive: true,
    })
      .select('_id')
      .lean();

    await this.runWithConcurrency(
      users.map((user) => String(user._id)),
      BOOTSTRAP_CONCURRENCY,
      async (userId) => {
        try {
          await this.bootstrapUser(userId);
        } catch (error: any) {
          console.error(
            `[MailIndex] bootstrap for ${userId} failed:`,
            error?.message,
          );
        }
      },
    );
  }

  async bootstrapUser(
    userId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    await this.initialize();

    const existing = this.bootstrapInFlight.get(userId);
    if (existing) return existing;

    const request = (async () => {
      await this.ensureState(userId);

      if (!options.force && (await this.isAllMailboxesReady(userId))) {
        return;
      }

      if (options.force) {
        await GmailMailboxItem.deleteMany({ ownerCrmUserId: userId });
        await GmailMailboxIndexState.updateOne(
          { ownerCrmUserId: userId },
          {
            $set: {
              version: INDEX_VERSION,
              status: 'pending',
              mailboxes: {
                INBOX: this.defaultCoverage(),
                STARRED: this.defaultCoverage(),
                SENT: this.defaultCoverage(),
                DRAFTS: this.defaultCoverage(),
                TRASH: this.defaultCoverage(),
              },
            },
          },
        );
      }

      await this.markStateStatus(userId, 'running');

      try {
        // Intentionally sequential across mailboxes. Bootstrap is background
        // work and should never recreate the Stage 1 Gmail request storm.
        for (const mailbox of MESSAGE_MAILBOXES) {
          if (!options.force && (await this.isMailboxReady(userId, mailbox))) {
            continue;
          }
          await this.bootstrapMessageMailbox(userId, mailbox);
        }

        if (options.force || !(await this.isMailboxReady(userId, 'DRAFTS'))) {
          await this.bootstrapDraftMailbox(userId);
        }

        const allReady = await this.isAllMailboxesReady(userId);
        await this.markStateStatus(
          userId,
          allReady ? 'ready' : 'error',
          allReady ? undefined : 'One or more mailboxes could not be indexed',
        );

        if (allReady) {
          console.log(`[MailIndex] ${userId} Stage 2 mailbox index ready`);
        }
      } catch (error: any) {
        await this.markStateStatus(
          userId,
          'error',
          error?.message || 'Mailbox index bootstrap failed',
        );
        throw error;
      }
    })().finally(() => {
      if (this.bootstrapInFlight.get(userId) === request) {
        this.bootstrapInFlight.delete(userId);
      }
    });

    this.bootstrapInFlight.set(userId, request);
    return request;
  }

  private async bootstrapMessageMailbox(
    userId: string,
    mailbox: MessageMailboxId,
  ): Promise<void> {
    let pageToken: string | undefined;
    let page = 0;
    let firstPageSucceeded = false;

    while (page < BOOTSTRAP_PAGES_PER_MAILBOX) {
      const result = await gmailService.listMessages(userId, {
        labelIds: [mailbox],
        pageToken,
        maxResults: PAGE_SIZE,
      });

      // Stage 1 may intentionally return a bounded partial mailbox when Gmail
      // metadata is unhealthy. Never promote that degraded response into the
      // canonical Stage 2 index: leave this mailbox not-ready so HTTP reads
      // continue using the proven Gmail fallback until a complete page succeeds.
      if (result.nextPageToken && result.messages.length < PAGE_SIZE) {
        throw new Error(`Incomplete ${mailbox} metadata page during index bootstrap`);
      }

      await this.upsertParsedMessages(userId, result.messages);
      firstPageSucceeded = true;
      page += 1;
      pageToken = result.nextPageToken;

      if (!pageToken) break;
    }

    if (!firstPageSucceeded) {
      throw new Error(`Could not index ${mailbox}`);
    }

    await this.setMailboxCoverage(userId, mailbox, {
      ready: true,
      fullyIndexed: !pageToken,
      nextGmailPageToken: pageToken,
    });

    console.log(
      `[MailIndex] ${userId} ${mailbox} ready (${page * PAGE_SIZE} row window${pageToken ? ', more available' : ''})`,
    );
  }

  private async bootstrapDraftMailbox(userId: string): Promise<void> {
    let pageToken: string | undefined;
    let page = 0;
    let firstPageSucceeded = false;

    while (page < BOOTSTRAP_PAGES_PER_MAILBOX) {
      const result = await gmailService.listDrafts(userId, pageToken);
      if (result.nextPageToken && result.drafts.length < PAGE_SIZE) {
        throw new Error('Incomplete DRAFTS metadata page during index bootstrap');
      }
      await this.upsertDrafts(userId, result.drafts);
      firstPageSucceeded = true;
      page += 1;
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }

    if (!firstPageSucceeded) {
      throw new Error('Could not index DRAFTS');
    }

    await this.setMailboxCoverage(userId, 'DRAFTS', {
      ready: true,
      fullyIndexed: !pageToken,
      nextGmailPageToken: pageToken,
    });

    console.log(
      `[MailIndex] ${userId} DRAFTS ready (${page * PAGE_SIZE} row window${pageToken ? ', more available' : ''})`,
    );
  }

  private itemUpdateFromParsed(
    userId: string,
    message: ParsedMessage,
    kind: 'message' | 'draft',
    draftId?: string,
  ) {
    const set: Record<string, unknown> = {
      ownerCrmUserId: userId,
      kind,
      gmailMessageId: message.id,
      gmailThreadId: message.threadId || '',
      labelIds: message.labelIds || [],
      snippet: message.snippet || '',
      internalDate: Number(message.internalDate || Date.now()),
      subject: message.subject || '(no subject)',
      fromName: message.from?.name || '',
      fromEmail: message.from?.email || '',
      to: message.to || '',
      cc: message.cc || undefined,
      date: message.date || '',
      rfc822MessageId: message.rfc822MessageId || undefined,
      references: message.references || undefined,
      isUnread: Boolean(message.isUnread),
      isStarred: Boolean(message.isStarred),
      syncedAt: new Date(),
    };

    if (draftId) set.draftId = draftId;
    return set;
  }

  async upsertParsedMessage(userId: string, message: ParsedMessage): Promise<void> {
    if (!message?.id) return;

    const existing = await GmailMailboxItem.findOne({
      ownerCrmUserId: userId,
      gmailMessageId: message.id,
    })
      .select('kind draftId')
      .lean();

    const remainsDraft =
      message.labelIds.includes('DRAFT') &&
      existing?.kind === 'draft' &&
      Boolean(existing.draftId);

    const set = this.itemUpdateFromParsed(
      userId,
      message,
      remainsDraft ? 'draft' : 'message',
      remainsDraft ? existing?.draftId : undefined,
    );

    const update: Record<string, unknown> = { $set: set };
    if (!remainsDraft) {
      update.$unset = { draftId: 1 };
    }

    await GmailMailboxItem.updateOne(
      { ownerCrmUserId: userId, gmailMessageId: message.id },
      update,
      { upsert: true },
    );
  }

  async upsertParsedMessages(
    userId: string,
    messages: ParsedMessage[],
  ): Promise<void> {
    if (!messages.length) return;

    const operations = messages
      .filter((message) => Boolean(message?.id))
      .map((message) => ({
        updateOne: {
          filter: {
            ownerCrmUserId: new mongoose.Types.ObjectId(userId),
            gmailMessageId: message.id,
          },
          update: {
            $set: this.itemUpdateFromParsed(userId, message, 'message'),
            $unset: { draftId: 1 },
          },
          upsert: true,
        },
      }));

    if (operations.length) {
      await GmailMailboxItem.bulkWrite(operations, { ordered: false });
    }
  }

  async upsertDraft(
    userId: string,
    draft: { draftId: string; message: ParsedMessage },
  ): Promise<void> {
    if (!draft?.draftId || !draft.message?.id) return;

    await GmailMailboxItem.updateOne(
      { ownerCrmUserId: userId, gmailMessageId: draft.message.id },
      {
        $set: this.itemUpdateFromParsed(
          userId,
          draft.message,
          'draft',
          draft.draftId,
        ),
      },
      { upsert: true },
    );
  }

  async upsertDrafts(
    userId: string,
    drafts: Array<{ draftId: string; message: ParsedMessage }>,
  ): Promise<void> {
    if (!drafts.length) return;

    const operations = drafts
      .filter((draft) => Boolean(draft?.draftId && draft.message?.id))
      .map((draft) => ({
        updateOne: {
          filter: {
            ownerCrmUserId: new mongoose.Types.ObjectId(userId),
            gmailMessageId: draft.message.id,
          },
          update: {
            $set: this.itemUpdateFromParsed(
              userId,
              draft.message,
              'draft',
              draft.draftId,
            ),
          },
          upsert: true,
        },
      }));

    if (operations.length) {
      await GmailMailboxItem.bulkWrite(operations, { ordered: false });
    }
  }

  async refreshDraftById(userId: string, draftId: string): Promise<void> {
    try {
      const draft = await gmailService.getDraftMetadata(userId, draftId);
      await this.upsertDraft(userId, draft);
    } catch (error: any) {
      const status = error?.statusCode ?? error?.status ?? error?.response?.status;
      if (status === 404) {
        await this.removeDraft(userId, draftId);
        return;
      }
      throw error;
    }
  }

  async refreshDraftHead(userId: string): Promise<void> {
    if (!(await this.isMailboxReady(userId, 'DRAFTS'))) return;

    const result = await gmailService.listDrafts(userId);
    await this.upsertDrafts(userId, result.drafts);

    // Remove locally-indexed first-page drafts that Gmail no longer returns.
    // Only the head is reconciled here; deeper pages retain lazy coverage.
    const liveIds = result.drafts.map((draft) => draft.draftId);
    const newestBoundary = result.drafts.length
      ? Math.min(...result.drafts.map((draft) => Number(draft.message.internalDate || 0)))
      : Date.now();

    if (!liveIds.length) {
      // An empty first page means Gmail currently has no drafts at all.
      await GmailMailboxItem.deleteMany({ ownerCrmUserId: userId, kind: 'draft' });
    } else {
      await GmailMailboxItem.deleteMany({
        ownerCrmUserId: userId,
        kind: 'draft',
        internalDate: { $gte: newestBoundary },
        draftId: { $nin: liveIds },
      });
    }
  }

  async removeDraft(userId: string, draftId: string): Promise<void> {
    await GmailMailboxItem.deleteOne({ ownerCrmUserId: userId, draftId });
  }

  async removeMessage(userId: string, gmailMessageId: string): Promise<void> {
    await GmailMailboxItem.deleteOne({ ownerCrmUserId: userId, gmailMessageId });
  }

  async removeMessages(userId: string, gmailMessageIds: string[]): Promise<void> {
    if (!gmailMessageIds.length) return;
    await GmailMailboxItem.deleteMany({
      ownerCrmUserId: userId,
      gmailMessageId: { $in: gmailMessageIds },
    });
  }

  async clearUser(userId: string): Promise<void> {
    // A disconnected Gmail account must also leave the adaptive-sync hot set.
    // The Stage 2 controller already calls clearUser() during disconnect, so no
    // new API/controller change is needed for Stage 2.1.
    mailActivityService.clearUser(userId);

    await Promise.all([
      GmailMailboxItem.deleteMany({ ownerCrmUserId: userId }),
      GmailMailboxIndexState.deleteOne({ ownerCrmUserId: userId }),
    ]);
  }

  async scheduleRebuild(userId: string): Promise<void> {
    // Mark not-ready before the async rebuild begins so HTTP reads safely fall
    // back to the frozen Stage 1 Gmail path while coverage is being recreated.
    await this.ensureState(userId);
    await GmailMailboxIndexState.updateOne(
      { ownerCrmUserId: userId },
      {
        $set: {
          status: 'pending',
          version: INDEX_VERSION,
          mailboxes: {
            INBOX: this.defaultCoverage(),
            STARRED: this.defaultCoverage(),
            SENT: this.defaultCoverage(),
            DRAFTS: this.defaultCoverage(),
            TRASH: this.defaultCoverage(),
          },
        },
      },
    );

    const rebuild = async () => {
      const existing = this.bootstrapInFlight.get(userId);
      if (existing) {
        try {
          await existing;
        } catch {
          // A forced rebuild below is the recovery path.
        }
      }
      await this.bootstrapUser(userId, { force: true });
    };

    void rebuild().catch((error: any) => {
      console.error(`[MailIndex] rebuild for ${userId} failed:`, error?.message);
    });
  }

  async ensureUserIndexed(userId: string): Promise<void> {
    try {
      if (await this.isAllMailboxesReady(userId)) return;
      void this.bootstrapUser(userId).catch((error: any) => {
        console.error(`[MailIndex] ensure index for ${userId} failed:`, error?.message);
      });
    } catch (error: any) {
      console.error(`[MailIndex] readiness check for ${userId} failed:`, error?.message);
    }
  }

  async reconcileMessageIds(userId: string, messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    if (!(await this.isAllMailboxesReady(userId))) {
      await this.ensureUserIndexed(userId);
      return;
    }

    let draftTouched = false;

    await this.runWithConcurrency(
      [...new Set(messageIds)],
      RECONCILE_CONCURRENCY,
      async (messageId) => {
        try {
          const parsed = await gmailService.getMessageMetadata(userId, messageId);
          if (parsed.labelIds.includes('DRAFT')) draftTouched = true;
          await this.upsertParsedMessage(userId, parsed);
        } catch (error: any) {
          const status = error?.statusCode ?? error?.status ?? error?.response?.status;
          if (status === 404) {
            await this.removeMessage(userId, messageId);
            return;
          }
          throw error;
        }
      },
    );

    if (draftTouched) {
      try {
        await this.refreshDraftHead(userId);
      } catch (error: any) {
        console.warn(`[MailIndex] draft-head reconcile for ${userId} failed:`, error?.message);
      }
    }

    await GmailMailboxIndexState.updateOne(
      { ownerCrmUserId: userId },
      { $set: { lastSyncAt: new Date(), lastError: null } },
    );
  }

  async applyMessageAction(
    userId: string,
    gmailMessageId: string,
    action: string,
  ): Promise<void> {
    const item = await GmailMailboxItem.findOne({
      ownerCrmUserId: userId,
      gmailMessageId,
    });
    if (!item) return;

    const labels = new Set(item.labelIds || []);

    switch (action) {
      case 'read':
        labels.delete('UNREAD');
        item.isUnread = false;
        break;
      case 'unread':
        labels.add('UNREAD');
        item.isUnread = true;
        break;
      case 'star':
        labels.add('STARRED');
        item.isStarred = true;
        break;
      case 'unstar':
        labels.delete('STARRED');
        item.isStarred = false;
        break;
      case 'archive':
        labels.delete('INBOX');
        break;
      case 'trash':
        labels.delete('INBOX');
        labels.add('TRASH');
        break;
      case 'untrash':
        labels.delete('TRASH');
        break;
      default:
        return;
    }

    item.labelIds = [...labels];
    item.syncedAt = new Date();
    await item.save({ validateModifiedOnly: true });
  }

  private encodeCursor(item: { internalDate: number; _id: unknown }): string {
    const payload: LocalCursor = {
      internalDate: Number(item.internalDate || 0),
      id: String(item._id),
    };
    return `idx:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  }

  private decodeCursor(pageToken?: string): LocalCursor | null {
    if (!pageToken) return null;
    if (!pageToken.startsWith('idx:')) return null;

    try {
      const decoded = JSON.parse(
        Buffer.from(pageToken.slice(4), 'base64url').toString('utf8'),
      ) as LocalCursor;
      if (
        !Number.isFinite(Number(decoded.internalDate)) ||
        !mongoose.Types.ObjectId.isValid(decoded.id)
      ) {
        return null;
      }
      return {
        internalDate: Number(decoded.internalDate),
        id: decoded.id,
      };
    } catch {
      return null;
    }
  }

  private rowToParsedMessage(row: any): ParsedMessage {
    return {
      id: row.gmailMessageId,
      threadId: row.gmailThreadId || '',
      labelIds: row.labelIds || [],
      snippet: row.snippet || '',
      internalDate: Number(row.internalDate || Date.now()),
      subject: row.subject || '(no subject)',
      from: {
        name: row.fromName || '',
        email: row.fromEmail || '',
      },
      to: row.to || '',
      cc: row.cc || undefined,
      date: row.date || '',
      rfc822MessageId: row.rfc822MessageId || undefined,
      references: row.references || undefined,
      attachments: [],
      isUnread: Boolean(row.isUnread),
      isStarred: Boolean(row.isStarred),
    };
  }

  private async getCoverage(userId: string, mailbox: IndexedMailboxId) {
    const state = await GmailMailboxIndexState.findOne({ ownerCrmUserId: userId })
      .select(`version mailboxes.${mailbox}`)
      .lean();
    if (!state || state.version !== INDEX_VERSION) return null;
    return (state.mailboxes as any)?.[mailbox] || null;
  }

  private async hydrateNextPage(
    userId: string,
    mailbox: IndexedMailboxId,
  ): Promise<void> {
    const key = `${userId}|${mailbox}`;
    const existing = this.hydrateInFlight.get(key);
    if (existing) return existing;

    const request = (async () => {
      const coverage = await this.getCoverage(userId, mailbox);
      if (!coverage?.ready || coverage.fullyIndexed || !coverage.nextGmailPageToken) {
        return;
      }

      if (mailbox === 'DRAFTS') {
        const result = await gmailService.listDrafts(
          userId,
          coverage.nextGmailPageToken,
        );
        await this.upsertDrafts(userId, result.drafts);
        await this.setMailboxCoverage(userId, mailbox, {
          ready: true,
          fullyIndexed: !result.nextPageToken,
          nextGmailPageToken: result.nextPageToken,
        });
        return;
      }

      const result = await gmailService.listMessages(userId, {
        labelIds: [mailbox],
        pageToken: coverage.nextGmailPageToken,
        maxResults: PAGE_SIZE,
      });
      await this.upsertParsedMessages(userId, result.messages);
      await this.setMailboxCoverage(userId, mailbox, {
        ready: true,
        fullyIndexed: !result.nextPageToken,
        nextGmailPageToken: result.nextPageToken,
      });
    })().finally(() => {
      if (this.hydrateInFlight.get(key) === request) {
        this.hydrateInFlight.delete(key);
      }
    });

    this.hydrateInFlight.set(key, request);
    return request;
  }

  async listMessages(
    userId: string,
    options: {
      label: IndexedMailboxId;
      pageToken?: string;
      maxResults?: number;
    },
  ): Promise<LocalMessageListResult | null> {
    // Existing local-index reads are our activity signal. This keeps adaptive
    // polling entirely inside the current Stage 2 architecture: no frontend
    // heartbeat and no new API route.
    mailActivityService.recordMailboxAccess(userId);

    const { label, pageToken } = options;
    if (label === 'DRAFTS') return null;
    if (!(await this.isMailboxReady(userId, label))) return null;

    // A Gmail page token from a pre-deploy browser session is not a local
    // cursor. Let the controller use the Stage 1 Gmail fallback for that call.
    if (pageToken && !pageToken.startsWith('idx:')) return null;

    const limit = Math.min(Math.max(options.maxResults || PAGE_SIZE, 1), 50);
    const cursor = this.decodeCursor(pageToken);
    if (pageToken && !cursor) return null;

    const buildFilter = () => {
      const filter: any = {
        ownerCrmUserId: userId,
        kind: 'message',
        labelIds:
          label === 'TRASH'
            ? 'TRASH'
            : { $all: [label], $nin: ['TRASH', 'SPAM'] },
      };
      if (cursor) {
        filter.$or = [
          { internalDate: { $lt: cursor.internalDate } },
          {
            internalDate: cursor.internalDate,
            _id: { $lt: new mongoose.Types.ObjectId(cursor.id) },
          },
        ];
      }
      return filter;
    };

    let coverage = await this.getCoverage(userId, label);
    let rows = await GmailMailboxItem.find(buildFilter())
      .sort({ internalDate: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    // First-page reads must stay database-fast. Remote hydration is only
    // allowed after the user explicitly asks for a later local page. The first
    // response can still advertise a next cursor when Gmail coverage says
    // more rows exist beyond the indexed head.
    if (
      pageToken &&
      rows.length <= limit &&
      coverage?.ready &&
      !coverage.fullyIndexed &&
      coverage.nextGmailPageToken
    ) {
      await this.hydrateNextPage(userId, label);
      coverage = await this.getCoverage(userId, label);
      rows = await GmailMailboxItem.find(buildFilter())
        .sort({ internalDate: -1, _id: -1 })
        .limit(limit + 1)
        .lean();
    }

    const remoteMore = Boolean(
      coverage?.ready &&
      !coverage.fullyIndexed &&
      coverage.nextGmailPageToken,
    );
    const hasMore = rows.length > limit || remoteMore;
    const visible = rows.slice(0, limit);
    const nextPageToken = hasMore && visible.length
      ? this.encodeCursor(visible[visible.length - 1])
      : undefined;

    return {
      messages: visible.map((row) => this.rowToParsedMessage(row)),
      nextPageToken,
      resultSizeEstimate: await GmailMailboxItem.countDocuments({
        ownerCrmUserId: userId,
        kind: 'message',
        labelIds:
          label === 'TRASH'
            ? 'TRASH'
            : { $all: [label], $nin: ['TRASH', 'SPAM'] },
      }),
    };
  }

  async listDrafts(
    userId: string,
    pageToken?: string,
  ): Promise<LocalDraftListResult | null> {
    mailActivityService.recordMailboxAccess(userId);

    if (!(await this.isMailboxReady(userId, 'DRAFTS'))) return null;
    if (pageToken && !pageToken.startsWith('idx:')) return null;

    const cursor = this.decodeCursor(pageToken);
    if (pageToken && !cursor) return null;

    const buildFilter = () => {
      const filter: any = {
        ownerCrmUserId: userId,
        kind: 'draft',
        draftId: { $exists: true, $ne: null },
      };
      if (cursor) {
        filter.$or = [
          { internalDate: { $lt: cursor.internalDate } },
          {
            internalDate: cursor.internalDate,
            _id: { $lt: new mongoose.Types.ObjectId(cursor.id) },
          },
        ];
      }
      return filter;
    };

    let coverage = await this.getCoverage(userId, 'DRAFTS');
    let rows = await GmailMailboxItem.find(buildFilter())
      .sort({ internalDate: -1, _id: -1 })
      .limit(PAGE_SIZE + 1)
      .lean();

    if (
      pageToken &&
      rows.length <= PAGE_SIZE &&
      coverage?.ready &&
      !coverage.fullyIndexed &&
      coverage.nextGmailPageToken
    ) {
      await this.hydrateNextPage(userId, 'DRAFTS');
      coverage = await this.getCoverage(userId, 'DRAFTS');
      rows = await GmailMailboxItem.find(buildFilter())
        .sort({ internalDate: -1, _id: -1 })
        .limit(PAGE_SIZE + 1)
        .lean();
    }

    const remoteMore = Boolean(
      coverage?.ready &&
      !coverage.fullyIndexed &&
      coverage.nextGmailPageToken,
    );
    const hasMore = rows.length > PAGE_SIZE || remoteMore;
    const visible = rows.slice(0, PAGE_SIZE);

    return {
      drafts: visible.map((row: any) => ({
        draftId: row.draftId,
        message: this.rowToParsedMessage(row),
      })),
      nextPageToken:
        hasMore && visible.length
          ? this.encodeCursor(visible[visible.length - 1])
          : undefined,
    };
  }
}

export const gmailMailboxIndexService = new GmailMailboxIndexService();
export default gmailMailboxIndexService;