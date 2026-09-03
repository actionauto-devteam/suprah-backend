import { Request, Response } from "express";
import { Types } from "mongoose";
import { CalendarEvent } from "../models/calendarEvent.model";
import Appointment from "../models/Appointment.model";
import {
  emitCalendarChange,
} from "../services/calendarSocket.service";
import notificationService from "../services/notification.service";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import ical, { ICalCalendarMethod } from "ical-generator";

/**
 * crmAuth attaches req.crmUser (ICrmUser or synthetic plain object) and
 * req.orgId. Both are required for every calendar route.
 */
function requireAuth(
  req: Request
): { userId: string; orgId: string; fullName: string; role: string } {
  const crmUser = (req as any).crmUser;
  const orgId = (req as any).orgId as string | undefined;
  if (!crmUser?._id || !orgId) {
    throw new ApiError(
      401,
      "Not authenticated — ensure crmAuth() is applied to /calendar routes."
    );
  }
  return {
    userId: String(crmUser._id),
    orgId,
    fullName: crmUser.fullName ?? crmUser.username ?? crmUser.email ?? "A teammate",
    role: crmUser.role ?? "",
  };
}

const isAdminRole = (role: string) => ["admin", "super_admin"].includes(role);

/** True when the only change requested is the caller removing themself from `assignees`. */
function isSelfRemoval(
  body: Record<string, unknown>,
  currentAssignees: string[],
  userId: string
): boolean {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "assignees") return false;
  const next = body.assignees;
  if (!Array.isArray(next)) return false;
  const nextIds = next.map(String).sort();
  const expected = currentAssignees.filter((id) => id !== userId).sort();
  return (
    currentAssignees.includes(userId) &&
    JSON.stringify(nextIds) === JSON.stringify(expected)
  );
}

const VALID_TYPES = ["event", "task", "reminder", "meeting"] as const;
const VALID_STATUSES = ["scheduled", "completed", "cancelled"] as const;
const MAX_FEED_RANGE_DAYS = 120;
const MAX_BULK = 50;

/** Validates the fields present in `body`. `partial` = only validate keys that are actually present (PATCH). */
function assertValidEventInput(
  body: Record<string, unknown>,
  { partial }: { partial: boolean }
): void {
  if (!partial || "type" in body) {
    if (!VALID_TYPES.includes(body.type as any)) {
      throw new ApiError(400, `type must be one of ${VALID_TYPES.join(", ")}.`);
    }
  }
  if (!partial || "title" in body) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new ApiError(400, "A title is required.");
    }
  }
  if (!partial || "start" in body) {
    if (isNaN(new Date(body.start as any).getTime())) {
      throw new ApiError(400, "A valid start date is required.");
    }
  }
  if (!partial || "end" in body) {
    if (isNaN(new Date(body.end as any).getTime())) {
      throw new ApiError(400, "A valid end date is required.");
    }
  }
  // Only enforced when both are present in this request — a PATCH that only
  // touches one of the two can't be range-checked without the existing doc,
  // and the schema's own end >= start validator still guards that narrow case.
  if ("start" in body && "end" in body) {
    if (new Date(body.end as any).getTime() < new Date(body.start as any).getTime()) {
      throw new ApiError(400, "End must be on or after start.");
    }
  }
  if (body.assignees !== undefined) {
    const assignees = body.assignees;
    if (
      !Array.isArray(assignees) ||
      !assignees.every((a) => Types.ObjectId.isValid(a))
    ) {
      throw new ApiError(400, "assignees must be a list of valid user ids.");
    }
  }
}

function assertRangeWithinCap(from: Date, to: Date): void {
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays < 0) {
    throw new ApiError(400, "`from` must be before `to`.");
  }
  if (spanDays > MAX_FEED_RANGE_DAYS) {
    throw new ApiError(
      400,
      `Date range too wide — max ${MAX_FEED_RANGE_DAYS} days.`
    );
  }
}

const POPULATE_USERS = [
  { path: "createdBy", select: "fullName username email" },
  { path: "assignees", select: "fullName username email" },
];

/** Normalised shape both calendars render. */
interface FeedItem {
  id: string;
  source: "calendarEvent" | "appointment";
  type: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  repeatsDailyWindow: boolean;
  dailyStartTime?: string;
  dailyEndTime?: string;
  includedDates?: string[];
  status: string;
  color?: string;
  meetingLink?: string;
  createdBy?: unknown;
  assignees?: unknown[];
  /** Viewer-specific: true when the requester created the item or is an org admin. */
  canEdit?: boolean;
}

