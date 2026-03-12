import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import TimeLog from '../models/TimeLog.model';
import CrmUser from '../models/CrmUser.model';

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

  // Currently clocked in (no matching time-out)
  if (currentIn) {
    const now = new Date();
    sessions.push({
      in: currentIn,
      out: null,
      duration: (now.getTime() - currentIn.getTime()) / 1000,
      isLive: true,
    });
  }

  return sessions;
};

/** Date → "YYYY-MM-DD" */
const toDateStr = (date: Date) => date.toISOString().split('T')[0];

/** Start of ISO week (Monday 00:00:00) */
const getWeekStart = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Build per-day calendar map from raw log array */
const buildCalendarMap = (logs: any[]) => {
  const byDate: Record<string, any[]> = {};
  for (const log of logs) {
    const d = toDateStr(new Date(log.timestamp));
    (byDate[d] ??= []).push(log);
  }

  const calendar: Record<
    string,
    { sessions: ReturnType<typeof buildSessions>; totalSeconds: number }
  > = {};

  for (const [date, dateLogs] of Object.entries(byDate)) {
    const sessions = buildSessions(dateLogs);
    const totalSeconds = sessions.reduce((sum, s) => sum + s.duration, 0);
    calendar[date] = { sessions, totalSeconds };
  }

  return calendar;
};

/** Compute consecutive working-day streak */
const computeStreak = (calendar: ReturnType<typeof buildCalendarMap>) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayStr = toDateStr(now);

  let streak = 0;
  const check = new Date(now);

  while (true) {
    const dateStr = toDateStr(check);
    const hasWork = !!calendar[dateStr] && calendar[dateStr].totalSeconds > 0;

    if (hasWork) {
      streak++;
      check.setDate(check.getDate() - 1);
    } else if (dateStr === todayStr) {
      // Today hasn't been worked yet — look back from yesterday
      check.setDate(check.getDate() - 1);
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

/** Build 24-element array: how many clock-ins per hour-of-day */
const buildHourPattern = (logs: any[]) => {
  const pattern = new Array(24).fill(0);
  for (const log of logs) {
    if (log.type === 'time-in') {
      const h = new Date(log.timestamp).getHours();
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

/** Aggregate per-day data into week/month buckets */
const aggregateSummary = (calendar: ReturnType<typeof buildCalendarMap>) => {
  const now = new Date();
  const todayStr = toDateStr(now);
  const weekStart = getWeekStart(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let todaySeconds = 0;
  let weekSeconds = 0;
  let monthSeconds = 0;

  for (const [dateStr, data] of Object.entries(calendar)) {
    const d = new Date(dateStr + 'T12:00:00');
    if (dateStr === todayStr) todaySeconds += data.totalSeconds;
    if (d >= weekStart) weekSeconds += data.totalSeconds;
    if (d >= monthStart) monthSeconds += data.totalSeconds;
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

  const calendar = buildCalendarMap(logs);
  const summary = aggregateSummary(calendar);
  const { streak, longestStreak } = computeStreak(calendar);
  const hourPattern = buildHourPattern(logs);

  // Is currently clocked in?
  const todayStr = toDateStr(new Date());
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
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = getWeekStart(now);
  const todayStr = toDateStr(now);

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

      return {
        user: {
          _id: u._id,
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
        },
        today: summary.today,
        thisWeek: summary.thisWeek,
        thisMonth: summary.thisMonth,
        streak,
        isLive,
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

  const calendar = buildCalendarMap(logs);
  const summary = aggregateSummary(calendar);
  const { streak, longestStreak } = computeStreak(calendar);
  const hourPattern = buildHourPattern(logs);

  const todayStr = toDateStr(new Date());
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

  const rows = ['Date,Sessions,Total Hours,Total Minutes'];
  for (const [date, data] of Object.entries(calendar).sort()) {
    const sessions = data.sessions.map(s =>
      `${new Date(s.in).toLocaleTimeString()}→${s.out ? new Date(s.out).toLocaleTimeString() : 'ongoing'}`
    ).join(' | ');
    const h = Math.floor(data.totalSeconds / 3600);
    const m = Math.floor((data.totalSeconds % 3600) / 60);
    rows.push(`${date},"${sessions}",${h},${m}`);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=timeproof-${targetId}-${range}d.csv`);
  res.send(rows.join('\n'));
});

export default {
  getMyTimeproof,
  getAllUsersTimeproof,
  getUserTimeproof,
  exportTimeproof,
};