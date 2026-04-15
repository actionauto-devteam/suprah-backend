import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed from '../models/Feed.model';
import FeedComment from '../models/FeedComment.model';
import FeedReaction, { REACTION_TYPES, ReactionType } from '../models/FeedReaction.model';
import { getIO } from '../socket/feedSocket';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a reaction summary map from a list of reactions.
 * Shape: { like: { count: 3, users: ['Alice', 'Bob', 'Carol'] }, ... }
 */
function buildSummary(reactions: Array<{ reaction: string; authorName: string }>) {
  const summary: Record<string, { count: number; users: string[] }> = {};
  for (const r of reactions) {
    if (!summary[r.reaction]) summary[r.reaction] = { count: 0, users: [] };
    summary[r.reaction].count++;
    summary[r.reaction].users.push(r.authorName);
  }
  return summary;
}

// ─── Toggle Reaction ──────────────────────────────────────────────────────────

/**
 * POST /api/crm/feeds/reactions
 *
 * Upserts a reaction for the authenticated user on a post or comment.
 * Rules:
 *  - If the user has NO reaction → insert it (add).
 *  - If the user reacts with the SAME type → remove it (toggle off).
 *  - If the user reacts with a DIFFERENT type → replace it (switch).
 *
 * Emits `feed:reactions_updated` with the new summary so all clients
 * can re-render reaction counts in real time without a round-trip.
 */
export const toggleReaction = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const { targetType, targetId, reaction } = req.body;

  // ── Validate inputs ──
  if (!['post', 'comment'].includes(targetType)) {
    throw new ApiError(400, 'targetType must be "post" or "comment"');
  }
  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    throw new ApiError(400, 'Invalid targetId');
  }
  if (!REACTION_TYPES.includes(reaction as ReactionType)) {
    throw new ApiError(400, `reaction must be one of: ${REACTION_TYPES.join(', ')}`);
  }

  // ── Verify the target exists and belongs to the same org ──
  let orgId: mongoose.Types.ObjectId;

  if (targetType === 'post') {
    const post = await Feed.findOne({ _id: targetId, deletedAt: null }).lean();
    if (!post) throw new ApiError(404, 'Post not found');
    if (post.organizationId.toString() !== actor.organizationId.toString()) {
      throw new ApiError(403, 'Access denied');
    }
    orgId = post.organizationId;
  } else {
    const comment = await FeedComment.findOne({ _id: targetId, deletedAt: null }).lean();
    if (!comment) throw new ApiError(404, 'Comment not found');
    if (comment.organizationId.toString() !== actor.organizationId.toString()) {
      throw new ApiError(403, 'Access denied');
    }
    orgId = comment.organizationId;
  }

  // ── Toggle logic ──
  const existing = await FeedReaction.findOne({ targetId, userId: actor._id });

  let action: 'added' | 'removed' | 'switched';

  if (!existing) {
    // No reaction yet → add it
    await FeedReaction.create({
      organizationId: orgId,
      userId:         actor._id,
      authorName:     actor.fullName,
      targetType,
      targetId,
      reaction,
    });
    action = 'added';
  } else if (existing.reaction === reaction) {
    // Same reaction → remove (toggle off)
    await existing.deleteOne();
    action = 'removed';
  } else {
    // Different reaction → switch
    existing.reaction = reaction as ReactionType;
    await existing.save();
    action = 'switched';
  }

  // ── Build updated summary ──
  const allReactions = await FeedReaction.find({ targetId }).lean();
  const summary      = buildSummary(allReactions);

  // ── Broadcast to org room ──
  try {
    getIO()
      .to(`org:${orgId.toString()}`)
      .emit('feed:reactions_updated', { targetType, targetId, summary });
  } catch { /* Socket.IO not running */ }

  res.json(
    new ApiResponse(200, { action, targetId, targetType, summary }, `Reaction ${action}`)
  );
});

// ─── Get Reactions ────────────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds/reactions?targetType=post&targetId=xxx
 *
 * Returns the aggregated reaction summary for a single target plus the
 * current user's own reaction (if any), so the UI can highlight it.
 */
export const getReactions = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { targetType, targetId } = req.query as { targetType: string; targetId: string };

  if (!['post', 'comment'].includes(targetType)) {
    throw new ApiError(400, 'targetType must be "post" or "comment"');
  }
  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    throw new ApiError(400, 'Invalid targetId');
  }

  const allReactions = await FeedReaction.find({ targetId }).lean();
  const summary      = buildSummary(allReactions);
  const myReaction   = allReactions.find(
    (r) => r.userId.toString() === actor._id.toString()
  )?.reaction ?? null;

  res.json(
    new ApiResponse(200, { summary, myReaction }, 'Reactions fetched')
  );
});

// ─── Bulk Get Reactions ───────────────────────────────────────────────────────

/**
 * POST /api/crm/feeds/reactions/bulk
 *
 * Body: { targetIds: string[] }
 *
 * Returns summaries for multiple targets in one request — used when the
 * feed page loads a page of posts and needs reaction counts for all of them
 * without N individual round-trips.
 */
export const getBulkReactions = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { targetIds } = req.body as { targetIds: string[] };

  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new ApiError(400, 'targetIds must be a non-empty array');
  }

  const validIds = targetIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

  const allReactions = await FeedReaction.find({ targetId: { $in: validIds } }).lean();

  // Group by targetId
  const byTarget: Record<string, typeof allReactions> = {};
  for (const r of allReactions) {
    const key = r.targetId.toString();
    if (!byTarget[key]) byTarget[key] = [];
    byTarget[key].push(r);
  }

  // Build result map
  const result: Record<string, { summary: ReturnType<typeof buildSummary>; myReaction: string | null }> = {};
  for (const id of validIds) {
    const reactions = byTarget[id] || [];
    result[id] = {
      summary:    buildSummary(reactions),
      myReaction: reactions.find((r) => r.userId.toString() === actor._id.toString())?.reaction ?? null,
    };
  }

  res.json(new ApiResponse(200, { reactions: result }, 'Bulk reactions fetched'));
});

export default { toggleReaction, getReactions, getBulkReactions };