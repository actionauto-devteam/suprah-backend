// repush
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import TimeLog from '../models/TimeLog.model';
import CrmUser from '../models/CrmUser.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';
import { storageService, BucketType } from '../services/storage.service';
import { getSignedProofUrl } from '../utils/signedUrlCache';
import { emitToUser, emitToShiftBoard, isCrmUserOnline } from '../utils/socketEmitter';
import CrmPushService from '../services/crmPush.service';

const BREAK_LIMIT_SECONDS = 3600; // 3600

// Company operates on Mountain Daylight Time (MDT = UTC-6).
// All timeproof calendar dates are computed in this fixed offset
// regardless of where the user's device is physically located.
const COMPANY_TZ_OFFSET_MINUTES = -360; // MDT UTC-6

/* ──────────────────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────────────────── */

/** Pair time-in / time-out logs into complete sessions */
const buildSessions = (logs: any[]) => {
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessions: { in: Date; out: Date | null; duration: number; isLive: boolean }[] = [];
  let currentIn: Date | null = null;

  for (const log of sorted) {
    if (log.type === 'time-in') {
      currentIn = new Date(log.timestamp);
    } else if (log.type === 'time-out' && currentIn) {
      const out = new Date(log.timestamp);
      sessions.push({
        in: currentIn,
        out,
        duration: (out.getTime() - currentIn.getTime()) / 1000,
        isLive: false,
      });
      currentIn = null;
    }
  }

  // Currently clocked in (no matching time-out).
  // Cap at 12 hours so a single forgotten clock-out cannot inflate every subsequent
  // calendar day with 24:00 entries (one unclosed session → one live slice per day).
  if (currentIn) {
    const now = new Date();
    const MAX_LIVE_MS = 12 * 60 * 60 * 1000;
    const elapsedMs = now.getTime() - currentIn.getTime();
    const isCapped = elapsedMs > MAX_LIVE_MS;
    sessions.push({
      in: currentIn,
      out: null,
      duration: Math.min(elapsedMs, MAX_LIVE_MS) / 1000,
      isLive: !isCapped,
    });
  }

  return sessions;
};

/** Date → "YYYY-MM-DD" (UTC) */
const toDateStr = (date: Date) => date.toISOString().split('T')[0];

/** Date → "YYYY-MM-DD" in the user's local timezone (tzOffsetMinutes = minutes east of UTC, e.g. +480 for UTC+8) */
const toLocalDateStr = (date: Date, tzOffsetMinutes: number): string => {
  const local = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  return local.toISOString().split('T')[0];
};

/** Start of ISO week (Monday 00:00:00) */
const getWeekStart = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Pair break-in / break-out logs into break sessions */
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
      breaks.push({
        in: currentBreakIn,
        out,
        duration: (out.getTime() - currentBreakIn.getTime()) / 1000,
        isActive: false,
      });
      currentBreakIn = null;
    }
  }

  if (currentBreakIn) {
    const now = new Date();
    breaks.push({
      in: currentBreakIn,
      out: null,
      duration: (now.getTime() - currentBreakIn.getTime()) / 1000,
      isActive: true,
    });
  }

  return breaks;
};

/**
 * Splits a time range into calendar-day segments using LOCAL midnight boundaries.
 * tzOffsetMinutes: minutes east of UTC (e.g. +480 for UTC+8 Philippines).
 * Each segment belongs to exactly one local calendar day.
 */
