import { Request, Response } from "express";
import { Types } from "mongoose";
import { CalendarEvent } from "../models/calendarEvent.model";
import ProjectTask from "../models/ProjectTask.model";
import ProjectGroup from "../models/ProjectGroup.model";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { CALENDAR_TZ } from "../constants/calendarTimezone";

/**
 * Calendar notification center backend.
 *
 * GET /api/calendar/notifications-summary
 *
 * Everything the Suprah Calendar bell + sidebar badge need, computed live
 * (no stored documents to keep in sync):
 *   todayItems         — my events / meetings / tasks / reminders happening today
 *   upcoming24h        — my items starting within the next 24 hours (after today's)
 *   overdueTasks       — PM tasks I'm involved in whose deadline has passed
 *   approachingTasks   — PM tasks I'm involved in due within the next 3 days
 *   badgeCount         — today's remaining items + overdue + due-today tasks
 *
 * "My" = I created it or I'm an assignee. Day boundaries are Mountain Time,
 * matching the calendar's rendering convention. Mount in calendar.routes.ts:
 *   router.get("/notifications-summary", getNotificationsSummary);
 */

/** MT UTC offset (minutes) in effect at a given instant, via Intl's longOffset part. */
function mtOffsetMinutesAt(instant: Date): number {
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TZ,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-06:00" / "GMT-07:00"
  const match = offsetPart?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return match
    ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
    : -420; // fallback: MST
}

/** Start of "today" and "tomorrow" as instants, using Mountain Time dates. */
function mtDayBounds(now: Date): { dayStart: Date; dayEnd: Date } {
  const key = now.toLocaleDateString("en-CA", { timeZone: CALENDAR_TZ }); // YYYY-MM-DD
  const utcMidnight = Date.parse(`${key}T00:00:00Z`);

  // First pass: offset "around now" gives a candidate midnight instant that's
  // correct on ~363 days a year.
  const roughOffset = mtOffsetMinutesAt(now);
  const candidate = new Date(utcMidnight - roughOffset * 60000);

  // Second pass: re-read the offset AT that candidate instant itself, not at
  // `now` or at noon — on the two annual DST-transition days, the offset
  // sampled elsewhere in the day can differ from the offset actually
  // governing local midnight (transitions happen at 2am local, not
  // midnight), so probing the candidate instant directly is what makes this
  // exact rather than approximate.
  const refinedOffset = mtOffsetMinutesAt(candidate);
  const dayStart =
    refinedOffset === roughOffset
      ? candidate
      : new Date(utcMidnight - refinedOffset * 60000);

  return { dayStart, dayEnd: new Date(dayStart.getTime() + 86_400_000) };
}

export const getNotificationsSummary = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = (req as any).crmUser;
  const orgId = (req as any).orgId as string | undefined;
  if (!crmUser?._id || !orgId) {
    throw new ApiError(401, "Not authenticated.");
  }

  const organizationId = new Types.ObjectId(orgId);
  const me = new Types.ObjectId(String(crmUser._id));
  const now = new Date();
  const { dayStart, dayEnd } = mtDayBounds(now);
  const in24h = new Date(now.getTime() + 24 * 3_600_000);
  const in3d = new Date(now.getTime() + 3 * 86_400_000);

  const [todayEvents, upcomingEvents, memberGroups] = await Promise.all([
    // My calendar items overlapping today (includes task events synced from PM).
    CalendarEvent.find({
      organizationId,
      status: "scheduled",
      deletedAt: null,
      $or: [{ createdBy: me }, { assignees: me }],
      start: { $lt: dayEnd },
      end: { $gt: dayStart },
    })
      .select("type title start end allDay meetingLink")
      .sort({ start: 1 })
      .lean(),
    // My items starting after today but within 24h (late-night heads-up).
    CalendarEvent.find({
      organizationId,
      status: "scheduled",
      deletedAt: null,
      $or: [{ createdBy: me }, { assignees: me }],
      start: { $gte: dayEnd, $lt: in24h },
    })
      .select("type title start end allDay meetingLink")
      .sort({ start: 1 })
      .lean(),
    ProjectGroup.find({ organizationId, memberIds: me, deletedAt: null })
      .select("_id name")
      .lean(),
  ]);

  const groupIds = memberGroups.map((g) => g._id);
  const groupNames = new Map(memberGroups.map((g: any) => [g._id.toString(), g.name]));

  const myTaskFilter = {
    groupId: { $in: groupIds },
    deletedAt: null,
    status: { $ne: "completed" },
    $or: [{ assigneeIds: me }, { createdBy: me }],
  };

  const [overdue, approaching, overdueTotal, dueTodayTotal] = await Promise.all([
    ProjectTask.find({ ...myTaskFilter, deadline: { $lt: now } })
      .select("title deadline groupId status")
      .sort({ deadline: 1 })
      .limit(20)
      .lean(),
    ProjectTask.find({ ...myTaskFilter, deadline: { $gte: now, $lte: in3d } })
      .select("title deadline groupId status")
      .sort({ deadline: 1 })
      .limit(20)
      .lean(),
    // Unbounded counts for badgeCount — the arrays above are capped at 20 for
    // display, but the badge must reflect the true total, not the capped page.
    ProjectTask.countDocuments({ ...myTaskFilter, deadline: { $lt: now } }),
    ProjectTask.countDocuments({
      ...myTaskFilter,
      deadline: { $gte: now, $lte: in3d, $lt: dayEnd },
    }),
  ]);

  const decorate = (t: any) => ({
    id: String(t._id),
    title: t.title,
    deadline: t.deadline,
    groupId: String(t.groupId),
    groupName: groupNames.get(t.groupId.toString()) || "",
  });

  const todayRemaining = todayEvents.filter((e: any) => new Date(e.end) > now);

  res.json({
    todayItems: todayEvents.map((e: any) => ({ ...e, id: String(e._id) })),
    upcoming24h: upcomingEvents.map((e: any) => ({ ...e, id: String(e._id) })),
    overdueTasks: overdue.map(decorate),
    approachingTasks: approaching.map(decorate),
    badgeCount: todayRemaining.length + overdueTotal + dueTodayTotal,
    generatedAt: now,
  });
});
