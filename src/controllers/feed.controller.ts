import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Feed, { IFeedAttachment } from '../models/Feed.model';
import { getIO } from '../socket/feedSocket';
import { BucketType, storageService } from '../services/storage.service';
import { notifyForPost } from '../services/feedNotification.service';
import { stripMentionTokens } from '../utils/feedMentions';


const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;


function parsePositiveInt(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

async function signAttachments<T extends { attachments?: IFeedAttachment[] }>(doc: T): Promise<T> {
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


export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const content = (req.body.content || '').trim();
  const files = (req.files || []) as Express.Multer.File[];

  if (!content && files.length === 0) {
    throw new ApiError(400, 'Post content cannot be empty');
  }
  // Mention tokens (`@[Name](id)`) inflate the raw string well beyond what the
  // author typed, so the 5000-char limit applies to the *visible* text.
  if (stripMentionTokens(content).length > 5000) {
    throw new ApiError(400, 'Post content cannot exceed 5000 characters');
  }

  if (!actor.organizationId) {
    throw new ApiError(403, 'You must belong to an organization to post');
  }

  const attachments: IFeedAttachment[] = [];
  const uploadedKeys: string[] = [];

  try {
    for (const file of files) {
      const fileUrl = await storageService.upload(file, 'feed-attachments', BucketType.PRIVATE, { allowLocalFallback: false });
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

    const post = await Feed.create({
      organizationId: actor.organizationId,
      userId:         actor._id,
      authorName:     actor.fullName,
      authorAvatar:   actor.avatar || null,
      authorRole:     actor.role,
      content,
      attachments,
      isEdited:       false,
    });

    const postForClient = await signAttachments(post.toObject());

    try {
      getIO()
        .to(`org:${actor.organizationId.toString()}`)
        .emit('feed:new', { post: postForClient });
    } catch {
      // Socket.IO not initialised — REST response is still sent below
    }

    // Mention / @all notification fanout — best-effort, must never fail the post.
    try {
      await notifyForPost(post, actor as any);
    } catch (err) {
      console.error('[feed] notification fanout failed:', err);
    }

    res.status(201).json(new ApiResponse(201, { post: postForClient }, 'Post created successfully'));
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => storageService.delete(key, BucketType.PRIVATE).catch(() => undefined)));
    throw error;
  }
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

  // Fetch one extra row instead of counting the entire organization feed on
  // every request. This keeps the initial query fast as the feed grows while
  // still allowing the client to determine whether another page is available.
  const rows = await Feed.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const posts = hasMore ? rows.slice(0, limit) : rows;

  // URL signing is required only for posts that actually contain attachments.
  // Posts without files are returned immediately without storage-service calls.
  const signedPosts = await Promise.all(
    posts.map((post) => post.attachments?.length ? signAttachments(post) : post)
  );

  res.json(
    new ApiResponse(200, { posts: signedPosts, page, limit, hasMore }, 'Feed fetched successfully')
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
 *
 * Note: edits deliberately do NOT re-run the notification fanout — this
 * avoids duplicate mention notifications when an author tweaks wording.
 */
export const updatePost = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;

  // Validate that the ID is a proper MongoDB ObjectId before querying
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid post ID');

  const { content } = req.body;
  const trimmedContent = (content || '').trim();
  if (stripMentionTokens(trimmedContent).length > 5000) {
    throw new ApiError(400, 'Post content cannot exceed 5000 characters');
  }

  // Fetch the post (excluding soft-deleted ones)
  const post = await Feed.findOne({ _id: id, deletedAt: null });
  if (!post) throw new ApiError(404, 'Post not found');

  // Editing text is content-only (no re-upload here) — only reject an empty
  // body when the post also has no attachments left to stand on its own.
  if (!trimmedContent && (!post.attachments || post.attachments.length === 0)) {
    throw new ApiError(400, 'Post content cannot be empty');
  }

  // Permission check: only the owner (or an admin) may edit
  const isOwner = post.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only edit your own posts');

  // Apply the edit
  post.content  = trimmedContent;
  post.isEdited = true;
  await post.save();

  const postForClient = await signAttachments(post.toObject());

  // Notify all org members so the edited post updates live in their feeds
  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('feed:updated', { post: postForClient });
  } catch { /* Socket.IO not running — swallow */ }

  res.json(new ApiResponse(200, { post: postForClient }, 'Post updated successfully'));
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

  if (post.attachments?.length) {
    await Promise.all(
      post.attachments.map((a) => storageService.delete(a.fileKey || a.url, BucketType.PRIVATE).catch(() => undefined))
    );
  }

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