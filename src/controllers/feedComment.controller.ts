import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed from '../models/Feed.model';
import FeedComment from '../models/FeedComment.model';
import { getIO } from '../socket/feedSocket';

// ─── Add Comment ──────────────────────────────────────────────────────────────

/**
 * POST /api/crm/feeds/:postId/comments
 *
 * Adds a comment to an existing, live feed post.
 * Any authenticated user in the same organisation can comment —
 * there is no owner restriction on reads or writes for comments.
 *
 * After saving, emits `feed:comment_added` to the org room so every
 * user's feed updates the comment count / thread in real time.
 */
export const addComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { postId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Invalid post ID');

  const { content } = req.body;
  if (!content || !content.trim()) throw new ApiError(400, 'Comment cannot be empty');
  if (content.trim().length > 1000) throw new ApiError(400, 'Comment cannot exceed 1000 characters');

  // Confirm the parent post exists and is not soft-deleted
  const post = await Feed.findOne({ _id: postId, deletedAt: null });
  if (!post) throw new ApiError(404, 'Post not found');

  // Enforce org scoping: commenter must belong to the same org as the post
  if (post.organizationId.toString() !== actor.organizationId?.toString()) {
    throw new ApiError(403, 'You cannot comment on posts outside your organisation');
  }

  const comment = await FeedComment.create({
    postId,
    organizationId: post.organizationId,
    userId:         actor._id,
    authorName:     actor.fullName,
    authorAvatar:   actor.avatar || null,
    authorRole:     actor.role,
    content:        content.trim(),
  });

  // Broadcast to the org room so all open tabs show the new comment instantly
  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('feed:comment_added', { postId, comment });
  } catch { /* Socket.IO not running — swallow */ }

  res.status(201).json(new ApiResponse(201, { comment }, 'Comment added'));
});

// ─── Get Comments ─────────────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds/:postId/comments
 *
 * Returns all live (non-deleted) comments for a post, ordered oldest-first
 * so the thread reads naturally top-to-bottom.
 * No pagination here — comment threads are expected to be short.
 * Add ?limit=N if you need to cap results in the future.
 */
export const getComments = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { postId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Invalid post ID');

  // Confirm the post belongs to the user's org before returning comments
  const post = await Feed.findOne({ _id: postId, deletedAt: null });
  if (!post) throw new ApiError(404, 'Post not found');

  if (post.organizationId.toString() !== actor.organizationId?.toString()) {
    throw new ApiError(403, 'Access denied');
  }

  const comments = await FeedComment.find({ postId, deletedAt: null })
    .sort({ createdAt: 1 }) // Oldest first — natural thread order
    .lean();

  res.json(new ApiResponse(200, { comments, total: comments.length }, 'Comments fetched'));
});

// ─── Delete Comment ───────────────────────────────────────────────────────────

/**
 * DELETE /api/crm/feeds/:postId/comments/:commentId
 *
 * Soft-deletes a comment. The document is kept in the DB for audit purposes.
 * Allowed by: comment owner OR organisation admin.
 * Emits `feed:comment_deleted` to the org room for instant UI removal.
 */
export const deleteComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { postId, commentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(commentId)) throw new ApiError(400, 'Invalid comment ID');

  const comment = await FeedComment.findOne({ _id: commentId, postId, deletedAt: null });
  if (!comment) throw new ApiError(404, 'Comment not found');

  const isOwner = comment.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only delete your own comments');

  comment.deletedAt = new Date();
  await comment.save();

  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('feed:comment_deleted', { postId, commentId });
  } catch { /* swallow */ }

  res.json(new ApiResponse(200, { commentId }, 'Comment deleted'));
});

export default { addComment, getComments, deleteComment };