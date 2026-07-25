import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import {
  WhatsNewRelease,
  WhatsNewRead,
  WhatsNewPermission,
  IWhatsNewItem,
} from '../models/WhatsNew.model';
import { storageService } from '../services/storage.service';

const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || '';

const VALID_ITEM_KINDS = ['feature', 'improvement', 'fix', 'announcement'] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── Permission helpers ─────────────────────────────────────────────────────
 * Default: role === 'admin' can post/manage. A WhatsNewPermission doc with
 * revoked=true removes that right for a specific admin (keyed by email so it
 * also covers synthetic main-app admins from crmAuth's Bearer fallback). */

const isRevoked = async (email: string): Promise<boolean> => {
  if (!email) return false;
  const doc = await WhatsNewPermission.findOne({ email }).select('revoked').lean();
  return !!doc?.revoked;
};

const canManage = async (user?: ICrmUser): Promise<boolean> => {
  if (!user || user.role !== 'admin') return false;
  return !(await isRevoked(normalizeEmail(user.email)));
};

const assertCanManage = async (user?: ICrmUser): Promise<ICrmUser> => {
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (user.role !== 'admin') {
    throw new ApiError(403, "Only admins can manage What's New posts");
  }
  if (await isRevoked(normalizeEmail(user.email))) {
    throw new ApiError(
      403,
      "Your What's New posting privileges have been revoked. Contact another administrator.",
    );
  }
  return user;
};

/* ── Payload sanitizers ──────────────────────────────────────────────────── */

const sanitizeItems = (rawItems: unknown): IWhatsNewItem[] => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(400, 'A release must contain at least one update item');
  }
  if (rawItems.length > 25) {
    throw new ApiError(400, 'A release can contain at most 25 update items');
  }

  return rawItems.map((it: any, idx: number) => {
    const title = typeof it?.title === 'string' ? it.title.trim() : '';
    const description = typeof it?.description === 'string' ? it.description.trim() : '';
    if (!title) throw new ApiError(400, `Item ${idx + 1}: title is required`);
    if (!description) throw new ApiError(400, `Item ${idx + 1}: description is required`);

    const media = Array.isArray(it?.media)
      ? it.media
          .filter((m: any) => typeof m?.url === 'string' && m.url.trim())
          .slice(0, 10)
          .map((m: any) => ({
            url: m.url.trim(),
            type: m.type === 'video' ? ('video' as const) : ('image' as const),
          }))
      : [];

    return {
      title,
      description,
      kind: VALID_ITEM_KINDS.includes(it?.kind) ? it.kind : 'feature',
      media,
    };
  });
};

/* ── Feed ──────────────────────────────────────────────────────────────────
 * GET /api/crm/whats-new
 * Global — no organization filter, by design. Returns releases newest-first
 * with a per-user isRead flag, the user's unread count, and whether the
 * caller may manage posts (drives the admin UI on the frontend).
 *
 * Query params: search (title/description/item text), kind (release type —
 * matched against any item's kind), author (release author name/email,
 * partial match), sort (newest|oldest|unread — unread puts the user's unread
 * releases first, newest-first within each group), dateFrom/dateTo
 * (publishedAt range, inclusive). All server-side so pagination stays
 * correct against the filtered set, not just the current page. */

const VALID_SORTS = ['newest', 'oldest', 'unread'] as const;

