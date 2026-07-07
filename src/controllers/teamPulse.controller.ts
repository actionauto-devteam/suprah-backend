import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Absence from '../models/Absence.model';
import BoardNote from '../models/BoardNote.model';
import Notification from '../models/Notification.model';
import FeedReaction, { REACTION_TYPES } from '../models/FeedReaction.model';
import ActivityLog from '../models/ActivityLog.model';
import PresenceEvent from '../models/PresenceEvent.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import { emitToOrg, emitToUser } from '../utils/socketEmitter';
import { BucketType, storageService } from '../services/storage.service';

const PRESENCE_TTL_MS = 2 * 60 * 1000;

// ── Ping rate-limit (in-memory, per sender:recipient pair) ────────────────────
const pingLog = new Map<string, number[]>();
const PING_WINDOW_MS = 60 * 60 * 1000;
const PING_MAX = 3;

function canPing(fromId: string, toId: string): boolean {
    const key = `${fromId}:${toId}`;
    const now = Date.now();
    const times = (pingLog.get(key) || []).filter(t => now - t < PING_WINDOW_MS);
    if (times.length >= PING_MAX) return false;
    times.push(now);
    pingLog.set(key, times);
    return true;
}

// ── Members ───────────────────────────────────────────────────────────────────

const getMembers = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    const statusOrder: Record<string, number> = {
        online: 0, busy: 1, do_not_disturb: 2, away: 3, idle: 4, offline: 5,
    };

    const members = await User.find({
        organizationId: orgId,
        role: { $in: ['employee', 'admin', 'super_admin'] },
    })
        .select('name avatar onlineStatus customStatus statusIsManual lastActive lastDeviceType role personalInfo breakStatus employmentLocationType locationConsent')
        .lean();

    const cutoff = new Date(Date.now() - PRESENCE_TTL_MS);

    // Only override the DISPLAYED status for members in automatic mode (statusIsManual === false)
    // whose heartbeat has gone stale — i.e. their tab/app is no longer reporting in, so whatever
    // "online"/"away" value is stored is out of date and they should read as offline. A manually
    // chosen status (including a manually-set "Away" or "Invisible") is never overridden here.
    const adjusted = members.map((m) => {
        const stale = !m.lastActive || new Date(m.lastActive) < cutoff;
        const effectiveStatus = (!m.statusIsManual && stale) ? 'offline' : m.onlineStatus;
        return { ...m, onlineStatus: effectiveStatus };
    });

    adjusted.sort((a, b) => {
        const diff = (statusOrder[a.onlineStatus] ?? 5) - (statusOrder[b.onlineStatus] ?? 5);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

    res.json(new ApiResponse(200, adjusted, 'Team members fetched'));
});

const setEmploymentLocationType = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { userId } = req.params;
    const { employmentLocationType } = req.body as { employmentLocationType: 'onsite' | 'remote' };

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can change an employee\'s location type');
    if (!['onsite', 'remote'].includes(employmentLocationType)) throw new ApiError(400, 'Invalid employment location type');

    const member = await User.findOne({ _id: userId, organizationId: orgId });
    if (!member) throw new ApiError(404, 'Team member not found');

    member.employmentLocationType = employmentLocationType;
    await member.save();

    if (employmentLocationType === 'remote') {
        await EmployeeLocation.findOneAndUpdate(
            { userId },
            { sharingState: 'off_duty', $unset: { currentPlaceId: '' } },
        );
        emitToOrg(orgId, 'locator:sharing_state_changed', { userId, sharingState: 'off_duty' });
    }

    emitToOrg(orgId, 'team-pulse:member_updated', { userId, employmentLocationType });

    res.json(new ApiResponse(200, { userId, employmentLocationType }, 'Employment location type updated'));
});

// ── Absences ──────────────────────────────────────────────────────────────────

const getAbsences = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { year, month, status } = req.query;

    if (status === 'pending') {
        const pendingAbsences = await Absence.find({ organizationId: orgId, status: 'pending' })
            .sort({ date: 1 })
            .lean();
        return res.json(new ApiResponse(200, pendingAbsences, 'Pending absences fetched'));
    }

    const y = parseInt(year as string) || new Date().getFullYear();
    const m = parseInt(month as string) || new Date().getMonth() + 1;

    const from = new Date(y, m - 1, 1);
    const to   = new Date(y, m, 0, 23, 59, 59);

    const absences = await Absence.find({
        organizationId: orgId,
        date: { $gte: from, $lte: to },
    }).lean();

    res.json(new ApiResponse(200, absences, 'Absences fetched'));
});

