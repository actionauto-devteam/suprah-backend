import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { CalendarEvent } from "../models/calendarEvent.model";
import Appointment from "../models/Appointment.model";
import {
  emitCalendarChange,
} from "../services/calendarSocket.service";
import notificationService from "../services/notification.service";

/** Route async errors into the Express error pipeline (ApiError-compatible). */
const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/**
 * crmAuth attaches req.crmUser (ICrmUser or synthetic plain object) and
 * req.orgId. Both are required for every calendar route.
 */
function requireAuth(
  req: Request,
  res: Response
): { userId: string; orgId: string; fullName: string } | null {
  const crmUser = (req as any).crmUser;
  const orgId = (req as any).orgId as string | undefined;
  if (!crmUser?._id || !orgId) {
    res.status(401).json({
      message:
        "Not authenticated — ensure crmAuth() is applied to /calendar routes.",
    });
    return null;
  }
  return {
    userId: String(crmUser._id),
    orgId,
    fullName: crmUser.fullName ?? crmUser.username ?? crmUser.email ?? "A teammate",
  };
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
  /** Viewer-specific: true only when the requester created the item. */
  canEdit?: boolean;
}

/** Socket broadcasts go to many viewers — never carry viewer-specific flags. */
const stripViewerFields = (item: FeedItem): Omit<FeedItem, "canEdit"> => {
  const { canEdit, ...rest } = item;
  return rest;
};

const mapCalendarEvent = (doc: any, viewerId?: string): FeedItem => ({
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
      ? String(doc.createdBy?._id ?? doc.createdBy) === viewerId
      : undefined,
});

/** Appointment statuses that don't exist on CalendarEvent collapse into the closest bucket the frontend's stricter union expects — appointments render read-only, so this only affects display grouping, never edit logic. */
const mapAppointmentStatus = (status: string | undefined): FeedItem["status"] => {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "no-show") return "cancelled";
  return "scheduled";
};

/** Exported so the Appointment controller can reuse it in its emit hooks. */
export const mapAppointment = (doc: any): FeedItem => {
  const customerName = doc.customerBooking
    ? [doc.customerBooking.firstName, doc.customerBooking.lastName].filter(Boolean).join(" ")
    : undefined;
  return {
    id: String(doc._id),
    source: "appointment",
    type: "appointment",
    title: doc.title ?? `Appointment — ${customerName || "Customer"}`,
    description: doc.notes ?? doc.description,
    start: doc.startTime,
    end: doc.endTime,
    allDay: false,
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
export const getFeed = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const from = new Date(String(req.query.from));
  const to = new Date(String(req.query.to));
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    res.status(400).json({ message: "Valid `from` and `to` are required." });
    return;
  }

  const organizationId = new Types.ObjectId(auth.orgId);

  const [events, appointments] = await Promise.all([
    CalendarEvent.find({
      organizationId,
      status: { $ne: "cancelled" },
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
    ...events.map((e) => mapCalendarEvent(e, auth.userId)),
    ...appointments.map(mapAppointment),
  ].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  res.json({ items });
});

/**
 * GET /api/calendar/my-schedule?from=ISO&to=ISO
 * Items the user created or is assigned to, grouped for the My Schedule panel.
 */
export const getMySchedule = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : now;
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(now.getTime() + 30 * 86_400_000);

  const organizationId = new Types.ObjectId(auth.orgId);
  const me = new Types.ObjectId(auth.userId);

  const [events, appointments] = await Promise.all([
    CalendarEvent.find({
      organizationId,
      status: { $ne: "cancelled" },
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
    ...events.map((e) => mapCalendarEvent(e, auth.userId)),
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

/** POST /api/calendar/events */
export const createEvent = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

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

  const item = mapCalendarEvent(doc.toObject(), auth.userId);
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
export const updateEvent = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
    return;
  }
  if (String(doc.createdBy) !== auth.userId) {
    res.status(403).json({ message: "Only the creator can edit this item." });
    return;
  }

  const before = new Set(doc.assignees.map(String));

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

  const item = mapCalendarEvent(doc.toObject(), auth.userId);
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
export const deleteEvent = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
    return;
  }
  if (String(doc.createdBy) !== auth.userId) {
    res.status(403).json({ message: "Only the creator can delete this item." });
    return;
  }
  await doc.deleteOne();
  emitCalendarChange("calendar:deleted", auth.orgId, {
    source: "calendarEvent",
    id: String(doc._id),
  });
  res.json({ ok: true });
});

/** POST /api/calendar/events/:id/meeting-link */
export const generateMeetingLink = asyncHandler(async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    organizationId: auth.orgId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
    return;
  }
  if (String(doc.createdBy) !== auth.userId) {
    res
      .status(403)
      .json({ message: "Only the creator can generate the meeting link." });
    return;
  }
  if (!doc.meetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), auth.orgId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
    await doc.save();
    emitCalendarChange("calendar:updated", auth.orgId, {
      source: "calendarEvent",
      item: stripViewerFields(mapCalendarEvent(doc.toObject(), auth.userId)),
    });
  }
  res.json({ meetingLink: doc.meetingLink, roomName: doc.meetingRoomName });
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
