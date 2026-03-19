import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed from '../models/Feed.model';
import { getIO } from '../socket/feedSocket';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20; // Posts per page when the client doesn't specify
const MAX_LIMIT     = 50; // Hard ceiling — prevents clients from pulling too much data at once

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Safely parse a query-string value into a positive integer.
 * Falls back to `fallback` if the value is missing, NaN, or less than 1.
 */
function parsePositiveInt(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

// ─── Create Post ──────────────────────────────────────────────────────────────

/**
 * POST /api/crm/feeds
 *
 * Creates a new feed post scoped to the authenticated user's organisation.
 * After saving, emits a `feed:new` Socket.IO event to all members of the
 * same org room so their feeds update in real time.
 */
export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { content } = req.body;

  // Guard: content must be a non-empty string within the length limit
  if (!content || !content.trim()) {
    throw new ApiError(400, 'Post content cannot be empty');
  }
  if (content.trim().length > 5000) {
    throw new ApiError(400, 'Post content cannot exceed 5000 characters');
  }

  // Guard: users without an organisation cannot post (multi-tenancy enforcement)
  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization to post');
  }

  // Persist the post, denormalising author info at creation time
  const post = await Feed.create({
    organizationId: actor.organizationId,
    userId:         actor._id,
    authorName:     actor.fullName,
    authorAvatar:   actor.avatar || null,
    authorRole:     actor.role,
    content:        content.trim(),
    isEdited:       false,
  });

  // Broadcast to every socket in the org room.
  // Wrapped in try/catch so a missing Socket.IO instance never breaks the API.
  try {
    getIO()
      .to(`org:${actor.organizationId.toString()}`)
      .emit('feed:new', { post });
  } catch {
    // Socket.IO not initialised — REST response is still sent below
  }

  res.status(201).json(new ApiResponse(201, { post }, 'Post created successfully'));
});

// ─── Get Posts (paginated) ────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds?page=1&limit=20
 *
 * Returns a paginated list of live (non-deleted) posts belonging to the
 * authenticated user's organisation, sorted newest-first.
 *
 * Response shape:
 *   { posts[], total, page, limit, hasMore }
 */
export const getPosts = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization to view the feed');
  }

  // Parse and clamp pagination params
  const page  = parsePositiveInt(req.query.page,  1);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip  = (page - 1) * limit;

  // Base filter: same org + not soft-deleted
  const filter = {
    organizationId: actor.organizationId,
    deletedAt: null,
  };

  // Run count and data fetch in parallel for efficiency
  const [posts, total] = await Promise.all([
    Feed.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Feed.countDocuments(filter),
  ]);

  // hasMore lets the frontend know whether to show a "Load more" button
  const hasMore = skip + posts.length < total;

  res.json(
    new ApiResponse(200, { posts, total, page, limit, hasMore }, 'Feed fetched successfully')
  );
});

// ─── Update Post ──────────────────────────────────────────────────────────────

/**
 * PUT /api/crm/feeds/:id
 *
 * Allows the post owner to edit the content of an existing post.
 * Sets `isEdited: true` so the UI can display an "(edited)" label.
 * Emits a `feed:updated` event so other clients refresh the post in place.
 *
 * Permission: post owner only.
 */
export const updatePost = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;

  // Validate that the ID is a proper MongoDB ObjectId before querying
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid post ID');

  const { content } = req.body;
  if (!content || !content.trim())         throw new ApiError(400, 'Post content cannot be empty');
  if (content.trim().length > 5000)        throw new ApiError(400, 'Post content cannot exceed 5000 characters');

  // Fetch the post (excluding soft-deleted ones)
  const post = await Feed.findOne({ _id: id, deletedAt: null });
  if (!post) throw new ApiError(404, 'Post not found');

  // Permission check: only the owner (or an admin) may edit
  const isOwner = post.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only edit your own posts');

  // Apply the edit
  post.content  = content.trim();
  post.isEdited = true;
  await post.save();

  // Notify all org members so the edited post updates live in their feeds
  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('feed:updated', { post });
  } catch { /* Socket.IO not running — swallow */ }

  res.json(new ApiResponse(200, { post }, 'Post updated successfully'));
});

// ─── Delete Post ──────────────────────────────────────────────────────────────

/**
 * DELETE /api/crm/feeds/:id
 *
 * Soft-deletes a post by stamping `deletedAt` with the current timestamp.
 * The document is NOT removed from the database — this preserves audit history.
 * Emits a `feed:deleted` event so other clients instantly remove the post from
 * their UI without needing to refetch.
 *
 * Permission: post owner OR organisation admin.
 */
export const deletePost = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid post ID');

  // Only fetch live posts — already-deleted posts return 404
  const post = await Feed.findOne({ _id: id, deletedAt: null });
  if (!post) throw new ApiError(404, 'Post not found');

  // Permission check: owner or admin
  const isOwner = post.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only delete your own posts');

  // Soft delete: stamp the timestamp instead of calling .deleteOne()
  post.deletedAt = new Date();
  await post.save();

  // Tell all org members to remove this post from their local feed list
  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('feed:deleted', { postId: id });
  } catch { /* Socket.IO not running — swallow */ }

  res.json(new ApiResponse(200, { postId: id }, 'Post deleted successfully'));
});

export default { createPost, getPosts, updatePost, deletePost };