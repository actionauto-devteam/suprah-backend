import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import ServiceSlot from '../models/ServiceSlot.model';
import Appointment from '../models/Appointment.model';
import { emitToOrg } from '../utils/socketEmitter';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toMidnightUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function parseTimeToLabel(time: string): string {
  const [hStr, mStr] = time.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const mins = m === 0 ? '' : `:${mStr}`;
  return `${hour12}${mins} ${suffix}`;
}

// ─── CRM: Get all slots for a month ──────────────────────────────────────────
export const getCrmSlots = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization linked to your account.');

  const { month } = req.query; // "2026-06"
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new ApiError(400, 'month query param required, format: YYYY-MM');
  }

  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1)); // exclusive

  const slots = await ServiceSlot.find({
    organizationId: orgId,
    date: { $gte: start, $lt: end },
  }).sort({ date: 1, time: 1 }).lean();

  res.json(new ApiResponse(200, slots, 'Slots fetched'));
});

// ─── CRM: Create a slot ───────────────────────────────────────────────────────
export const createSlot = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization linked to your account.');

  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'CRM authentication required.');

  const { date, time, maxBookings } = req.body as {
    date?: string;
    time?: string;
    maxBookings?: number | string;
  };

  if (!date || !time) throw new ApiError(400, 'date and time are required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(time)) throw new ApiError(400, 'time must be HH:MM (24-hour)');

  const dateUTC = toMidnightUTC(date);
  const max = maxBookings !== undefined ? Number(maxBookings) : 1;
  if (Number.isNaN(max) || max < 1) throw new ApiError(400, 'maxBookings must be >= 1');

  const label = parseTimeToLabel(time);

  const slot = await ServiceSlot.create({
    organizationId: orgId,
    date: dateUTC,
    time,
    label,
    maxBookings: max,
    currentBookings: 0,
    isBlocked: false,
    createdBy: actor.fullName,
  });

  emitToOrg(orgId.toString(), 'slot:created', slot);
  res.status(201).json(new ApiResponse(201, slot, 'Slot created'));
});

// ─── CRM: Update a slot (block/unblock, maxBookings, time) ───────────────────
export const updateSlot = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization linked to your account.');

  const { id } = req.params;
  const { isBlocked, maxBookings, time } = req.body as {
    isBlocked?: boolean;
    maxBookings?: number | string;
    time?: string;
  };

  const updates: Record<string, unknown> = {};
  if (isBlocked !== undefined) updates.isBlocked = Boolean(isBlocked);
  if (maxBookings !== undefined) {
    const max = Number(maxBookings);
    if (Number.isNaN(max) || max < 1) throw new ApiError(400, 'maxBookings must be >= 1');
    updates.maxBookings = max;
  }
  if (time !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(time)) throw new ApiError(400, 'time must be HH:MM');
    updates.time = time;
    updates.label = parseTimeToLabel(time);
  }

  const slot = await ServiceSlot.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    updates,
    { new: true }
  );
  if (!slot) throw new ApiError(404, 'Slot not found');

  emitToOrg(orgId.toString(), 'slot:updated', slot);
  res.json(new ApiResponse(200, slot, 'Slot updated'));
});

// ─── CRM: Delete a slot ───────────────────────────────────────────────────────
export const deleteSlot = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization linked to your account.');

  const { id } = req.params;
  const slot = await ServiceSlot.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!slot) throw new ApiError(404, 'Slot not found');

  emitToOrg(orgId.toString(), 'slot:deleted', { _id: id, date: slot.date, time: slot.time });
  res.json(new ApiResponse(200, null, 'Slot deleted'));
});

// ─── Customer: Available slots for a specific date ───────────────────────────
export const getAvailableSlots = asyncHandler(async (req: Request, res: Response) => {
  // service.route.ts does not use requireOrg, so derive orgId from the user record directly
  const orgId = req.orgId ?? (req.user as any)?.organizationId?.toString();
  if (!orgId) {
    res.json(new ApiResponse(200, [], 'No organization linked — no slots available'));
    return;
  }

  const { date } = req.query;
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, 'date query param required, format: YYYY-MM-DD');
  }

  const dateUTC = toMidnightUTC(date);
  const nextDay = new Date(dateUTC.getTime() + 86400000);

  const slots = await ServiceSlot.find({
    organizationId: orgId,
    date: { $gte: dateUTC, $lt: nextDay },
    isBlocked: false,
  }).sort({ time: 1 }).lean();

  const available = slots.map((s) => ({
    _id: s._id,
    time: s.time,
    label: s.label,
    maxBookings: s.maxBookings,
    currentBookings: s.currentBookings,
    isFull: s.currentBookings >= s.maxBookings,
  }));

  res.json(new ApiResponse(200, available, 'Available slots fetched'));
});

// ─── Customer: Month availability map ────────────────────────────────────────
// Returns ISO date strings that have at least one available (not-full, not-blocked) slot.
export const getMonthAvailability = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId ?? (req.user as any)?.organizationId?.toString();
  if (!orgId) {
    res.json(new ApiResponse(200, [], 'No organization linked — no slots available'));
    return;
  }

  const { month } = req.query;
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new ApiError(400, 'month query param required, format: YYYY-MM');
  }

  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));

  const slots = await ServiceSlot.find({
    organizationId: orgId,
    date: { $gte: start, $lt: end },
    isBlocked: false,
    $expr: { $lt: ['$currentBookings', '$maxBookings'] },
  }).select('date').lean();

  const uniqueDates = [...new Set(
    slots.map((s) => {
      const d = new Date(s.date);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    })
  )];

  res.json(new ApiResponse(200, uniqueDates, 'Month availability fetched'));
});

// ─── CRM: Customer bookings for a specific date ───────────────────────────────
// Returns service appointments booked by customers on the given calendar day.
export const getDateBookings = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'No organization linked to your account.');

  const { date } = req.query;
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, 'date query param required, format: YYYY-MM-DD');
  }

  const startOfDay = toMidnightUTC(date);
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  const bookings = await Appointment.find({
    organizationId: orgId,
    startTime: { $gte: startOfDay, $lt: endOfDay },
    $or: [
      { 'customerBooking.isCustomerBooking': true },
      { type: 'service', createdByModel: 'User' },
    ],
  })
    .populate('createdBy', 'name email avatarUrl avatar')
    .sort({ startTime: 1 })
    .lean();

  const result = bookings.map((b: any) => ({
    _id: b._id,
    title: b.title,
    startTime: b.startTime,
    status: b.status,
    notes: b.notes,
    customer: b.createdBy
      ? {
          _id: b.createdBy._id,
          name: b.createdBy.name || 'Unknown',
          email: b.createdBy.email || '',
          avatar: b.createdBy.avatarUrl || b.createdBy.avatar || null,
        }
      : null,
  }));

  res.json(new ApiResponse(200, result, 'Date bookings fetched'));
});
