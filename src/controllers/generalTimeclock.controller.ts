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

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_TZ_OFFSET_MINUTES = -360; // MDT UTC-6
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;

// ── Actor helper ──────────────────────────────────────────────────────────────

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

// ── Calendar helpers (mirrors crmTimeproof.controller.ts) ─────────────────────

const toDateStr = (date: Date) => date.toISOString().split('T')[0];

const toLocalDateStr = (date: Date, tzOffsetMinutes: number): string => {
  const local = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  return local.toISOString().split('T')[0];
};

const buildSessions = (logs: any[]) => {
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const sessions: { in: Date; out: Date | null; duration: number; isLive: boolean; isOpen: boolean }[] = [];
  let currentIn: Date | null = null;

  for (const log of sorted) {
    if (log.type === 'time-in') {
      currentIn = new Date(log.timestamp);
    } else if (log.type === 'time-out' && currentIn) {
      const out = new Date(log.timestamp);
      sessions.push({ in: currentIn, out, duration: (out.getTime() - currentIn.getTime()) / 1000, isLive: false, isOpen: false });
      currentIn = null;
    }
  }

  if (currentIn) {
    const now = new Date();
    const MAX_LIVE_MS = 12 * 60 * 60 * 1000;
    const elapsedMs = now.getTime() - currentIn.getTime();
    const isCapped = elapsedMs > MAX_LIVE_MS;
    sessions.push({ in: currentIn, out: null, duration: Math.min(elapsedMs, MAX_LIVE_MS) / 1000, isLive: !isCapped, isOpen: true });
  }

  return sessions;
};

const buildBreakSessions = (logs: any[]) => {
  const sorted = [...logs]
    .filter((l) => l.type === 'break-in' || l.type === 'break-out')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const breaks: { in: Date; out: Date | null; duration: number; isActive: boolean }[] = [];
  let currentBreakIn: Date | null = null;

  for (const log of sorted) {
    if (log.type === 'break-in') {
      currentBreakIn = new Date(log.timestamp);
    } else if (log.type === 'break-out' && currentBreakIn) {
      const out = new Date(log.timestamp);
      breaks.push({ in: currentBreakIn, out, duration: (out.getTime() - currentBreakIn.getTime()) / 1000, isActive: false });
      currentBreakIn = null;
    }
  }

  if (currentBreakIn) {
    breaks.push({ in: currentBreakIn, out: null, duration: (Date.now() - currentBreakIn.getTime()) / 1000, isActive: true });
  }

  return breaks;
};

const getMidnightSegments = (
  startTime: Date,
  endTime: Date,
  tzOffsetMinutes: number
): Array<{ date: string; segStart: Date; segEnd: Date }> => {
  const result: Array<{ date: string; segStart: Date; segEnd: Date }> = [];
  let segStart = new Date(startTime);

  while (true) {
    const segDateStr = toLocalDateStr(segStart, tzOffsetMinutes);
    const localDayStartUTC = new Date(segDateStr + 'T00:00:00.000Z').getTime();
    const nextLocalMidnightUTC = new Date(localDayStartUTC + 24 * 60 * 60 * 1000 - tzOffsetMinutes * 60_000);

    if (endTime <= nextLocalMidnightUTC) {
      result.push({ date: segDateStr, segStart: new Date(segStart), segEnd: new Date(endTime) });
      break;
    }

    result.push({ date: segDateStr, segStart: new Date(segStart), segEnd: new Date(nextLocalMidnightUTC) });
    segStart = new Date(nextLocalMidnightUTC);
  }

  return result;
};

type CalendarDay = {
  sessions: Array<{ in: Date; out: Date | null; duration: number; isLive: boolean; isOpen: boolean }>;
  totalSeconds: number;
  breaks: Array<{ in: Date; out: Date | null; duration: number; isActive: boolean }>;
  breakSeconds: number;
  weekTotalSeconds?: number;
};

const attachWeekTotals = (calendar: Record<string, CalendarDay>) => {
  const weekMap: Record<string, string[]> = {};

  for (const dateStr of Object.keys(calendar)) {
    if (calendar[dateStr].totalSeconds === 0) continue;
    const d = new Date(dateStr + 'T12:00:00Z');
    const dayOfWeek = d.getUTCDay();
    const daysToSaturday = dayOfWeek === 0 ? 6 : 6 - dayOfWeek;
    const saturday = new Date(d);
    saturday.setUTCDate(d.getUTCDate() + daysToSaturday);
    const saturdayStr = toDateStr(saturday);
    (weekMap[saturdayStr] ??= []).push(dateStr);
  }

  for (const [saturdayStr, dates] of Object.entries(weekMap)) {
    const weekTotal = dates.reduce((sum, d) => sum + calendar[d].totalSeconds, 0);
    if (!calendar[saturdayStr]) {
      calendar[saturdayStr] = { sessions: [], totalSeconds: 0, breaks: [], breakSeconds: 0 };
    }
    calendar[saturdayStr].weekTotalSeconds = weekTotal;
  }
};

