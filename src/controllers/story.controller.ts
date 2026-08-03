import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Story, { StoryMediaType } from '../models/Story.model';
import CrmUser from '../models/CrmUser.model';
import Note from '../models/Note.model';
import { storageService } from '../services/storage.service';
import { getSocketIO, emitToUser } from '../utils/socketEmitter';
import { resolvePresenceForCrmRoster } from '../utils/presenceBridge';

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEO_SECONDS = 120;

/** Best-effort org broadcast. Requires CRM sockets to `socket.join('org:'+orgId)`
 *  on connect (see setup notes). Falls back to no-op if IO is uninitialised —
 *  the client also polls, so realtime is an enhancement, never a dependency. */
function emitToOrg(orgId: string, event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit(event, payload);
  } catch {
    /* socket not ready — ignore */
  }
}

/** Guarded direct-to-user emit — never lets a socket failure bubble into a 500. */
function safeEmitToUser(userId: string, event: string, payload: unknown) {
  try {
    emitToUser(userId, event, payload);
  } catch {
    /* socket not ready — ignore */
  }
}

/** Shape a story for the client (never leaks viewer/reaction identities beyond counts). */
function serializeStory(story: any, meId: string) {
  const reactions = story.reactions || [];
  const mine = reactions.find((r: any) => r.userId?.toString() === meId);
  return {
    _id: story._id,
    userId: story.userId,
    authorName: story.authorName,
    authorAvatar: story.authorAvatar,
    media: story.media,
    caption: story.caption,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    viewCount: (story.viewers || []).length,
    reactionCount: reactions.length,
    myReaction: mine?.emoji ?? null,
    viewedByMe: (story.viewers || []).some((v: any) => v.userId?.toString() === meId),
    commentCount: (story.comments || []).length,
  };
}

/**
 * POST /api/crm/stories
 * multipart: media (image/video, required), thumbnail (image, optional — the
 * client captures a video's first frame and sends it here), caption, durationSec.
 */
const createStory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');

  const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
  const mediaFile = files?.media?.[0];
  const thumbFile = files?.thumbnail?.[0];
  if (!mediaFile) throw new ApiError(400, 'A photo or video is required.');

  const mediaType: StoryMediaType = mediaFile.mimetype.startsWith('video/') ? 'video' : 'image';

  const durationSec = req.body.durationSec ? Number(req.body.durationSec) : undefined;
  if (mediaType === 'video' && durationSec && durationSec > MAX_VIDEO_SECONDS + 1) {
    throw new ApiError(400, 'Video stories can be at most 2 minutes long.');
  }

  // Upload media (and optional thumbnail) to the public bucket — same path feeds use.
  const mediaUrl = await storageService.upload(mediaFile, 'stories');
  let thumbnailUrl: string | undefined;
  let thumbnailKey: string | undefined;
  if (thumbFile) {
    thumbnailUrl = await storageService.upload(thumbFile, 'stories/thumbs');
    thumbnailKey = storageService.getKeyFromUrl(thumbnailUrl) || undefined;
  }

  const story = await Story.create({
    organizationId: user.organizationId,
    userId: user._id,
    authorName: user.fullName,
    authorAvatar: user.avatar,
    authorRole: user.role,
    media: {
      url: mediaUrl,
      fileKey: storageService.getKeyFromUrl(mediaUrl) || undefined,
      mimeType: mediaFile.mimetype,
      mediaType,
      durationSec: mediaType === 'video' ? durationSec : undefined,
      width: req.body.width ? Number(req.body.width) : undefined,
      height: req.body.height ? Number(req.body.height) : undefined,
      thumbnailUrl,
      thumbnailKey,
    },
    caption: typeof req.body.caption === 'string' ? req.body.caption.trim() : undefined,
    viewers: [],
    reactions: [],
    comments: [],
    expiresAt: new Date(Date.now() + STORY_TTL_MS),
  });

  const serialized = serializeStory(story.toObject(), user._id.toString());
  emitToOrg(user.organizationId.toString(), 'story:new', {
    story: serialized,
    author: { _id: user._id, fullName: user.fullName, avatar: user.avatar },
  });

  res.status(201).json(new ApiResponse(201, { story: serialized }, 'Story posted'));
});

/**
 * GET /api/crm/stories/feed
 * The Instagram-style social rail: EVERY active user in the org, each carrying
 * their live stories (possibly none) and their current note (possibly null).
 * The client uses this single payload to render rings + note bubbles and to
 * drive the story viewer.
 *
 * Ordering: me first, then unseen stories, then seen stories, then note-only
 * (newest activity first), then everyone else by presence (online > busy >
 * do_not_disturb > idle > away > offline), then alphabetically.
 */