/** Socket broadcasts go to many viewers — never carry viewer-specific flags. */
const stripViewerFields = (item: FeedItem): Omit<FeedItem, "canEdit"> => {
  const { canEdit, ...rest } = item;
  return rest;
};

const mapCalendarEvent = (
  doc: any,
  viewerId?: string,
  viewerIsAdmin?: boolean
): FeedItem => ({
  id: String(doc._id),
  source: "calendarEvent",
  type: doc.type,
  title: doc.title,
  description: doc.description,
  start: doc.start,
  end: doc.end,
  allDay: doc.allDay,
  repeatsDailyWindow: doc.repeatsDailyWindow,
  dailyStartTime: doc.dailyStartTime,
  dailyEndTime: doc.dailyEndTime,
  includedDates: doc.includedDates,
  status: doc.status,
  color: doc.color,
  meetingLink: doc.meetingLink,
  createdBy: doc.createdBy,
  assignees: doc.assignees,
  canEdit:
    viewerId !== undefined
      ? String(doc.createdBy?._id ?? doc.createdBy) === viewerId || !!viewerIsAdmin
      : undefined,
});

/** Appointment statuses that don't exist on CalendarEvent collapse into the closest bucket the frontend's stricter union expects — appointments render read-only, so this only affects display grouping, never edit logic. */
const mapAppointmentStatus = (status: string | undefined): FeedItem["status"] => {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "no-show") return "cancelled";
  return "scheduled";
};

/**
 * Appointment has no allDay field of its own. A Google Calendar all-day
 * event (a "date", not a "dateTime") syncs into this collection as UTC
 * midnight → UTC midnight/23:59:59.999 — a timezone-agnostic date, not an
 * instant meant to be read in the org's display timezone. Detecting that
 * shape here (UTC boundaries, ~24h span) is what lets the calendar render
 * it as a compact all-day item instead of a ~24h timed block that
 * splitOccurrencesByDay clips across two calendar days in Mountain time
 * (a "00:00–17:59" remainder on one side, "18:00–midnight" on the other) —
 * which, multiplied across many such synced items (e.g. recurring
 * "<name> On Day Off" entries), used to bury the day's real events under a
 * wall of misclassified timed blocks in Week/Day view.
 */
function isUtcAllDaySpan(start: Date, end: Date): boolean {
  const startsAtUtcMidnight =
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0;
  const durationMs = end.getTime() - start.getTime();
  return startsAtUtcMidnight && durationMs >= 23 * 60 * 60 * 1000;
}

/** Exported so the Appointment controller can reuse it in its emit hooks. */
export const mapAppointment = (doc: any): FeedItem => {
  const customerName = doc.customerBooking
    ? [doc.customerBooking.firstName, doc.customerBooking.lastName].filter(Boolean).join(" ")
    : undefined;
  const start: Date = doc.startTime;
  const end: Date = doc.endTime;
  return {
    id: String(doc._id),
    source: "appointment",
    type: "appointment",
    title: doc.title ?? `Appointment — ${customerName || "Customer"}`,
    description: doc.notes ?? doc.description,
    start,
    end,
    allDay: isUtcAllDaySpan(start, end),
    repeatsDailyWindow: false,
    status: mapAppointmentStatus(doc.status),
    color: "appointment",
    createdBy: doc.createdBy,
    assignees: doc.participants ?? [],
  };
};

/**
 * Persists + pushes a real notification to each assignee via the shared
 * pipeline (bell/page entry, preference gate, web push) — this used to only
 * emit a raw `notification:new` socket event through calendarSocket.service's
 * `ioRef`, which is never wired to the real Socket.IO server (no code calls
 * `setCalendarIO`/`registerCalendarSocket` anywhere), so being assigned to a
 * calendar event/meeting produced zero notification of any kind.
 */
async function pushNotification(opts: {
  userIds: string[];
  title: string;
  body: string;
  link: string;
  orgId: string;
}): Promise<void> {
  await notificationService.createNotificationBatch(
    opts.userIds.map((userId) => ({
      userId,
      organizationId: opts.orgId,
      type: "calendar_event_assigned",
      title: opts.title,
      message: opts.body,
      metadata: { route: opts.link },
    }))
  );
}

const overlapQuery = (from: Date, to: Date) => ({
  start: { $lt: to },
  end: { $gt: from },
});

/**
 * GET /api/calendar/feed?from=ISO&to=ISO
 * Unified feed: calendar items + appointments, merged and sorted.
 */