const buildCalendarMap = (logs: any[], tzOffsetMinutes = 0) => {
  const allSessions = buildSessions(logs);
  const allBreaks = buildBreakSessions(logs);

  const byDate: Record<string, { sessions: CalendarDay['sessions']; breaks: CalendarDay['breaks'] }> = {};
  const ensure = (d: string) => { if (!byDate[d]) byDate[d] = { sessions: [], breaks: [] }; };

  for (const s of allSessions) {
    const endTime = s.out ?? (s.isLive ? new Date() : new Date(s.in.getTime() + s.duration * 1000));
    const segments = getMidnightSegments(s.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].sessions.push({ in: segStart, out: s.out && isLast ? s.out : segEnd, duration: (segEnd.getTime() - segStart.getTime()) / 1000, isLive: s.isLive && isLast, isOpen: s.isOpen });
    }
  }

  for (const b of allBreaks) {
    const endTime = b.out ?? new Date();
    const segments = getMidnightSegments(b.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].breaks.push({ in: segStart, out: b.out && isLast ? b.out : segEnd, duration: (segEnd.getTime() - segStart.getTime()) / 1000, isActive: b.isActive && isLast });
    }
  }

  const calendar: Record<string, CalendarDay> = {};
  for (const [date, data] of Object.entries(byDate)) {
    const grossSessionSeconds = data.sessions.reduce((sum, s) => sum + s.duration, 0);
    const breakSeconds = data.breaks.reduce((sum, b) => sum + b.duration, 0);
    calendar[date] = { sessions: data.sessions, totalSeconds: Math.max(0, grossSessionSeconds - breakSeconds), breaks: data.breaks, breakSeconds };
  }

  attachWeekTotals(calendar);
  return calendar;
};

const computeStreak = (calendar: ReturnType<typeof buildCalendarMap>, tzOffsetMinutes = 0) => {
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];
  let streak = 0;
  const check = new Date(localNow);
  check.setUTCHours(12, 0, 0, 0);

  while (true) {
    const dateStr = check.toISOString().split('T')[0];
    const hasWork = !!calendar[dateStr] && calendar[dateStr].totalSeconds > 0;
    if (hasWork) { streak++; check.setUTCDate(check.getUTCDate() - 1); }
    else if (dateStr === todayStr) { check.setUTCDate(check.getUTCDate() - 1); }
    else { break; }
  }

  const sorted = Object.keys(calendar).sort();
  let longest = 0, temp = 0;
  for (const d of sorted) {
    if (calendar[d].totalSeconds > 0) { temp++; longest = Math.max(longest, temp); }
    else { temp = 0; }
  }

  return { streak, longestStreak: longest };
};

const buildHourPattern = (logs: any[], tzOffsetMinutes = 0) => {
  const pattern = new Array(24).fill(0);
  for (const log of logs) {
    if (log.type === 'time-in') {
      const localTs = new Date(new Date(log.timestamp).getTime() + tzOffsetMinutes * 60_000);
      pattern[localTs.getUTCHours()]++;
    }
  }
  return pattern;
};

const formatHours = (seconds: number) => ({
  hours: Math.floor(seconds / 3600),
  minutes: Math.floor((seconds % 3600) / 60),
  totalSeconds: Math.round(seconds),
  decimal: parseFloat((seconds / 3600).toFixed(2)),
});

const aggregateSummary = (calendar: ReturnType<typeof buildCalendarMap>, tzOffsetMinutes = 0) => {
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];
  const localDay = localNow.getUTCDay();
  const daysFromMonday = localDay === 0 ? 6 : localDay - 1;
  const weekStartStr = new Date(localNow.getTime() - daysFromMonday * 86_400_000).toISOString().split('T')[0];
  const monthStartStr = todayStr.slice(0, 7) + '-01';

  let todaySeconds = 0, weekSeconds = 0, monthSeconds = 0;
  for (const [dateStr, data] of Object.entries(calendar)) {
    if (dateStr === todayStr) todaySeconds += data.totalSeconds;
    if (dateStr >= weekStartStr) weekSeconds += data.totalSeconds;
    if (dateStr >= monthStartStr) monthSeconds += data.totalSeconds;
  }

  return { today: formatHours(todaySeconds), thisWeek: formatHours(weekSeconds), thisMonth: formatHours(monthSeconds) };
};

// ── Helper: get today's MDT window ────────────────────────────────────────────

function getTodayMDTWindow() {
  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime() - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  return { todayMDTStr, today: new Date(todayMDTStartUTC), tomorrow: new Date(todayMDTStartUTC + 24 * 60 * 60 * 1000) };
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/timeclock/me
 * Returns current user info + today's time logs. Works for both User and CrmUser.
 */
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const actor = getActor(req);
  const { today, tomorrow } = getTodayMDTWindow();

  const todayTimeLogs = await TimeLog.find({
    userId: actor.id,
    timestamp: { $gte: today, $lt: tomorrow },
  }).sort({ timestamp: 1 }).select('_id type timestamp').lean();

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

/**
 * POST /api/timeclock/clock
 * Clock-in / clock-out / break-in / break-out for both User and CrmUser.
 */
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

export default { getMe, timeClock, getShiftState, getMyTimeproof, getResumableShift, postHeartbeat, postActivityInterval };
