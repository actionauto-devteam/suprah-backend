import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DayPulse, { DAYPULSE_DEPARTMENTS, DayPulseDepartment } from '../models/Daypulse.model';
import FeedComment from '../models/FeedComment.model';
import FeedReaction from '../models/FeedReaction.model';
import { getIO } from '../socket/feedSocket';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

// ─── Utility ──────────────────────────────────────────────────────────────────

function parsePositiveInt(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

/**
 * Normalises a date string to midnight UTC of that calendar day.
 * e.g. "2024-07-15" → 2024-07-15T00:00:00.000Z
 */
function toMidnightUTC(dateStr: string): Date {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error('Invalid date');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Returns a { $gte, $lt } range that covers the entire calendar day in UTC.
 */
function dayRange(date: Date): { $gte: Date; $lt: Date } {
  const start = new Date(date);
  const end   = new Date(date);
  end.setUTCDate(end.getUTCDate() + 1);
  return { $gte: start, $lt: end };
}

// ─── Create DayPulse Report ───────────────────────────────────────────────────

/**
 * POST /api/crm/daypulse
 *
 * Creates a structured daily report with three required sections.
 * The report is scoped to a department (hashtag) and a reportDate.
 * Emits `daypulse:new` to the org room for real-time feed updates.
 */
export const createReport = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization to post');

  const { department, reportDate, accomplishment, blockers, inProgress } = req.body;

  // ── Validate department ──
  if (!department || !DAYPULSE_DEPARTMENTS.includes(department as DayPulseDepartment)) {
    throw new ApiError(
      400,
      `department must be one of: ${DAYPULSE_DEPARTMENTS.join(', ')}`
    );
  }

  // ── Validate date ──
  if (!reportDate) throw new ApiError(400, 'reportDate is required');
  let parsedDate: Date;
  try {
    parsedDate = toMidnightUTC(reportDate);
  } catch {
    throw new ApiError(400, 'reportDate must be a valid date string (YYYY-MM-DD)');
  }

  // ── Validate structured sections ──
  if (!accomplishment || !accomplishment.trim()) {
    throw new ApiError(400, 'Accomplishment section cannot be empty');
  }
  if (accomplishment.trim().length > 5000) {
    throw new ApiError(400, 'Accomplishment cannot exceed 5000 characters');
  }
  if (!blockers || !blockers.trim()) {
    throw new ApiError(400, 'Blockers section cannot be empty');
  }
  if (blockers.trim().length > 5000) {
    throw new ApiError(400, 'Blockers cannot exceed 5000 characters');
  }
  if (!inProgress || !inProgress.trim()) {
    throw new ApiError(400, 'In Progress section cannot be empty');
  }
  if (inProgress.trim().length > 5000) {
    throw new ApiError(400, 'In Progress cannot exceed 5000 characters');
  }

  const report = await DayPulse.create({
    organizationId: actor.organizationId,
    userId:         actor._id,
    authorName:     actor.fullName,
    authorAvatar:   actor.avatar || null,
    authorRole:     actor.role,
    department:     department as DayPulseDepartment,
    reportDate:     parsedDate,
    accomplishment: accomplishment.trim(),
    blockers:       blockers.trim(),
    inProgress:     inProgress.trim(),
    isEdited:       false,
  });

  try {
    getIO()
      .to(`org:${actor.organizationId.toString()}`)
      .emit('daypulse:new', { report });
  } catch { /* Socket.IO not initialised */ }

  res.status(201).json(new ApiResponse(201, { report }, 'DayPulse report created'));
});

// ─── Get Reports (paginated, filtered by department + date) ───────────────────

/**
 * GET /api/crm/daypulse?department=SalesAndFinance&date=2024-07-15&page=1&limit=20
 *
 * Returns paginated reports for a department on a given date.
 * Both `department` and `date` are optional — omitting them returns all live
 * reports for the org (useful for org-wide date views).
 */
