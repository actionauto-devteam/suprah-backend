import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DayPulse, { DAYPULSE_DEPARTMENTS, DayPulseAttachmentSection, DayPulseDepartment, IDayPulseAttachment } from '../models/Daypulse.model';
import FeedComment from '../models/FeedComment.model';
import FeedReaction from '../models/FeedReaction.model';
import { getIO } from '../socket/feedSocket';
import { BucketType, storageService } from '../services/storage.service';


const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DAYPULSE_SECTION_MAX_LENGTH = 10000;
const DAYPULSE_ATTACHMENT_FIELDS: Array<{ field: string; section: DayPulseAttachmentSection }> = [
  { field: 'attachmentsAccomplishment', section: 'accomplishment' },
  { field: 'attachmentsBlockers', section: 'blockers' },
  { field: 'attachmentsInProgress', section: 'inProgress' },
];


function parsePositiveInt(val: unknown, fallback: number): number {
  const n = parseInt(val as string, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

function toMidnightUTC(dateStr: string): Date {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error('Invalid date');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayRange(date: Date): { $gte: Date; $lt: Date } {
  const start = new Date(date);
  const end = new Date(date);
  end.setUTCDate(end.getUTCDate() + 1);
  return { $gte: start, $lt: end };
}

async function signAttachments<T extends { attachments?: IDayPulseAttachment[] }>(report: T): Promise<T> {
  if (!Array.isArray(report.attachments) || report.attachments.length === 0) {
    return report;
  }

  await Promise.all(report.attachments.map(async (attachment) => {
    const signedUrl = await storageService.getSignedUrl(attachment.fileKey || attachment.url);
    if (signedUrl) {
      attachment.url = signedUrl;
      if (attachment.thumbnailUrl) {
        attachment.thumbnailUrl = signedUrl;
      }
    }
  }));

  return report;
}


export const createReport = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'You must belong to an organization to post');

  const { department, reportDate, accomplishment, blockers, inProgress } = req.body;
  const uploadedFiles = (req.files || {}) as Record<string, Express.Multer.File[]>;
  const attachments: IDayPulseAttachment[] = [];
  const uploadedKeys: string[] = [];

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
  if (accomplishment.trim().length > DAYPULSE_SECTION_MAX_LENGTH) {
    throw new ApiError(400, `Accomplishment cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);
  }
  if (!blockers || !blockers.trim()) {
    throw new ApiError(400, 'Blockers section cannot be empty');
  }
  if (blockers.trim().length > DAYPULSE_SECTION_MAX_LENGTH) {
    throw new ApiError(400, `Blockers cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);
  }
  if (!inProgress || !inProgress.trim()) {
    throw new ApiError(400, 'In Progress section cannot be empty');
  }
  if (inProgress.trim().length > DAYPULSE_SECTION_MAX_LENGTH) {
    throw new ApiError(400, `In Progress cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);
  }

  try {
    for (const { field, section } of DAYPULSE_ATTACHMENT_FIELDS) {
      const files = uploadedFiles[field] || [];

      for (const file of files) {
        const fileUrl = await storageService.upload(file, 'daypulse-attachments', BucketType.PRIVATE);
        const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
        uploadedKeys.push(fileKey);

        const isImage = file.mimetype.startsWith('image/');
        attachments.push({
          url: fileKey,
          fileKey,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          thumbnailUrl: isImage ? fileKey : undefined,
          section,
        });
      }
    }

    const report = await DayPulse.create({
      organizationId: actor.organizationId,
      userId: actor._id,
      authorName: actor.fullName,
      authorAvatar: actor.avatar || null,
      authorRole: actor.role,
      department: department as DayPulseDepartment,
      reportDate: parsedDate,
      accomplishment: accomplishment.trim(),
      blockers: blockers.trim(),
      inProgress: inProgress.trim(),
      attachments,
      isEdited: false,
    });

    const reportForClient = await signAttachments(report.toObject());

    try {
      getIO()
        .to(`org:${actor.organizationId.toString()}`)
        .emit('daypulse:new', { report: reportForClient });
    } catch { /* Socket.IO not yet initialised — REST response unaffected */ }

    res.status(201).json(new ApiResponse(201, { report: reportForClient }, 'DayPulse report created'));
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => storageService.delete(key, BucketType.PRIVATE).catch(() => undefined)));
    throw error;
  }
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

  const page = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip = (page - 1) * limit;

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

  const reportsWithAttachments = await Promise.all((reports as Array<Record<string, any>>).map((report) => signAttachments(report)));

  const hasMore = skip + reports.length < total;

  res.json(new ApiResponse(200, { reports: reportsWithAttachments, total, page, limit, hasMore }, 'DayPulse reports fetched'));
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
  if (!blockers || !blockers.trim()) throw new ApiError(400, 'Blockers section cannot be empty');
  if (!inProgress || !inProgress.trim()) throw new ApiError(400, 'In Progress section cannot be empty');

  if (accomplishment.trim().length > DAYPULSE_SECTION_MAX_LENGTH) throw new ApiError(400, `Accomplishment cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);
  if (blockers.trim().length > DAYPULSE_SECTION_MAX_LENGTH) throw new ApiError(400, `Blockers cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);
  if (inProgress.trim().length > DAYPULSE_SECTION_MAX_LENGTH) throw new ApiError(400, `In Progress cannot exceed ${DAYPULSE_SECTION_MAX_LENGTH} characters`);

  const report = await DayPulse.findOne({ _id: id, deletedAt: null });
  if (!report) throw new ApiError(404, 'Report not found');

  const isOwner = report.userId.toString() === actor._id.toString();
  const isAdmin = actor.role === 'admin';
  if (!isOwner && !isAdmin) throw new ApiError(403, 'You can only edit your own reports');

  report.accomplishment = accomplishment.trim();
  report.blockers = blockers.trim();
  report.inProgress = inProgress.trim();
  report.isEdited = true;
  await report.save();

  const reportForClient = await signAttachments(report.toObject());

  try {
    getIO()
      .to(`org:${actor.organizationId!.toString()}`)
      .emit('daypulse:updated', { report: reportForClient });
  } catch { /* swallow */ }

  res.json(new ApiResponse(200, { report: reportForClient }, 'Report updated'));
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

  if (Array.isArray((report as any).attachments) && (report as any).attachments.length > 0) {
    await Promise.all(
      (report as any).attachments.map((attachment: IDayPulseAttachment) =>
        storageService.delete(attachment.fileKey || attachment.url, BucketType.PRIVATE).catch(() => undefined)
      )
    );
  }

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