export const getFeed = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const from = new Date(String(req.query.from));
  const to = new Date(String(req.query.to));
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new ApiError(400, "Valid `from` and `to` are required.");
  }
  assertRangeWithinCap(from, to);

  const organizationId = new Types.ObjectId(auth.orgId);
  const viewerIsAdmin = isAdminRole(auth.role);

  const [events, appointments] = await Promise.all([
    CalendarEvent.find({
      organizationId,
      status: { $ne: "cancelled" },
      deletedAt: null,
      ...overlapQuery(from, to),
    })
      .populate(POPULATE_USERS)
      .lean(),
    // Appointment.organizationId is a plain String field, unlike CalendarEvent's ObjectId.
    Appointment.find({
      organizationId: auth.orgId,
      status: { $ne: "cancelled" },
      startTime: { $lt: to },
      endTime: { $gt: from },
    })
      .populate("participants", "fullName username email")
      .lean(),
  ]);

  const items: FeedItem[] = [
    ...events.map((e) => mapCalendarEvent(e, auth.userId, viewerIsAdmin)),
    ...appointments.map(mapAppointment),
  ].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  res.json({ items });
});

/**
 * GET /api/calendar/my-schedule?from=ISO&to=ISO
 * Items the user created or is assigned to, grouped for the My Schedule panel.
 */
export const getMySchedule = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : now;
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(now.getTime() + 30 * 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new ApiError(400, "Valid `from`/`to` are required when provided.");
  }
  assertRangeWithinCap(from, to);

  const organizationId = new Types.ObjectId(auth.orgId);
  const me = new Types.ObjectId(auth.userId);
  const viewerIsAdmin = isAdminRole(auth.role);

  const [events, appointments] = await Promise.all([
    CalendarEvent.find({
      organizationId,
      status: { $ne: "cancelled" },
      deletedAt: null,
      $or: [{ createdBy: me }, { assignees: me }],
      ...overlapQuery(from, to),
    })
      .populate(POPULATE_USERS)
      .sort({ start: 1 })
      .lean(),
    Appointment.find({
      organizationId: auth.orgId,
      status: { $ne: "cancelled" },
      $or: [{ createdBy: me }, { participants: me }],
      startTime: { $lt: to },
      endTime: { $gt: from },
    })
      .populate("participants", "fullName username email")
      .sort({ startTime: 1 })
      .lean(),
  ]);

  const items = [
    ...events.map((e) => mapCalendarEvent(e, auth.userId, viewerIsAdmin)),
    ...appointments.map(mapAppointment),
  ];

  res.json({
    upcoming: items.filter((i) => i.type !== "task"),
    pendingTasks: items.filter(
      (i) => i.type === "task" && i.status === "scheduled"
    ),
    meetings: items.filter((i) => i.type === "meeting"),
  });
});

/**
 * GET /api/calendar/export.ics?from=ISO&to=ISO
 * Downloadable .ics for the requested range — reuses the same
 * ical-generator dependency and calendar-building approach already used
 * for appointment email invites (email.service.ts's generateICS), just as
 * a standalone file download instead of an email attachment.
 */
export const exportIcs = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const from = new Date(String(req.query.from));
  const to = new Date(String(req.query.to));
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new ApiError(400, "Valid `from` and `to` are required.");
  }
  assertRangeWithinCap(from, to);

  const organizationId = new Types.ObjectId(auth.orgId);

  const [events, appointments] = await Promise.all([
    CalendarEvent.find({
      organizationId,
      status: { $ne: "cancelled" },
      deletedAt: null,
      ...overlapQuery(from, to),
    }).lean(),
    Appointment.find({
      organizationId: auth.orgId,
      status: { $ne: "cancelled" },
      startTime: { $lt: to },
      endTime: { $gt: from },
    }).lean(),
  ]);

  const calendar = ical({ name: "Suprah Calendar", method: ICalCalendarMethod.PUBLISH });

  for (const e of events) {
    calendar.createEvent({
      id: String(e._id),
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      summary: e.title,
      description: e.description,
    });
  }
  for (const a of appointments as any[]) {
    calendar.createEvent({
      id: String(a._id),
      start: a.startTime,
      end: a.endTime,
      allDay: isUtcAllDaySpan(a.startTime, a.endTime),
      summary: a.title ?? "Appointment",
      description: a.notes,
    });
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="suprah-calendar.ics"');
  res.send(calendar.toString());
});

