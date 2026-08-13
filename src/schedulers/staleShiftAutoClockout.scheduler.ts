import cron from 'node-cron';
import logger from '../utils/logger';
import TimeLog from '../models/TimeLog.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { toCompanyDateStr, getCompanyDayRange } from '../utils/companyTimezone';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';

// Auto-close forgotten shifts using last activity time
const RENDERED_HOURS_THRESHOLD_SECONDS = 8 * 60 * 60;
const HEARTBEAT_SILENCE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
// Auto-close sub-8h shifts after 30m silence
const SHORT_SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const NO_DATA_GRACE_HOURS = 16;
// Prevents race where break-out just before cron tick gets misclosed
const BREAK_RESUME_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// Mirrors AUTO_SILENCE_CLOCKOUT_NOTES in crmTimeproof.controller.ts's getResumableShift/resumeShift
// — these are the two notes written below that qualify for a seamless Resume Shift, so only
// these two get an immediate alert (the "no activity data ever" branch is a different, more
// extreme case that isn't resumable and shouldn't be conflated with it).
const SILENCE_CLOSURE_NOTES = [
  'Auto clock-out — device went idle/offline after rendering 8+ hours',
  'Auto clock-out — device went idle/offline for 30+ minutes',
];

export async function runStaleShiftAutoClockout(opts: { dryRun?: boolean } = {}): Promise<{ closed: number; checked: number }> {
  const dryRun = !!opts.dryRun;
  const userIds: string[] = await TimeLog.distinct('userId') as any;
  const now = new Date();
  let closed = 0;
  // Batch alerts per org so several closures in one tick don't spam separate chat messages.
  const chatMessagesByOrg = new Map<string, string[]>();

  for (const userId of userIds) {
    const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
    if (!logs.length) continue;

    // Find open shift and any active break
    let isOnShift = false;
    let shiftStartedAt: Date | null = null;
    let userModel: "CrmUser" | "User" = "CrmUser";
    let openBreakStartedAt: Date | null = null;
    let lastBreakOutAt: Date | null = null;
    for (const log of logs) {
      if (log.type === "time-in") {
        isOnShift = true;
        shiftStartedAt = log.timestamp;
        userModel = (log as any).userModel || "CrmUser";
        openBreakStartedAt = null;
        lastBreakOutAt = null;
      } else if (log.type === "time-out") {
        isOnShift = false;
        shiftStartedAt = null;
        openBreakStartedAt = null;
        lastBreakOutAt = null;
      } else if (log.type === "break-in") {
        openBreakStartedAt = log.timestamp;
      } else if (log.type === "break-out") {
        openBreakStartedAt = null;
        lastBreakOutAt = log.timestamp;
      }
    }
    if (!isOnShift || !shiftStartedAt) continue;

    // Allow grace period after break resume before judging silence
    if (
      lastBreakOutAt &&
      now.getTime() - lastBreakOutAt.getTime() < BREAK_RESUME_GRACE_MS
    )
      continue;

    const heartbeat = await AgentHeartbeat.findOne({ userId }).lean();
    const silentMs = heartbeat
      ? now.getTime() - new Date(heartbeat.lastSeenAt).getTime()
      : Infinity;
    if (silentMs < SHORT_SILENCE_THRESHOLD_MS) continue; // tray still recently checking in — leave it alone

    // Sum all active intervals since shift start (may span days)
    const intervals = await ActivityInterval.find({
      userId,
      startAt: { $gte: shiftStartedAt },
    })
      .select("startAt endAt durationSeconds")
      .lean();
    const renderedSeconds = intervals.reduce(
      (sum, i) => sum + i.durationSeconds,
      0,
    );

    const lastIntervalEndMs = intervals.length
      ? Math.max(...intervals.map((i) => new Date(i.endAt).getTime()))
      : null;
    const lastHeartbeatMs = heartbeat
      ? new Date(heartbeat.lastSeenAt).getTime()
      : null;
    const lastKnownActivityMsCandidates = [
      lastIntervalEndMs,
      lastHeartbeatMs,
    ].filter((v): v is number => v !== null);
    const closeAtMs = lastKnownActivityMsCandidates.length
      ? Math.max(...lastKnownActivityMsCandidates)
      : null;

    let closeAt: Date | null = null;
    let closeNote = "";

    if (openBreakStartedAt) {
      // Exempt open breaks from silence checks to avoid false shift closes
    } else if (
      renderedSeconds >= RENDERED_HOURS_THRESHOLD_SECONDS &&
      silentMs >= HEARTBEAT_SILENCE_THRESHOLD_MS
    ) {
      if (closeAtMs !== null && closeAtMs > shiftStartedAt.getTime()) {
        closeAt = new Date(closeAtMs);
        closeNote =
          "Auto clock-out — device went idle/offline after rendering 8+ hours";
      }
    } else if (
      renderedSeconds < RENDERED_HOURS_THRESHOLD_SECONDS &&
      intervals.length > 0 &&
      silentMs >= SHORT_SILENCE_THRESHOLD_MS
    ) {
      if (closeAtMs !== null && closeAtMs > shiftStartedAt.getTime()) {
        closeAt = new Date(closeAtMs);
        closeNote = "Auto clock-out — device went idle/offline for 30+ minutes";
      }
    } else {
      const openHours = (now.getTime() - shiftStartedAt.getTime()) / 3_600_000;
      const hasNoDataEver = intervals.length === 0 && !heartbeat;
      if (hasNoDataEver && openHours > NO_DATA_GRACE_HOURS) {
        closeAt = new Date(
          shiftStartedAt.getTime() + RENDERED_HOURS_THRESHOLD_SECONDS * 1000,
        );
        closeNote =
          "Auto clock-out — no activity data ever recorded for this shift; assumed a standard 8h shift";
      }
    }

    if (!closeAt) continue; // not yet eligible for any closure rule — leave shift open

    logger.info(
      `[auto-clockout]${dryRun ? " [dry-run]" : ""} userId=${userId} shiftStartedAt=${shiftStartedAt.toISOString()} ` +
        `renderedSeconds=${renderedSeconds} silentHours=${(silentMs / 3_600_000).toFixed(1)} closeAt=${closeAt.toISOString()} reason="${closeNote}"`,
    );

    if (!dryRun) {
      if (openBreakStartedAt) {
        await TimeLog.create({
          userId,
          userModel,
          type: "break-out",
          timestamp: closeAt,
          note: "Auto clock-out — break closed alongside forgotten shift",
        });
      }
      await TimeLog.create({
        userId,
        userModel,
        type: "time-out",
        timestamp: closeAt,
        note: closeNote,
      });

      // Immediate heads-up for the two resumable (silence-based) closures — previously this
      // closed with zero notification, so the employee had no way to know until they happened
      // to notice their web tab disagreed with the tray, sometimes an hour or more later. Now
      // that Resume Shift can actually undo an erroneous closure (see resumeShift in
      // crmTimeproof.controller.ts), this alert is directly actionable.
      if (SILENCE_CLOSURE_NOTES.includes(closeNote)) {
        const userDoc =
          userModel === "CrmUser"
            ? await CrmUser.findById(userId).select("organizationId fullName").lean()
            : await User.findById(userId).select("organizationId name").lean();
        if (userDoc?.organizationId) {
          const displayName = (userDoc as any).fullName || (userDoc as any).name || "A user";
          const orgId = userDoc.organizationId.toString();
          const chatMessage = `⏸️ ${displayName}'s shift was auto-ended due to inactivity.`;
          await fireShiftAlert({
            organizationId: orgId,
            targetUserId: userId,
            targetUserModel: userModel,
            chatMessage,
            notifyTitle: "⏸️ Shift auto-ended — inactivity",
            notifyBody: "Your shift was automatically ended due to inactivity. If you were still working, click Start Shift to resume.",
            notifyTag: `stale-shift-clockout-${userId}`,
            url: "/crm/timeproof-clock",
            skipChatMessage: true,
          }).catch(() => {});
          if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
          chatMessagesByOrg.get(orgId)!.push(chatMessage);
        }
      }
    }
    closed++;
  }

  await Promise.allSettled(
    Array.from(chatMessagesByOrg.entries()).map(([orgId, messages]) =>
      postBatchedShiftAlertMessages(orgId, messages),
    ),
  );

  return { closed, checked: userIds.length };
}

