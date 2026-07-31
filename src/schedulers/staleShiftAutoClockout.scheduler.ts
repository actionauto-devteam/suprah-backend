import cron from 'node-cron';
import logger from '../utils/logger';
import TimeLog from '../models/TimeLog.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { toCompanyDateStr, getCompanyDayRange } from '../utils/companyTimezone';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';

/**
 * Backend safety net for forgotten clock-outs. The tray app tries to clock a
 * user out proactively (OS sleep/shutdown event, or 30 continuous idle
 * minutes) once they've already rendered 8+ hours for the current shift —
 * see actionauto-tray/src/main.ts. This scheduler is the backstop for when
 * that never reaches the server (abrupt power loss, tray crash, no network
 * at the moment of sleep, etc.): if a shift is still open, the tray has gone
 * silent for a while, AND the user has already rendered 8+ hours since
 * clocking in, auto-close it using the last known activity as the time-out —
 * never "now", which would falsely inflate hours by the entire silent gap.
 *
 * Shifts under 8 rendered hours are handled by a separate, shorter rule: if
 * there IS real activity data for this shift (the tray genuinely ran) and
 * the heartbeat has gone silent for 30+ minutes, close it at the last known
 * activity time regardless of hours rendered — a genuine sleep/shutdown/
 * crash this early in a shift means the device is very unlikely to still be
 * in use, and there's no reason to make the shift stay open for the rest of
 * the day (or until the next MDT-day boundary closure) just because 8h
 * hadn't accumulated yet. See SHORT_SILENCE_THRESHOLD_MS below.
 *
 * Exception: a shift with ZERO ActivityInterval/heartbeat data ever (the
 * tray never ran this session — e.g. clocked in from the web only) can
 * never reach the 8h-rendered threshold above, and would otherwise stay
 * open forever. Once it's been open far longer than any real single shift
 * could be, assume one standard 8h shift from time-in — there's no signal
 * to know the true stop time, and that's a fairer default than either
 * "still open after 500+ hours" or "0 hours worked".
 */
const RENDERED_HOURS_THRESHOLD_SECONDS = 8 * 60 * 60;
const HEARTBEAT_SILENCE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
// Below 8h rendered, a genuine sleep/shutdown/crash this early in a shift
// means the device is very unlikely to still be in use — no reason to make
// them wait until 8h accumulates before ever considering a close. Shorter
// than the 1h threshold above since there's no rendered-hours minimum acting
// as a second gate here. (Confirmed in production: a user stopped working
// around 3:49 PM having rendered ~5h48m, but with nothing below 8h ever
// eligible to close, the shift stayed open until the next MDT day's
// boundary closure — wall-clock "Work Time" showed ~14h.)
const SHORT_SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const NO_DATA_GRACE_HOURS = 16;

