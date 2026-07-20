import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { CalendarEvent } from "../models/calendarEvent.model";
import ProjectTask from "../models/ProjectTask.model";
import ProjectGroup from "../models/ProjectGroup.model";

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

const TZ = "America/Denver";

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** Start of "today" and "tomorrow" as instants, using Mountain Time dates. */
function mtDayBounds(now: Date): { dayStart: Date; dayEnd: Date } {
  const key = now.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  // Offset of MT at this moment (handles MST/MDT automatically).
  const offsetMin =
    (new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime() -
      new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) /
    60000;
  const dayStart = new Date(Date.parse(`${key}T00:00:00Z`) - offsetMin * 60000);
  return { dayStart, dayEnd: new Date(dayStart.getTime() + 86_400_000) };
}

export const getNotificationsSummary = asyncHandler(async (req, res) => {
  const crmUser = (req as any).crmUser;
  const orgId = (req as any).orgId as string | undefined;
  if (!crmUser?._id || !orgId) {
    res.status(401).json({ message: "Not authenticated." });
    return;
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
      $or: [{ createdBy: me }, { assignees: me }],
      start: { $gte: dayEnd, $lt: in24h },
    })
      .select("type title start end allDay")
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

  const [overdue, approaching] = await Promise.all([
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
  ]);

  const decorate = (t: any) => ({
    id: String(t._id),
    title: t.title,
    deadline: t.deadline,
    groupId: String(t.groupId),
    groupName: groupNames.get(t.groupId.toString()) || "",
  });

  const todayRemaining = todayEvents.filter((e: any) => new Date(e.end) > now);
  const dueToday = approaching.filter((t: any) => new Date(t.deadline) < dayEnd);

  res.json({
    todayItems: todayEvents.map((e: any) => ({ ...e, id: String(e._id) })),
    upcoming24h: upcomingEvents.map((e: any) => ({ ...e, id: String(e._id) })),
    overdueTasks: overdue.map(decorate),
    approachingTasks: approaching.map(decorate),
    badgeCount: todayRemaining.length + overdue.length + dueToday.length,
    generatedAt: now,
  });
});