const APPROVAL_REQUIRED = new Set(['day_off', 'vacation', 'other']);

const createAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const userId = user._id.toString();
    const orgId = req.orgId as string;
    const { date, endDate, type, title, note, otherText } = req.body;

    if (!date || !type) throw new ApiError(400, 'date and type are required');
    if (type === 'other' && !otherText?.trim()) throw new ApiError(400, 'Please specify what "Other" means');

    const requiresApproval = APPROVAL_REQUIRED.has(type);
    const status = requiresApproval ? 'pending' : 'approved';

    function parseDate(s: string): Date {
        const [y, mo, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    }

    const startDate = parseDate(date as string);

    // Multi-day range support
    if (endDate && endDate !== date) {
        const end = parseDate(endDate as string);
        if (end < startDate) throw new ApiError(400, 'endDate must be on or after date');

        const created = [];
        const cursor = new Date(startDate);
        while (cursor <= end) {
            const existing = await Absence.findOne({ organizationId: orgId, userId, date: new Date(cursor) });
            if (!existing) {
                const absence = await Absence.create({
                    organizationId: orgId,
                    userId,
                    userName: user.name,
                    userAvatar: user.avatar,
                    date: new Date(cursor),
                    type,
                    title: title?.trim(),
                    note: note?.trim(),
                    otherText: type === 'other' ? otherText?.trim() : undefined,
                    status,
                });
                created.push(absence);
            }
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }

        if (requiresApproval) {
            // Notify admins of the range request
            const admins = await User.find({ organizationId: orgId, role: { $in: ['admin', 'super_admin'] } }).select('_id').lean();
            const rangeLabel = `${date} → ${endDate}`;
            await Promise.all(admins.map(admin =>
                Notification.create({
                    userId: admin._id,
                    organizationId: orgId,
                    type: 'system_announcement',
                    title: 'Absence Request',
                    message: `${user.name} requested ${type} from ${rangeLabel}`,
                    metadata: { absenceType: type, fromDate: date, toDate: endDate, requesterId: userId },
                })
            ));
        }

        return res.status(201).json(new ApiResponse(201, created, 'Absences created'));
    }

    // Single day
    const existing = await Absence.findOne({ organizationId: orgId, userId, date: startDate });
    if (existing) throw new ApiError(409, 'You already have an entry for this date');

    const absence = await Absence.create({
        organizationId: orgId,
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        date: startDate,
        type,
        title: title?.trim(),
        note: note?.trim(),
        otherText: type === 'other' ? otherText?.trim() : undefined,
        status,
    });

    if (requiresApproval) {
        const admins = await User.find({ organizationId: orgId, role: { $in: ['admin', 'super_admin'] } }).select('_id').lean();
        await Promise.all(admins.map(admin =>
            Notification.create({
                userId: admin._id,
                organizationId: orgId,
                type: 'system_announcement',
                title: 'Absence Request',
                message: `${user.name} requested ${type} on ${date}`,
                metadata: { absenceId: absence._id, absenceType: type, date, requesterId: userId },
            })
        ));
    }

    res.status(201).json(new ApiResponse(201, absence, 'Absence created'));
});

const updateAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { title, note, otherText } = req.body;

    const absence = await Absence.findOne({ _id: id, organizationId: orgId });
    if (!absence) throw new ApiError(404, 'Absence not found');

    const isOwner = absence.userId.toString() === user._id.toString();
    if (!isOwner) throw new ApiError(403, 'Not authorized');

    if (title !== undefined) absence.title = title?.trim();
    if (note !== undefined) absence.note = note?.trim();
    if (otherText !== undefined) absence.otherText = otherText?.trim();

    await absence.save();
    res.json(new ApiResponse(200, absence, 'Absence updated'));
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

const approveAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can approve absences');

    const absence = await Absence.findOne({ _id: id, organizationId: orgId });
    if (!absence) throw new ApiError(404, 'Absence not found');
    if (absence.status !== 'pending') throw new ApiError(400, 'Absence is not pending');

    absence.status = 'approved';
    absence.approvedBy = user._id;
    absence.approvedAt = new Date();
    await absence.save();

    // Notify the requester
    await Notification.create({
        userId: absence.userId,
        organizationId: orgId,
        type: 'absence_approved',
        title: 'Absence Approved',
        message: `Your ${absence.type} on ${absence.date.toISOString().split('T')[0]} was approved`,
        metadata: { absenceId: absence._id, approvedBy: user.name },
    });

    emitToUser(absence.userId.toString(), 'absence:approved', { absenceId: id });
    emitToOrg(orgId, 'absence:status_changed', { absenceId: id, status: 'approved' });

    res.json(new ApiResponse(200, absence, 'Absence approved'));
});

