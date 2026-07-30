import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Note from '../models/Note.model';
import { getSocketIO, emitToUser } from '../utils/socketEmitter';

const NOTE_TTL_MS = 24 * 60 * 60 * 1000;

function emitToOrg(orgId: string, event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit(event, payload);
  } catch {
    /* ignore */
  }
}

/** Guarded direct-to-user emit — never lets a socket failure bubble into a 500. */
function safeEmitToUser(userId: string, event: string, payload: unknown) {
  try {
    emitToUser(userId, event, payload);
  } catch {
    /* ignore */
  }
}

/** GET /api/crm/notes — every live note in the org (with lightweight counts). */
const getNotes = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');

  const meId = user._id.toString();
  const raw = await Note.find({
    organizationId: user.organizationId,
    expiresAt: { $gt: new Date() },
  })
    .sort({ updatedAt: -1 })
    .lean();

  const notes = raw.map((n: any) => ({
    _id: n._id,
    userId: n.userId,
    authorName: n.authorName,
    authorAvatar: n.authorAvatar,
    text: n.text,
    updatedAt: n.updatedAt,
    reactionCount: (n.reactions || []).length,
    commentCount: (n.comments || []).length,
    myReaction: (n.reactions || []).find((r: any) => r.userId?.toString() === meId)?.emoji ?? null,
  }));

  const myNote = notes.find((n) => n.userId.toString() === meId) || null;

  res.json(new ApiResponse(200, { notes, myNote }, 'Notes fetched'));
});

/** GET /api/crm/notes/:id — full note with public comments; owner sees reactors. */
const getNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const note = await Note.findOne({ _id: req.params.id, organizationId: user.organizationId }).lean();
  if (!note) throw new ApiError(404, 'Note not found');

  const meId = user._id.toString();
  const isOwner = note.userId.toString() === meId;

  const comments = (note.comments || []).map((c: any) => ({
    _id: c._id,
    userId: c.userId,
    authorName: c.authorName,
    authorAvatar: c.authorAvatar,
    text: c.text,
    createdAt: c.createdAt,
  }));

  const reactions = note.reactions || [];
  const myReaction = reactions.find((r: any) => r.userId?.toString() === meId)?.emoji ?? null;

  res.json(
    new ApiResponse(200, {
      note: {
        _id: note._id,
        userId: note.userId,
        authorName: note.authorName,
        authorAvatar: note.authorAvatar,
        text: note.text,
        updatedAt: note.updatedAt,
        isOwner,
        myReaction,
        reactionCount: reactions.length,
        commentCount: comments.length,
        comments,
        // Owner can see exactly who reacted and with what.
        reactions: isOwner
          ? reactions.map((r: any) => ({ userId: r.userId, authorName: r.authorName, authorAvatar: r.authorAvatar, emoji: r.emoji }))
          : undefined,
      },
    }, 'Note fetched')
  );
});

/** PUT /api/crm/notes — set/replace my note (one per user). */
const putNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');

  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'Note text is required.');
  if (text.trim().length > 100) throw new ApiError(400, 'Notes are limited to 100 characters.');

  const note = await Note.findOneAndUpdate(
    { organizationId: user.organizationId, userId: user._id },
    {
      $set: {
        authorName: user.fullName,
        authorAvatar: user.avatar,
        text: text.trim(),
        expiresAt: new Date(Date.now() + NOTE_TTL_MS),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  emitToOrg(user.organizationId.toString(), 'note:updated', { note });
  res.json(new ApiResponse(200, { note }, 'Note saved'));
});

/** DELETE /api/crm/notes — clear my note. */
const deleteNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  await Note.deleteOne({ organizationId: user.organizationId, userId: user._id });
  emitToOrg(user.organizationId!.toString(), 'note:deleted', { userId: user._id });
  res.json(new ApiResponse(200, null, 'Note removed'));
});

/** POST /api/crm/notes/:id/react — toggle/replace a single emoji reaction (atomic). */
const reactNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string') throw new ApiError(400, 'An emoji is required.');

  const note = await Note.findOne({ _id: req.params.id, organizationId: user.organizationId })
    .select('reactions userId organizationId')
    .lean();
  if (!note) throw new ApiError(404, 'Note not found');

  const meId = user._id.toString();
  const existing = (note.reactions || []).find((r: any) => r.userId.toString() === meId);
  let myReaction: string | null = emoji;

  await Note.updateOne({ _id: note._id }, { $pull: { reactions: { userId: user._id } } });

  if (existing && existing.emoji === emoji) {
    myReaction = null;
  } else {
    await Note.updateOne(
      { _id: note._id },
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

  emitToOrg(note.organizationId.toString(), 'note:updated', { noteId: note._id });
  if (myReaction && note.userId.toString() !== meId) {
    safeEmitToUser(note.userId.toString(), 'note:reaction', { noteId: note._id, emoji, from: user.fullName });
  }

  res.json(new ApiResponse(200, { myReaction }, 'Reaction saved'));
});

/** POST /api/crm/notes/:id/comment — a PUBLIC comment everyone can see (atomic). */
const commentNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'Comment text is required.');
  if (text.trim().length > 500) throw new ApiError(400, 'Comment is too long.');

  const note = await Note.findOne({ _id: req.params.id, organizationId: user.organizationId })
    .select('userId organizationId')
    .lean();
  if (!note) throw new ApiError(404, 'Note not found');

  const commentDoc = {
    _id: new mongoose.Types.ObjectId(),
    userId: user._id,
    authorName: user.fullName || (user as any).username || 'User',
    authorAvatar: user.avatar,
    text: text.trim(),
    createdAt: new Date(),
  };

  await Note.updateOne({ _id: note._id }, { $push: { comments: commentDoc } });

  emitToOrg(note.organizationId.toString(), 'note:comment', { noteId: note._id, comment: commentDoc });
  res.status(201).json(new ApiResponse(201, { comment: commentDoc }, 'Comment added'));
});

export default { getNotes, getNote, putNote, deleteNote, reactNote, commentNote };