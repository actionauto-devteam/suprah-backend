import { Request, Response } from "express";
import { Types } from "mongoose";
import { CalendarEvent } from "../models/calendarEvent.model";
import {
  emitCalendarChange,
  emitToUsers,
} from "../services/calendarSocket.service";

// ── INTEGRATION ───────────────────────────────────────────────────────────
// 1. Appointment model: import your existing model so the feed can merge
//    appointments. Adjust `mapAppointment` to your real field names.
// TODO(integration): import { Appointment } from "../models/appointment.model";
//
// 2. Notification service: swap `pushNotification` for the same service the
//    Project Management module uses, so calendar pings land in the shared
//    notifications inbox.
// TODO(integration): import { createNotification } from "../services/notification.service";
//
// 3. crmAuth: this controller assumes crmAuth attaches a plain object
//    (post-fix — no Mongoose prototype tricks) shaped like:
//    req.user = { _id, dealershipId, firstName, lastName, email }
// ──────────────────────────────────────────────────────────────────────────

type AuthedRequest = Request & {
  user: {
    _id: string;
    dealershipId: string;
    firstName?: string;
    lastName?: string;
  };
};

const POPULATE_USERS = [
  { path: "createdBy", select: "firstName lastName email avatarUrl" },
  { path: "assignees", select: "firstName lastName email avatarUrl" },
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
  status: string;
  color?: string;
  meetingLink?: string;
  createdBy?: unknown;
  assignees?: unknown[];
}

const mapCalendarEvent = (doc: any): FeedItem => ({
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
  status: doc.status,
  color: doc.color,
  meetingLink: doc.meetingLink,
  createdBy: doc.createdBy,
  assignees: doc.assignees,
});

/**
 * TODO(integration): adapt to your Appointment schema. The mapping below
 * assumes fields commonly present in the Appointment Page calendar
 * (customerName, scheduledAt, durationMinutes, assignedTo, status).
 */
const mapAppointment = (doc: any): FeedItem => {
  const start = doc.scheduledAt ?? doc.start ?? doc.date;
  const durationMs = (doc.durationMinutes ?? 60) * 60_000;
  return {
    id: String(doc._id),
    source: "appointment",
    type: "appointment",
    title: doc.title ?? `Appointment — ${doc.customerName ?? "Customer"}`,
    description: doc.notes ?? doc.description,
    start,
    end: doc.end ?? new Date(new Date(start).getTime() + durationMs),
    allDay: false,
    repeatsDailyWindow: false,
    status: doc.status ?? "scheduled",
    color: "appointment",
    createdBy: doc.createdBy,
    assignees: doc.assignedTo ? [doc.assignedTo] : doc.assignees ?? [],
  };
};

// TODO(integration): replace with your shared notification service call.
async function pushNotification(opts: {
  userIds: string[];
  title: string;
  body: string;
  link: string;
  dealershipId: string;
}): Promise<void> {
  // await createNotification({ ...opts, category: "calendar" });
  emitToUsers(opts.userIds, "notification:new", {
    title: opts.title,
    body: opts.body,
    link: opts.link,
    category: "calendar",
    createdAt: new Date(),
  });
}

const overlapQuery = (from: Date, to: Date) => ({
  start: { $lt: to },
  end: { $gt: from },
});

/**
 * GET /api/calendar/feed?from=ISO&to=ISO
 * Unified feed: native calendar items + appointments, merged and sorted.
 * Both the Appointment Page calendar and Suprah Calendar call this.
 */
export async function getFeed(req: Request, res: Response): Promise<void> {
  const { user } = req as AuthedRequest;
  const from = new Date(String(req.query.from));
  const to = new Date(String(req.query.to));
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    res.status(400).json({ message: "Valid `from` and `to` are required." });
    return;
  }

  const dealershipId = new Types.ObjectId(user.dealershipId);

  const [events /*, appointments */] = await Promise.all([
    CalendarEvent.find({
      dealershipId,
      status: { $ne: "cancelled" },
      ...overlapQuery(from, to),
    })
      .populate(POPULATE_USERS)
      .lean(),
    // TODO(integration): uncomment once Appointment is imported.
    // Appointment.find({ dealershipId, scheduledAt: { $gte: from, $lt: to } })
    //   .populate("assignedTo", "firstName lastName email avatarUrl")
    //   .lean(),
  ]);

  const items: FeedItem[] = [
    ...events.map(mapCalendarEvent),
    // ...appointments.map(mapAppointment),
  ].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  res.json({ items });
}

/**
 * GET /api/calendar/my-schedule?from=ISO&to=ISO
 * Personal dashboard: items the user created or is assigned to,
 * grouped for the My Schedule panel.
 */