const getReleases = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');

  const pageNum = Math.max(Number(req.query.page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const skip = (pageNum - 1) * limitNum;

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
  const author = typeof req.query.author === 'string' ? req.query.author.trim() : '';
  const sort = VALID_SORTS.includes(req.query.sort as any) ? (req.query.sort as string) : 'newest';
  const dateFrom = typeof req.query.dateFrom === 'string' ? new Date(req.query.dateFrom) : null;
  const dateTo = typeof req.query.dateTo === 'string' ? new Date(req.query.dateTo) : null;

  const match: Record<string, unknown> = {};
  if (kind && VALID_ITEM_KINDS.includes(kind as any)) {
    match['items.kind'] = kind;
  }
  if (author) {
    const re = new RegExp(escapeRegex(author), 'i');
    match.$or = [{ 'author.fullName': re }, { 'author.email': re }];
  }
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    const searchOr = [
      { title: re },
      { description: re },
      { 'items.title': re },
      { 'items.description': re },
    ];
    // Combine with the author $or (if present) as an AND of two OR-groups.
    if (match.$or) {
      match.$and = [{ $or: match.$or }, { $or: searchOr }];
      delete match.$or;
    } else {
      match.$or = searchOr;
    }
  }
  if ((dateFrom && !Number.isNaN(dateFrom.getTime())) || (dateTo && !Number.isNaN(dateTo.getTime()))) {
    const range: Record<string, Date> = {};
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) range.$gte = dateFrom;
    if (dateTo && !Number.isNaN(dateTo.getTime())) range.$lte = dateTo;
    match.publishedAt = range;
  }

  const [reads, manage] = await Promise.all([
    WhatsNewRead.find({ userId: user._id }).select('releaseId').lean(),
    canManage(user),
  ]);
  const readIds = reads.map((r) => r.releaseId);
  const readIdSet = new Set(readIds.map((id) => id.toString()));

  const sortStage =
    sort === 'oldest'
      ? { publishedAt: 1 as const, _id: 1 as const }
      : sort === 'unread'
        ? { isReadForSort: 1 as const, publishedAt: -1 as const, _id: -1 as const }
        : { publishedAt: -1 as const, _id: -1 as const };

  const pipeline: any[] = [{ $match: match }];
  if (sort === 'unread') {
    pipeline.push({ $addFields: { isReadForSort: { $in: ['$_id', readIds] } } });
  }
  pipeline.push(
    { $sort: sortStage },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limitNum }],
        totalCount: [{ $count: 'count' }],
      },
    },
  );

  const [result] = await WhatsNewRelease.aggregate(pipeline);
  const releases = result?.data ?? [];
  const total = result?.totalCount?.[0]?.count ?? 0;

  const enriched = releases.map((r: any) => ({
    ...r,
    isRead: readIdSet.has(r._id.toString()),
  }));

  // Unread = all releases the user has never opened platform-wide (not scoped
  // to the current filters/page) — this drives the sidebar badge.
  const unreadCount = Math.max((await WhatsNewRelease.countDocuments({})) - readIdSet.size, 0);

  res.json(
    new ApiResponse(
      200,
      {
        releases: enriched,
        unreadCount,
        canManage: manage,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.max(Math.ceil(total / limitNum), 1),
        },
      },
      'Releases fetched',
    ),
  );
});

/* GET /api/crm/whats-new/unread-count — lightweight poll for the sidebar badge. */
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');

  const [total, readCount] = await Promise.all([
    WhatsNewRelease.countDocuments({}),
    WhatsNewRead.countDocuments({ userId: user._id }),
  ]);

  res.json(
    new ApiResponse(200, { unreadCount: Math.max(total - readCount, 0) }, 'Unread count fetched'),
  );
});

/* POST /api/crm/whats-new/:id/read — mark a release as seen (idempotent upsert).
 * The frontend calls this when the walkthrough modal for a release opens. */
const markReleaseRead = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;
  const release = await WhatsNewRelease.findById(id).select('_id').lean();
  if (!release) throw new ApiError(404, 'Release not found');

  await WhatsNewRead.updateOne(
    { userId: user._id, releaseId: release._id },
    { $setOnInsert: { readAt: new Date() } },
    { upsert: true },
  );

  const [total, readCount] = await Promise.all([
    WhatsNewRelease.countDocuments({}),
    WhatsNewRead.countDocuments({ userId: user._id }),
  ]);

  res.json(
    new ApiResponse(200, { unreadCount: Math.max(total - readCount, 0) }, 'Release marked as read'),
  );
});

/* ── Authoring ───────────────────────────────────────────────────────────── */

/* POST /api/crm/whats-new */
const createRelease = asyncHandler(async (req: Request, res: Response) => {
  const actor = await assertCanManage(req.crmUser);

  const { title, description, publishedAt, items } = req.body;

  if (typeof title !== 'string' || !title.trim()) {
    throw new ApiError(400, 'Title is required');
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new ApiError(400, 'Description is required');
  }

  const publishedDate = publishedAt ? new Date(publishedAt) : new Date();
  if (Number.isNaN(publishedDate.getTime())) {
    throw new ApiError(400, 'publishedAt must be a valid date');
  }

  const release = await WhatsNewRelease.create({
    title: title.trim(),
    description: description.trim(),
    publishedAt: publishedDate,
    items: sanitizeItems(items),
    author: {
      userId: actor._id,
      fullName: actor.fullName,
      email: normalizeEmail(actor.email),
      avatar: actor.avatar ?? null,
    },
  });

  res.status(201).json(new ApiResponse(201, release, 'Release published'));
});

/* PATCH /api/crm/whats-new/:id */
const updateRelease = asyncHandler(async (req: Request, res: Response) => {
  await assertCanManage(req.crmUser);

  const { id } = req.params;
  const { title, description, publishedAt, items } = req.body;

  const release = await WhatsNewRelease.findById(id);
  if (!release) throw new ApiError(404, 'Release not found');

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new ApiError(400, 'Title cannot be empty');
    release.title = title.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || !description.trim()) {
      throw new ApiError(400, 'Description cannot be empty');
    }
    release.description = description.trim();
  }
  if (publishedAt !== undefined) {
    const d = new Date(publishedAt);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, 'publishedAt must be a valid date');
    release.publishedAt = d;
  }
  if (items !== undefined) {
    release.items = sanitizeItems(items);
  }

  await release.save();
  res.json(new ApiResponse(200, release, 'Release updated'));
});