const getMidnightSegments = (
  startTime: Date,
  endTime: Date,
  tzOffsetMinutes: number
): Array<{ date: string; segStart: Date; segEnd: Date }> => {
  const result: Array<{ date: string; segStart: Date; segEnd: Date }> = [];
  let segStart = new Date(startTime);

  while (true) {
    const segDateStr = toLocalDateStr(segStart, tzOffsetMinutes);
    // Compute the next local midnight as a UTC timestamp:
    // Local midnight of (segDate + 1 day) = segDate "T00:00:00Z" + 24h - tzOffset
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
  sessions: Array<{ in: Date; out: Date | null; duration: number; isLive: boolean }>;
  totalSeconds: number;
  breaks: Array<{ in: Date; out: Date | null; duration: number; isActive: boolean }>;
  breakSeconds: number;
  weekTotalSeconds?: number;
};

/**
 * Attach weekTotalSeconds to the Saturday of each Sun–Sat week.
 * If the user has worked days in a week, the total is placed on that week's Saturday.
 * A skeleton CalendarDay is created for Saturday if no logs exist on that day,
 * so the frontend can still render the green badge.
 * Break time is excluded from the week total.
 */
const attachWeekTotals = (calendar: Record<string, CalendarDay>) => {
  // Group worked dates by their week's Saturday
  const weekMap: Record<string, string[]> = {};

  for (const dateStr of Object.keys(calendar)) {
    if (calendar[dateStr].totalSeconds === 0) continue;
    const d = new Date(dateStr + 'T12:00:00Z');
    const dayOfWeek = d.getUTCDay(); // 0=Sun … 6=Sat
    const daysToSaturday = dayOfWeek === 0 ? 6 : 6 - dayOfWeek;
    const saturday = new Date(d);
    saturday.setUTCDate(d.getUTCDate() + daysToSaturday);
    const saturdayStr = toDateStr(saturday);
    (weekMap[saturdayStr] ??= []).push(dateStr);
  }

  for (const [saturdayStr, dates] of Object.entries(weekMap)) {
    const weekTotal = dates.reduce((sum, d) => sum + calendar[d].totalSeconds, 0);

    // Ensure Saturday entry exists even if no logs that day
    if (!calendar[saturdayStr]) {
      calendar[saturdayStr] = { sessions: [], totalSeconds: 0, breaks: [], breakSeconds: 0 };
    }
    calendar[saturdayStr].weekTotalSeconds = weekTotal;
  }
};

/** Build per-day calendar map from raw log array with local-midnight-split support */
const buildCalendarMap = (logs: any[], tzOffsetMinutes = 0) => {
  // Build sessions and breaks globally so cross-midnight pairs are handled
  const allSessions = buildSessions(logs);
  const allBreaks = buildBreakSessions(logs);

  const byDate: Record<string, {
    sessions: CalendarDay['sessions'];
    breaks: CalendarDay['breaks'];
  }> = {};

  const ensure = (d: string) => {
    if (!byDate[d]) byDate[d] = { sessions: [], breaks: [] };
  };

  for (const s of allSessions) {
    // For capped sessions (out=null, isLive=false), reconstruct effective end from duration
    // so getMidnightSegments doesn't spread the session to "now" across all subsequent days.
    const endTime = s.out ?? (s.isLive ? new Date() : new Date(s.in.getTime() + s.duration * 1000));
    const segments = getMidnightSegments(s.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].sessions.push({
        in: segStart,
        out: s.out && isLast ? s.out : segEnd,
        duration: (segEnd.getTime() - segStart.getTime()) / 1000,
        isLive: s.isLive && isLast,
      });
    }
  }

  for (const b of allBreaks) {
    const endTime = b.out ?? new Date();
    const segments = getMidnightSegments(b.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].breaks.push({
        in: segStart,
        out: b.out && isLast ? b.out : segEnd,
        duration: (segEnd.getTime() - segStart.getTime()) / 1000,
        isActive: b.isActive && isLast,
      });
    }
  }

  const calendar: Record<string, CalendarDay> = {};
  for (const [date, data] of Object.entries(byDate)) {
    const grossSessionSeconds = data.sessions.reduce((sum, s) => sum + s.duration, 0);
    const breakSeconds = data.breaks.reduce((sum, b) => sum + b.duration, 0);
    // totalSeconds is the NET work time (excludes breaks). Both the time clock
    // and this calendar use net work for consistency.
    calendar[date] = {
      sessions: data.sessions,
      totalSeconds: Math.max(0, grossSessionSeconds - breakSeconds),
      breaks: data.breaks,
      breakSeconds,
    };
  }

  attachWeekTotals(calendar);

  return calendar;
};

/** Compute consecutive working-day streak using local calendar dates */
const computeStreak = (calendar: ReturnType<typeof buildCalendarMap>, tzOffsetMinutes = 0) => {
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];

  let streak = 0;
  // Walk backwards one UTC-day at a time (date strings are local, so stepping by 1 day is fine)
  const check = new Date(localNow);
  check.setUTCHours(12, 0, 0, 0); // pin to noon to avoid DST edge cases

  while (true) {
    const dateStr = check.toISOString().split('T')[0];
    const hasWork = !!calendar[dateStr] && calendar[dateStr].totalSeconds > 0;

    if (hasWork) {
      streak++;
      check.setUTCDate(check.getUTCDate() - 1);
    } else if (dateStr === todayStr) {
      // Today hasn't been worked yet — look back from yesterday
      check.setUTCDate(check.getUTCDate() - 1);
    } else {
      break;
    }
  }

  // Longest ever streak
  const sorted = Object.keys(calendar).sort();
  let longest = 0;
  let temp = 0;
  for (const d of sorted) {
    if (calendar[d].totalSeconds > 0) {
      temp++;
      longest = Math.max(longest, temp);
    } else {
      temp = 0;
    }
  }

  return { streak, longestStreak: longest };
};

