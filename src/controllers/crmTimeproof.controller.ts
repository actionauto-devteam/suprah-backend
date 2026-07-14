import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import TimeLog from '../models/TimeLog.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';
import { storageService, BucketType } from '../services/storage.service';
import { getSignedProofUrl } from '../utils/signedUrlCache';
import { emitToUser, emitToShiftBoard, isCrmUserOnline } from '../utils/socketEmitter';
import { PushService } from '../services/push.service';
import ExcludedScreenshot from '../models/ExcludedScreenshot.model';
import ScreenshotDeduction from '../models/ScreenshotDeduction.model';
import AuditLog from '../models/AuditLog.model';
import { isTimeEditExempt } from '../config/departmentMonitoring';
import { getCompanyDayRange, isPayoutUnblurWindow } from '../utils/companyTimezone';
import sharp from 'sharp';

const BREAK_LIMIT_SECONDS = 3600;

const COMPANY_TZ_OFFSET_MINUTES = -360;

const MIN_ACTIVITY_COVERAGE = 0.65;

// How long after the last heartbeat to keep trusting the tray's currentIntervalStartAt.
// Tray heartbeats every 60s with no retry on failure (silent best-effort post),
// so ordinary blips — brief network loss, laptop sleep/wake, a throttled
// background tab — can easily produce a 2-10 min gap between heartbeats even
// though the user never stopped working. A 5 min threshold was flipping the
// web timer to "stale" during these normal gaps, which (see getShiftState)
// freezes the timer and shows a false "Paused"/"Resume Shift" state. 15 min
// gives enough margin to absorb that jitter while still catching a tray that
// is genuinely offline (laptop closed, app crashed, etc).
const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;

