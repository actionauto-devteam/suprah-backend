import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import TimeLog from '../models/TimeLog.model';
import { PushService } from '../services/push.service';
import { IUser } from '../models/User.model';
import { ICrmUser } from '../models/CrmUser.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';
import { isMobileMonitoringDept } from '../config/departmentMonitoring';
import { getSocketIO } from '../utils/socketEmitter';


const COMPANY_TZ_OFFSET_MINUTES = -360; // MDT UTC-6
// See crmTimeproof.controller.ts's HEARTBEAT_FRESH_MS comment — 60s heartbeat
// cadence with no retry means ordinary blips can create a multi-minute gap
// even though the user never stopped working; 15 min avoids false "Paused".
const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;


interface TimeclockActor {
  id: mongoose.Types.ObjectId;
  model: 'User' | 'CrmUser';
  orgId: string;
  fullName: string;
  email: string;
  avatar?: string;
  role: string;
  department?: string;
}

function getActor(req: Request): TimeclockActor {
  const mainUser = req.user as IUser | undefined;
  const crmUser  = req.crmUser as ICrmUser | undefined;

  if (mainUser) {
    const u = mainUser as any;
    return {
      id: u._id,
      model: 'User',
      orgId: (req.orgId ?? u.organizationId?.toString()) as string,
      fullName: u.name || u.fullName || u.email || 'Employee',
      email: u.email,
      avatar: u.avatar,
      role: u.role,
      department: u.personalInfo?.department,
    };
  }

  if (crmUser) {
    const c = crmUser as any;
    return {
      id: c._id,
      model: 'CrmUser',
      orgId: c.organizationId?.toString() as string,
      fullName: c.fullName || c.email || 'Employee',
      email: c.email,
      avatar: c.avatar,
      role: c.role,
      department: c.department,
    };
  }

  throw new ApiError(401, 'Not authenticated');
}

// ── Calendar helpers — shared with crmTimeproof.controller.ts and
//    crm.controller.ts via utils/timeLogEngine.ts, no local copies anymore ────
import {
  buildSessions, buildCalendarMap, computeStreak, buildHourPattern, aggregateSummary, toLocalDateStr, buildIdleLog,
} from '../utils/timeLogEngine';


function getTodayMDTWindow() {
  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime() - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  return { todayMDTStr, today: new Date(todayMDTStartUTC), tomorrow: new Date(todayMDTStartUTC + 24 * 60 * 60 * 1000) };
}


export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { today, tomorrow } = getTodayMDTWindow();

  // Look back 2 days so a shift that started "yesterday" (crossed midnight)
  // is still detected as an open time-in today — same lookback +
  // chronological walk getShiftState uses. Without this, an open overnight
  // shift's time-in is invisible here, so the page shows "Start Shift" while
  // the backend/tray already consider the user clocked in.
  const lookbackStart = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
  const lookbackLogs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: lookbackStart, $lt: tomorrow },
  }).sort({ timestamp: 1 }).select('_id type timestamp').lean();

  let isOnShiftWalk = false;
  let walkShiftStartedAt: Date | null = null;
  for (const log of lookbackLogs) {
    if (log.type === 'time-in') {
      isOnShiftWalk = true;
      walkShiftStartedAt = log.timestamp;
    } else if (log.type === 'time-out') {
      isOnShiftWalk = false;
      walkShiftStartedAt = null;
    }
  }

  const todayTimeLogs = (isOnShiftWalk && walkShiftStartedAt && walkShiftStartedAt.getTime() < today.getTime()
    ? lookbackLogs.filter((l) => l.timestamp.getTime() >= walkShiftStartedAt!.getTime())
    : lookbackLogs.filter((l) => l.timestamp.getTime() >= today.getTime())
  ).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  res.json(new ApiResponse(200, {
    _id: actor.id,
    fullName: actor.fullName,
    username: actor.email,
    email: actor.email,
    avatar: actor.avatar,
    role: actor.role,
    department: actor.department,
    userModel: actor.model,
    todayTimeLogs,
  }, 'User fetched'));
});