/** Build 24-element array: how many clock-ins per hour-of-day (in user's local time) */
const buildHourPattern = (logs: any[], tzOffsetMinutes = 0) => {
  const pattern = new Array(24).fill(0);
  for (const log of logs) {
    if (log.type === 'time-in') {
      const localTs = new Date(new Date(log.timestamp).getTime() + tzOffsetMinutes * 60_000);
      const h = localTs.getUTCHours();
      pattern[h]++;
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

/** Aggregate per-day data into week/month buckets using local calendar dates */
const aggregateSummary = (calendar: ReturnType<typeof buildCalendarMap>, tzOffsetMinutes = 0) => {
  const now = new Date();
  // Shift "now" into the user's local timezone for date-string comparisons
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];

  // Local week start (Monday) as a date string
  const localDay = localNow.getUTCDay(); // 0=Sun … 6=Sat
  const daysFromMonday = localDay === 0 ? 6 : localDay - 1;
  const localWeekStartMs = localNow.getTime() - daysFromMonday * 86_400_000;
  const weekStartStr = new Date(localWeekStartMs).toISOString().split('T')[0];

  // Local month start as a date string  ("YYYY-MM-01")
  const monthStartStr = todayStr.slice(0, 7) + '-01';

  let todaySeconds = 0;
  let weekSeconds = 0;
  let monthSeconds = 0;

  for (const [dateStr, data] of Object.entries(calendar)) {
    if (dateStr === todayStr) todaySeconds += data.totalSeconds;
    if (dateStr >= weekStartStr) weekSeconds += data.totalSeconds;
    if (dateStr >= monthStartStr) monthSeconds += data.totalSeconds;
  }

  return {
    today: formatHours(todaySeconds),
    thisWeek: formatHours(weekSeconds),
    thisMonth: formatHours(monthSeconds),
  };
};

/* ──────────────────────────────────────────────────────────────────────────
   Controllers
────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/crm/timeproof/my?range=90
 * Returns the current user's full timeproof dataset.
 */
export const getMyTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { range = '90' } = req.query;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(range as string));
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);

  const logs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const calendar = buildCalendarMap(logs, COMPANY_TZ_OFFSET_MINUTES);

  // Override EVERY day's calendar entry with the activity-based total when it's
  // smaller than the session wall-clock. A multi-day unclosed clock-in (e.g. the
  // user forgot to clock out for two days) otherwise paints the intermediate
  // days as 24h "work" via the midnight segment splitter — pure ghost time the
  // user never actually worked. Activity intervals (saved per real active
  // period) are the authoritative truth, so we prefer them whenever they exist.
  const todayStr = toLocalDateStr(new Date(), COMPANY_TZ_OFFSET_MINUTES);
  const allActivityIntervals = await ActivityInterval.find({
    userId: user._id,
    shiftDate: { $in: Object.keys(calendar) },
  }).lean();
  const activityByDate: Record<string, number> = {};
  for (const i of allActivityIntervals) {
    activityByDate[i.shiftDate] = (activityByDate[i.shiftDate] ?? 0) + i.durationSeconds;
  }

  // For today specifically, also include the currently-running interval (if any)
  // so the displayed total tracks the live timer.
  const todayHeartbeat = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
  const heartbeatFresh = todayHeartbeat
    ? Date.now() - new Date(todayHeartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const liveActiveSeconds = heartbeatFresh && todayHeartbeat?.currentIntervalStartAt
    ? Math.max(0, (Date.now() - new Date(todayHeartbeat.currentIntervalStartAt).getTime()) / 1000)
    : 0;
  activityByDate[todayStr] = (activityByDate[todayStr] ?? 0) + liveActiveSeconds;

  for (const dateStr of Object.keys(calendar)) {
    const activeForDate = activityByDate[dateStr] ?? 0;
    // Only override when the activity-based number is SMALLER — i.e. the wall-clock
    // is inflated. If activity is larger (rare/impossible) we keep the wall-clock.
    if (activeForDate > 0 && activeForDate < calendar[dateStr].totalSeconds) {
      calendar[dateStr].totalSeconds = activeForDate;
    }
  }

  const summary = aggregateSummary(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const { streak, longestStreak } = computeStreak(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const hourPattern = buildHourPattern(logs, COMPANY_TZ_OFFSET_MINUTES);

  const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

  res.json(
    new ApiResponse(200, {
      user: {
        _id: user._id,
        fullName: user.fullName,
        username: user.username,
        avatar: user.avatar,
        role: user.role,
      },
      calendar,
      summary,
      streak,
      longestStreak,
      hourPattern,
      isLive,
      range: { startDate, endDate },
    }, 'Timeproof data fetched')
  );
});

/**
 * GET /api/crm/timeproof/users
 * Admin/Manager: leaderboard-style summary for all active users.
 */
export const getAllUsersTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied — admin or manager role required');
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Use MDT window for today so shift-state matches getShiftState
  const nowMDT = new Date(now.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  const tomorrowMDTStartUTC = todayMDTStartUTC + 24 * 60 * 60 * 1000;
  const todayStart = new Date(todayMDTStartUTC);
  const tomorrow   = new Date(tomorrowMDTStartUTC);
  const weekStart = getWeekStart(now);
  const todayStr = todayMDTStr;

  const users = await CrmUser.find({ isActive: true }).select('-password').lean();

  const results = await Promise.all(
    users.map(async (u) => {
      const logs = await TimeLog.find({
        userId: u._id,
        timestamp: { $gte: monthStart },
      }).sort({ timestamp: 1 }).lean();

      const calendar = buildCalendarMap(logs);
      const summary = aggregateSummary(calendar);
      const { streak } = computeStreak(calendar);
      const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

      // ── Timer state: exact same logic as getShiftState so admin board ──────
      // and tray always compute from the same source.
      const todayLogs = logs.filter(l => {
        const ts = new Date(l.timestamp);
        return ts >= todayStart && ts < tomorrow;
      });

      const timeIns  = todayLogs.filter(l => l.type === 'time-in');
      const timeOuts = todayLogs.filter(l => l.type === 'time-out');
      const isOnShift = timeIns.length > timeOuts.length;
      const shiftStartedAt = isOnShift
        ? new Date(timeIns.at(-1)!.timestamp).toISOString()
        : null;

      // Completed session wall-times (same as tray's todayTotalWorkedSeconds)
      const allTodaySessions = buildSessions(todayLogs);
      const todayTotalWorkedSeconds = allTodaySessions
        .filter(s => !s.isLive)
        .reduce((sum, s) => sum + s.duration, 0);

      // Completed break seconds in current session only (same as tray's totalBreakSeconds)
      const currentSessionStart = isOnShift && shiftStartedAt
        ? new Date(shiftStartedAt)
        : null;
      const breakLogs = todayLogs
        .filter(l =>
          (l.type === 'break-in' || l.type === 'break-out') &&
          (!currentSessionStart || new Date(l.timestamp) >= currentSessionStart)
        )
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      let totalBreakSeconds = 0;
      let bIn: Date | null = null;
      for (const log of breakLogs) {
        if (log.type === 'break-in') {
          bIn = new Date(log.timestamp);
        } else if (log.type === 'break-out' && bIn) {
          totalBreakSeconds += (new Date(log.timestamp).getTime() - bIn.getTime()) / 1000;
          bIn = null;
        }
      }

      // Snapshot for the non-live fallback (frozen display when offline/off-shift)
      const liveWallSec = isOnShift && shiftStartedAt
        ? (now.getTime() - new Date(shiftStartedAt).getTime()) / 1000
        : 0;
      const todayNetSnapshot = todayTotalWorkedSeconds + Math.max(0, liveWallSec - totalBreakSeconds);
      const today = formatHours(todayNetSnapshot);

      return {
        user: {
          _id: u._id,
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
        },
        today,
        thisWeek: summary.thisWeek,
        thisMonth: summary.thisMonth,
        streak,
        isLive,
        shiftStartedAt,
        todayTotalWorkedSeconds,
        totalBreakSeconds,
      };
    })
  );

  // Sort by this month hours descending
  results.sort((a, b) => b.thisMonth.totalSeconds - a.thisMonth.totalSeconds);

  res.json(new ApiResponse(200, { users: results }, 'Team timeproof fetched'));
});