/* ──────────────────────────────────────────────────────────────────────────
   Helpers — core session/calendar math now lives in utils/timeLogEngine.ts,
   shared with generalTimeclock.controller.ts and crm.controller.ts so the
   three no longer maintain separate copies of the same pairing logic.
────────────────────────────────────────────────────────────────────────── */
import {
  buildSessions, buildBreakSessions, buildCalendarMap, computeStreak,
  buildHourPattern, aggregateSummary, getWeekStart, toDateStr, toLocalDateStr,
  formatHours, buildIdleLog, type CalendarDay,
} from '../utils/timeLogEngine';


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

  const todayStr = toLocalDateStr(new Date(), COMPANY_TZ_OFFSET_MINUTES);
  const allActivityIntervals = await ActivityInterval.find({
    userId: user._id,
    shiftDate: { $in: Object.keys(calendar) },
  }).lean();
  const activityByDate: Record<string, number> = {};
  for (const i of allActivityIntervals) {
    activityByDate[i.shiftDate] = (activityByDate[i.shiftDate] ?? 0) + i.durationSeconds;
  }

  const todayHeartbeat = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  const heartbeatFresh = todayHeartbeat
    ? Date.now() - new Date(todayHeartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  // Never count live time while on break — TimeLogs/heartbeat break state is
  // authoritative here, same rule as getShiftState. Without this guard a
  // stale-but-not-yet-refreshed heartbeat keeps ticking through the break and
  // Rendered Hours ends up including break time.
  const liveActiveSeconds = !todayHeartbeat?.isOnBreak && heartbeatFresh && todayHeartbeat?.currentIntervalStartAt
    ? Math.max(0, (Date.now() - new Date(todayHeartbeat.currentIntervalStartAt).getTime()) / 1000)
    : 0;
  activityByDate[todayStr] = (activityByDate[todayStr] ?? 0) + liveActiveSeconds;

  for (const dateStr of Object.keys(calendar)) {
    const activeForDate = activityByDate[dateStr] ?? 0;
    const wallClock = calendar[dateStr].totalSeconds;
    if (activeForDate > 0 && activeForDate < wallClock && activeForDate / wallClock >= MIN_ACTIVITY_COVERAGE) {
      calendar[dateStr].totalSeconds = activeForDate;
    }
  }

  for (const dateStr of Object.keys(calendar)) {
    if (dateStr === todayStr) continue;
    if ((activityByDate[dateStr] ?? 0) > 0) continue;

    const openSeconds = calendar[dateStr].sessions
      .filter(s => s.isOpen)
      .reduce((sum, s) => sum + s.duration, 0);

    if (openSeconds > 0) {
      calendar[dateStr].totalSeconds = Math.max(0, calendar[dateStr].totalSeconds - openSeconds);
    }
  }

  // Apply self-deleted-screenshot deductions — must run after every other
  // total-seconds adjustment above so it's the final word on each day's total.
  const deductions = await ScreenshotDeduction.find({
    userId: user._id,
    date: { $in: Object.keys(calendar) },
  }).select('date deductedSeconds').lean();
  for (const d of deductions) {
    if (calendar[d.date]) {
      calendar[d.date].totalSeconds = Math.max(0, calendar[d.date].totalSeconds - d.deductedSeconds);
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
 * GET /api/crm/timeproof/idle-log?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Read-only report of when the authenticated user went idle (tray-detected
 * inactivity), derived from the gaps between committed ActivityIntervals
 * within each clocked-in session. Days the tray never ran are skipped
 * entirely (no data), not reported as "idle the whole day".
 */
export const getMyIdleLog = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
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
    userId: user._id,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const activityIntervals = await ActivityInterval.find({
    userId: user._id,
    startAt: { $lte: endDate },
    endAt: { $gte: startDate },
  }).select('startAt endAt').lean();

  const idleLog = buildIdleLog(logs, activityIntervals, COMPANY_TZ_OFFSET_MINUTES);

  res.json(new ApiResponse(200, { idleLog, range: { startDate: startDateStr, endDate: endDateStr } }, 'Idle log fetched'));
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

  const nowMDT = new Date(now.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  const tomorrowMDTStartUTC = todayMDTStartUTC + 24 * 60 * 60 * 1000;
  const todayStart = new Date(todayMDTStartUTC);
  const tomorrow   = new Date(tomorrowMDTStartUTC);
  const weekStart = getWeekStart(now);
  const todayStr = todayMDTStr;

  const users = await CrmUser.find({ isActive: true, organizationId: requestor.organizationId }).select('-password').lean();

  const mainDeptByEmail = new Map<string, string>();
  try {
    const emails = users.map((u) => u.email).filter(Boolean) as string[];
    const mainUsers = await User.find({ email: { $in: emails } })
      .select('email personalInfo')
      .lean();
    mainUsers.forEach((mu) => {
      const dept = (mu.personalInfo as any)?.department;
      if (mu.email && dept && typeof dept === 'string' && dept.trim()) {
        mainDeptByEmail.set(mu.email, dept.trim());
      }
    });
  } catch {
  }

  const allDeductions = await ScreenshotDeduction.find({
    userId: { $in: users.map((u) => u._id) },
  }).select('userId date deductedSeconds').lean();
  const deductionsByUser = new Map<string, Map<string, number>>();
  for (const d of allDeductions) {
    const uid = d.userId.toString();
    if (!deductionsByUser.has(uid)) deductionsByUser.set(uid, new Map());
    deductionsByUser.get(uid)!.set(d.date, d.deductedSeconds);
  }

  const results = await Promise.all(
    users.map(async (u) => {
      const logs = await TimeLog.find({
        userId: u._id,
        timestamp: { $gte: monthStart },
      }).sort({ timestamp: 1 }).lean();

      const calendar = buildCalendarMap(logs);
      const userDeductions = deductionsByUser.get(u._id.toString());
      let todayDeduction = 0;
      if (userDeductions) {
        for (const [date, seconds] of userDeductions) {
          if (calendar[date]) calendar[date].totalSeconds = Math.max(0, calendar[date].totalSeconds - seconds);
          if (date === todayStr) todayDeduction = seconds;
        }
      }
      const summary = aggregateSummary(calendar);
      const { streak } = computeStreak(calendar);
      const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

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

      const allTodaySessions = buildSessions(todayLogs);
      const todayTotalWorkedSeconds = allTodaySessions
        .filter(s => !s.isLive)
        .reduce((sum, s) => sum + s.duration, 0);

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

      const liveWallSec = isOnShift && shiftStartedAt
        ? (now.getTime() - new Date(shiftStartedAt).getTime()) / 1000
        : 0;
      const todayNetSnapshot = Math.max(0, todayTotalWorkedSeconds + Math.max(0, liveWallSec - totalBreakSeconds) - todayDeduction);
      const today = formatHours(todayNetSnapshot);

      const department = (u.department && u.department.trim()) || mainDeptByEmail.get(u.email) || undefined;

      return {
        user: {
          _id: u._id,
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
          department,
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

  results.sort((a, b) => b.thisMonth.totalSeconds - a.thisMonth.totalSeconds);

  res.json(new ApiResponse(200, { users: results }, 'Team timeproof fetched'));
});

export const getUserTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const { userId } = req.params;
  const { range = '90' } = req.query;

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('-password');
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

  const todayStr = toLocalDateStr(new Date(), COMPANY_TZ_OFFSET_MINUTES);
  const allUserIntervals = await ActivityInterval.find({
    userId,
    shiftDate: { $in: Object.keys(calendar) },
  }).lean();
  const userActivityByDate: Record<string, number> = {};
  for (const i of allUserIntervals) {
    userActivityByDate[i.shiftDate] = (userActivityByDate[i.shiftDate] ?? 0) + i.durationSeconds;
  }

  const userTodayHeartbeat = await AgentHeartbeat.findOne({ userId }).lean();
  const userHeartbeatFresh = userTodayHeartbeat
    ? Date.now() - new Date(userTodayHeartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const userLiveActiveSeconds = !userTodayHeartbeat?.isOnBreak && userHeartbeatFresh && userTodayHeartbeat?.currentIntervalStartAt
    ? Math.max(0, (Date.now() - new Date(userTodayHeartbeat.currentIntervalStartAt).getTime()) / 1000)
    : 0;
  userActivityByDate[todayStr] = (userActivityByDate[todayStr] ?? 0) + userLiveActiveSeconds;

  for (const dateStr of Object.keys(calendar)) {
    const activeForDate = userActivityByDate[dateStr] ?? 0;
    const wallClock = calendar[dateStr].totalSeconds;
    if (activeForDate > 0 && activeForDate < wallClock && activeForDate / wallClock >= MIN_ACTIVITY_COVERAGE) {
      calendar[dateStr].totalSeconds = activeForDate;
    }
  }

  for (const dateStr of Object.keys(calendar)) {
    if (dateStr === todayStr) continue;
    if ((userActivityByDate[dateStr] ?? 0) > 0) continue;

    const openSeconds = calendar[dateStr].sessions
      .filter(s => s.isOpen)
      .reduce((sum, s) => sum + s.duration, 0);

    if (openSeconds > 0) {
      calendar[dateStr].totalSeconds = Math.max(0, calendar[dateStr].totalSeconds - openSeconds);
    }
  }

  // Apply self-deleted-screenshot deductions — must run after every other
  // total-seconds adjustment above so it's the final word on each day's total.
  const userDeductions = await ScreenshotDeduction.find({
    userId,
    date: { $in: Object.keys(calendar) },
  }).select('date deductedSeconds').lean();
  for (const d of userDeductions) {
    if (calendar[d.date]) {
      calendar[d.date].totalSeconds = Math.max(0, calendar[d.date].totalSeconds - d.deductedSeconds);
    }
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
        department: targetUser.department,
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
 * GET /api/crm/timeproof/user/:userId/idle-log?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Admin/Manager: read-only idle report for a specific user. Same derivation
 * as getMyIdleLog — see that function's doc comment.
 */
export const getUserIdleLog = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied — admin or manager role required');
  }
  const { userId } = req.params;
  const { startDate: startDateStr, endDate: endDateStr } = req.query;
  if (!startDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(startDateStr as string)) {
    throw new ApiError(400, 'startDate is required (YYYY-MM-DD)');
  }
  if (!endDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr as string)) {
    throw new ApiError(400, 'endDate is required (YYYY-MM-DD)');
  }

  const targetUser = await CrmUser.findById(userId).select('_id');
  if (!targetUser) throw new ApiError(404, 'User not found');

  const startDate = new Date(`${startDateStr}T00:00:00.000Z`);
  startDate.setUTCMinutes(startDate.getUTCMinutes() - COMPANY_TZ_OFFSET_MINUTES);
  const endDate = new Date(`${endDateStr}T23:59:59.999Z`);
  endDate.setUTCMinutes(endDate.getUTCMinutes() - COMPANY_TZ_OFFSET_MINUTES);

  const logs = await TimeLog.find({
    userId,
    timestamp: { $gte: startDate, $lte: endDate },
  }).sort({ timestamp: 1 }).lean();

  const activityIntervals = await ActivityInterval.find({
    userId,
    startAt: { $lte: endDate },
    endAt: { $gte: startDate },
  }).select('startAt endAt').lean();

  const idleLog = buildIdleLog(logs, activityIntervals, COMPANY_TZ_OFFSET_MINUTES);

  res.json(new ApiResponse(200, { idleLog, range: { startDate: startDateStr, endDate: endDateStr } }, 'Idle log fetched'));
});

/**
 * GET /api/crm/timeproof/export?userId=...&range=90
 * Returns a CSV-compatible string for download.
 */
export const exportTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { userId, range = '30' } = req.query;

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
  //  • On break: always null — the timer must freeze. TimeLogs are authoritative for
  //    break state; the tray may have missed a break-in socket event and still be
  //    heartbeating with a live currentIntervalStartAt. Never trust heartbeat over
  //    TimeLogs for break state.
  //  • Tray actively reporting (fresh heartbeat, not on break): trust its value —
  //    including null (idle), which freezes the timer in lock-step with the tray.
  //  • Tray offline / never ran: fall back to (shiftStartedAt + currentSessionBreaks)
  //    so (now - fallbackStart) excludes break time. Without this shift, a CRM-only
  //    user's live counter over-counts every break they took during the current shift.
  const heartbeatFresh = heartbeat
    ? Date.now() - new Date(heartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const fallbackShiftedStart = isOnShift && !isOnBreak && isShiftFromToday && shiftStartedAt
    ? new Date(new Date(shiftStartedAt).getTime() + (totalBreakSeconds * 1000)).toISOString()
    : null;
  // When the heartbeat is stale AND ActivityIntervals already exist, returning
  // the fallback start would cause the dashboard to add liveMs (full wall-clock
  // since shift start) ON TOP of the already-accumulated interval total — i.e.
  // double-counting. Return null instead so the dashboard freezes at the
  // accumulated total. Fall back to wall-clock only when no intervals exist
  // (CRM-only users who never ran the tray).
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
    // Org-scoped — an unscoped query here would leak this event to every
    // other organization's admins too.
    const admins = await CrmUser.find({ organizationId: user.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
    const idlePayload = { userId: user._id, fullName: user.fullName, isIdle: true, at: new Date() };
    for (const admin of admins) {
      emitToUser(admin._id.toString(), 'agent:idle', idlePayload);
    }
    emitToShiftBoard('agent:idle', idlePayload);

    // Push notification to admins across all devices — reaches both CrmUser
    // and main-User admins of this org, not just whichever model this event
    // originated from.
    PushService.notifyOrgAdmins(user.organizationId, {
      title: '⚪ Agent Idle',
      body: `${user.fullName} has been idle for 10 minutes.`,
      tag: `crm-idle-${user._id}`,
      data: { url: '/crm/timeproof/users' },
    }).catch(() => {});
  }

  // ── Notify admins: agent exceeded 1-hour break ────────────────────────────
  if (isOnBreak && isOnShift && breakDurationSeconds >= BREAK_LIMIT_SECONDS && !lastBreakNotifiedAt) {
    await AgentHeartbeat.updateOne(
      { userId: user._id },
      { lastBreakNotifiedAt: new Date() }
    );

    const admins = await CrmUser.find({ organizationId: user.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
    const breakExceededPayload = {
      userId: user._id,
      fullName: user.fullName,
      breakDurationSeconds,
      at: new Date(),
    };
    for (const admin of admins) {
      emitToUser(admin._id.toString(), 'agent:break-exceeded', breakExceededPayload);
    }
    emitToShiftBoard('agent:break-exceeded', breakExceededPayload);

    PushService.notifyOrgAdmins(user.organizationId, {
      title: '☕ Break Exceeded',
      body: `${user.fullName} exceeds break time.`,
      tag: `crm-break-${user._id}`,
      data: { url: '/crm/timeproof/users' },
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

  const users = await CrmUser.find({ isActive: true, organizationId: requestor.organizationId }).select('-password').lean();
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

  // If someone OTHER than the account owner is viewing (an admin/manager),
  // and that account has screenshotBlurUntilPayout set, serve blurred proxy
  // URLs instead of the real signed URLs, except in the payout window.
  const isSelf = targetId === requestor._id.toString();
  let shouldBlur = false;
  if (!isSelf) {
    const targetUser = await CrmUser.findById(targetId).select('screenshotBlurUntilPayout').lean();
    shouldBlur = !!targetUser?.screenshotBlurUntilPayout && !isPayoutUnblurWindow(new Date());
  }
  const requestToken = req.cookies?.['crm_token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : '');

  const prefix = `screenshots/${targetId}/${date}/`;
  const [objects, excludedRows] = await Promise.all([
    storageService.list(prefix, BucketType.PRIVATE),
    ExcludedScreenshot.find({ userId: targetId, key: { $regex: `^${prefix}` } }).select('key').lean(),
  ]);
  const excludedKeys = new Set(excludedRows.map((r) => r.key));

  // Parse each key into structured screenshot data
  const parsed = objects
    .filter((obj) => !excludedKeys.has(obj.key))
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
      isBlurred: shouldBlur,
      url: shouldBlur
        ? `/api/crm/timeproof/screenshot-blurred?key=${encodeURIComponent(s.r2Key)}&t=${encodeURIComponent(requestToken)}`
        : await getSignedProofUrl(s.r2Key),
    }))
  );

  res.json(new ApiResponse(200, { screenshots: withUrls }, 'Screenshots fetched'));
});

/**
 * GET /api/crm/timeproof/screenshot-blurred?key=...
 * Serves a blurred version of a screenshot for accounts with
 * screenshotBlurUntilPayout set. Re-derives access control from the key path
 * itself (screenshots/{userId}/{date}/{file}) rather than trusting the caller
 * — the account owner always gets access; anyone else needs admin/manager.
 */
export const getBlurredScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { key } = req.query;

  if (!key || typeof key !== 'string' || !key.startsWith('screenshots/')) {
    throw new ApiError(400, 'Valid key query param required');
  }

  const targetUserId = key.split('/')[1];
  const isSelf = targetUserId === requestor._id.toString();
  if (!isSelf && !['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const file = await storageService.streamPrivateFile(key);
  if (!file) throw new ApiError(404, 'Screenshot not found');

  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) {
    chunks.push(chunk as Buffer);
  }
  const original = Buffer.concat(chunks);
  const blurred = await sharp(original).resize(480).blur(24).jpeg({ quality: 55 }).toBuffer();

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(blurred);
});

// Each screenshot represents this much of the 10-min capture interval —
// deleting one deducts this many seconds from that day's rendered hours.
const SCREENSHOT_DELETE_DEDUCTION_SECONDS = 10 * 60;

/**
 * DELETE /api/crm/timeproof/screenshots?key=...
 * A user permanently deletes one of their OWN screenshots (no archive/audit
 * trail), and the corresponding time is deducted from that day's rendered
 * hours. TEMPORARY: also allows admin/manager to delete on another user's
 * behalf (same deduction, applied to the target user) — requested for a
 * one-off need; remove the admin/manager allowance again once no longer needed.
 */
export const deleteMyScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { key } = req.query;

  if (!key || typeof key !== 'string' || !key.startsWith('screenshots/')) {
    throw new ApiError(400, 'Valid key query param required');
  }

  const [, targetUserId, date] = key.split('/');
  const isSelf = targetUserId === requestor._id.toString();
  if (!isSelf && !['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'You can only delete your own screenshots');
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, 'Invalid screenshot key');
  }

  await storageService.delete(key, BucketType.PRIVATE);

  await ScreenshotDeduction.updateOne(
    { userId: targetUserId, date },
    { $inc: { deductedSeconds: SCREENSHOT_DELETE_DEDUCTION_SECONDS } },
    { upsert: true }
  );

  res.json(new ApiResponse(200, { deductedSeconds: SCREENSHOT_DELETE_DEDUCTION_SECONDS }, 'Screenshot deleted'));
});

/**
 * PATCH /api/crm/timeproof/correct-time
 * Admin/manager-only: corrects an overrun shift (forgotten clock-out) by either
 * updating the existing time-out log for that day or, if the shift is still
 * open, inserting a new time-out at the corrected timestamp. Every correction
 * is written to AuditLog with before/after values — TimeLog is never silently
 * mutated without a trail. Exempt departments (e.g. Web Dev) cannot be corrected.
 */
export const correctTimeLog = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can correct time logs');
  }

  const { userId, date, correctedTimeOut, reason } = req.body as {
    userId?: string; date?: string; correctedTimeOut?: string; reason?: string;
  };
  if (!userId || !date || !correctedTimeOut || !reason?.trim()) {
    throw new ApiError(400, 'userId, date, correctedTimeOut and reason are all required');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('department fullName organizationId').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');
  if (isTimeEditExempt(targetUser.department)) {
    throw new ApiError(403, `${targetUser.fullName}'s time logs are exempt from admin correction`);
  }

  const { start, end } = getCompanyDayRange(date);
  const correctedAt = new Date(correctedTimeOut);
  if (correctedAt < start || correctedAt >= new Date(end.getTime() + 12 * 60 * 60 * 1000)) {
    throw new ApiError(400, 'correctedTimeOut must fall on or shortly after the given date');
  }

  const dayLogs = await TimeLog.find({ userId, timestamp: { $gte: start, $lt: end } }).sort({ timestamp: 1 }).lean();
  const lastTimeIn = [...dayLogs].reverse().find((l) => l.type === 'time-in');
  if (!lastTimeIn) throw new ApiError(404, 'No time-in found for that date to correct');

  const existingTimeOut = dayLogs.find(
    (l) => l.type === 'time-out' && new Date(l.timestamp).getTime() >= new Date(lastTimeIn.timestamp).getTime(),
  );

  let before: Date | null = null;
  let logId: string;

  if (existingTimeOut) {
    before = existingTimeOut.timestamp;
    await TimeLog.updateOne({ _id: existingTimeOut._id }, { timestamp: correctedAt, note: `Corrected by ${requestor.fullName}: ${reason}` });
    logId = existingTimeOut._id.toString();
  } else {
    const created = await TimeLog.create({
      userId, userModel: 'CrmUser', type: 'time-out',
      timestamp: correctedAt, note: `Added by ${requestor.fullName} (forgotten clock-out): ${reason}`,
    });
    logId = created._id.toString();
  }

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: logId,
    action: 'CORRECT_TIME_LOG',
    changes: { userId, date, before, after: correctedAt },
    reason,
    performedBy: requestor._id,
    organizationId: targetUser.organizationId?.toString(),
  });

  res.json(new ApiResponse(200, { logId, correctedTimeOut: correctedAt }, 'Time log corrected'));
});