export const timeClock = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { type, note } = req.body;

  const VALID_TYPES = ['time-in', 'time-out', 'break-in', 'break-out'] as const;
  if (!type || !VALID_TYPES.includes(type)) {
    throw new ApiError(400, 'Type must be "time-in", "time-out", "break-in", or "break-out"');
  }

  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 2);
  lookbackStart.setHours(0, 0, 0, 0);

  const recentLogs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).lean();

  let hasActiveSession = false;
  let hasActiveBreak = false;
  for (const log of recentLogs) {
    if (log.type === 'time-in')    { hasActiveSession = true; }
    else if (log.type === 'time-out')  { hasActiveSession = false; hasActiveBreak = false; }
    else if (log.type === 'break-in')  { hasActiveBreak = true; }
    else if (log.type === 'break-out') { hasActiveBreak = false; }
  }

  if (type === 'time-in'   && hasActiveSession) throw new ApiError(400, 'You are already clocked in');
  if (type === 'time-out'  && !hasActiveSession) throw new ApiError(400, 'You must clock in before clocking out');
  if (type === 'time-out'  && hasActiveBreak)   throw new ApiError(400, 'Please end your break before clocking out');
  if (type === 'break-in'  && !hasActiveSession) throw new ApiError(400, 'You must be clocked in to start a break');
  if (type === 'break-in'  && hasActiveBreak)   throw new ApiError(400, 'You are already on break');
  if (type === 'break-out' && !hasActiveBreak)  throw new ApiError(400, 'No active break to end');

  const { today, tomorrow } = getTodayMDTWindow();

  const timeLog = await TimeLog.create({
    userId: actor.id,
    userModel: actor.model,
    type,
    timestamp: new Date(),
    note: note || undefined,
    ipAddress: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
  });

  try {
    const io = getSocketIO();
    if (io) {
      let totalBreakSeconds: number | undefined;
      if (type === 'break-out') {
        const todayBreakLogs = await TimeLog.find({
          userId: actor.id,
          type: { $in: ['break-in', 'break-out'] },
          timestamp: { $gte: today, $lt: timeLog.timestamp },
        }).sort({ timestamp: 1 }).lean();
        totalBreakSeconds = 0;
        let currentBreakIn: Date | null = null;
        for (const log of todayBreakLogs) {
          if (log.type === 'break-in') currentBreakIn = new Date(log.timestamp);
          else if (log.type === 'break-out' && currentBreakIn) {
            totalBreakSeconds += (new Date(log.timestamp).getTime() - currentBreakIn.getTime()) / 1000;
            currentBreakIn = null;
          }
        }
      }

      io.to(`user:${actor.id.toString()}`).emit(type, {
        _id: timeLog._id,
        type: timeLog.type,
        timestamp: timeLog.timestamp,
        ...(type === 'time-in' && { shiftStartedAt: timeLog.timestamp }),
        ...(type === 'break-in' && { breakStartedAt: timeLog.timestamp }),
        ...(type === 'break-out' && { totalBreakSeconds }),
      });
    }
  } catch (error) {
    console.error('Failed to emit time log event:', error);
  }

  // Mobile-monitoring department push notifications (main User model, e.g. Lot Tech)
  const isLotTech = actor.model === 'User' && isMobileMonitoringDept(actor.department);
  if (isLotTech && actor.orgId) {
    if (type === 'time-in') {
      PushService.notifyOrgAdmins(actor.orgId, {
        title: '🟢 Lot Tech — Clocked In',
        body: `${actor.fullName} clocked in`,
        tag: `lot-tech-in-${actor.id}`,
      }).catch(() => {});
    }

    if (type === 'time-out') {
      // Compute shift duration
      const todayInLogs = await TimeLog.find({
        userId: actor.id,
        type: { $in: ['time-in', 'time-out'] },
        timestamp: { $gte: today, $lt: timeLog.timestamp },
      }).sort({ timestamp: 1 }).lean();

      let totalMs = 0;
      let sessionIn: Date | null = null;
      for (const log of todayInLogs) {
        if (log.type === 'time-in') sessionIn = new Date(log.timestamp);
        else if (log.type === 'time-out' && sessionIn) {
          totalMs += new Date(log.timestamp).getTime() - sessionIn.getTime();
          sessionIn = null;
        }
      }
      const totalH = Math.floor(totalMs / 3_600_000);
      const totalM = Math.floor((totalMs % 3_600_000) / 60_000);
      const durationLabel = totalH > 0 ? `${totalH}h ${totalM}m` : `${totalM}m`;

      PushService.notifyOrgAdmins(actor.orgId, {
        title: '🔴 Lot Tech — Clocked Out',
        body: `${actor.fullName} clocked out — ${durationLabel}`,
        tag: `lot-tech-out-${actor.id}`,
      }).catch(() => {});
    }
  }

  // Return updated today logs
  const todayLogs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: 1 }).select('_id type timestamp').lean();

  res.json(new ApiResponse(200, { todayLogs }, 'Clock event recorded'));
});