/* DELETE /api/crm/whats-new/:id — also best-effort cleans up R2 media and
 * removes read records so counts stay consistent. */
const deleteRelease = asyncHandler(async (req: Request, res: Response) => {
  await assertCanManage(req.crmUser);

  const { id } = req.params;
  const release = await WhatsNewRelease.findByIdAndDelete(id);
  if (!release) throw new ApiError(404, 'Release not found');

  await WhatsNewRead.deleteMany({ releaseId: release._id });

  // Best-effort R2 cleanup — never fail the request over storage hiccups.
  const mediaUrls = release.items.flatMap((it) => it.media.map((m) => m.url));
  for (const url of mediaUrls) {
    try {
      await storageService.delete(url);
    } catch {
      /* best-effort */
    }
  }

  res.json(new ApiResponse(200, null, 'Release deleted'));
});

/* POST /api/crm/whats-new/media — multer memory upload → R2 public bucket.
 * Returns { url, type } for the editor to attach to an item. */
const uploadMedia = asyncHandler(async (req: Request, res: Response) => {
  await assertCanManage(req.crmUser);

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) throw new ApiError(400, 'A media file is required');

  const type = file.mimetype.startsWith('video/') ? 'video' : 'image';
  const url = await storageService.upload(file, 'whats-new');

  res.status(201).json(new ApiResponse(201, { url, type }, 'Media uploaded'));
});

/* ── Permission management ───────────────────────────────────────────────── */

/* GET /api/crm/whats-new/permissions
 * Lists all active CRM admins platform-wide with their posting status.
 * NOTE: this intentionally spans organizations — the feature is global, so
 * managing who may post to it is inherently a platform-level view. */
const getPermissions = asyncHandler(async (req: Request, res: Response) => {
  await assertCanManage(req.crmUser);

  const [admins, revocations] = await Promise.all([
    CrmUser.find({ role: 'admin', isActive: true, isSystem: { $ne: true } })
      .select('fullName email avatar organizationId')
      .sort({ fullName: 1 })
      .lean(),
    WhatsNewPermission.find({ revoked: true }).lean(),
  ]);

  const revokedByEmail = new Map(revocations.map((r) => [r.email, r]));

  // Dedupe by email — the same person may exist in several orgs.
  const seen = new Set<string>();
  const list = admins
    .filter((a) => {
      const email = normalizeEmail(a.email);
      if (!email || seen.has(email)) return false;
      seen.add(email);
      return true;
    })
    .map((a) => {
      const email = normalizeEmail(a.email);
      const revocation = revokedByEmail.get(email);
      return {
        _id: a._id,
        fullName: a.fullName,
        email,
        avatar: a.avatar ?? null,
        canPost: !revocation,
        revokedBy: revocation?.revokedBy ?? null,
        revokedAt: revocation?.revokedAt ?? null,
      };
    });

  res.json(new ApiResponse(200, { admins: list }, 'Permissions fetched'));
});

/* PATCH /api/crm/whats-new/permissions
 * Body: { email: string, canPost: boolean } */
const updatePermission = asyncHandler(async (req: Request, res: Response) => {
  const actor = await assertCanManage(req.crmUser);

  const { email, canPost } = req.body;
  const targetEmail = normalizeEmail(email);

  if (!targetEmail) throw new ApiError(400, 'email is required');
  if (typeof canPost !== 'boolean') throw new ApiError(400, 'canPost must be a boolean');

  // Lockout guard — you cannot revoke your own privileges. Another authorized
  // admin must do it, which also guarantees at least one manager remains.
  if (targetEmail === normalizeEmail(actor.email)) {
    throw new ApiError(400, "You cannot revoke your own What's New privileges");
  }

  if (canPost) {
    await WhatsNewPermission.deleteOne({ email: targetEmail });
  } else {
    await WhatsNewPermission.updateOne(
      { email: targetEmail },
      {
        $set: {
          revoked: true,
          revokedAt: new Date(),
          revokedBy: {
            userId: actor._id,
            fullName: actor.fullName,
            email: normalizeEmail(actor.email),
          },
        },
      },
      { upsert: true },
    );
  }

  res.json(
    new ApiResponse(
      200,
      { email: targetEmail, canPost },
      canPost ? 'Posting privileges restored' : 'Posting privileges revoked',
    ),
  );
});

export default {
  getReleases,
  getUnreadCount,
  markReleaseRead,
  createRelease,
  updateRelease,
  deleteRelease,
  uploadMedia,
  getPermissions,
  updatePermission,
};