/** POST /api/calendar/events */
export const createEvent = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  assertValidEventInput(req.body, { partial: false });

  const {
    type,
    title,
    description,
    start,
    end,
    allDay,
    repeatsDailyWindow,
    dailyStartTime,
    dailyEndTime,
    includedDates,
    assignees = [],
    color,
    generateMeetingLink,
  } = req.body;

  const doc = new CalendarEvent({
    organizationId: auth.orgId,
    type,
    title,
    description,
    start,
    end,
    allDay: !!allDay,
    repeatsDailyWindow: !!repeatsDailyWindow,
    dailyStartTime,
    dailyEndTime,
    includedDates,
    createdBy: auth.userId,
    assignees,
    color,
  });

  if (type === "meeting" && generateMeetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), auth.orgId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
  }

  await doc.save();
  await doc.populate(POPULATE_USERS);

  const item = mapCalendarEvent(doc.toObject(), auth.userId, isAdminRole(auth.role));
  emitCalendarChange("calendar:created", auth.orgId, {
    source: "calendarEvent",
    item: stripViewerFields(item),
  });

  const others = (assignees as string[]).filter((a) => a !== auth.userId);
  if (others.length) {
    await pushNotification({
      userIds: others,
      orgId: auth.orgId,
      title: `${auth.fullName} added you to a ${type}`,
      body: `${title} — ${new Date(start).toLocaleString()}`,
      link: `/crm/suprah-calendar?event=${doc._id}`,
    });
  }

  res.status(201).json({ item });
});

/** PATCH /api/calendar/events/:id */
export const updateEvent = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
    deletedAt: null,
  });
  if (!doc) {
    throw new ApiError(404, "Calendar item not found.");
  }

  const isCreator = String(doc.createdBy) === auth.userId;
  const isAdmin = isAdminRole(auth.role);
  const currentAssignees = doc.assignees.map(String);
  if (
    !isCreator &&
    !isAdmin &&
    !isSelfRemoval(req.body, currentAssignees, auth.userId)
  ) {
    throw new ApiError(403, "Only the creator or an admin can edit this item.");
  }

  assertValidEventInput(req.body, { partial: true });

  const before = new Set(currentAssignees);

  const editable = [
    "type",
    "title",
    "description",
    "start",
    "end",
    "allDay",
    "repeatsDailyWindow",
    "dailyStartTime",
    "dailyEndTime",
    "includedDates",
    "assignees",
    "status",
    "color",
  ] as const;
  for (const key of editable) {
    if (key in req.body) (doc as any)[key] = req.body[key];
  }

  if (req.body.generateMeetingLink && !doc.meetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), auth.orgId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
  }

  await doc.save();
  await doc.populate(POPULATE_USERS);

  const item = mapCalendarEvent(doc.toObject(), auth.userId, isAdmin);
  emitCalendarChange("calendar:updated", auth.orgId, {
    source: "calendarEvent",
    item: stripViewerFields(item),
  });

  const added = doc.assignees
    .map(String)
    .filter((id) => !before.has(id) && id !== auth.userId);
  if (added.length) {
    await pushNotification({
      userIds: added,
      orgId: auth.orgId,
      title: `${auth.fullName} added you to a ${doc.type}`,
      body: `${doc.title} — ${doc.start.toLocaleString()}`,
      link: `/crm/suprah-calendar?event=${doc._id}`,
    });
  }

  res.json({ item });
});

/** DELETE /api/calendar/events/:id */
export const deleteEvent = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
    deletedAt: null,
  });
  if (!doc) {
    throw new ApiError(404, "Calendar item not found.");
  }
  const isCreator = String(doc.createdBy) === auth.userId;
  if (!isCreator && !isAdminRole(auth.role)) {
    throw new ApiError(403, "Only the creator or an admin can delete this item.");
  }
  doc.deletedAt = new Date();
  await doc.save();
  emitCalendarChange("calendar:deleted", auth.orgId, {
    source: "calendarEvent",
    id: String(doc._id),
  });
  res.json({ ok: true });
});

/** POST /api/calendar/events/:id/meeting-link */
export const generateMeetingLink = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
    deletedAt: null,
  });
  if (!doc) {
    throw new ApiError(404, "Calendar item not found.");
  }
  const isCreator = String(doc.createdBy) === auth.userId;
  const isAdmin = isAdminRole(auth.role);
  if (!isCreator && !isAdmin) {
    throw new ApiError(403, "Only the creator or an admin can generate the meeting link.");
  }
  if (!doc.meetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), auth.orgId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
    await doc.save();
    emitCalendarChange("calendar:updated", auth.orgId, {
      source: "calendarEvent",
      item: stripViewerFields(mapCalendarEvent(doc.toObject(), auth.userId, isAdmin)),
    });
  }
  res.json({ meetingLink: doc.meetingLink, roomName: doc.meetingRoomName });
});

/** Shape returned by every bulk-* endpoint below. */
interface BulkResult {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

function assertBulkIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, "ids must be a non-empty array.");
  }
  if (ids.length > MAX_BULK) {
    throw new ApiError(400, `Too many ids — max ${MAX_BULK} per request.`);
  }
}