const rejectAbsence = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { reason } = req.body;

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isAdmin) throw new ApiError(403, 'Only admins can reject absences');

    const absence = await Absence.findOne({ _id: id, organizationId: orgId });
    if (!absence) throw new ApiError(404, 'Absence not found');
    if (absence.status !== 'pending') throw new ApiError(400, 'Absence is not pending');

    absence.status = 'rejected';
    absence.rejectedReason = reason?.trim() || null;
    await absence.save();

    await Notification.create({
        userId: absence.userId,
        organizationId: orgId,
        type: 'absence_rejected',
        title: 'Absence Request Rejected',
        message: `Your ${absence.type} on ${absence.date.toISOString().split('T')[0]} was not approved${reason ? ': ' + reason : ''}`,
        metadata: { absenceId: absence._id, rejectedBy: user.name },
    });

    emitToUser(absence.userId.toString(), 'absence:rejected', { absenceId: id });
    emitToOrg(orgId, 'absence:status_changed', { absenceId: id, status: 'rejected' });

    res.json(new ApiResponse(200, absence, 'Absence rejected'));
});

const uploadAbsenceProof = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) throw new ApiError(400, 'No files provided');

    const absence = await Absence.findOne({ _id: id, organizationId: orgId });
    if (!absence) throw new ApiError(404, 'Absence not found');

    const isOwner = absence.userId.toString() === user._id.toString();
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isOwner && !isAdmin) throw new ApiError(403, 'Not authorized');

    const uploaded = [];
    for (const file of files) {
        const fileUrl = await storageService.upload(file, 'absence-proofs', BucketType.PRIVATE);
        const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
        uploaded.push({
            url: fileKey,
            fileKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
        });
    }

    absence.proofAttachments.push(...uploaded);
    await absence.save();

    res.json(new ApiResponse(200, absence, 'Proof uploaded'));
});

// ── Board Notes ───────────────────────────────────────────────────────────────

const getBoardNotes = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const now = new Date();

    const notes = await BoardNote.find({
        organizationId: orgId,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
        .sort({ pinned: -1, sortOrder: 1, createdAt: -1 })
        .limit(80)
        .lean();

    await Promise.all(notes.map(async (note) => {
        if (note.attachments?.length) {
            await Promise.all(note.attachments.map(async (att: any) => {
                const signed = await storageService.getSignedUrl(att.fileKey || att.url);
                if (signed) att.url = signed;
            }));
        }
    }));

    const allAckedIds = [...new Set(notes.flatMap(n => (n.ackedBy || []).map((id: any) => id.toString())))];
    if (allAckedIds.length > 0) {
        const ackedUsers = await User.find({ _id: { $in: allAckedIds } }).select('name avatar').lean();
        const ackedUserMap = new Map(ackedUsers.map(u => [u._id.toString(), { name: u.name, avatar: (u as any).avatar }]));
        notes.forEach((note: any) => {
            note.ackedByDetails = (note.ackedBy || []).map((uid: any) =>
                ackedUserMap.get(uid.toString()) || { name: 'Unknown' }
            );
        });
    } else {
        notes.forEach((note: any) => { note.ackedByDetails = []; });
    }

    res.json(new ApiResponse(200, notes, 'Board notes fetched'));
});

const createBoardNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { content, color, title, durationDays, announcementType, emoji, requiresAck } = req.body;

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
        announcementType: announcementType || 'general',
        emoji: emoji || undefined,
        requiresAck: !!requiresAck,
    });

    emitToOrg(orgId, 'board:new_note', {
        _id: note._id,
        title: note.title,
        content: note.content.slice(0, 80),
        announcementType: note.announcementType,
        userName: note.userName,
    });

    const notifRecipients = await User.find({
        organizationId: orgId,
        _id: { $ne: user._id },
        role: { $in: ['employee', 'admin', 'super_admin'] },
    }).select('_id').lean();

    if (notifRecipients.length > 0) {
        const preview = note.title || note.content.slice(0, 60);
        const prefix = note.announcementType === 'urgent' ? '🚨 URGENT: ' : note.announcementType === 'important' ? '⚠️ Important: ' : '📌 ';
        await Notification.insertMany(notifRecipients.map(m => ({
            userId: m._id,
            organizationId: orgId,
            type: 'board_note_posted',
            title: `${prefix}${preview}`,
            message: `${user.name} posted to the Team Board`,
            metadata: { noteId: note._id, announcementType: note.announcementType },
        })));
    }

    res.status(201).json(new ApiResponse(201, note, 'Note created'));
});

const updateBoardNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { title, content, color, emoji, postedAt } = req.body;

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    const isOwner = note.userId.toString() === user._id.toString();
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isOwner) throw new ApiError(403, 'Only the creator can edit this note');

    if (title !== undefined) note.title = title?.trim() || undefined;
    if (content?.trim()) note.content = content.trim();
    if (color) note.color = color;
    if (emoji !== undefined) note.emoji = emoji || undefined;
    if (postedAt !== undefined && (isOwner || isAdmin)) {
        note.postedAt = postedAt ? new Date(postedAt) : null;
    }

    await note.save();
    res.json(new ApiResponse(200, note, 'Note updated'));
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

const reorderBoardNotes = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { orderedIds } = req.body as { orderedIds: string[] };

    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedIds must be an array');

    await Promise.all(
        orderedIds.map((id, index) =>
            BoardNote.updateOne({ _id: id, organizationId: orgId }, { sortOrder: index })
        )
    );

    res.json(new ApiResponse(200, null, 'Order updated'));
});

const ackBoardNote = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    const userId = user._id;
    const alreadyAcked = note.ackedBy.some(uid => uid.toString() === userId.toString());
    if (!alreadyAcked) {
        note.ackedBy.push(userId);
        await note.save();
    }

    emitToOrg(orgId, 'board:acked', { noteId: id, userId: userId.toString() });

    res.json(new ApiResponse(200, { ackedBy: note.ackedBy }, 'Acknowledged'));
});

const uploadBoardNoteAttachments = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) throw new ApiError(400, 'No files provided');

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    const isOwner = note.userId.toString() === user._id.toString();
    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    if (!isOwner && !isAdmin) throw new ApiError(403, 'Not authorized');

    if (note.attachments.length + files.length > 3) {
        throw new ApiError(400, 'Maximum 3 images per note');
    }

    const uploaded = [];
    for (const file of files) {
        const fileUrl = await storageService.upload(file, 'board-attachments', BucketType.PRIVATE);
        const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
        uploaded.push({
            url: fileKey,
            fileKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
        });
    }

    note.attachments.push(...uploaded);
    await note.save();

    res.json(new ApiResponse(200, note, 'Attachments added'));
});

// ── Board Note Reactions ──────────────────────────────────────────────────────

const getBoardNoteReactions = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { id } = req.params;

    const reactions = await FeedReaction.find({ targetId: id, targetType: 'board_note' }).lean();
    res.json(new ApiResponse(200, reactions, 'Reactions fetched'));
});

const toggleBoardNoteReaction = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { reaction } = req.body;

    if (!REACTION_TYPES.includes(reaction)) throw new ApiError(400, 'Invalid reaction type');

    const note = await BoardNote.findOne({ _id: id, organizationId: orgId });
    if (!note) throw new ApiError(404, 'Note not found');

    const existing = await FeedReaction.findOne({ targetId: id, userId: user._id });
    if (existing) {
        if (existing.reaction === reaction) {
            await existing.deleteOne();
            emitToOrg(orgId, 'board:reaction_removed', { noteId: id, userId: user._id.toString(), reaction });
            return res.json(new ApiResponse(200, null, 'Reaction removed'));
        }
        existing.reaction = reaction;
        await existing.save();
    } else {
        await FeedReaction.create({
            organizationId: orgId,
            userId: user._id,
            authorName: user.name,
            targetType: 'board_note',
            targetId: id,
            reaction,
        });
    }

    emitToOrg(orgId, 'board:reaction_added', { noteId: id, userId: user._id.toString(), reaction });
    res.json(new ApiResponse(200, { reaction }, 'Reaction saved'));
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

const getLeaderboard = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { period = 'week' } = req.query;

    const now = new Date();
    let fromDate = new Date();
    if (period === 'today') {
        fromDate.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
        fromDate.setDate(now.getDate() - 7);
    } else if (period === 'month') {
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const orgObjectId = new mongoose.Types.ObjectId(orgId);

    const rawLogs = await ActivityLog.aggregate([
        { $match: { timestamp: { $gte: fromDate } } },
        {
            $lookup: {
                from: 'crmusers',
                localField: 'userId',
                foreignField: '_id',
                as: 'crmUser',
            },
        },
        {
            $lookup: {
                from: 'users',
                localField: 'crmUser.userId',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $match: { 'user.organizationId': orgObjectId } },
        {
            $group: {
                _id: '$userId',
                totalScore: { $sum: { $ifNull: ['$score', 1] } },
                activityCount: { $sum: 1 },
                userName: { $first: { $arrayElemAt: ['$user.name', 0] } },
                userAvatar: { $first: { $arrayElemAt: ['$user.avatar', 0] } },
            },
        },
        { $sort: { totalScore: -1 } },
        { $limit: 20 },
    ]);

    res.json(new ApiResponse(200, rawLogs, 'Leaderboard fetched'));
});

