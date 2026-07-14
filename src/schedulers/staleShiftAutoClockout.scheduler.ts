import cron from 'node-cron';
import logger from '../utils/logger';
import TimeLog from '../models/TimeLog.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';

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
 * Shifts that haven't reached 8 rendered hours yet are intentionally left
 * open — same rule as the tray-side mechanisms, so a shift only ever gets
 * auto-closed after the user's minimum work is already done.
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
    if (silentMs < HEARTBEAT_SILENCE_THRESHOLD_MS) continue; // tray still recently checking in — leave it alone

    // Sum all committed active intervals since this shift began (not just
    // "today" — a forgotten clock-out can span multiple calendar days).
    const intervals = await ActivityInterval.find({
      userId,
      startAt: { $gte: shiftStartedAt },
    }).select('startAt endAt durationSeconds').lean();
    const renderedSeconds = intervals.reduce((sum, i) => sum + i.durationSeconds, 0);

    let closeAt: Date | null = null;
    let closeNote = '';

    if (renderedSeconds >= RENDERED_HOURS_THRESHOLD_SECONDS) {
      const lastIntervalEndMs = intervals.length
        ? Math.max(...intervals.map((i) => new Date(i.endAt).getTime()))
        : null;
      const lastHeartbeatMs = heartbeat ? new Date(heartbeat.lastSeenAt).getTime() : null;
      const closeAtMs = Math.max(...[lastIntervalEndMs, lastHeartbeatMs].filter((v): v is number => v !== null));
      if (Number.isFinite(closeAtMs) && closeAtMs > shiftStartedAt.getTime()) {
        closeAt = new Date(closeAtMs);
        closeNote = 'Auto clock-out — device went idle/offline after rendering 8+ hours';
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

export const initStaleShiftAutoClockoutScheduler = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { closed } = await runStaleShiftAutoClockout();
      if (closed > 0) logger.info(`[auto-clockout] Closed ${closed} stale shift(s)`);
    } catch (error) {
      logger.error({ error }, 'Stale shift auto-clockout scheduler error');
    }
  });

  logger.info('✓ Stale shift auto-clockout scheduler initialized - Runs every 15 minutes');
};