/**
 * POST /api/crm/timeproof/screenshots/exclude
 * Admin/manager-only: archives (does not delete) screenshots captured after a
 * corrected clock-out so they no longer show in the gallery or count as
 * proof-of-work, while keeping the underlying files and an audit trail.
 */
export const excludeScreenshots = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can exclude screenshots');
  }

  const { userId, date, after, reason } = req.body as {
    userId?: string; date?: string; after?: string; reason?: string;
  };
  if (!userId || !date || !after || !reason?.trim()) {
    throw new ApiError(400, 'userId, date, after and reason are all required');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('department fullName organizationId').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');
  if (isTimeEditExempt(targetUser.department)) {
    throw new ApiError(403, `${targetUser.fullName}'s screenshots are exempt from admin exclusion`);
  }

  const prefix = `screenshots/${userId}/${date}/`;
  const objects = await storageService.list(prefix, BucketType.PRIVATE);
  const afterMs = new Date(after).getTime();

  const toExclude = objects.filter((obj) => {
    const tail = obj.key.slice(prefix.length).replace(/\.jpg$/i, '');
    const ms = parseInt(tail.slice(0, tail.lastIndexOf('-')), 10);
    return Number.isFinite(ms) && ms > afterMs;
  });

  if (toExclude.length === 0) {
    return res.json(new ApiResponse(200, { excluded: 0 }, 'No screenshots after that time'));
  }

  await ExcludedScreenshot.insertMany(
    toExclude.map((obj) => ({
      organizationId: targetUser.organizationId,
      userId, key: obj.key, reason, excludedBy: requestor._id,
    })),
    { ordered: false },
  ).catch(() => {}); // duplicate keys (already excluded) are fine to ignore

  await AuditLog.create({
    entityType: 'Screenshot',
    action: 'EXCLUDE_SCREENSHOT',
    changes: { userId, date, after, keys: toExclude.map((o) => o.key) },
    reason,
    performedBy: requestor._id,
    organizationId: targetUser.organizationId?.toString(),
  });

  res.json(new ApiResponse(200, { excluded: toExclude.length }, `${toExclude.length} screenshot(s) excluded`));
});

/**
 * POST /api/crm/timeproof/push/subscribe
 * Save a Web Push subscription for the authenticated CRM user (admin/manager only).
 */
export const subscribeCrmPush = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

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
  const orgUsers = await CrmUser.find({ organizationId: requestor.organizationId }).select('_id').lean();
  const allowedUserIds = new Set(orgUsers.map((u) => u._id.toString()));
  const { wipeAllScreenshots } = await import('../schedulers/screenshotRetention.scheduler');
  const result = await wipeAllScreenshots(allowedUserIds);
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
  getBlurredScreenshot,
  deleteMyScreenshot,
  wipeAllScreenshotsHandler,
  subscribeCrmPush,
  unsubscribeCrmPush,
};