const getFeed = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');

  const meId = user._id.toString();
  const now = new Date();

  const [stories, notes, orgUsers] = await Promise.all([
    Story.find({ organizationId: user.organizationId, expiresAt: { $gt: now } }).sort({ createdAt: 1 }).lean(),
    Note.find({ organizationId: user.organizationId, expiresAt: { $gt: now } }).lean(),
    CrmUser.find({
      organizationId: user.organizationId,
      isActive: true,
      isOffboarded: { $ne: true },
      isSystem: { $ne: true },
    })
      .select('fullName avatar role email')
      .lean(),
  ]);

  // Index stories + notes by user.
  const storiesByUser = new Map<string, any[]>();
  for (const s of stories) {
    const key = s.userId.toString();
    if (!storiesByUser.has(key)) storiesByUser.set(key, []);
    storiesByUser.get(key)!.push(serializeStory(s, meId));
  }
  const noteByUser = new Map<string, any>();
  for (const n of notes) noteByUser.set(n.userId.toString(), n);

  // Ensure the current user is always represented (covers synthetic admins that
  // may not be a stored CrmUser document in this org).
  const byId = new Map<string, any>();
  for (const u of orgUsers) byId.set(u._id.toString(), u);
  if (!byId.has(meId)) {
    byId.set(meId, { _id: user._id, fullName: user.fullName, avatar: user.avatar, role: user.role, email: user.email });
  }

  const presenceByUser = await resolvePresenceForCrmRoster(Array.from(byId.values()));

  const users = Array.from(byId.values()).map((u) => {
    const id = u._id.toString();
    const myStories = storiesByUser.get(id) || [];
    const note = noteByUser.get(id);
    const hasStory = myStories.length > 0;
    const hasUnseen = id !== meId && myStories.some((s) => !s.viewedByMe);
    const presence = presenceByUser.get(id);
    // Most recent activity = newest story OR the note's last update.
    let latestAt = 0;
    if (myStories.length) latestAt = Math.max(latestAt, new Date(myStories[myStories.length - 1].createdAt).getTime());
    if (note) latestAt = Math.max(latestAt, new Date(note.updatedAt).getTime());
    return {
      _id: id,
      fullName: u.fullName,
      avatar: u.avatar,
      role: u.role,
      isMe: id === meId,
      hasStory,
      hasUnseen, // green ring when true, amber ring when hasStory && !hasUnseen
      storyCount: myStories.length,
      stories: myStories,
      note: note ? { _id: note._id, text: note.text, updatedAt: note.updatedAt } : null,
      latestAt,
      onlineStatus: presence?.onlineStatus || 'offline',
      lastDeviceType: presence?.lastDeviceType ?? null,
    };
  });

  // Anyone with a note or story stays pinned to the front, newest activity
  // first — even after their story is viewed (only the ring color changes,
  // green → amber). Everyone else is grouped by presence (online first,
  // offline last) before falling back to alphabetical order.
  const hasActivity = (u: any) => u.hasStory || Boolean(u.note);
  const STATUS_RANK: Record<string, number> = {
    online: 0,
    busy: 1,
    do_not_disturb: 2,
    idle: 3,
    away: 4,
    offline: 5,
  };
  const statusRank = (u: any) => STATUS_RANK[u.onlineStatus] ?? STATUS_RANK.offline;
  users.sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    const aa = hasActivity(a);
    const ba = hasActivity(b);
    if (aa !== ba) return aa ? -1 : 1;          // active users (story/note) first
    if (aa && ba) return b.latestAt - a.latestAt; // latest activity first
    const ra = statusRank(a);
    const rb = statusRank(b);
    if (ra !== rb) return ra - rb;               // then by presence (online first)
    return (a.fullName || '').localeCompare(b.fullName || '');
  });

  res.json(new ApiResponse(200, { users }, 'Stories rail'));
});

/** GET /api/crm/stories/:id — comments are public; owner also sees who viewed/reacted. */
const getStory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId }).lean();
  if (!story) throw new ApiError(404, 'Story not found');

  const meId = user._id.toString();
  const base = serializeStory(story, meId);
  const isOwner = story.userId.toString() === meId;

  // Comments are visible to everyone who can see the story.
  const comments = (story.comments || []).map((c: any) => ({
    _id: c._id,
    userId: c.userId,
    authorName: c.authorName,
    authorAvatar: c.authorAvatar,
    text: c.text,
    createdAt: c.createdAt,
  }));

  // Owner-only: the "seen by" list, each viewer annotated with their reaction.
  let viewers: any;
  let reactions: any;
  if (isOwner) {
    const reactionByUser = new Map<string, string>();
    for (const r of story.reactions || []) reactionByUser.set(r.userId.toString(), r.emoji);
    viewers = (story.viewers || [])
      .slice()
      .sort((a: any, b: any) => new Date(b.viewedAt).getTime() - new Date(a.viewedAt).getTime())
      .map((v: any) => ({
        userId: v.userId,
        name: v.name,
        avatar: v.avatar,
        viewedAt: v.viewedAt,
        emoji: reactionByUser.get(v.userId.toString()) || null,
      }));
    reactions = (story.reactions || []).map((r: any) => ({
      userId: r.userId,
      authorName: r.authorName,
      authorAvatar: r.authorAvatar,
      emoji: r.emoji,
    }));
  }

  res.json(
    new ApiResponse(200, {
      story: { ...base, isOwner, comments, viewers, reactions },
    }, 'Story fetched')
  );
});