// Close shifts at MDT midnight to enforce daily boundaries
export async function closeShiftsFromPreviousMDTDays(opts: { dryRun?: boolean } = {}): Promise<{ closed: number; checked: number }> {
  const dryRun = !!opts.dryRun;
  const userIds: string[] = (await TimeLog.distinct("userId")) as any;
  const todayStr = toCompanyDateStr(new Date());
  let closed = 0;
  // Batch shift closures per org to send one combined alert
  const chatMessagesByOrg = new Map<string, string[]>();

  for (const userId of userIds) {
    const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
    if (!logs.length) continue;

    let isOnShift = false;
    let shiftStartedAt: Date | null = null;
    let userModel: "CrmUser" | "User" = "CrmUser";
    let openBreakStartedAt: Date | null = null;
    for (const log of logs) {
      if (log.type === "time-in") {
        isOnShift = true;
        shiftStartedAt = log.timestamp;
        userModel = (log as any).userModel || "CrmUser";
        openBreakStartedAt = null;
      } else if (log.type === "time-out") {
        isOnShift = false;
        shiftStartedAt = null;
        openBreakStartedAt = null;
      } else if (log.type === "break-in") {
        openBreakStartedAt = log.timestamp;
      } else if (log.type === "break-out") {
        openBreakStartedAt = null;
      }
    }
    if (!isOnShift || !shiftStartedAt) continue;

    const shiftStartDateStr = toCompanyDateStr(shiftStartedAt);
    if (shiftStartDateStr === todayStr) continue; // still today's (MDT) shift — leave it alone

    const closeAt = getCompanyDayRange(shiftStartDateStr).end;
    const closeNote =
      "Auto clock-out — new day started (MDT); please Start Shift again";

    logger.info(
      `[day-boundary-clockout]${dryRun ? " [dry-run]" : ""} userId=${userId} shiftStartedAt=${shiftStartedAt.toISOString()} ` +
        `shiftStartDateStr=${shiftStartDateStr} closeAt=${closeAt.toISOString()}`,
    );

    if (!dryRun) {
      // Skip closing breaks that started after the day boundary
      if (
        openBreakStartedAt &&
        openBreakStartedAt.getTime() < closeAt.getTime()
      ) {
        await TimeLog.create({
          userId,
          userModel,
          type: "break-out",
          timestamp: closeAt,
          note: "Auto clock-out — break closed alongside day-boundary shift close",
        });
      }
      await TimeLog.create({
        userId,
        userModel,
        type: "time-out",
        timestamp: closeAt,
        note: closeNote,
      });

      // Route day-boundary auto-clockouts through Shift Alerts for admin visibility
      const userDoc =
        userModel === "CrmUser"
          ? await CrmUser.findById(userId)
              .select("organizationId fullName")
              .lean()
          : await User.findById(userId).select("organizationId name").lean();
      if (userDoc?.organizationId) {
        const displayName =
          (userDoc as any).fullName || (userDoc as any).name || "A user";
        const orgId = userDoc.organizationId.toString();
        const chatMessage = `🕛 ${displayName}'s shift was auto-ended because a new day started.`;
        await fireShiftAlert({
          organizationId: orgId,
          targetUserId: userId,
          targetUserModel: userModel,
          chatMessage,
          notifyTitle: "🕛 Shift auto-ended — new day",
          notifyBody:
            "Your shift was automatically closed because a new day started. Please Start Shift again to continue tracking.",
          notifyTag: `day-boundary-clockout-${userId}`,
          url: "/crm/timeproof-clock",
          skipChatMessage: true,
        }).catch(() => {});
        if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
        chatMessagesByOrg.get(orgId)!.push(chatMessage);
      }
    }
    closed++;
  }

  await Promise.allSettled(
    Array.from(chatMessagesByOrg.entries()).map(([orgId, messages]) =>
      postBatchedShiftAlertMessages(orgId, messages),
    ),
  );

  return { closed, checked: userIds.length };
}

export const initStaleShiftAutoClockoutScheduler = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { closed } = await runStaleShiftAutoClockout();
      if (closed > 0) logger.info(`[auto-clockout] Closed ${closed} stale shift(s)`);
    } catch (error) {
      logger.error({ error }, 'Stale shift auto-clockout scheduler error');
    }

    try {
      const { closed } = await closeShiftsFromPreviousMDTDays();
      if (closed > 0) logger.info(`[day-boundary-clockout] Closed ${closed} shift(s) carried over from a previous MDT day`);
    } catch (error) {
      logger.error({ error }, 'Day-boundary auto-clockout scheduler error');
    }
  });

  logger.info('✓ Stale shift auto-clockout scheduler initialized - Runs every 15 minutes');
};
