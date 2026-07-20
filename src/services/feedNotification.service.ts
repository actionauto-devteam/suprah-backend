import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import FeedNotification, { FeedNotificationType } from '../models/FeedNotification.model';
import { extractMentions, buildSnippet } from '../utils/feedMentions';
import { getIO } from '../socket/feedSocket';

/**
 * services/feedNotification.service.ts
 *
 * Fanout for Feeds notifications. Both entry points are best-effort: they are
 * awaited inside a try/catch by the controllers so a notification failure can
 * never fail the post/comment request itself.
 *
 * Real-time delivery uses the `user:{id}` room convention (joined in
 * socket/feedSocket.ts on connection) with a `feed:notify` event.
 */

interface ActorLike {
  _id: mongoose.Types.ObjectId | string;
  fullName: string;
  organizationId: mongoose.Types.ObjectId | string;
}

interface NotificationDoc {
  organizationId: mongoose.Types.ObjectId | string;
  recipientId: string;
  actorId: mongoose.Types.ObjectId | string;
  actorName: string;
  type: FeedNotificationType;
  postId: mongoose.Types.ObjectId | string;
  commentId?: mongoose.Types.ObjectId | string | null;
  snippet: string;
}

/** All active org members except `excludeId` (the actor). */
async function resolveOrgRecipientIds(
  organizationId: mongoose.Types.ObjectId | string,
  excludeId: mongoose.Types.ObjectId | string,
): Promise<string[]> {
  const users = await CrmUser.find({
    organizationId,
    isActive: true,
    _id: { $ne: excludeId },
  })
    .select('_id')
    .lean();
  return users.map((u: any) => u._id.toString());
}

/**
 * Keep only mentioned ids that are valid ObjectIds AND real, active members
 * of the actor's organisation — a mention token can't be used to notify
 * users in another tenant.
 */
async function validateMentionedUserIds(
  organizationId: mongoose.Types.ObjectId | string,
  ids: string[],
): Promise<string[]> {
  const valid = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (valid.length === 0) return [];
  const users = await CrmUser.find({
    _id: { $in: valid },
    organizationId,
    isActive: true,
  })
    .select('_id')
    .lean();
  return users.map((u: any) => u._id.toString());
}

/** Persist notifications and push each one to its recipient's user room. */
async function createAndEmit(docs: NotificationDoc[]): Promise<void> {
  if (docs.length === 0) return;

  const created = await FeedNotification.insertMany(docs);

  try {
    const io = getIO();
    for (const notification of created) {
      const plain = notification.toObject();
      io.to(`user:${plain.recipientId.toString()}`).emit('feed:notify', { notification: plain });
    }
  } catch {
    // Socket.IO not initialised — notifications are still persisted and will
    // surface via the sidebar poller / Activity panel.
  }
}

/**
 * Fanout for a newly created post.
 *   - each mentioned user            → 'mention_post'
 *   - @all: every other org member   → 'all_announcement'
 *     (mentioned users are deduped — they get the more specific type)
 */
export async function notifyForPost(
  post: { _id: mongoose.Types.ObjectId | string; content?: string },
  actor: ActorLike,
): Promise<void> {
  const { userIds, mentionsAll } = extractMentions(post.content || '');
  const actorId = actor._id.toString();
  const snippet = buildSnippet(post.content || '');
  const docs: NotificationDoc[] = [];

  const mentioned = (await validateMentionedUserIds(actor.organizationId, userIds)).filter(
    (id) => id !== actorId,
  );
  const mentionedSet = new Set(mentioned);

  for (const recipientId of mentioned) {
    docs.push({
      organizationId: actor.organizationId,
      recipientId,
      actorId: actor._id,
      actorName: actor.fullName,
      type: 'mention_post',
      postId: post._id,
      snippet,
    });
  }

  if (mentionsAll) {
    const everyone = await resolveOrgRecipientIds(actor.organizationId, actor._id);
    for (const recipientId of everyone) {
      if (mentionedSet.has(recipientId)) continue;
      docs.push({
        organizationId: actor.organizationId,
        recipientId,
        actorId: actor._id,
        actorName: actor.fullName,
        type: 'all_announcement',
        postId: post._id,
        snippet,
      });
    }
  }

  await createAndEmit(docs);
}

/**
 * Fanout for a newly created comment.
 *   - each mentioned user                          → 'mention_comment'
 *   - @all inside a comment: every org member      → 'mention_comment'
 *   - the parent post's owner (if not the actor
 *     and not already mentioned)                   → 'comment_on_post'
 */
export async function notifyForComment(params: {
  comment: { _id: mongoose.Types.ObjectId | string; content?: string };
  postId: mongoose.Types.ObjectId | string;
  /** Owner of the parent post/report — null when unknown (e.g. legacy docs). */
  postOwnerId?: string | null;
  actor: ActorLike;
}): Promise<void> {
  const { comment, postId, postOwnerId, actor } = params;
  const { userIds, mentionsAll } = extractMentions(comment.content || '');
  const actorId = actor._id.toString();
  const snippet = buildSnippet(comment.content || '');
  const docs: NotificationDoc[] = [];

  let mentioned = (await validateMentionedUserIds(actor.organizationId, userIds)).filter(
    (id) => id !== actorId,
  );

  if (mentionsAll) {
    const everyone = await resolveOrgRecipientIds(actor.organizationId, actor._id);
    mentioned = Array.from(new Set([...mentioned, ...everyone]));
  }
  const mentionedSet = new Set(mentioned);

  for (const recipientId of mentioned) {
    docs.push({
      organizationId: actor.organizationId,
      recipientId,
      actorId: actor._id,
      actorName: actor.fullName,
      type: 'mention_comment',
      postId,
      commentId: comment._id,
      snippet,
    });
  }

  if (postOwnerId && postOwnerId !== actorId && !mentionedSet.has(postOwnerId)) {
    docs.push({
      organizationId: actor.organizationId,
      recipientId: postOwnerId,
      actorId: actor._id,
      actorName: actor.fullName,
      type: 'comment_on_post',
      postId,
      commentId: comment._id,
      snippet,
    });
  }

  await createAndEmit(docs);
}

export default { notifyForPost, notifyForComment };