/**
 * GET /api/timeclock/shift-state
 * Returns current shift state for both User and CrmUser.
 * No tray-app data (ActivityInterval / AgentHeartbeat) — falls back to wall-clock.
 */
export const getShiftState = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);

  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 2);
  lookbackStart.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).lean();

  // Walk chronologically to determine current state
  let isOnShiftWalk = false;
  let walkShiftStartedAt: string | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') {
      isOnShiftWalk = true;
      walkShiftStartedAt = log.timestamp instanceof Date ? log.timestamp.toISOString() : String(log.timestamp);
    } else if (log.type === 'time-out') {
      isOnShiftWalk = false;
      walkShiftStartedAt = null;
    }
  }
  const isOnShift = isOnShiftWalk;
  const shiftStartedAt = walkShiftStartedAt;

  const timeIns = logs.filter(l => l.type === 'time-in');
  const lastTimeIn = isOnShift && timeIns.length > 0 ? new Date(timeIns[timeIns.length - 1].timestamp) : null;
  const sessionLogs = lastTimeIn ? logs.filter(l => new Date(l.timestamp) >= lastTimeIn!) : logs;
  const breakIns  = sessionLogs.filter(l => l.type === 'break-in');
  const breakOuts = sessionLogs.filter(l => l.type === 'break-out');
  const isOnBreak = breakIns.length > breakOuts.length;
  const breakStartedAt = isOnBreak ? breakIns.at(-1)!.timestamp : null;

  const { todayMDTStr, today: todayMDTStartUTC } = getTodayMDTWindow();

  // Total break seconds in current session
  const currentSessionStart = isOnShift && shiftStartedAt ? new Date(shiftStartedAt) : null;
  const breakLogs = logs
    .filter(l => (l.type === 'break-in' || l.type === 'break-out') && (!currentSessionStart || new Date(l.timestamp) >= currentSessionStart))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let totalBreakSeconds = 0;
  let currentBreakIn: Date | null = null;
  for (const log of breakLogs) {
    if (log.type === 'break-in') currentBreakIn = new Date(log.timestamp);
    else if (log.type === 'break-out' && currentBreakIn) {
      totalBreakSeconds += (new Date(log.timestamp).getTime() - currentBreakIn.getTime()) / 1000;
      currentBreakIn = null;
    }
  }

  // Today's completed worked seconds
  const allSessions = buildSessions(logs);
  const todayTotalWorkedSeconds = allSessions
    .filter(s => !s.isLive && new Date(s.in).getTime() >= todayMDTStartUTC.getTime())
    .reduce((sum, s) => sum + s.duration, 0);

  // Activity-based tracking: sum of completed ActivityIntervals for today
  const activityIntervals = await ActivityInterval.find({
    userId: actor.id,
    shiftDate: todayMDTStr,
  }).lean();
  const activityIntervalTotal = activityIntervals.reduce((sum: number, i: any) => sum + i.durationSeconds, 0);
  const todayTotalActiveSeconds = activityIntervalTotal > 0
    ? activityIntervalTotal
    : Math.max(0, todayTotalWorkedSeconds - totalBreakSeconds);

  const isShiftFromToday = shiftStartedAt ? new Date(shiftStartedAt).getTime() >= todayMDTStartUTC.getTime() : false;

  // Live interval start — use tray heartbeat if fresh, else wall-clock fallback
  const heartbeat = await AgentHeartbeat.findOne({ userId: actor.id }).lean();
  const rawIntervalStart = (heartbeat as any)?.currentIntervalStartAt
    ? new Date((heartbeat as any).currentIntervalStartAt).toISOString()
    : null;
  const heartbeatFresh = heartbeat
    ? Date.now() - new Date((heartbeat as any).lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const fallbackShiftedStart = isOnShift && !isOnBreak && isShiftFromToday && shiftStartedAt
    ? new Date(new Date(shiftStartedAt).getTime() + totalBreakSeconds * 1000).toISOString()
    : null;
  const currentIntervalStartAt = isOnBreak
    ? null
    : heartbeatFresh
      ? rawIntervalStart
      : activityIntervalTotal > 0
        ? null
        : fallbackShiftedStart;

  res.json(new ApiResponse(200, {
    isOnShift,
    isOnBreak,
    isShiftFromToday,
    shiftStartedAt,
    breakStartedAt,
    totalBreakSeconds,
    todayTotalWorkedSeconds,
    todayTotalActiveSeconds,
    currentIntervalStartAt,
  }, 'Shift state fetched'));
});

