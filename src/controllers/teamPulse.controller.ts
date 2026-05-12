import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Absence from '../models/Absence.model';
import BoardNote from '../models/BoardNote.model';

// ── Members ───────────────────────────────────────────────────────────────────

const getMembers = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    const statusOrder: Record<string, number> = {
        online: 0, busy: 1, away: 2, idle: 3, do_not_disturb: 4, offline: 5,
    };

    const members = await User.find({
        organizationId: orgId,
        role: { $in: ['employee', 'admin', 'super_admin'] },
    })
        .select('name avatar onlineStatus customStatus lastActive role personalInfo')
        .lean();

    members.sort((a, b) => {
        const diff = (statusOrder[a.onlineStatus] ?? 5) - (statusOrder[b.onlineStatus] ?? 5);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

    res.json(new ApiResponse(200, members, 'Team members fetched'));
});

// ── Absences ──────────────────────────────────────────────────────────────────

const getAbsences = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { year, month } = req.query;

    const y = parseInt(year as string) || new Date().getFullYear();
    const m = parseInt(month as string) || new Date().getMonth() + 1;

    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0, 23, 59, 59);

    const absences = await Absence.find({
        organizationId: orgId,
        date: { $gte: from, $lte: to },
    }).lean();

    res.json(new ApiResponse(200, absences, 'Absences fetched'));
});

const createAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = user._id.toString();
    const orgId = req.orgId as string;
    const { date, type, note } = req.body;

    if (!date || !type) throw new ApiError(400, 'date and type are required');

    const parsedDate = new Date(date);
    parsedDate.setUTCHours(12, 0, 0, 0);

    const existing = await Absence.findOne({ organizationId: orgId, userId, date: parsedDate });
    if (existing) throw new ApiError(409, 'You already have an entry for this date');

    const absence = await Absence.create({
        organizationId: orgId,
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        date: parsedDate,
        type,
        note,
    });

    res.status(201).json(new ApiResponse(201, absence, 'Absence created'));
});

const deleteAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = user._id.toString();
    const orgId = req.orgId as string;
    const { id } = req.params;

    const absence = await Absence.findOne({ _id: id, organizationId: orgId });
    if (!absence) throw new ApiError(404, 'Absence not found');

    const isOwner = absence.userId.toString() === userId;
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isOwner && !isAdmin) throw new ApiError(403, 'Not authorized');

    await absence.deleteOne();
    res.json(new ApiResponse(200, null, 'Absence deleted'));
});

// ── Board Notes ───────────────────────────────────────────────────────────────

const getBoardNotes = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const now = new Date();

    const notes = await BoardNote.find({
        organizationId: orgId,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
        .sort({ pinned: -1, createdAt: -1 })
        .limit(60)
        .lean();

    res.json(new ApiResponse(200, notes, 'Board notes fetched'));
});

const createBoardNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { content, color, title, durationDays } = req.body;

    if (!content?.trim()) throw new ApiError(400, 'content is required');

    let expiresAt: Date | null = null;
    if (durationDays && Number(durationDays) > 0) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + Number(durationDays));
    }

    const note = await BoardNote.create({
        organizationId: orgId,
        userId: user._id,
        userName: user.name,
        userAvatar: user.avatar,
        title: title?.trim() || undefined,
        content: content.trim(),
        color: color || 'yellow',
        durationDays: durationDays || null,
        expiresAt,
    });

    res.status(201).json(new ApiResponse(201, note, 'Note created'));
});

const deleteBoardNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    const isOwner = note.userId.toString() === user._id.toString();
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isOwner && !isAdmin) throw new ApiError(403, 'Not authorized');

    await note.deleteOne();
    res.json(new ApiResponse(200, null, 'Note deleted'));
});

const togglePinNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can pin notes');

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    note.pinned = !note.pinned;
    await note.save();

    res.json(new ApiResponse(200, note, 'Note pinned state toggled'));
});

export default {
    getMembers,
    getAbsences, createAbsence, deleteAbsence,
    getBoardNotes, createBoardNote, deleteBoardNote, togglePinNote,
};
