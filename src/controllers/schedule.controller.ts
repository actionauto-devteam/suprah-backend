import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User, { IUser } from '../models/User.model';
import Shift from '../models/Shift.model';
import { emitToOrg } from '../utils/socketEmitter';

const getShifts = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { year, month, week } = req.query;

    let from: Date, to: Date;
    if (week) {
        const weekStart = new Date(week as string);
        weekStart.setHours(0, 0, 0, 0);
        from = weekStart;
        to = new Date(weekStart);
        to.setDate(to.getDate() + 6);
        to.setHours(23, 59, 59, 999);
    } else {
        const y = parseInt(year as string) || new Date().getFullYear();
        const m = parseInt(month as string) || new Date().getMonth() + 1;
        from = new Date(y, m - 1, 1);
        to = new Date(y, m, 0, 23, 59, 59);
    }

    const shifts = await Shift.find({
        organizationId: orgId,
        date: { $gte: from, $lte: to },
    }).sort({ date: 1, startTime: 1 }).lean();

    res.json(new ApiResponse(200, shifts, 'Shifts fetched'));
});

const createShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { userId, date, startTime, endTime, shiftType, role, location, note } = req.body;

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const targetUserId = isAdmin && userId ? userId : user._id.toString();

    if (!date || !startTime || !endTime) throw new ApiError(400, 'date, startTime, endTime are required');

    const targetUser = await User.findOne({ _id: targetUserId, organizationId: orgId }).select('name avatar').lean();
    if (!targetUser) throw new ApiError(404, 'User not found');

    function parseDate(s: string): Date {
        const [y, mo, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    }

    const shift = await Shift.create({
        organizationId: orgId,
        userId: targetUserId,
        userName: targetUser.name,
        userAvatar: targetUser.avatar || null,
        date: parseDate(date as string),
        startTime,
        endTime,
        shiftType: shiftType || 'custom',
        role: role?.trim(),
        location: location?.trim(),
        note: note?.trim(),
        createdBy: user._id,
        createdByName: user.name,
    });

    emitToOrg(orgId, 'shift:created', { _id: shift._id, userId: targetUserId, date });
    res.status(201).json(new ApiResponse(201, shift, 'Shift created'));
});

const updateShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;
    const { startTime, endTime, shiftType, role, location, note } = req.body;

    const shift = await Shift.findOne({ _id: id, organizationId: orgId });
    if (!shift) throw new ApiError(404, 'Shift not found');

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const isOwner = shift.userId.toString() === user._id.toString();
    if (!isAdmin && !isOwner) throw new ApiError(403, 'Not authorized');

    if (startTime) shift.startTime = startTime;
    if (endTime) shift.endTime = endTime;
    if (shiftType) shift.shiftType = shiftType;
    if (role !== undefined) shift.role = role?.trim();
    if (location !== undefined) shift.location = location?.trim();
    if (note !== undefined) shift.note = note?.trim();

    await shift.save();
    emitToOrg(orgId, 'shift:updated', { _id: shift._id });
    res.json(new ApiResponse(200, shift, 'Shift updated'));
});

const deleteShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as IUser;
    const orgId = req.orgId as string;
    const { id } = req.params;

    const shift = await Shift.findOne({ _id: id, organizationId: orgId });
    if (!shift) throw new ApiError(404, 'Shift not found');

    const isAdmin = ['admin', 'super_admin'].includes(user.role);
    const isOwner = shift.userId.toString() === user._id.toString();
    if (!isAdmin && !isOwner) throw new ApiError(403, 'Not authorized');

    await shift.deleteOne();
    emitToOrg(orgId, 'shift:deleted', { _id: id });
    res.json(new ApiResponse(200, null, 'Shift deleted'));
});

export default { getShifts, createShift, updateShift, deleteShift };