/**
 * GET /api/timeclock/my?range=90
 * Returns full timeproof calendar data for both User and CrmUser.
 */
export const getMyTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { range = '90' } = req.query;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(range as string));
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);

  const logs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const calendar = buildCalendarMap(logs, COMPANY_TZ_OFFSET_MINUTES);
  const todayStr = toLocalDateStr(new Date(), COMPANY_TZ_OFFSET_MINUTES);

  // Ghost-hours correction for past open sessions (no tray app, no ActivityIntervals)
  for (const dateStr of Object.keys(calendar)) {
    if (dateStr === todayStr) continue;
    const openSeconds = calendar[dateStr].sessions.filter(s => s.isOpen).reduce((sum, s) => sum + s.duration, 0);
    if (openSeconds > 0) {
      calendar[dateStr].totalSeconds = Math.max(0, calendar[dateStr].totalSeconds - openSeconds);
    }
  }

  const summary = aggregateSummary(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const { streak, longestStreak } = computeStreak(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const hourPattern = buildHourPattern(logs, COMPANY_TZ_OFFSET_MINUTES);
  const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

  res.json(new ApiResponse(200, {
    user: {
      _id: actor.id,
      fullName: actor.fullName,
      username: actor.email,
      avatar: actor.avatar,
      role: actor.role,
    },
    calendar,
    summary,
    streak,
    longestStreak,
    hourPattern,
    isLive,
    range: { startDate, endDate },
  }, 'Timeproof data fetched'));
});

/**
 * GET /api/timeclock/idle-log?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Read-only report of when the authenticated user went idle (tray-detected
 * inactivity), derived from gaps between committed ActivityIntervals within
 * each clocked-in session. Days the tray never ran are skipped entirely.
 */