/**
 * Loads + permission-checks one CalendarEvent for a bulk operation. Per-item
 * try/catch keeps one bad id from failing the whole batch — mirrors
 * bulkReplyToInquiries's {succeeded, failed} shape (lead.controller.ts),
 * the closest existing precedent for a real per-item-checked bulk endpoint
 * in this codebase (reorderDeals/reorderDepartments skip permission checks
 * entirely, which is fine for reordering but not for delete/status/reassign).
 */
async function loadForBulkOp(
  id: string,
  auth: { userId: string; orgId: string; role: string }
): Promise<{ doc: any } | { reason: string }> {
  if (!Types.ObjectId.isValid(id)) return { reason: "Invalid id." };
  const doc = await CalendarEvent.findOne({
    _id: id,
    organizationId: auth.orgId,
    deletedAt: null,
  });
  if (!doc) return { reason: "Not found." };
  const isCreator = String(doc.createdBy) === auth.userId;
  if (!isCreator && !isAdminRole(auth.role)) return { reason: "Not authorized." };
  return { doc };
}

/** PATCH /api/calendar/events/bulk-delete */
export const bulkDeleteEvents = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  assertBulkIds(req.body.ids);

  const result: BulkResult = { succeeded: [], failed: [] };
  for (const id of req.body.ids as string[]) {
    const loaded = await loadForBulkOp(id, auth);
    if ("reason" in loaded) {
      result.failed.push({ id, reason: loaded.reason });
      continue;
    }
    loaded.doc.deletedAt = new Date();
    await loaded.doc.save();
    emitCalendarChange("calendar:deleted", auth.orgId, {
      source: "calendarEvent",
      id: String(loaded.doc._id),
    });
    result.succeeded.push(id);
  }
  res.json(result);
});

/** PATCH /api/calendar/events/bulk-status — body { ids: string[], status } */
export const bulkUpdateStatus = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  assertBulkIds(req.body.ids);
  if (!VALID_STATUSES.includes(req.body.status)) {
    throw new ApiError(400, `status must be one of ${VALID_STATUSES.join(", ")}.`);
  }

  const isAdmin = isAdminRole(auth.role);
  const result: BulkResult = { succeeded: [], failed: [] };
  for (const id of req.body.ids as string[]) {
    const loaded = await loadForBulkOp(id, auth);
    if ("reason" in loaded) {
      result.failed.push({ id, reason: loaded.reason });
      continue;
    }
    loaded.doc.status = req.body.status;
    await loaded.doc.save();
    await loaded.doc.populate(POPULATE_USERS);
    emitCalendarChange("calendar:updated", auth.orgId, {
      source: "calendarEvent",
      item: stripViewerFields(mapCalendarEvent(loaded.doc.toObject(), auth.userId, isAdmin)),
    });
    result.succeeded.push(id);
  }
  res.json(result);
});

/** PATCH /api/calendar/events/bulk-reassign — body { ids: string[], assignees: string[] } */
export const bulkReassignEvents = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  assertBulkIds(req.body.ids);
  const assignees = req.body.assignees;
  if (!Array.isArray(assignees) || !assignees.every((a) => Types.ObjectId.isValid(a))) {
    throw new ApiError(400, "assignees must be a list of valid user ids.");
  }

  const isAdmin = isAdminRole(auth.role);
  const result: BulkResult = { succeeded: [], failed: [] };
  for (const id of req.body.ids as string[]) {
    const loaded = await loadForBulkOp(id, auth);
    if ("reason" in loaded) {
      result.failed.push({ id, reason: loaded.reason });
      continue;
    }
    loaded.doc.assignees = assignees;
    await loaded.doc.save();
    await loaded.doc.populate(POPULATE_USERS);
    emitCalendarChange("calendar:updated", auth.orgId, {
      source: "calendarEvent",
      item: stripViewerFields(mapCalendarEvent(loaded.doc.toObject(), auth.userId, isAdmin)),
    });
    result.succeeded.push(id);
  }
  res.json(result);
});

/**
 * TODO(integration): align with the SupraSpace/JaaS room + link format used
 * by the /calls flow. Deterministic room name; CallExperience mints the JWT
 * at join time, same as the existing calling system.
 */
function buildSupraSpaceLink(
  eventId: string,
  orgId: string
): { roomName: string; link: string } {
  const roomName = `suprah-${orgId.slice(-6)}-${eventId.slice(-8)}`;
  const base = process.env.APP_URL ?? "https://suprah-app.com";
  return { roomName, link: `${base}/supraspace/meet/${roomName}` };
}