export async function runStaleShiftAutoClockout(opts: { dryRun?: boolean } = {}): Promise<{ closed: number; checked: number }> {
  const dryRun = !!opts.dryRun;
  const userIds: string[] = await TimeLog.distinct('userId') as any;
  const now = new Date();
  let closed = 0;

  for (const userId of userIds) {
    const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
    if (!logs.length) continue;

    // Chronological walk — find the current open shift (if any) and any
    // dangling open break within it.
    let isOnShift = false;
    let shiftStartedAt: Date | null = null;
    let userModel: 'CrmUser' | 'User' = 'CrmUser';
    let openBreakStartedAt: Date | null = null;
    for (const log of logs) {
      if (log.type === 'time-in') {
        isOnShift = true;
        shiftStartedAt = log.timestamp;
        userModel = (log as any).userModel || 'CrmUser';
        openBreakStartedAt = null;
      } else if (log.type === 'time-out') {
        isOnShift = false;
        shiftStartedAt = null;
        openBreakStartedAt = null;
      } else if (log.type === 'break-in') {
        openBreakStartedAt = log.timestamp;
      } else if (log.type === 'break-out') {
        openBreakStartedAt = null;
      }
    }
    if (!isOnShift || !shiftStartedAt) continue;

    const heartbeat = await AgentHeartbeat.findOne({ userId }).lean();
    const silentMs = heartbeat ? now.getTime() - new Date(heartbeat.lastSeenAt).getTime() : Infinity;
    if (silentMs < SHORT_SILENCE_THRESHOLD_MS) continue; // tray still recently checking in — leave it alone

    // Sum all committed active intervals since this shift began (not just
    // "today" — a forgotten clock-out can span multiple calendar days).
    const intervals = await ActivityInterval.find({
      userId,
      startAt: { $gte: shiftStartedAt },
    }).select('startAt endAt durationSeconds').lean();
    const renderedSeconds = intervals.reduce((sum, i) => sum + i.durationSeconds, 0);

    const lastIntervalEndMs = intervals.length
      ? Math.max(...intervals.map((i) => new Date(i.endAt).getTime()))
      : null;
    const lastHeartbeatMs = heartbeat ? new Date(heartbeat.lastSeenAt).getTime() : null;
    const lastKnownActivityMsCandidates = [lastIntervalEndMs, lastHeartbeatMs].filter((v): v is number => v !== null);
    const closeAtMs = lastKnownActivityMsCandidates.length ? Math.max(...lastKnownActivityMsCandidates) : null;

    let closeAt: Date | null = null;
    let closeNote = '';

    if (renderedSeconds >= RENDERED_HOURS_THRESHOLD_SECONDS && silentMs >= HEARTBEAT_SILENCE_THRESHOLD_MS) {
      if (closeAtMs !== null && closeAtMs > shiftStartedAt.getTime()) {
        closeAt = new Date(closeAtMs);
        closeNote = 'Auto clock-out — device went idle/offline after rendering 8+ hours';
      }
    } else if (renderedSeconds < RENDERED_HOURS_THRESHOLD_SECONDS && intervals.length > 0 && silentMs >= SHORT_SILENCE_THRESHOLD_MS) {
      if (closeAtMs !== null && closeAtMs > shiftStartedAt.getTime()) {
        closeAt = new Date(closeAtMs);
        closeNote = 'Auto clock-out — device went idle/offline for 30+ minutes';
      }
    } else {
      const openHours = (now.getTime() - shiftStartedAt.getTime()) / 3_600_000;
      const hasNoDataEver = intervals.length === 0 && !heartbeat;
      if (hasNoDataEver && openHours > NO_DATA_GRACE_HOURS) {
        closeAt = new Date(shiftStartedAt.getTime() + RENDERED_HOURS_THRESHOLD_SECONDS * 1000);
        closeNote = 'Auto clock-out — no activity data ever recorded for this shift; assumed a standard 8h shift';
      }
    }

    if (!closeAt) continue; // not yet eligible for any closure rule — leave shift open

    logger.info(
      `[auto-clockout]${dryRun ? ' [dry-run]' : ''} userId=${userId} shiftStartedAt=${shiftStartedAt.toISOString()} ` +
      `renderedSeconds=${renderedSeconds} silentHours=${(silentMs / 3_600_000).toFixed(1)} closeAt=${closeAt.toISOString()} reason="${closeNote}"`
    );

    if (!dryRun) {
      if (openBreakStartedAt) {
        await TimeLog.create({
          userId, userModel, type: 'break-out', timestamp: closeAt,
          note: 'Auto clock-out — break closed alongside forgotten shift',
        });
      }
      await TimeLog.create({
        userId, userModel, type: 'time-out', timestamp: closeAt,
        note: closeNote,
      });
    }
    closed++;
  }

  return { closed, checked: userIds.length };
}

/**
 * No overnight/graveyard shifts exist in this business — every MDT calendar
 * day is meant to be an independent shift. A user who's still actively
 * working (not idle, heartbeat fresh) right through MDT midnight would never
 * be touched by runStaleShiftAutoClockout above (its rules only fire once
 * idle or once heartbeat goes silent) — their shift just keeps counting as
 * "open" into the new day. That's what was silently blocking screenshots:
 * the tray's own 16h "stale shift" check (unrelated to midnight) would
 * eventually classify the carried-over shift as stale and refuse to
 * auto-resume activity tracking, even though the user was genuinely active.
 *
 * This closes any shift whose start date (MDT) isn't today's MDT date,
 * regardless of idle/heartbeat state — the sole criterion is the calendar
 * boundary. Closes at the exact MDT midnight ending the day the shift
 * started, so that day's rendered hours stay accurate and don't bleed into
 * the next. The user sees "Not Clocked In" afterward and must Start Shift
 * again — a fresh, non-stale shift for the new day, which also unblocks the
 * tray's activity tracking / screenshot capture immediately.
 */