export const getMyIdleLog = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { startDate: startDateStr, endDate: endDateStr } = req.query;
  if (!startDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(startDateStr as string)) {
    throw new ApiError(400, 'startDate is required (YYYY-MM-DD)');
  }
  if (!endDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr as string)) {
    throw new ApiError(400, 'endDate is required (YYYY-MM-DD)');
  }

  const startDate = new Date(`${startDateStr}T00:00:00.000Z`);
  startDate.setUTCMinutes(startDate.getUTCMinutes() - COMPANY_TZ_OFFSET_MINUTES);
  const endDate = new Date(`${endDateStr}T23:59:59.999Z`);
  endDate.setUTCMinutes(endDate.getUTCMinutes() - COMPANY_TZ_OFFSET_MINUTES);

  const logs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const activityIntervals = await ActivityInterval.find({
    userId: actor.id,
    startAt: { $lte: endDate },
    endAt: { $gte: startDate },
  }).select('startAt endAt').lean();

  const idleLog = buildIdleLog(logs, activityIntervals, COMPANY_TZ_OFFSET_MINUTES);

  res.json(new ApiResponse(200, { idleLog, range: { startDate: startDateStr, endDate: endDateStr } }, 'Idle log fetched'));
});

/**
 * GET /api/timeclock/resumable-shift
 * Check if today has a previous clock-out that can be resumed.
 */
export const getResumableShift = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { today, tomorrow } = getTodayMDTWindow();

  const todayLogs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: 1 }).lean();

  const timeIns  = todayLogs.filter(l => l.type === 'time-in');
  const timeOuts = todayLogs.filter(l => l.type === 'time-out');
  const isOnShift = timeIns.length > timeOuts.length;
  const resumable = !isOnShift && timeOuts.length > 0;
  const originalClockIn = resumable && timeIns.length > 0 ? new Date(timeIns[0].timestamp).toISOString() : null;

  res.json(new ApiResponse(200, { resumable, originalClockIn }, 'Resumable shift checked'));
});

/**
 * POST /api/timeclock/heartbeat
 * Tray app pings every 60s. Works for both User and CrmUser.
 */
export const postHeartbeat = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const {
    isIdle = false,
    platform = 'win32',
    isOnBreak = false,
    breakDurationSeconds = 0,
    isOnShift = false,
    currentIntervalStartAt,
  } = req.body;

  const existing = await AgentHeartbeat.findOne({ userId: actor.id }).lean();
  const wasOnBreak = (existing as any)?.isOnBreak ?? false;

  let lastBreakNotifiedAt = (existing as any)?.lastBreakNotifiedAt ?? null;
  if (!isOnBreak && wasOnBreak) lastBreakNotifiedAt = null;

  await AgentHeartbeat.findOneAndUpdate(
    { userId: actor.id },
    {
      isIdle,
      isOnBreak,
      breakStartedAt: isOnBreak && !wasOnBreak ? new Date() : (isOnBreak ? (existing as any)?.breakStartedAt ?? null : null),
      lastBreakNotifiedAt,
      platform,
      lastSeenAt: new Date(),
      ...(currentIntervalStartAt !== undefined && {
        currentIntervalStartAt: currentIntervalStartAt ? new Date(currentIntervalStartAt) : null,
      }),
    },
    { upsert: true, new: true }
  );

  res.json(new ApiResponse(200, { received: true }, 'Heartbeat recorded'));
});

/**
 * POST /api/timeclock/activity-interval
 * Tray app posts a completed active period when the user goes idle. Works for both User and CrmUser.
 */
export const postActivityInterval = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { startAt, endAt } = req.body;

  if (!startAt || !endAt) throw new ApiError(400, 'startAt and endAt are required');

  const start = new Date(startAt);
  const end = new Date(endAt);
  const durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);

  if (durationSeconds < 30) {
    return res.json(new ApiResponse(200, { durationSeconds: 0 }, 'Interval too short, skipped'));
  }

  const shiftDate = toLocalDateStr(start, COMPANY_TZ_OFFSET_MINUTES);

  await ActivityInterval.create({
    userId: actor.id,
    shiftDate,
    startAt: start,
    endAt: end,
    durationSeconds,
  });

  res.json(new ApiResponse(201, { durationSeconds }, 'Activity interval saved'));
});

export default { getMe, timeClock, getShiftState, getMyTimeproof, getMyIdleLog, getResumableShift, postHeartbeat, postActivityInterval };
