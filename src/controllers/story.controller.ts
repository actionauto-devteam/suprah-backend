import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Story, { StoryMediaType } from '../models/Story.model';
import CrmUser from '../models/CrmUser.model';
import Note from '../models/Note.model';
import { storageService } from '../services/storage.service';
import { getSocketIO, emitToUser } from '../utils/socketEmitter';

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
    replyCount: (story.replies || []).length,
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
    replies: [],
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
 * Ordering: me first, then unseen stories, then seen stories, then note-only,
 * then everyone else alphabetically.
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
      .select('fullName avatar role')
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
    byId.set(meId, { _id: user._id, fullName: user.fullName, avatar: user.avatar, role: user.role });
  }

  const users = Array.from(byId.values()).map((u) => {
    const id = u._id.toString();
    const myStories = storiesByUser.get(id) || [];
    const note = noteByUser.get(id);
    const hasStory = myStories.length > 0;
    const hasUnseen = id !== meId && myStories.some((s) => !s.viewedByMe);
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
    };
  });

  // New/unseen stories come first. Once you've viewed someone's story, they
  // drop to the back alongside everyone who has no story at all.
  const rank = (u: any) => (u.hasUnseen ? 0 : 1);
  users.sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a.fullName || '').localeCompare(b.fullName || '');
  });

  res.json(new ApiResponse(200, { users }, 'Stories rail'));
});

/** GET /api/crm/stories/:id — single story (with replies for the owner). */
const getStory = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId });
  if (!story) throw new ApiError(404, 'Story not found');

  const base = serializeStory(story.toObject(), user._id.toString());
  const isOwner = story.userId.toString() === user._id.toString();
  res.json(
    new ApiResponse(200, {
      story: {
        ...base,
        // Owners can see who replied/reacted; others only see aggregates.
        replies: isOwner ? story.replies : undefined,
        viewers: isOwner ? story.viewers : undefined,
      },
    }, 'Story fetched')
  );
});

/** POST /api/crm/stories/:id/view — idempotent view marker. */
const markViewed = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId });
  if (!story) throw new ApiError(404, 'Story not found');

  const already = story.viewers.some((v) => v.userId.toString() === user._id.toString());
  if (!already) {
    story.viewers.push({ userId: user._id as any, viewedAt: new Date() });
    await story.save();
  }
  res.json(new ApiResponse(200, { viewCount: story.viewers.length }, 'Viewed'));
});

/** POST /api/crm/stories/:id/react — toggle/replace a single emoji reaction. */
const react = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string') throw new ApiError(400, 'An emoji is required.');

  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId });
  if (!story) throw new ApiError(404, 'Story not found');

  const meId = user._id.toString();
  const existing = story.reactions.find((r) => r.userId.toString() === meId);
  let myReaction: string | null = emoji;

  if (existing && existing.emoji === emoji) {
    // Same emoji → remove.
    story.reactions = story.reactions.filter((r) => r.userId.toString() !== meId) as any;
    myReaction = null;
  } else if (existing) {
    existing.emoji = emoji;
    existing.createdAt = new Date();
  } else {
    story.reactions.push({ userId: user._id as any, authorName: user.fullName, emoji, createdAt: new Date() });
  }
  await story.save();

  // Let the story owner know someone reacted.
  if (myReaction && story.userId.toString() !== meId) {
    emitToUser(story.userId.toString(), 'story:reaction', {
      storyId: story._id, emoji, from: user.fullName,
    });
  }

  res.json(new ApiResponse(200, { reactionCount: story.reactions.length, myReaction }, 'Reaction saved'));
});

/** POST /api/crm/stories/:id/reply — quick DM-style reply to the author. */
const reply = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'Reply text is required.');
  if (text.trim().length > 500) throw new ApiError(400, 'Reply is too long.');

  const story = await Story.findOne({ _id: req.params.id, organizationId: user.organizationId });
  if (!story) throw new ApiError(404, 'Story not found');

  const replyDoc = {
    userId: user._id as any,
    authorName: user.fullName,
    authorAvatar: user.avatar,
    text: text.trim(),
    createdAt: new Date(),
  };
  story.replies.push(replyDoc);
  await story.save();

  if (story.userId.toString() !== user._id.toString()) {
    emitToUser(story.userId.toString(), 'story:reply', {
      storyId: story._id, text: replyDoc.text, from: user.fullName,
    });
  }

  res.status(201).json(new ApiResponse(201, { replyCount: story.replies.length }, 'Reply sent'));
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
  reply,
  deleteStory,
};