export const getReports = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const { department, date } = req.query as { department?: string; date?: string };

  const page  = parsePositiveInt(req.query.page,  1);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip  = (page - 1) * limit;

  // Build filter incrementally
  const filter: Record<string, unknown> = {
    organizationId: actor.organizationId,
    deletedAt: null,
  };

  if (department) {
    if (!DAYPULSE_DEPARTMENTS.includes(department as DayPulseDepartment)) {
      throw new ApiError(400, `Invalid department: ${department}`);
    }
    filter.department = department;
  }

  if (date) {
    try {
      const d = toMidnightUTC(date);
      filter.reportDate = dayRange(d);
    } catch {
      throw new ApiError(400, 'date must be a valid date string (YYYY-MM-DD)');
    }
  }

  const [reports, total] = await Promise.all([
    DayPulse.find(filter).sort({ reportDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    DayPulse.countDocuments(filter),
  ]);

  const hasMore = skip + reports.length < total;

  res.json(new ApiResponse(200, { reports, total, page, limit, hasMore }, 'DayPulse reports fetched'));
});

// ─── Update Report ────────────────────────────────────────────────────────────

/**
 * PUT /api/crm/daypulse/:id
 *
 * Allows the report owner (or admin) to edit all three sections.
 * Sets `isEdited: true` and emits `daypulse:updated`.
 */
export const updateReport = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid report ID');

  const { accomplishment, blockers, inProgress } = req.body;

  if (!accomplishment || !accomplishment.trim()) throw new ApiError(400, 'Accomplishment section cannot be empty');
  if (!blockers       || !blockers.trim())       throw new ApiError(400, 'Blockers section cannot be empty');
  if (!inProgress     || !inProgress.trim())     throw new ApiError(400, 'In Progress section cannot be empty');

  if (accomplishment.trim().length > 5000) throw new ApiError(400, 'Accomplishment cannot exceed 5000 characters');
  if (blockers.trim().length > 5000)       throw new ApiError(400, 'Blockers cannot exceed 5000 characters');
  if (inProgress.trim().length > 5000)     throw new ApiError(400, 'In Progress cannot exceed 5000 characters');

  const report = await DayPulse.findOne({ _id: id, deletedAt: null });
  if (!report) throw new ApiError(404, 'Report not found');

  const isOwner = report.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only edit your own reports');

  report.accomplishment = accomplishment.trim();
  report.blockers       = blockers.trim();
  report.inProgress     = inProgress.trim();
  report.isEdited       = true;
  await report.save();

  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('daypulse:updated', { report });
  } catch { /* swallow */ }

  res.json(new ApiResponse(200, { report }, 'Report updated'));
});

// ─── Delete Report ────────────────────────────────────────────────────────────

/**
 * DELETE /api/crm/daypulse/:id
 *
 * Soft-deletes a report. Emits `daypulse:deleted` to the org room.
 * Permission: owner OR admin.
 */
export const deleteReport = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid report ID');

  const report = await DayPulse.findOne({ _id: id, deletedAt: null });
  if (!report) throw new ApiError(404, 'Report not found');

  const isOwner = report.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only delete your own reports');

  report.deletedAt = new Date();
  await report.save();

  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('daypulse:deleted', { reportId: id });
  } catch { /* swallow */ }

  res.json(new ApiResponse(200, { reportId: id }, 'Report deleted'));
});

// ─── Get Available Report Dates (for a department) ────────────────────────────

/**
 * GET /api/crm/daypulse/dates?department=SalesAndFinance
 *
 * Returns a list of distinct reportDate values (as ISO strings) that have
 * at least one live report for the given department. Used by the date-picker
 * to highlight active days on the calendar.
 */
export const getReportDates = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization');

  const { department } = req.query as { department?: string };

  const matchFilter: Record<string, unknown> = {
    organizationId: actor.organizationId,
    deletedAt: null,
  };

  if (department) {
    if (!DAYPULSE_DEPARTMENTS.includes(department as DayPulseDepartment)) {
      throw new ApiError(400, `Invalid department: ${department}`);
    }
    matchFilter.department = department;
  }

  const dates = await DayPulse.distinct('reportDate', matchFilter);

  // Sort newest-first and return as ISO date strings
  const sorted = (dates as Date[])
    .sort((a, b) => b.getTime() - a.getTime())
    .map((d) => d.toISOString().split('T')[0]);

  res.json(new ApiResponse(200, { dates: sorted }, 'Available report dates fetched'));
});

export default { createReport, getReports, updateReport, deleteReport, getReportDates };