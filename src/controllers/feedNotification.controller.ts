import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed from '../models/Feed.model';
import FeedNotification from '../models/FeedNotification.model';
import FeedReadState, { IFeedReadState } from '../models/FeedReadState.model';
import CrmUser from '../models/CrmUser.model';


const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parsePositiveInt(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

function requireActor(req: Request) {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization');
  }
  return actor;
}

/**
 * Lazily create the read-state doc with `lastSeenAt = now` so a user's badge
 * starts at 0 on rollout and only grows from genuinely new posts. The unique
 * (organizationId, userId) index guards the create race.
 */
async function getOrCreateReadState(
  organizationId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
): Promise<IFeedReadState> {
  let state = await FeedReadState.findOne({ organizationId, userId });
  if (state) return state;
  try {
    state = await FeedReadState.create({
      organizationId,
      userId,
      lastSeenAt: new Date(),
      readPostIds: [],
    });
  } catch {
    // Duplicate-key race: another request created it first.
    state = await FeedReadState.findOne({ organizationId, userId });
  }
  if (!state) throw new ApiError(500, 'Failed to initialise feed read state');
  return state;
}

// ─── Unread Count (sidebar badge) ─────────────────────────────────────────────

/**
 * GET /api/crm/feeds/notifications/unread-count
 *
 * Response: { unseenPosts, notifications, total }
 *   unseenPosts   — live org posts newer than the user's watermark,
 *                   excluding their own posts and individually-read ones.
 *   notifications — unread FeedNotification docs (mentions, comments, @all).
 */
export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const state = await getOrCreateReadState(actor.organizationId!, actor._id as mongoose.Types.ObjectId);

  const [unseenPosts, notifications] = await Promise.all([
    Feed.countDocuments({
      organizationId: actor.organizationId,
      deletedAt: null,
      userId: { $ne: actor._id },
      createdAt: { $gt: state.lastSeenAt },
      _id: { $nin: state.readPostIds },
    }),
    FeedNotification.countDocuments({ recipientId: actor._id, readAt: null }),
  ]);

  res.json(
    new ApiResponse(
      200,
      { unseenPosts, notifications, total: unseenPosts + notifications },
      'Unread counts fetched',
    ),
  );
});

// ─── Activity List ────────────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds/notifications?page=1&limit=20&unreadOnly=true
 *
 * Newest-first list of this user's mentions / comment / announcement
 * notifications for the Feeds "Activity" panel.
 */
export const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const page = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { recipientId: actor._id };
  if (req.query.unreadOnly === 'true') filter.readAt = null;

  const [items, total] = await Promise.all([
    FeedNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    FeedNotification.countDocuments(filter),
  ]);

  const hasMore = skip + items.length < total;

  res.json(
    new ApiResponse(200, { notifications: items, total, page, limit, hasMore }, 'Notifications fetched'),
  );
});

// ─── Mark Notifications Read ──────────────────────────────────────────────────

/**
 * PATCH /api/crm/feeds/notifications/read
 * Body: { ids?: string[] }  — omit ids to mark everything read.
 */
export const markNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const { ids } = (req.body || {}) as { ids?: string[] };

  const filter: Record<string, unknown> = { recipientId: actor._id, readAt: null };
  if (Array.isArray(ids) && ids.length > 0) {
    const valid = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (valid.length === 0) throw new ApiError(400, 'No valid notification ids provided');
    filter._id = { $in: valid };
  }

  const result = await FeedNotification.updateMany(filter, { $set: { readAt: new Date() } });

  res.json(new ApiResponse(200, { modified: result.modifiedCount ?? 0 }, 'Notifications marked read'));
});

// ─── Read State ───────────────────────────────────────────────────────────────

/** GET /api/crm/feeds/read-state — current watermark + individually-read ids. */
export const getReadState = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const state = await getOrCreateReadState(actor.organizationId!, actor._id as mongoose.Types.ObjectId);
  res.json(
    new ApiResponse(
      200,
      { lastSeenAt: state.lastSeenAt, readPostIds: state.readPostIds },
      'Read state fetched',
    ),
  );
});

/**
 * POST /api/crm/feeds/read-state
 *
 * Advances the watermark to "now" (called when the user opens the Feeds page)
 * and returns the PREVIOUS watermark so the frontend can still highlight
 * which posts were unread on this visit.
 *
 * Response: { previousLastSeenAt, lastSeenAt }
 */
export const advanceReadState = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const now = new Date();

  // `new: false` → returns the pre-update document (null on first-ever upsert).
  const previous = await FeedReadState.findOneAndUpdate(
    { organizationId: actor.organizationId, userId: actor._id },
    { $set: { lastSeenAt: now, readPostIds: [] } },
    { upsert: true, new: false },
  );

  res.json(
    new ApiResponse(
      200,
      { previousLastSeenAt: previous?.lastSeenAt ?? now, lastSeenAt: now },
      'Read state advanced',
    ),
  );
});

/**
 * POST /api/crm/feeds/read-state/posts
 * Body: { postIds: string[] } — mark specific posts read without moving the
 * watermark (per-post "mark as read").
 */
export const markPostsRead = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const { postIds } = (req.body || {}) as { postIds?: string[] };
  if (!Array.isArray(postIds) || postIds.length === 0) {
    throw new ApiError(400, 'postIds must be a non-empty array');
  }
  const valid = postIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (valid.length === 0) throw new ApiError(400, 'No valid post ids provided');

  await getOrCreateReadState(actor.organizationId!, actor._id as mongoose.Types.ObjectId);
  await FeedReadState.updateOne(
    { organizationId: actor.organizationId, userId: actor._id },
    { $addToSet: { readPostIds: { $each: valid } } },
  );

  res.json(new ApiResponse(200, { marked: valid.length }, 'Posts marked read'));
});

// ─── Mention Candidates ───────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds/mention-candidates
 *
 * Active members of the actor's organisation, used to populate the @ mention
 * autocomplete in the composer and comment inputs. The special "@all" entry
 * is added client-side.
 */
export const getMentionCandidates = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const users = await CrmUser.find({ organizationId: actor.organizationId, isActive: true })
    .select('fullName username email avatar role')
    .sort({ fullName: 1 })
    .lean();

  res.json(new ApiResponse(200, { users }, 'Mention candidates fetched'));
});

export default {
  getUnreadCount,
  listNotifications,
  markNotificationsRead,
  getReadState,
  advanceReadState,
  markPostsRead,
  getMentionCandidates,
};