export async function closeShiftsFromPreviousMDTDays(opts: { dryRun?: boolean } = {}): Promise<{ closed: number; checked: number }> {
  const dryRun = !!opts.dryRun;
  const userIds: string[] = await TimeLog.distinct('userId') as any;
  const todayStr = toCompanyDateStr(new Date());
  let closed = 0;
  // Grouped per org so a tick that closes several stale shifts at once posts
  // one combined Shift Alerts chat message instead of one per shift.
  const chatMessagesByOrg = new Map<string, string[]>();

  for (const userId of userIds) {
    const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
    if (!logs.length) continue;

    let isOnShift = false;
    let shiftStartedAt: Date | null = null;
    let userModel: 'CrmUser' | 'User' = 'CrmUser';
    let openBreakStartedAt: Date | null = null;
    for (const log of logs) {
      if (log.type === 'time-in') {
        isOnShift = true;
        shiftStartedAt = log.timestamp;
        userModel = (log as any).userModel || 'CrmUser';
        openBreakStartedAt = null;
      } else if (log.type === 'time-out') {
        isOnShift = false;
        shiftStartedAt = null;
        openBreakStartedAt = null;
      } else if (log.type === 'break-in') {
        openBreakStartedAt = log.timestamp;
      } else if (log.type === 'break-out') {
        openBreakStartedAt = null;
      }
    }
    if (!isOnShift || !shiftStartedAt) continue;

    const shiftStartDateStr = toCompanyDateStr(shiftStartedAt);
    if (shiftStartDateStr === todayStr) continue; // still today's (MDT) shift — leave it alone

    const closeAt = getCompanyDayRange(shiftStartDateStr).end;
    const closeNote = 'Auto clock-out — new day started (MDT); please Start Shift again';

    logger.info(
      `[day-boundary-clockout]${dryRun ? ' [dry-run]' : ''} userId=${userId} shiftStartedAt=${shiftStartedAt.toISOString()} ` +
      `shiftStartDateStr=${shiftStartDateStr} closeAt=${closeAt.toISOString()}`
    );

    if (!dryRun) {
      // Guard against a multi-day-forgotten shift where the open break itself
      // started on a LATER day than the boundary we're closing at — closing
      // a break before its own break-in would be nonsensical, so just skip
      // that part in this rare edge case (the shift close below still applies).
      if (openBreakStartedAt && openBreakStartedAt.getTime() < closeAt.getTime()) {
        await TimeLog.create({
          userId, userModel, type: 'break-out', timestamp: closeAt,
          note: 'Auto clock-out — break closed alongside day-boundary shift close',
        });
      }
      await TimeLog.create({
        userId, userModel, type: 'time-out', timestamp: closeAt,
        note: closeNote,
      });

      // Routed through the shared Shift Alerts pipeline (previously a raw,
      // unpersisted push with zero admin visibility) — this is a net
      // feature add: admins now see day-boundary auto-clockouts too, grouped
      // with any other shift-alert triggers for the same person.
      const userDoc = userModel === 'CrmUser'
        ? await CrmUser.findById(userId).select('organizationId fullName').lean()
        : await User.findById(userId).select('organizationId name').lean();
      if (userDoc?.organizationId) {
        const displayName = (userDoc as any).fullName || (userDoc as any).name || 'A user';
        const orgId = userDoc.organizationId.toString();
        const chatMessage = `🕛 ${displayName}'s shift was auto-ended because a new day started.`;
        await fireShiftAlert({
          organizationId: orgId,
          targetUserId: userId,
          targetUserModel: userModel,
          chatMessage,
          notifyTitle: '🕛 Shift auto-ended — new day',
          notifyBody: 'Your shift was automatically closed because a new day started. Please Start Shift again to continue tracking.',
          notifyTag: `day-boundary-clockout-${userId}`,
          url: '/crm/timeproof-clock',
          skipChatMessage: true,
        }).catch(() => {});
        if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
        chatMessagesByOrg.get(orgId)!.push(chatMessage);
      }
    }
    closed++;
  }

  await Promise.allSettled(
    Array.from(chatMessagesByOrg.entries()).map(([orgId, messages]) => postBatchedShiftAlertMessages(orgId, messages)),
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