const getPerformanceStats = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { period = 'month' } = req.query;

    const now = new Date();
    let fromDate = new Date();
    if (period === 'week') {
        fromDate.setDate(now.getDate() - 7);
    } else if (period === 'month') {
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === 'quarter') {
        fromDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    }

    const members = await User.find({
        organizationId: orgId,
        role: { $in: ['employee', 'admin', 'super_admin'] },
    }).select('_id name avatar').lean();

    res.json(new ApiResponse(200, { members, period, fromDate }, 'Performance stats fetched'));
});

// ── Ping ──────────────────────────────────────────────────────────────────────

const pingMember = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { userId: targetId } = req.params;
    const { message } = req.body;

    if (targetId === user._id.toString()) throw new ApiError(400, 'Cannot ping yourself');

    if (!canPing(user._id.toString(), targetId)) {
        throw new ApiError(429, 'Too many pings — max 3 per hour to the same person');
    }

    const target = await User.findOne({ _id: targetId, organizationId: orgId }).select('_id name').lean();
    if (!target) throw new ApiError(404, 'User not found');

    await Notification.create({
        userId: targetId,
        organizationId: orgId,
        type: 'ping',
        title: `Ping from ${user.name}`,
        message: message?.trim() || `${user.name} pinged you`,
        metadata: { fromUserId: user._id, fromUserName: user.name, fromUserAvatar: user.avatar },
    });

    emitToUser(targetId, 'ping:received', {
        fromUserId: user._id,
        fromUserName: user.name,
        fromUserAvatar: user.avatar,
        message: message?.trim() || null,
    });

    res.json(new ApiResponse(200, null, 'Ping sent'));
});

// ── Activity Feed ─────────────────────────────────────────────────────────────

const getActivityFeed = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 80, 200);
    const before = req.query.before ? new Date(req.query.before as string) : undefined;

    const query: any = { organizationId: orgId };
    if (before) query.createdAt = { $lt: before };

    const events = await PresenceEvent.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    res.json(new ApiResponse(200, events, 'Activity feed fetched'));
});

const startBreak = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const userId = user._id.toString();

    const now = new Date();
    await User.findByIdAndUpdate(userId, {
        'breakStatus.isOnBreak': true,
        'breakStatus.startedAt': now,
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'break_start',
        description: `${user.name} started a break`,
        meta: { startedAt: now.toISOString() },
    });

    emitToOrg(orgId, 'presence_update', {
        userId,
        breakStatus: { isOnBreak: true, startedAt: now.toISOString() },
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { breakStatus: { isOnBreak: true, startedAt: now } }, 'Break started'));
});

const endBreak = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const userId = user._id.toString();

    const current = await User.findById(userId).select('breakStatus').lean();
    const durationMin = current?.breakStatus?.startedAt
        ? Math.round((Date.now() - new Date(current.breakStatus.startedAt).getTime()) / 60000)
        : 0;

    await User.findByIdAndUpdate(userId, {
        'breakStatus.isOnBreak': false,
        $unset: { 'breakStatus.startedAt': '' },
    });

    const event = await PresenceEvent.create({
        organizationId: orgId,
        userId,
        userName: user.name,
        userAvatar: user.avatar,
        type: 'break_end',
        description: `${user.name} returned from break`,
        meta: { durationMin },
    });

    emitToOrg(orgId, 'presence_update', {
        userId,
        breakStatus: { isOnBreak: false },
    });
    emitToOrg(orgId, 'activity:new', event);

    res.json(new ApiResponse(200, { durationMin }, 'Break ended'));
});

export default {
    getMembers, setEmploymentLocationType,
    getAbsences, createAbsence, updateAbsence, deleteAbsence,
    approveAbsence, rejectAbsence, uploadAbsenceProof,
    getBoardNotes, createBoardNote, updateBoardNote, deleteBoardNote, togglePinNote, reorderBoardNotes,
    ackBoardNote, uploadBoardNoteAttachments,
    getBoardNoteReactions, toggleBoardNoteReaction,
    getLeaderboard, getPerformanceStats,
    pingMember,
    getActivityFeed, startBreak, endBreak,
};
