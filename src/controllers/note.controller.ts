import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Note from '../models/Note.model';
import { getSocketIO } from '../utils/socketEmitter';

const NOTE_TTL_MS = 24 * 60 * 60 * 1000;

function emitToOrg(orgId: string, event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit(event, payload);
  } catch {
    /* ignore */
  }
}

/** GET /api/crm/notes — every live note in the org. */
const getNotes = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to an organization.');

  const notes = await Note.find({
    organizationId: user.organizationId,
    expiresAt: { $gt: new Date() },
  })
    .sort({ updatedAt: -1 })
    .lean();

  const meId = user._id.toString();
  const myNote = notes.find((n) => n.userId.toString() === meId) || null;

  res.json(new ApiResponse(200, { notes, myNote }, 'Notes fetched'));
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

export default { getNotes, putNote, deleteNote };