/**
 * GET /api/crm/timeproof/user/:userId?range=90
 * Admin/Manager: full dataset for a specific user.
 */
export const getUserTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const { userId } = req.params;
  const { range = '90' } = req.query;

  const targetUser = await CrmUser.findById(userId).select('-password');
  if (!targetUser) throw new ApiError(404, 'User not found');

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(range as string));
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);

  const logs = await TimeLog.find({
    userId,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const calendar = buildCalendarMap(logs, COMPANY_TZ_OFFSET_MINUTES);

  // Override TODAY with activity-based time to avoid ghost hours from stale
  // unclosed clock-ins (same fix as getMyTimeproof).
  const todayStr = toLocalDateStr(new Date(), COMPANY_TZ_OFFSET_MINUTES);
  const userTodayIntervals = await ActivityInterval.find({ userId, shiftDate: todayStr }).lean();
  const userTodayIntervalTotal = userTodayIntervals.reduce((sum, i) => sum + i.durationSeconds, 0);
  const userTodayHeartbeat = await AgentHeartbeat.findOne({ userId }).lean();
  const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
  const userHeartbeatFresh = userTodayHeartbeat
    ? Date.now() - new Date(userTodayHeartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const userLiveActiveSeconds = userHeartbeatFresh && userTodayHeartbeat?.currentIntervalStartAt
    ? Math.max(0, (Date.now() - new Date(userTodayHeartbeat.currentIntervalStartAt).getTime()) / 1000)
    : 0;
  const userTodayActiveSeconds = userTodayIntervalTotal + userLiveActiveSeconds;
  if (calendar[todayStr] && userTodayActiveSeconds < calendar[todayStr].totalSeconds) {
    calendar[todayStr].totalSeconds = userTodayActiveSeconds;
  }

  const summary = aggregateSummary(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const { streak, longestStreak } = computeStreak(calendar, COMPANY_TZ_OFFSET_MINUTES);
  const hourPattern = buildHourPattern(logs, COMPANY_TZ_OFFSET_MINUTES);

  const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

  res.json(
    new ApiResponse(200, {
      user: {
        _id: targetUser._id,
        fullName: targetUser.fullName,
        username: targetUser.username,
        avatar: targetUser.avatar,
        role: targetUser.role,
      },
      calendar,
      summary,
      streak,
      longestStreak,
      hourPattern,
      isLive,
      range: { startDate, endDate },
    }, 'User timeproof fetched')
  );
});

/**
 * GET /api/crm/timeproof/export?userId=...&range=90
 * Returns a CSV-compatible string for download.
 */
export const exportTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { userId, range = '30' } = req.query;

  // Only admins can export others; employees export their own
  const targetId =
    userId && ['admin', 'manager'].includes(requestor.role)
      ? (userId as string)
      : requestor._id.toString();

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(range as string));
  startDate.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({
    userId: targetId,
    timestamp: { $gte: startDate },
  }).sort({ timestamp: 1 }).lean();

  const calendar = buildCalendarMap(logs);

  const rows = ['Date,Work Sessions,Work Hours,Work Minutes,Break Sessions,Break Hours,Break Minutes'];
  for (const [date, data] of Object.entries(calendar).sort()) {
    const workSessions = data.sessions.map(s =>
      `${new Date(s.in).toLocaleTimeString()}→${s.out ? new Date(s.out).toLocaleTimeString() : 'ongoing'}`
    ).join(' | ');
    const wh = Math.floor(data.totalSeconds / 3600);
    const wm = Math.floor((data.totalSeconds % 3600) / 60);
    const breakSessions = data.breaks.map(b =>
      `${new Date(b.in).toLocaleTimeString()}→${b.out ? new Date(b.out).toLocaleTimeString() : 'ongoing'}`
    ).join(' | ');
    const bh = Math.floor(data.breakSeconds / 3600);
    const bm = Math.floor((data.breakSeconds % 3600) / 60);
    rows.push(`${date},"${workSessions}",${wh},${wm},"${breakSessions}",${bh},${bm}`);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=timeproof-${targetId}-${range}d.csv`);
  res.send(rows.join('\n'));
});

/**
 * GET /api/crm/timeproof/shift-state
 * Returns the current shift/break state of the authenticated user.
 * Used by the tray app on startup to sync its initial state.
 */
export const getShiftState = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  // Look back 2 days so sessions that started on a previous UTC date
  // (e.g. Philippine users whose shift begins on what is "yesterday" UTC)
  // are still detected as active when no time-out has been recorded.
  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 2);
  lookbackStart.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).lean();

  const timeIns  = logs.filter(l => l.type === 'time-in');
  const timeOuts = logs.filter(l => l.type === 'time-out');

  // Walk the logs chronologically and track whether the latest event leaves the
  // user clocked-in. This is more accurate than counting time-ins vs time-outs,
  // which breaks if any orphan log exists in the lookback window (e.g. a
  // time-out without a matching time-in from a prior desync). Orphans caused
  // the tray to see isOnShift=false even with an active clock-in today.
  let isOnShiftWalk = false;
  let walkShiftStartedAt: string | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') {
      isOnShiftWalk = true;
      walkShiftStartedAt = log.timestamp instanceof Date
        ? log.timestamp.toISOString()
        : String(log.timestamp);
    } else if (log.type === 'time-out') {
      isOnShiftWalk = false;
      walkShiftStartedAt = null;
    }
  }
  const isOnShift = isOnShiftWalk;

  // Scope break detection to the current session only (logs after the most recent
  // time-in). Without this, a stale unpaired break-in from a previous session in
  // the 2-day lookback window falsely sets isOnBreak=true and wipes the timer.
  const lastTimeIn = isOnShift && timeIns.length > 0
    ? new Date(timeIns[timeIns.length - 1].timestamp)
    : null;
  const sessionLogs = lastTimeIn
    ? logs.filter(l => new Date(l.timestamp) >= lastTimeIn!)
    : logs;
  const breakIns  = sessionLogs.filter(l => l.type === 'break-in');
  const breakOuts = sessionLogs.filter(l => l.type === 'break-out');

  const isOnBreak = breakIns.length > breakOuts.length;

  const shiftStartedAt = isOnShift ? timeIns.at(-1)!.timestamp : null;
  const breakStartedAt = isOnBreak ? breakIns.at(-1)!.timestamp : null;

  // Compute total seconds spent in completed breaks in the CURRENT session only
  const currentSessionStart = isOnShift && shiftStartedAt ? new Date(shiftStartedAt) : null;
  const breakLogs = logs
    .filter(l =>
      (l.type === 'break-in' || l.type === 'break-out') &&
      (!currentSessionStart || new Date(l.timestamp) >= currentSessionStart)
    )
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let totalBreakSeconds = 0;
  let currentBreakIn: Date | null = null;
  for (const log of breakLogs) {
    if (log.type === 'break-in') {
      currentBreakIn = new Date(log.timestamp);
    } else if (log.type === 'break-out' && currentBreakIn) {
      totalBreakSeconds += (new Date(log.timestamp).getTime() - currentBreakIn.getTime()) / 1000;
      currentBreakIn = null;
    }
  }

  // Total worked seconds from COMPLETED sessions within TODAY's MDT window only.
  // The lookback spans 2 days, so we must exclude completed sessions from yesterday
  // to avoid inflating the tray's running total.
  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  // MDT midnight expressed as a UTC timestamp  (e.g. 2026-05-25 00:00 MDT = 2026-05-25 06:00 UTC)
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;

  const allSessions = buildSessions(logs);
  const todayTotalWorkedSeconds = allSessions
    .filter(s => !s.isLive && new Date(s.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, s) => sum + s.duration, 0);

  // Sum of ALL break seconds that fall within today's MDT window (across all
  // sessions today, completed or live). Used to net out break time from the
  // wall-clock fallback so the time clock matches the calendar's net work time.
  const allBreakSessions = buildBreakSessions(logs);
  const todayBreakTotalSeconds = allBreakSessions
    .filter(b => new Date(b.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, b) => sum + b.duration, 0);

  // Activity-based tracking: sum of completed ActivityIntervals for today
  const activityIntervals = await ActivityInterval.find({
    userId: user._id,
    shiftDate: todayMDTStr,
  }).lean();
  const activityIntervalTotal = activityIntervals.reduce((sum, i) => sum + i.durationSeconds, 0);
  // When ActivityIntervals are absent (tray not running, save failed, etc.), the
  // fallback uses session wall-clock MINUS today's breaks → net work time. Without
  // the break subtraction the time clock would over-count by the break duration.
  const todayTotalActiveSeconds = activityIntervalTotal > 0
    ? activityIntervalTotal
    : Math.max(0, todayTotalWorkedSeconds - todayBreakTotalSeconds);

  const heartbeat = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  const rawIntervalStart = heartbeat?.currentIntervalStartAt?.toISOString() ?? null;
  const isShiftFromToday = shiftStartedAt
    ? new Date(shiftStartedAt).getTime() >= todayMDTStartUTC
    : false;

  // Decide the live-interval start that the CRM timer counts from.
  //  • Tray actively reporting (fresh heartbeat): trust its value verbatim — including
  //    null, which means the user is idle/on-break and the timer must FREEZE. This keeps
  //    the CRM in lock-step with the tray (same machine clock → no drift).
  //  • Tray offline / never ran: fall back to (shiftStartedAt + currentSessionBreaks)
  //    so (now - fallbackStart) excludes break time. Without this shift, a CRM-only
  //    user's live counter over-counts every break they took during the current shift.
  const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
  const heartbeatFresh = heartbeat
    ? Date.now() - new Date(heartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const fallbackShiftedStart = isOnShift && !isOnBreak && isShiftFromToday && shiftStartedAt
    ? new Date(new Date(shiftStartedAt).getTime() + (totalBreakSeconds * 1000)).toISOString()
    : null;
  const currentIntervalStartAt = heartbeatFresh
    ? rawIntervalStart
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
 * GET /api/crm/timeproof/my-agent
 * Returns whether the current user's tray agent is online.
 */
export const getMyAgentStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

  const hb = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  const isOnline = hb
    ? new Date().getTime() - new Date(hb.lastSeenAt).getTime() < OFFLINE_THRESHOLD_MS
    : false;

  res.json(new ApiResponse(200, {
    isOnline,
    isIdle: isOnline ? hb!.isIdle : false,
    lastSeenAt: hb?.lastSeenAt ?? null,
  }, 'Agent status fetched'));
});

/**
 * POST /api/crm/timeproof/heartbeat
 * Tray app pings every 60s — upserts AgentHeartbeat, emits idle/break alerts to admins.
 */
export const postHeartbeat = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const {
    isIdle = false,
    platform = 'win32',
    isOnBreak = false,
    breakDurationSeconds = 0,
    isOnShift = false,
    currentIntervalStartAt,
  } = req.body;

  const existing = await AgentHeartbeat.findOne({ userId: user._id });
  const wasIdle = existing?.isIdle ?? false;
  const wasOnBreak = existing?.isOnBreak ?? false;
  const hadBreakNotification = existing?.lastBreakNotifiedAt ?? null;

  // Determine lastBreakNotifiedAt for this upsert
  let lastBreakNotifiedAt = hadBreakNotification;
  if (!isOnBreak && wasOnBreak) {
    // Break ended — reset so the next break can trigger a notification again
    lastBreakNotifiedAt = null;
  }

  await AgentHeartbeat.findOneAndUpdate(
    { userId: user._id },
    {
      isIdle,
      isOnBreak,
      breakStartedAt: isOnBreak && !wasOnBreak ? new Date() : (isOnBreak ? existing?.breakStartedAt ?? null : null),
      lastBreakNotifiedAt,
      platform,
      lastSeenAt: new Date(),
      ...(currentIntervalStartAt !== undefined && {
        currentIntervalStartAt: currentIntervalStartAt ? new Date(currentIntervalStartAt) : null,
      }),
    },
    { upsert: true, new: true }
  );

  // ── Notify admins: agent went idle ────────────────────────────────────────
  if (!wasIdle && isIdle && isOnShift) {
    const admins = await CrmUser.find({ role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
    const idlePayload = { userId: user._id, fullName: user.fullName, isIdle: true, at: new Date() };
    for (const admin of admins) {
      emitToUser(admin._id.toString(), 'agent:idle', idlePayload);
    }
    emitToShiftBoard('agent:idle', idlePayload);

    // Push notification to admins across all devices
    CrmPushService.sendToAdmins({
      title: '⚪ Agent Idle',
      body: `${user.fullName} has been idle for 10 minutes.`,
      icon: '/icon-192x192.png',
      tag: `crm-idle-${user._id}`,
      data: { url: '/crm/timeproof' },
    }).catch(() => {});
  }

  // ── Notify admins: agent exceeded 1-hour break ────────────────────────────
  if (isOnBreak && isOnShift && breakDurationSeconds >= BREAK_LIMIT_SECONDS && !lastBreakNotifiedAt) {
    await AgentHeartbeat.updateOne(
      { userId: user._id },
      { lastBreakNotifiedAt: new Date() }
    );

    const admins = await CrmUser.find({ role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
    for (const admin of admins) {
      emitToUser(admin._id.toString(), 'agent:break-exceeded', {
        userId: user._id,
        fullName: user.fullName,
        breakDurationSeconds,
        at: new Date(),
      });
    }

    CrmPushService.sendToAdmins({
      title: '☕ Break Exceeded',
      body: `${user.fullName} exceeds break time.`,
      icon: '/icon-192x192.png',
      tag: `crm-break-${user._id}`,
      data: { url: '/crm/timeproof' },
    }).catch(() => {});
  }

  res.json(new ApiResponse(200, { received: true }, 'Heartbeat recorded'));
});

/**
 * GET /api/crm/timeproof/agent-status
 * Admin/Manager: real-time view of all agents — online, offline, idle.
 */
export const getAgentStatus = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  // 5-minute window: tray heartbeats every 60s, so a user needs to miss 4
  // consecutive heartbeats before appearing offline — resilient to network hiccups.
  const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
  const now = new Date();

  const users = await CrmUser.find({ isActive: true }).select('-password').lean();
  const heartbeats = await AgentHeartbeat.find({
    userId: { $in: users.map(u => u._id) },
  }).lean();

  const hbMap = new Map(heartbeats.map(h => [h.userId.toString(), h]));

  const agents = users.map(u => {
    const hb = hbMap.get(u._id.toString());
    // Online if tray heartbeat is fresh OR CRM tab is open (active socket connection)
    const isOnline = isCrmUserOnline(u._id.toString()) ||
      (hb ? now.getTime() - new Date(hb.lastSeenAt).getTime() < OFFLINE_THRESHOLD_MS : false);

    const isOnBreak = isOnline && (hb?.isOnBreak ?? false);
    return {
      user: { _id: u._id, fullName: u.fullName, username: u.username, avatar: u.avatar, role: u.role },
      isOnline,
      isIdle: isOnline ? (hb?.isIdle ?? false) : false,
      isOnBreak,
      breakStartedAt: isOnBreak ? (hb?.breakStartedAt?.toISOString() ?? null) : null,
      platform: hb?.platform ?? null,
      lastSeenAt: hb?.lastSeenAt ?? null,
    };
  });

  agents.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return a.user.fullName.localeCompare(b.user.fullName);
  });

  res.json(new ApiResponse(200, { agents }, 'Agent status fetched'));
});

/**
 * POST /api/crm/timeproof/screenshots
 * Tray app uploads a screenshot. Stored ONLY in R2 — no MongoDB metadata.
 * All info needed (userId, shiftDate, capturedAt, idleDetected) is encoded
 * in the R2 object key so we can query by listing with a prefix.
 *
 * Key shape: screenshots/{userId}/{shiftDate}/{capturedAtMs}-{flag}.jpg
 *   flag = "idle" or "active"
 */
export const submitScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  if (!req.file) throw new ApiError(400, 'Screenshot file is required');

  const { capturedAt, shiftDate, idleDetected = 'false' } = req.body;
  if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new ApiError(400, 'shiftDate is required (YYYY-MM-DD)');
  }

  const capturedAtDate = capturedAt ? new Date(capturedAt) : new Date();
  const flag = idleDetected === 'true' ? 'idle' : 'active';
  // Override the multer file name so storageService.upload puts the key in our
  // structured layout. We don't need a hash suffix because capturedAtMs is unique.
  const customFileName = `${capturedAtDate.getTime()}-${flag}.jpg`;
  const fileWithName: Express.Multer.File = { ...req.file, originalname: customFileName };

  const r2Key = await storageService.upload(
    fileWithName,
    `screenshots/${user._id.toString()}/${shiftDate}`,
    BucketType.PRIVATE,
    { allowLocalFallback: true }
  );

  res.json(new ApiResponse(201, { r2Key }, 'Screenshot uploaded'));
});

/**
 * GET /api/crm/timeproof/screenshots?date=YYYY-MM-DD&userId=...
 * Lists screenshots for a given date directly from R2 — no MongoDB lookup.
 * Employees: own only. Admin/Manager: any userId.
 *
 * Key shape parsed: screenshots/{userId}/{shiftDate}/{capturedAtMs}-{flag}.jpg
 */
export const getScreenshots = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { date, userId } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date as string)) {
    throw new ApiError(400, 'date query param required (YYYY-MM-DD)');
  }

  const targetId =
    userId && ['admin', 'manager'].includes(requestor.role)
      ? (userId as string)
      : requestor._id.toString();

  if (targetId !== requestor._id.toString() && !['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const prefix = `screenshots/${targetId}/${date}/`;
  const objects = await storageService.list(prefix, BucketType.PRIVATE);

  // Parse each key into structured screenshot data
  const parsed = objects
    .map((obj) => {
      // key suffix after prefix is "{capturedAtMs}-{flag}.jpg" — anything else is ignored
      const tail = obj.key.slice(prefix.length).replace(/\.jpg$/i, '');
      const dashIdx = tail.lastIndexOf('-');
      if (dashIdx < 0) return null;
      const msStr = tail.slice(0, dashIdx);
      const flag = tail.slice(dashIdx + 1);
      const ms = parseInt(msStr, 10);
      if (!Number.isFinite(ms)) return null;
      return {
        r2Key: obj.key,
        capturedAt: new Date(ms),
        idleDetected: flag === 'idle',
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());

  const withUrls = await Promise.all(
    parsed.map(async (s) => ({
      _id: s.r2Key, // use the key as the unique identifier
      capturedAt: s.capturedAt,
      idleDetected: s.idleDetected,
      url: await getSignedProofUrl(s.r2Key),
    }))
  );

  res.json(new ApiResponse(200, { screenshots: withUrls }, 'Screenshots fetched'));
});

/**
 * POST /api/crm/timeproof/push/subscribe
 * Save a Web Push subscription for the authenticated CRM user (admin/manager only).
 */
export const subscribeCrmPush = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!['admin', 'manager'].includes(user.role)) {
    throw new ApiError(403, 'Push subscriptions are for admins and managers only');
  }

  const { subscription, deviceHint } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new ApiError(400, 'Invalid push subscription object');
  }

  // Upsert by endpoint — replace if it already exists, otherwise push
  await CrmUser.updateOne(
    { _id: user._id, 'pushSubscriptions.endpoint': subscription.endpoint },
    {
      $set: {
        'pushSubscriptions.$': {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          deviceHint: deviceHint ?? 'unknown',
          createdAt: new Date(),
        },
      },
    }
  );

  // If no existing entry was matched, push a new one
  await CrmUser.updateOne(
    { _id: user._id, 'pushSubscriptions.endpoint': { $ne: subscription.endpoint } },
    {
      $push: {
        pushSubscriptions: {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          deviceHint: deviceHint ?? 'unknown',
          createdAt: new Date(),
        },
      },
    }
  );

  res.json(new ApiResponse(200, { subscribed: true }, 'Push subscription saved'));
});

/**
 * DELETE /api/crm/timeproof/push/subscribe
 * Remove a Web Push subscription for the authenticated CRM user.
 */
export const unsubscribeCrmPush = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { endpoint } = req.body;

  if (!endpoint) throw new ApiError(400, 'endpoint is required');

  await CrmUser.updateOne(
    { _id: user._id },
    { $pull: { pushSubscriptions: { endpoint } } }
  );

  res.json(new ApiResponse(200, { unsubscribed: true }, 'Push subscription removed'));
});

/**
 * POST /api/crm/timeproof/activity-interval
 * Tray app posts a completed active period when the user goes idle.
 */
export const postActivityInterval = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { startAt, endAt } = req.body;

  if (!startAt || !endAt) throw new ApiError(400, 'startAt and endAt are required');

  const start = new Date(startAt);
  const end = new Date(endAt);
  const durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);

  if (durationSeconds < 30) {
    return res.json(new ApiResponse(200, { durationSeconds: 0 }, 'Interval too short, skipped'));
  }

  // Assign the interval to its MDT calendar date
  const shiftDate = toLocalDateStr(start, COMPANY_TZ_OFFSET_MINUTES);

  await ActivityInterval.create({
    userId: user._id,
    shiftDate,
    startAt: start,
    endAt: end,
    durationSeconds,
  });

  res.json(new ApiResponse(201, { durationSeconds }, 'Activity interval saved'));
});

/**
 * GET /api/crm/timeproof/resumable-shift
 * Returns whether the user has a clock-out today they can resume from.
 * Used by the CRM dashboard to show a "Resume Shift?" prompt on Start Shift.
 */
/**
 * POST /api/crm/timeproof/screenshots/wipe-all
 * Admin-only one-time operation: deletes ALL screenshots from R2 and MongoDB.
 * TimeLog (clock-in/out history) is preserved. Use to free storage when the
 * archive is full. There is no undo — the binaries are permanently removed.
 */
export const wipeAllScreenshotsHandler = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (requestor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can wipe all screenshots');
  }
  const { wipeAllScreenshots } = await import('../schedulers/screenshotRetention.scheduler');
  const result = await wipeAllScreenshots();
  res.json(new ApiResponse(200, result, `Wiped ${result.deleted} screenshot record(s)`));
});

export const getResumableShift = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;

  const todayLogs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: new Date(todayMDTStartUTC) },
  }).sort({ timestamp: 1 }).lean();

  const timeIns  = todayLogs.filter(l => l.type === 'time-in');
  const timeOuts = todayLogs.filter(l => l.type === 'time-out');

  // Resumable only if user has clocked in AND clocked out today (not currently on shift)
  const isOnShift = timeIns.length > timeOuts.length;
  const hasClockOutToday = timeOuts.length > 0;
  const resumable = !isOnShift && hasClockOutToday;

  const originalClockIn = resumable && timeIns.length > 0
    ? new Date(timeIns[0].timestamp).toISOString()
    : null;

  res.json(new ApiResponse(200, { resumable, originalClockIn }, 'Resumable shift checked'));
});

export default {
  getMyTimeproof,
  getAllUsersTimeproof,
  getUserTimeproof,
  exportTimeproof,
  postHeartbeat,
  postActivityInterval,
  getAgentStatus,
  getResumableShift,
  submitScreenshot,
  getScreenshots,
  wipeAllScreenshotsHandler,
  subscribeCrmPush,
  unsubscribeCrmPush,
};