/** POST /api/crm/stories/:id/view — idempotent view marker (atomic; records name/avatar). */
const markViewed = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const displayName = user.fullName || (user as any).username || 'User';

  // Atomic add-if-absent — avoids re-validating any pre-existing subdocuments.
  const result = await Story.updateOne(
    { _id: req.params.id, organizationId: user.organizationId, 'viewers.userId': { $ne: user._id } },
    { $push: { viewers: { userId: user._id, name: displayName, avatar: user.avatar, viewedAt: new Date() } } }
  );

  if (result.modifiedCount) {
    const story = await Story.findById(req.params.id).select('userId').lean();
    if (story && story.userId.toString() !== user._id.toString()) {
      safeEmitToUser(story.userId.toString(), 'story:view', { storyId: req.params.id });
    }
  }
  res.json(new ApiResponse(200, { ok: true }, 'Viewed'));
});

/** POST /api/crm/stories/:id/react — toggle/replace a single emoji reaction (atomic). */
const react = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string') throw new ApiError(400, 'An emoji is required.');

  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId })
    .select('reactions userId')
    .lean();
  if (!story) throw new ApiError(404, 'Story not found');

  const meId = user._id.toString();
  const existing = (story.reactions || []).find((r: any) => r.userId.toString() === meId);
  let myReaction: string | null = emoji;

  // Always drop any prior reaction from this user first (atomic).
  await Story.updateOne({ _id: story._id }, { $pull: { reactions: { userId: user._id } } });

  if (existing && existing.emoji === emoji) {
    myReaction = null; // same emoji tapped again → toggled off
  } else {
    await Story.updateOne(
      { _id: story._id },
      {
        $push: {
          reactions: {
            userId: user._id,
            authorName: user.fullName || (user as any).username || 'User',
            authorAvatar: user.avatar,
            emoji,
            createdAt: new Date(),
          },
        },
      }
    );
  }

  if (myReaction && story.userId.toString() !== meId) {
    safeEmitToUser(story.userId.toString(), 'story:reaction', { storyId: story._id, emoji, from: user.fullName });
  }

  res.json(new ApiResponse(200, { myReaction }, 'Reaction saved'));
});

/** POST /api/crm/stories/:id/comment — a PUBLIC comment everyone can see (atomic). */
const comment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'Comment text is required.');
  if (text.trim().length > 500) throw new ApiError(400, 'Comment is too long.');

  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId })
    .select('userId organizationId')
    .lean();
  if (!story) throw new ApiError(404, 'Story not found');

  const commentDoc = {
    _id: new mongoose.Types.ObjectId(),
    userId: user._id,
    authorName: user.fullName || (user as any).username || 'User',
    authorAvatar: user.avatar,
    text: text.trim(),
    createdAt: new Date(),
  };

  await Story.updateOne({ _id: story._id }, { $push: { comments: commentDoc } });

  // Broadcast to the whole org so every viewer sees the new comment live.
  emitToOrg(story.organizationId.toString(), 'story:comment', { storyId: story._id, comment: commentDoc });

  res.status(201).json(new ApiResponse(201, { comment: commentDoc }, 'Comment added'));
});

/** DELETE /api/crm/stories/:id — owner or admin; also removes R2 objects. */
const deleteStory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId });
  if (!story) throw new ApiError(404, 'Story not found');

  const isOwner = story.userId.toString() === user._id.toString();
  if (!isOwner && user.role !== 'admin') throw new ApiError(403, 'You can only delete your own stories.');

  // Best-effort media cleanup — TTL only removes the document, not the object.
  if (story.media?.url) { try { await storageService.delete(story.media.url); } catch { /* ignore */ } }
  if (story.media?.thumbnailUrl) { try { await storageService.delete(story.media.thumbnailUrl); } catch { /* ignore */ } }

  await story.deleteOne();
  emitToOrg(user.organizationId!.toString(), 'story:deleted', { storyId: story._id, userId: story.userId });

  res.json(new ApiResponse(200, null, 'Story deleted'));
});

export default {
  createStory,
  getFeed,
  getStory,
  markViewed,
  react,
  comment,
  deleteStory,
};