export async function getMySchedule(req: Request, res: Response): Promise<void> {
  const { user } = req as AuthedRequest;
  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : now;
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(now.getTime() + 30 * 86_400_000);

  const dealershipId = new Types.ObjectId(user.dealershipId);
  const me = new Types.ObjectId(user._id);
  const mine = { $or: [{ createdBy: me }, { assignees: me }] };

  const [events /*, appointments */] = await Promise.all([
    CalendarEvent.find({
      dealershipId,
      status: { $ne: "cancelled" },
      ...mine,
      ...overlapQuery(from, to),
    })
      .populate(POPULATE_USERS)
      .sort({ start: 1 })
      .lean(),
    // TODO(integration):
    // Appointment.find({ dealershipId, assignedTo: me, scheduledAt: { $gte: from, $lt: to } }).lean(),
  ]);

  const items = [
    ...events.map(mapCalendarEvent),
    // ...appointments.map(mapAppointment),
  ];

  res.json({
    upcoming: items.filter((i) => i.type !== "task"),
    pendingTasks: items.filter(
      (i) => i.type === "task" && i.status === "scheduled"
    ),
    meetings: items.filter((i) => i.type === "meeting"),
  });
}

/** POST /api/calendar/events */
export async function createEvent(req: Request, res: Response): Promise<void> {
  const { user } = req as AuthedRequest;
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
    assignees = [],
    color,
    generateMeetingLink,
  } = req.body;

  const doc = new CalendarEvent({
    dealershipId: user.dealershipId,
    type,
    title,
    description,
    start,
    end,
    allDay: !!allDay,
    repeatsDailyWindow: !!repeatsDailyWindow,
    dailyStartTime,
    dailyEndTime,
    createdBy: user._id,
    assignees,
    color,
  });

  if (type === "meeting" && generateMeetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), user.dealershipId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
  }

  await doc.save();
  await doc.populate(POPULATE_USERS);

  const item = mapCalendarEvent(doc.toObject());
  emitCalendarChange("calendar:created", user.dealershipId, {
    source: "calendarEvent",
    item,
  });

  const others = assignees.filter((a: string) => a !== user._id);
  if (others.length) {
    await pushNotification({
      userIds: others,
      dealershipId: user.dealershipId,
      title: `You've been added to a ${type}`,
      body: `${title} — ${new Date(start).toLocaleString()}`,
      link: `/suprah-calendar?event=${doc._id}`,
    });
  }

  res.status(201).json({ item });
}

/** PATCH /api/calendar/events/:id */
export async function updateEvent(req: Request, res: Response): Promise<void> {
  const { user } = req as AuthedRequest;
  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    dealershipId: user.dealershipId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
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
    "assignees",
    "status",
    "color",
  ] as const;
  for (const key of editable) {
    if (key in req.body) (doc as any)[key] = req.body[key];
  }

  if (req.body.generateMeetingLink && !doc.meetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), user.dealershipId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
  }

  await doc.save();
  await doc.populate(POPULATE_USERS);

  const item = mapCalendarEvent(doc.toObject());
  emitCalendarChange("calendar:updated", user.dealershipId, {
    source: "calendarEvent",
    item,
  });

  const added = doc.assignees
    .map(String)
    .filter((id) => !before.has(id) && id !== user._id);
  if (added.length) {
    await pushNotification({
      userIds: added,
      dealershipId: user.dealershipId,
      title: `You've been added to a ${doc.type}`,
      body: `${doc.title} — ${doc.start.toLocaleString()}`,
      link: `/suprah-calendar?event=${doc._id}`,
    });
  }

  res.json({ item });
}

/** DELETE /api/calendar/events/:id */
export async function deleteEvent(req: Request, res: Response): Promise<void> {
  const { user } = req as AuthedRequest;
  const doc = await CalendarEvent.findOneAndDelete({
    _id: req.params.id,
    dealershipId: user.dealershipId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
    return;
  }
  emitCalendarChange("calendar:deleted", user.dealershipId, {
    source: "calendarEvent",
    id: String(doc._id),
  });
  res.json({ ok: true });
}

/** POST /api/calendar/events/:id/meeting-link — generate on an existing item. */
export async function generateMeetingLink(
  req: Request,
  res: Response
): Promise<void> {
  const { user } = req as AuthedRequest;
  const doc = await CalendarEvent.findOne({
    _id: req.params.id,
    dealershipId: user.dealershipId,
  });
  if (!doc) {
    res.status(404).json({ message: "Calendar item not found." });
    return;
  }
  if (!doc.meetingLink) {
    const { roomName, link } = buildSupraSpaceLink(String(doc._id), user.dealershipId);
    doc.meetingRoomName = roomName;
    doc.meetingLink = link;
    await doc.save();
    emitCalendarChange("calendar:updated", user.dealershipId, {
      source: "calendarEvent",
      item: mapCalendarEvent(doc.toObject()),
    });
  }
  res.json({ meetingLink: doc.meetingLink, roomName: doc.meetingRoomName });
}

/**
 * TODO(integration): align with SupraSpace's real room/link format.
 * SupraSpace uses JaaS (8x8) — if your CallSession flow expects a JaaS
 * room like `{appId}/{roomName}` plus a signed JWT minted at join time,
 * keep this as a deterministic room name and let CallExperience mint the
 * token when the link is opened, same as your existing call flow.
 */
function buildSupraSpaceLink(
  eventId: string,
  dealershipId: string
): { roomName: string; link: string } {
  const roomName = `suprah-${dealershipId.slice(-6)}-${eventId.slice(-8)}`;
  const base = process.env.APP_URL ?? "https://suprah-app.com";
  return { roomName, link: `${base}/supraspace/meet/${roomName}` };
}
