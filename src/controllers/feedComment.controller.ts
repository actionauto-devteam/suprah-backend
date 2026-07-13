import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed from '../models/Feed.model';
import DayPulse from '../models/Daypulse.model';
import FeedComment, { IFeedCommentAttachment } from '../models/FeedComment.model';
import { getIO } from '../socket/feedSocket';
import { BucketType, storageService } from '../services/storage.service';

async function signAttachments<T extends { attachments?: IFeedCommentAttachment[] }>(doc: T): Promise<T> {
  if (!Array.isArray(doc.attachments) || doc.attachments.length === 0) return doc;
  await Promise.all(doc.attachments.map(async (attachment) => {
    const signed = await storageService.getSignedUrl(attachment.fileKey || attachment.url);
    if (signed) {
      attachment.url = signed;
      if (attachment.thumbnailUrl) attachment.thumbnailUrl = signed;
    }
  }));
  return doc;
}

async function resolveOrgId(
  postId: string,
  actorOrgId: mongoose.Types.ObjectId | undefined,
): Promise<mongoose.Types.ObjectId> {
  const post = await Feed.findOne({ _id: postId, deletedAt: null }).lean();
  if (post) {
    if (post.organizationId.toString() !== actorOrgId?.toString()) {
      throw new ApiError(403, 'You cannot comment on posts outside your organisation');
    }
    return post.organizationId;
  }

  const report = await DayPulse.findOne({ _id: postId, deletedAt: null }).lean();
  if (report) {
    if (report.organizationId.toString() !== actorOrgId?.toString()) {
      throw new ApiError(403, 'You cannot comment on posts outside your organisation');
    }
    return report.organizationId;
  }

  throw new ApiError(404, 'Post not found');
}


export const addComment = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { postId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Invalid post ID');

  const content = (req.body.content || '').trim();
  const files = (req.files || []) as Express.Multer.File[];

  if (!content && files.length === 0) throw new ApiError(400, 'Comment cannot be empty');
  if (content.length > 1000) throw new ApiError(400, 'Comment cannot exceed 1000 characters');

  const orgId = await resolveOrgId(postId, actor.organizationId);

  const attachments: IFeedCommentAttachment[] = [];
  const uploadedKeys: string[] = [];

  try {
    for (const file of files) {
      const fileUrl = await storageService.upload(file, 'feed-comment-attachments', BucketType.PRIVATE, { allowLocalFallback: false });
      const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
      uploadedKeys.push(fileKey);
      attachments.push({
        url: fileKey,
        fileKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        thumbnailUrl: file.mimetype.startsWith('image/') ? fileKey : null,
      });
    }

    const comment = await FeedComment.create({
      postId,
      organizationId: orgId,
      userId:         actor._id,
      authorName:     actor.fullName,
      authorAvatar:   actor.avatar || null,
      authorRole:     actor.role,
      content,
      attachments,
    });

    const commentForClient = await signAttachments(comment.toObject());

    try {
      getIO()
        .to(`org:${actor.organizationId!.toString()}`)
        .emit('feed:comment_added', { postId, comment: commentForClient });
    } catch { /* Socket.IO not running — swallow */ }

    res.status(201).json(new ApiResponse(201, { comment: commentForClient }, 'Comment added'));
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => storageService.delete(key, BucketType.PRIVATE).catch(() => undefined)));
    throw error;
  }
});

// ─── Get Comments ─────────────────────────────────────────────────────────────

/**
 * GET /api/crm/feeds/:postId/comments
 *
 * Returns all live (non-deleted) comments for a Feed post or DayPulse report,
 * ordered oldest-first so the thread reads naturally top-to-bottom.
 */
export const getComments = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { postId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Invalid post ID');

  // Validates that the parent exists and belongs to the user's org
  await resolveOrgId(postId, actor.organizationId);

  const comments = await FeedComment.find({ postId, deletedAt: null })
    .sort({ createdAt: 1 }) // Oldest first — natural thread order
    .lean();

  const signedComments = await Promise.all(comments.map((c) => signAttachments(c)));

  res.json(new ApiResponse(200, { comments: signedComments, total: comments.length }, 'Comments fetched'));
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

  if (comment.attachments?.length) {
    await Promise.all(
      comment.attachments.map((a) => storageService.delete(a.fileKey || a.url, BucketType.PRIVATE).catch(() => undefined))
    );
  }

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