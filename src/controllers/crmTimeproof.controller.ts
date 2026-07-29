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
import CrmPushService from '../services/crmPush.service';
import ExcludedScreenshot from '../models/ExcludedScreenshot.model';
import ScreenshotDeduction from '../models/ScreenshotDeduction.model';
import AuditLog from '../models/AuditLog.model';
import { isTimeEditExempt } from '../config/departmentMonitoring';
import { getCompanyDayRange, isPayoutUnblurWindow } from '../utils/companyTimezone';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';
import notificationService from '../services/notification.service';
import sharp from 'sharp';
import logger from '../utils/logger';
import { getShiftStatusForActor } from '../utils/shiftStatus';

const BREAK_LIMIT_SECONDS = 3600;
// The admin notification fires 5 minutes AFTER the official 1h limit, not the
// instant it's crossed — gives the user a short grace window (matches the
// tray's own user-facing warning at 1h01m, four minutes earlier) before
// escalating to their admin/manager. Also matches the web widget's own
// "Break over" red-state threshold (65 min), which already used this grace.
const BREAK_ADMIN_NOTIFY_SECONDS = BREAK_LIMIT_SECONDS + 5 * 60;

const IDLE_ESCALATION_THRESHOLD_SECONDS = 15 * 60;

const COMPANY_TZ_OFFSET_MINUTES = -360;

/**
 * Collapses duplicate User-model documents that share the same email —
 * a real, confirmed data issue (e.g. a "Cesar Pavon" account re-created at
 * some point, leaving an old ghost document with no presence/activity data
 * alongside the one actually being used) rather than something this query
 * can prevent. Without this, a duplicate silently shows up as a second,
 * always-offline row for the same person and can even win the "which one is
 * canonical" toss-up in list ordering. Keeps whichever document has the more
 * recent lastActive (falling back to updatedAt) — the one that's actually
 * being used right now.
 */
function dedupeUsersByEmail<T extends { email?: string; lastActive?: Date; updatedAt?: Date }>(users: T[]): T[] {
  const byEmail = new Map<string, T>();
  const noEmail: T[] = [];
  for (const u of users) {
    if (!u.email) { noEmail.push(u); continue; }
    const key = u.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, u); continue; }
    const activityOf = (x: T) => (x.lastActive ?? x.updatedAt)?.getTime() ?? 0;
    if (activityOf(u) > activityOf(existing)) byEmail.set(key, u);
  }
  return [...byEmail.values(), ...noEmail];
}

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

  // Calendar totals (today and every past day) are trusted as-is from
  // buildCalendarMap — pure wall-clock (TimeLog time-in/time-out, minus
  // breaks), already capped against a forgotten-clock-out inflating a live
  // session (MAX_LIVE_MS), and already corrected for genuinely-stale opens by
  // the auto-clockout schedulers, which close at last-known-activity or the
  // MDT day boundary rather than "now". This used to be "verified" against a
  // heartbeat/ActivityInterval-derived figure and silently overridden
  // downward whenever that figure covered 65-99% of the wall-clock total —
  // but that figure is exactly the fragile mechanism (missed checkpoints,
  // idle-detection flaps, stale heartbeats) this session's other fixes
  // address, so the "verification" was actively corrupting correct, already-
  // closed days after the fact (e.g. a user's Thursday total quietly dropping
  // from 12h to 8h once Thursday was no longer "today"). Removed entirely —
  // wall-clock is the authoritative source everywhere now, matching the Time
  // Clock / tray-app live ticker.

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
  const weekStart = getWeekStart(now);
  const todayStr = todayMDTStr;

  const crmUsers = await CrmUser.find({ isActive: true, organizationId: requestor.organizationId }).select('-password').lean();

  const mainDeptByEmail = new Map<string, string>();
  try {
    const emails = crmUsers.map((u) => u.email).filter(Boolean) as string[];
    const mainUsersByEmail = await User.find({ email: { $in: emails } })
      .select('email personalInfo')
      .lean();
    mainUsersByEmail.forEach((mu) => {
      const dept = (mu.personalInfo as any)?.department;
      if (mu.email && dept && typeof dept === 'string' && dept.trim()) {
        mainDeptByEmail.set(mu.email, dept.trim());
      }
    });
  } catch {
  }

  // Employees who only have a main-site User account (no CrmUser record at
  // all — e.g. Lot Tech and anyone else clocking in via the general
  // timeclock, see generalTimeclock.controller.ts) were invisible on this
  // page entirely, regardless of department filter: this endpoint only ever
  // queried CrmUser. Merge in User-model employees too — exclude non-staff
  // roles (customer/driver) but do NOT skip by email overlap with crmUsers:
  // a CrmUser record existing for the same email doesn't mean it's the one
  // actually used (Lot Tech in particular may have a dormant CrmUser record
  // from HR/record-keeping with zero real TimeLog activity, while their
  // actual clock-ins are on the User account) — excluding by email hid the
  // one with the real rendered hours in favor of the one showing nothing.
  // Both are computed below; the dedup step after results are built picks
  // whichever one shows real activity this month.
  // organizationId is optional on both User and CrmUser (see their schemas)
  // and unreliably populated on User specifically — a strict equality match
  // silently excluded every User-model account whose field was never set,
  // which in practice was most/all of them. Match the established
  // call.controller.ts convention: don't gate the User query on
  // organizationId at all (CrmUser's isActive/organizationId filter above is
  // the real tenant boundary in this single-org-in-practice setup).
  const mainOnlyUsersRaw = await User.find({
    role: { $in: ['employee', 'admin', 'super_admin'] },
  }).select('fullName name email avatar role personalInfo lastActive updatedAt').lean();
  const mainOnlyUsers = dedupeUsersByEmail(mainOnlyUsersRaw);

  type TimeproofPerson = {
    _id: any;
    fullName: string;
    username?: string;
    avatar?: string;
    role: string;
    department?: string;
    email?: string;
  };

  const people: TimeproofPerson[] = [
    ...crmUsers.map((u): TimeproofPerson => ({
      _id: u._id,
      fullName: u.fullName,
      username: u.username,
      avatar: u.avatar,
      role: u.role,
      department: (u.department && u.department.trim()) || mainDeptByEmail.get(u.email) || undefined,
      email: u.email,
    })),
    ...mainOnlyUsers.map((u): TimeproofPerson => ({
      _id: u._id,
      fullName: (u as any).name || (u as any).fullName || u.email || 'Employee',
      avatar: u.avatar,
      role: u.role,
      department: (u.personalInfo as any)?.department,
      email: u.email,
    })),
  ];

  const allDeductions = await ScreenshotDeduction.find({
    userId: { $in: people.map((u) => u._id) },
  }).select('userId date deductedSeconds').lean();
  const deductionsByUser = new Map<string, Map<string, number>>();
  for (const d of allDeductions) {
    const uid = d.userId.toString();
    if (!deductionsByUser.has(uid)) deductionsByUser.set(uid, new Map());
    deductionsByUser.get(uid)!.set(d.date, d.deductedSeconds);
  }

  const allLogs = await TimeLog.find({
    userId: { $in: people.map((u) => u._id) },
    timestamp: { $gte: monthStart },
  }).sort({ timestamp: 1 }).lean();
  const logsByUser = new Map<string, typeof allLogs>();
  for (const log of allLogs) {
    const uid = log.userId.toString();
    if (!logsByUser.has(uid)) logsByUser.set(uid, []);
    logsByUser.get(uid)!.push(log);
  }

  const results = await Promise.all(
    people.map(async (u) => {
      const logs = logsByUser.get(u._id.toString()) ?? [];

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

      // Chronological walk over the FULL fetched range (from monthStart), not
      // just today's window — a shift that started yesterday (forgotten
      // clock-out carried into today) has no time-in log inside today's
      // window at all, so a today-only count would always read "not on
      // shift" even while the user is actively working right now.
      let isOnShift = false;
      let shiftStartedAt: string | null = null;
      for (const log of logs) {
        if (log.type === 'time-in') { isOnShift = true; shiftStartedAt = new Date(log.timestamp).toISOString(); }
        else if (log.type === 'time-out') { isOnShift = false; shiftStartedAt = null; }
      }

      // Today's totals come from the same calendar the employee's own page
      // uses (already midnight-split and break-netted), so a multi-day-old
      // shift is at least reported consistently everywhere rather than
      // recomputed a second, different way here.
      const totalBreakSeconds = calendar[todayStr]?.breakSeconds ?? 0;
      const todayTotalWorkedSeconds = (calendar[todayStr]?.totalSeconds ?? 0) + totalBreakSeconds;
      const today = formatHours(Math.max(0, (calendar[todayStr]?.totalSeconds ?? 0) - todayDeduction));

      return {
        email: u.email,
        user: {
          _id: u._id,
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
          department: u.department,
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

  // A CrmUser and a User document can legitimately share the same email —
  // separate collections, separate unique-email constraints — when the same
  // person has both (e.g. a dormant CrmUser record with zero real activity
  // alongside the User account they actually clock in with). Whichever one
  // actually has this month's hours wins the display slot, so the person
  // isn't listed twice with one row showing real numbers and a ghost row
  // showing zero.
  const byEmail = new Map<string, (typeof results)[number]>();
  const noEmail: typeof results = [];
  for (const r of results) {
    if (!r.email) { noEmail.push(r); continue; }
    const key = r.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, r); continue; }
    if (r.thisMonth.totalSeconds > existing.thisMonth.totalSeconds) byEmail.set(key, r);
  }
  const dedupedResults = [...byEmail.values(), ...noEmail].map(({ email: _email, ...rest }) => rest);

  dedupedResults.sort((a, b) => b.thisMonth.totalSeconds - a.thisMonth.totalSeconds);

  res.json(new ApiResponse(200, { users: dedupedResults }, 'Team timeproof fetched'));
});

export const getUserTimeproof = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const { userId } = req.params;
  const { range = '90' } = req.query;

  // The list this detail page is opened from (getAllUsersTimeproof) now
  // includes main-site User-model employees too (e.g. Lot Tech) — fall back
  // to the User collection so clicking into one of them doesn't 404.
  let targetPerson: { _id: any; fullName: string; username?: string; avatar?: string; role: string; department?: string; accountModel: 'CrmUser' | 'User' } | null = null;
  const crmTargetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('-password').lean();
  if (crmTargetUser) {
    targetPerson = {
      _id: crmTargetUser._id,
      fullName: crmTargetUser.fullName,
      username: crmTargetUser.username,
      avatar: crmTargetUser.avatar,
      role: crmTargetUser.role,
      department: crmTargetUser.department,
      accountModel: 'CrmUser',
    };
  } else {
    // Same organizationId unreliability as getAllUsersTimeproof — don't gate
    // the lookup on it, the _id itself (only reachable via the already
    // org-scoped list this page opened from) is enough.
    const mainTargetUser = await User.findOne({ _id: userId }).lean();
    if (mainTargetUser) {
      targetPerson = {
        _id: mainTargetUser._id,
        fullName: (mainTargetUser as any).name || (mainTargetUser as any).fullName || mainTargetUser.email || 'Employee',
        avatar: mainTargetUser.avatar,
        role: mainTargetUser.role,
        department: (mainTargetUser.personalInfo as any)?.department,
        accountModel: 'User',
      };
    }
  }
  if (!targetPerson) throw new ApiError(404, 'User not found');

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

  // See getMyTimeproof for the full explanation — calendar totals (today and
  // every past day) are trusted as-is from buildCalendarMap now. The
  // heartbeat-derived "verification" that used to run here was silently
  // corrupting already-closed days after the fact, since it trusted exactly
  // the fragile mechanism (missed checkpoints, idle-detection flaps, stale
  // heartbeats) this session's other fixes address. Removed entirely.

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
      user: targetPerson,
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

  // Same wall-clock (TimeLog-based) figure that already powers the Today card
  // and calendar — INCLUDING the live/open session's elapsed time, unlike
  // todayTotalWorkedSeconds above. This is why Today/calendar never show the
  // "resets to zero" bug the live ticker is prone to: they never depended on
  // ActivityInterval commits or tray heartbeat freshness in the first place.
  // Exposed here so the frontend/tray can display THIS as their authoritative
  // running total instead of reconstructing their own fragile one.
  const todayTotalWorkedSecondsIncludingLive = allSessions
    .filter(s => new Date(s.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, s) => sum + s.duration, 0);

  // Sum of ALL break seconds that fall within today's MDT window (across all
  // sessions today, completed or live). Used to net out break time from the
  // wall-clock fallback so the time clock matches the calendar's net work time.
  const allBreakSessions = buildBreakSessions(logs);
  const todayBreakTotalSeconds = allBreakSessions
    .filter(b => new Date(b.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, b) => sum + b.duration, 0);

  // a
  const wallClockRenderedSeconds = Math.max(0, todayTotalWorkedSecondsIncludingLive - todayBreakTotalSeconds);

  // Activity-based tracking: sum of completed ActivityIntervals for today
  const activityIntervals = await ActivityInterval.find({
    userId: user._id,
    shiftDate: todayMDTStr,
  }).lean();
  const activityIntervalTotal = activityIntervals.reduce((sum, i) => sum + i.durationSeconds, 0);
  // When ActivityIntervals are absent (tray not running, save failed, etc.), the
  // fallback uses session wall-clock MINUS today's breaks → net work time. Without
  // the break subtraction the time clock would over-count by the break duration.
  //
  // Same 65%-coverage floor as getMyTimeproof's calendar computation — without
  // it, a long continuous active stretch that never got checkpointed (tray
  // restarted mid-shift, save failures, etc.) leaves activityIntervalTotal far
  // below the truth, and this live "Tracking" figure would silently show a
  // much smaller number than the Today card / calendar (which already guard
  // against this), confusing the user with two contradicting totals.
  const wallClockNetSeconds = Math.max(0, todayTotalWorkedSeconds - todayBreakTotalSeconds);
  const trustActivityIntervals =
    activityIntervalTotal > 0 &&
    activityIntervalTotal < wallClockNetSeconds &&
    activityIntervalTotal / wallClockNetSeconds >= MIN_ACTIVITY_COVERAGE;
  const todayTotalActiveSeconds = trustActivityIntervals ? activityIntervalTotal : wallClockNetSeconds;
  // End of the most recently committed interval — the correct anchor to resume
  // live-ticking from when the heartbeat goes stale (see currentIntervalStartAt
  // below). Without this, a user with even ONE early checkpoint (e.g. a brief
  // idle blip at 10am) who then works a long uninterrupted stretch with no
  // further break/idle would have their live counter permanently FREEZE the
  // moment the heartbeat goes stale (>15 min gap) — showing only that early
  // checkpoint's total for the rest of the shift, no matter how much longer
  // they actually keep working. This was the root cause behind reports like
  // "worked 8+ hours, TimeProof only shows 3 hours."
  const lastIntervalEndMs = activityIntervals.length
    ? Math.max(...activityIntervals.map((i) => new Date(i.endAt).getTime()))
    : null;

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
  // When the heartbeat is stale, the resume anchor MUST match whichever total
  // todayTotalActiveSeconds actually used above, or we'd either double-count
  // or lose time:
  //  • trustActivityIntervals: todayTotalActiveSeconds already = activityIntervalTotal
  //    (everything up to the last committed checkpoint), so resume the live
  //    delta from lastIntervalEndMs — NOT shiftStartedAt, which would double-count
  //    the already-committed portion. Previously this branch returned null
  //    (froze the timer forever once heartbeat went stale) — see comment above
  //    lastIntervalEndMs for why that was wrong.
  //  • !trustActivityIntervals: todayTotalActiveSeconds = wallClockNetSeconds, which
  //    excludes the current OPEN session entirely (only completed sessions count),
  //    so the live delta must cover the whole current session from shiftStartedAt —
  //    that's exactly what fallbackShiftedStart does.
  const currentIntervalStartAt = isOnBreak
    ? null
    : heartbeatFresh
      ? rawIntervalStart
      : trustActivityIntervals
        ? (lastIntervalEndMs !== null ? new Date(lastIntervalEndMs).toISOString() : null)
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
    wallClockRenderedSeconds,
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
    screenRecordingGranted = null,
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

  // idleSince marks the start of the CURRENT idle stretch — used to gate the
  // 15-min admin escalation notification below. lastIdleEscalationNotifiedAt
  // resets whenever the user comes back from idle, so the next idle stretch
  // can trigger the escalation again.
  let idleSince = existing?.idleSince ?? null;
  if (isIdle && !wasIdle) idleSince = new Date();
  if (!isIdle) idleSince = null;

  let lastIdleEscalationNotifiedAt = existing?.lastIdleEscalationNotifiedAt ?? null;
  if (!isIdle) lastIdleEscalationNotifiedAt = null;

  // Reset the notify-cooldown once permission is (re-)granted, so if it's
  // ever revoked again later (e.g. after another auto-update, since the
  // build is unsigned) the next loss gets its own fresh notification instead
  // of staying silenced by an old timestamp from a previous incident.
  const wasScreenRecordingGranted = existing?.screenRecordingGranted ?? null;
  let lastScreenRecordingNotifiedAt = existing?.lastScreenRecordingNotifiedAt ?? null;
  if (screenRecordingGranted === true) lastScreenRecordingNotifiedAt = null;

  await AgentHeartbeat.findOneAndUpdate(
    { userId: user._id },
    {
      isIdle,
      idleSince,
      lastIdleEscalationNotifiedAt,
      isOnBreak,
      breakStartedAt: isOnBreak && !wasOnBreak ? new Date() : (isOnBreak ? existing?.breakStartedAt ?? null : null),
      lastBreakNotifiedAt,
      platform,
      screenRecordingGranted,
      lastScreenRecordingNotifiedAt,
      lastSeenAt: new Date(),
      ...(currentIntervalStartAt !== undefined && {
        currentIntervalStartAt: currentIntervalStartAt ? new Date(currentIntervalStartAt) : null,
      }),
    },
    { upsert: true, new: true }
  );

  // ── Notify: macOS Screen Recording permission is missing ──────────────────
  // Unsigned build (no Apple Developer cert) means this permission doesn't
  // reliably survive an auto-update — the tray keeps running and heartbeating
  // normally, so nothing else here would ever surface it. Notifies both the
  // affected user (so they can self-resolve) and admins (as a fallback in
  // case the user's own notification goes unnoticed), and leaves a record in
  // the read-only Shift Alerts channel. Re-notifies at most once every 24h
  // per person while unresolved, rather than once per 60s heartbeat forever.
  if (platform === 'darwin' && screenRecordingGranted === false && isOnShift) {
    const notifyCooldownMs = 24 * 60 * 60 * 1000;
    const dueForNotify = !lastScreenRecordingNotifiedAt
      || Date.now() - new Date(lastScreenRecordingNotifiedAt).getTime() > notifyCooldownMs;
    if (dueForNotify) {
      await AgentHeartbeat.updateOne({ userId: user._id }, { lastScreenRecordingNotifiedAt: new Date() });

      const title = '🔒 Screen Recording Permission Needed';
      const body = `${user.fullName}'s Mac needs Screen Recording permission re-granted for the tray app — screenshots have stopped.`;

      notificationService.createNotification({
        userId: user._id.toString(),
        organizationId: user.organizationId.toString(),
        type: 'screen_recording_missing',
        title: '🔒 Screen Recording Permission Needed',
        message: 'Your Mac needs Screen Recording permission re-granted for the tray app, or your screenshots will stop. Open System Settings → Privacy & Security → Screen Recording, enable it for the tray app, then relaunch the app.',
        metadata: { route: '/guide', selfNotify: true },
        dedupeKey: `screen-recording-self:${user._id}`,
        groupWindowMinutes: 60 * 24,
      }).catch(() => {});

      const admins = await CrmUser.find({ organizationId: user.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
      for (const admin of admins) {
        notificationService.createNotification({
          userId: admin._id.toString(),
          organizationId: user.organizationId.toString(),
          type: 'agent_screen_recording_missing',
          title,
          message: body,
          metadata: { route: `/crm/timeproof/users/${user._id}`, agentUserId: user._id },
          dedupeKey: `agent-screen-recording:${admin._id}:${user._id}`,
          groupWindowMinutes: 60 * 24,
        }).catch(() => {});
      }

      postBatchedShiftAlertMessages(user.organizationId.toString(), [`🔒 ${user.fullName}'s Mac needs Screen Recording permission re-granted — screenshots have stopped.`])
        .catch((err) => logger.error({ err, userId: user._id.toString() }, '[shiftAlerts] Failed to post screen-recording alert'));
    }
  } else if (platform === 'darwin' && screenRecordingGranted === true && wasScreenRecordingGranted === false) {
    postBatchedShiftAlertMessages(user.organizationId.toString(), [`✅ ${user.fullName} re-granted Screen Recording permission — screenshots resumed.`])
      .catch((err) => logger.error({ err, userId: user._id.toString() }, '[shiftAlerts] Failed to post screen-recording resolved alert'));
  }

  // ── Notify admins: agent went idle ────────────────────────────────────────
  // Routed through notificationService (persisted, preference-gated, unified
  // push) with an `agent-idle:{admin}:{agent}` dedupeKey shared with the
  // 15-min escalation below, so a person flapping idle/active repeatedly —
  // or escalating from a short idle into a long one — compiles into one
  // evolving notification instead of spamming admins with a new alert per
  // transition (see notification.service.ts's createNotification grouping).
  if (!wasIdle && isIdle && isOnShift) {
    // Org-scoped — an unscoped query here would leak this event to every
    // other organization's admins too.
    const admins = await CrmUser.find({ organizationId: user.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
    const idlePayload = { userId: user._id, fullName: user.fullName, isIdle: true, at: new Date() };
    for (const admin of admins) {
      emitToUser(admin._id.toString(), 'agent:idle', idlePayload);
    }
    emitToShiftBoard('agent:idle', idlePayload);

    for (const admin of admins) {
      notificationService.createNotification({
        userId: admin._id.toString(),
        organizationId: user.organizationId.toString(),
        type: 'agent_idle',
        title: '⚪ Agent Idle',
        message: `${user.fullName} has been idle for 10 minutes.`,
        metadata: { route: '/crm/timeproof/users', agentUserId: user._id },
        dedupeKey: `agent-idle:${admin._id}:${user._id}`,
        groupWindowMinutes: 30,
      }).catch(() => {});
    }

    // Also leaves a record in the read-only Shift Alerts channel — previously
    // idle events only reached each admin's own notification bell, with no
    // shared, browsable log of who went idle and when the way connection-loss/
    // stale-clockout/location alerts already had via fireShiftAlert.
    postBatchedShiftAlertMessages(user.organizationId.toString(), [`⚪ ${user.fullName} has been idle for 10 minutes.`])
      .catch((err) => logger.error({ err, userId: user._id.toString() }, '[shiftAlerts] Failed to post idle alert'));
  }

  // ── Notify admins: agent has been idle 15+ minutes — actionable alert ────
  // Deep-links straight to this user's manage page, where an admin/manager
  // can manually clock them out if they've stepped away without logging off.
  if (isIdle && isOnShift && idleSince && !lastIdleEscalationNotifiedAt) {
    const idleDurationSeconds = (Date.now() - idleSince.getTime()) / 1000;
    if (idleDurationSeconds >= IDLE_ESCALATION_THRESHOLD_SECONDS) {
      await AgentHeartbeat.updateOne({ userId: user._id }, { lastIdleEscalationNotifiedAt: new Date() });

      const idleMinutes = Math.floor(idleDurationSeconds / 60);
      const admins = await CrmUser.find({ organizationId: user.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true }).select('_id').lean();
      const idleEscalationPayload = { userId: user._id, fullName: user.fullName, idleMinutes, at: new Date() };
      for (const admin of admins) {
        emitToUser(admin._id.toString(), 'agent:idle-escalation', idleEscalationPayload);
      }
      emitToShiftBoard('agent:idle-escalation', idleEscalationPayload);

      for (const admin of admins) {
        notificationService.createNotification({
          userId: admin._id.toString(),
          organizationId: user.organizationId.toString(),
          type: 'agent_idle_escalation',
          title: '🟠 Agent Idle 15+ Minutes',
          message: `${user.fullName} has been idle for ${idleMinutes} minutes. Tap to review and clock out if needed.`,
          metadata: { route: `/crm/timeproof/users/${user._id}`, agentUserId: user._id },
          dedupeKey: `agent-idle:${admin._id}:${user._id}`,
          groupWindowMinutes: 30,
        }).catch(() => {});
      }
    }
  }

  // ── Notify admins: agent exceeded 1-hour break ────────────────────────────
  // TEMP diagnostic — pinpoints exactly which value is wrong when the
  // escalation doesn't fire as expected (e.g. tray never getting
  // breakDurationSeconds past the threshold, or lastBreakNotifiedAt stuck
  // set from an earlier test). Remove once confirmed working.
  if (isOnBreak) {
    logger.info(
      { userId: user._id.toString(), isOnBreak, isOnShift, breakDurationSeconds, BREAK_ADMIN_NOTIFY_SECONDS, lastBreakNotifiedAt },
      '[break-escalation] heartbeat check'
    );
  }
  if (isOnBreak && isOnShift && breakDurationSeconds >= BREAK_ADMIN_NOTIFY_SECONDS && !lastBreakNotifiedAt) {
    logger.info({ userId: user._id.toString() }, '[break-escalation] threshold crossed — firing Shift Alert');
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

    fireShiftAlert({
      organizationId: user.organizationId.toString(),
      targetUserId: user._id.toString(),
      targetUserModel: 'CrmUser',
      chatMessage: `☕ ${user.fullName} has exceeded their 1-hour break.`,
      notifyTitle: '☕ Break Exceeded',
      notifyBody: `${user.fullName} exceeds break time.`,
      notifyTag: `crm-break-${user._id}`,
      url: '/crm/timeproof/users',
    })
      .then(() => logger.info({ userId: user._id.toString() }, '[break-escalation] fireShiftAlert completed'))
      .catch((err) => logger.error({ err, userId: user._id.toString() }, '[break-escalation] fireShiftAlert failed'));
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

  const crmUsers = await CrmUser.find({ isActive: true, organizationId: requestor.organizationId }).select('-password').lean();

  // Merge in main-site User-model employees (e.g. Lot Tech) so they show up
  // in the live agent status view too. NOT excluded by email overlap with
  // crmUsers here (unlike earlier drafts of this fix) — a CrmUser record
  // existing for the same email doesn't mean it's the one actually used day
  // to day (Lot Tech in particular may have a dormant CrmUser record from
  // HR/record-keeping that never logs in — their real activity is on the
  // User account). Both are computed, then the dedup step below picks
  // whichever one actually shows real activity.
  const mainOnlyUsersRaw = await User.find({
    role: { $in: ['employee', 'admin', 'super_admin'] },
  }).select('fullName name email avatar role onlineStatus lastActive updatedAt').lean();
  const mainOnlyUsers = dedupeUsersByEmail(mainOnlyUsersRaw);

  const heartbeats = await AgentHeartbeat.find({
    userId: { $in: crmUsers.map(u => u._id) },
  }).lean();
  const hbMap = new Map(heartbeats.map(h => [h.userId.toString(), h]));

  const crmAgents = crmUsers.map(u => {
    const hb = hbMap.get(u._id.toString());
    // Online if tray heartbeat is fresh OR CRM tab is open (active socket connection)
    const isOnline = isCrmUserOnline(u._id.toString()) ||
      (hb ? now.getTime() - new Date(hb.lastSeenAt).getTime() < OFFLINE_THRESHOLD_MS : false);

    const isOnBreak = isOnline && (hb?.isOnBreak ?? false);
    return {
      email: u.email as string | undefined,
      user: { _id: u._id, fullName: u.fullName, username: u.username, avatar: u.avatar, role: u.role },
      isOnline,
      isIdle: isOnline ? (hb?.isIdle ?? false) : false,
      isOnBreak,
      breakStartedAt: isOnBreak ? (hb?.breakStartedAt?.toISOString() ?? null) : null,
      platform: hb?.platform ?? null,
      lastSeenAt: hb?.lastSeenAt ?? null,
    };
  });

  // User-model employees (Lot Tech and anyone else on mobile/PWA, no
  // tray-app) never hit AgentHeartbeat and never open a CRM-role socket —
  // both signals the block above relies on are permanently empty for them,
  // so they'd always read "offline" regardless of actual activity. Derive
  // presence instead from the general profile heartbeat every web/PWA
  // session already sends (PATCH /api/profile/heartbeat — see
  // profile.controller.ts), and break status straight from TimeLog (the
  // same source getAllUsersTimeproof/getShiftStatusForActor already trust)
  // rather than a heartbeat record that will never exist for them.
  const mainAgents = await Promise.all(mainOnlyUsers.map(async (u) => {
    const lastActive = (u as any).lastActive ? new Date((u as any).lastActive).getTime() : 0;
    const isOnline = (u as any).onlineStatus === 'online' || (now.getTime() - lastActive < OFFLINE_THRESHOLD_MS);
    const { isOnBreak: onBreak } = isOnline ? await getShiftStatusForActor(u._id) : { isOnBreak: false };
    return {
      email: u.email as string | undefined,
      user: { _id: u._id, fullName: (u as any).name || (u as any).fullName || u.email || 'Employee', avatar: u.avatar, role: u.role },
      isOnline,
      isIdle: false,
      isOnBreak: isOnline && onBreak,
      breakStartedAt: null,
      platform: 'mobile',
      lastSeenAt: (u as any).lastActive ?? null,
    };
  }));

  // A CrmUser and a User document can legitimately share the same email —
  // separate collections, separate unique-email constraints — when the same
  // person has both (e.g. a dormant CrmUser record alongside the User
  // account they actually clock in with). Whichever entry shows real
  // activity right now (online, or more recently seen) wins the display
  // slot; the other is dropped so the person isn't listed twice with
  // conflicting statuses.
  const combined = [...crmAgents, ...mainAgents];
  const byEmail = new Map<string, (typeof combined)[number]>();
  const noEmail: typeof combined = [];
  for (const a of combined) {
    if (!a.email) { noEmail.push(a); continue; }
    const key = a.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, a); continue; }
    const rank = (x: (typeof combined)[number]) =>
      (x.isOnline ? 1e15 : 0) + (x.lastSeenAt ? new Date(x.lastSeenAt).getTime() : 0);
    if (rank(a) > rank(existing)) byEmail.set(key, a);
  }
  const agents = [...byEmail.values(), ...noEmail].map(({ email: _email, ...rest }) => rest);

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

  // Visible record for the account owner (and any admin/manager viewing) when
  // an admin deleted one of THIS user's screenshots on this date — the push
  // notification sent at delete-time is easy to miss, so this gives a
  // persistent, in-app trail. The admin's name is already embedded in
  // `reason` at write-time (see deleteMyScreenshot) rather than populated,
  // since performedBy may reference a CrmUser, not the User model this field
  // is typed against.
  const deletionNotices = await AuditLog.find({
    entityType: 'Screenshot',
    action: 'ADMIN_DELETE_SCREENSHOT',
    'changes.userId': targetId,
    'changes.date': date,
  }).select('reason createdAt').sort({ createdAt: -1 }).lean();

  res.json(new ApiResponse(200, {
    screenshots: withUrls,
    deletionNotices: deletionNotices.map((n: any) => ({ reason: n.reason, at: n.createdAt })),
  }, 'Screenshots fetched'));
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

  // Admin/manager deleting on someone ELSE's behalf must be visible to that
  // user — unlike a self-delete (intentionally no audit trail, personal use),
  // silently deleting another person's proof-of-work photo without their
  // knowledge isn't acceptable. Self-deletes are untouched by this block.
  if (!isSelf) {
    await AuditLog.create({
      entityType: 'Screenshot',
      entityId: key,
      action: 'ADMIN_DELETE_SCREENSHOT',
      changes: { userId: targetUserId, date, deductedSeconds: SCREENSHOT_DELETE_DEDUCTION_SECONDS },
      reason: `${requestor.fullName} deleted a screenshot on behalf of another user`,
      performedBy: requestor._id,
      organizationId: requestor.organizationId?.toString(),
    });

    // Persisted (not just a raw push) since this has real payroll impact —
    // the affected user needs a durable record even if the push is missed
    // (device off, subscription pruned, notification dismissed unseen).
    notificationService.createNotification({
      userId: targetUserId,
      organizationId: requestor.organizationId?.toString() || '',
      type: 'crm_timeproof',
      title: '🗑️ Screenshot Deleted by Admin',
      message: `${requestor.fullName} deleted one of your screenshots from ${date}. ${SCREENSHOT_DELETE_DEDUCTION_SECONDS / 60} minutes were deducted from that day's rendered hours.`,
      metadata: { route: `/crm/timeproof/${date}` },
    }).catch(() => {});
  }

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
  if (await isTimeEditExempt(targetUser.organizationId?.toString(), targetUser.department)) {
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
 * POST /api/crm/timeproof/users/:userId/clock-out
 * Admin/manager-only: immediately ends a user's currently open shift (and any
 * open break) right now. No rendered-hours gate — this is a deliberate
 * override for cases like a user stepping away idle without clocking out,
 * unlike the automatic stale-shift/idle clock-out which only fires past 8h.
 */
export const clockOutUser = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can clock out other users');
  }

  const { userId } = req.params;
  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('fullName organizationId').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');

  const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
  let isOnShift = false;
  let openBreak = false;
  for (const log of logs) {
    if (log.type === 'time-in') { isOnShift = true; openBreak = false; }
    else if (log.type === 'time-out') { isOnShift = false; openBreak = false; }
    else if (log.type === 'break-in') { openBreak = true; }
    else if (log.type === 'break-out') { openBreak = false; }
  }
  if (!isOnShift) throw new ApiError(400, `${targetUser.fullName} is not currently clocked in`);

  const now = new Date();
  let breakOutLogId: string | null = null;
  if (openBreak) {
    const created = await TimeLog.create({
      userId, userModel: 'CrmUser', type: 'break-out', timestamp: now,
      note: `Break closed alongside manual clock-out by ${requestor.fullName}`,
    });
    breakOutLogId = created._id.toString();
  }

  const timeOutLog = await TimeLog.create({
    userId, userModel: 'CrmUser', type: 'time-out', timestamp: now,
    note: `Manually clocked out by ${requestor.fullName} (admin action — agent was idle)`,
  });

  await AgentHeartbeat.updateOne({ userId }, { isIdle: false, idleSince: null, lastIdleEscalationNotifiedAt: null });

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: timeOutLog._id.toString(),
    action: 'MANUAL_CLOCK_OUT',
    changes: { userId, breakOutLogId, clockedOutAt: now },
    reason: 'Admin/manager manual clock-out from idle alert',
    performedBy: requestor._id,
    organizationId: targetUser.organizationId?.toString(),
  });

  emitToUser(userId, 'timeclock:force-clockout', { at: now, by: requestor.fullName });

  res.json(new ApiResponse(200, { clockedOutAt: now }, `${targetUser.fullName} has been clocked out`));
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
  if (await isTimeEditExempt(targetUser.organizationId?.toString(), targetUser.department)) {
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

  // A push endpoint belongs to the current installed browser/PWA instance.
  // Remove it from any previous account first so shared devices or account
  // switches cannot keep receiving another user's private notifications.
  // Excluded: the main-site User record sharing this CRM user's email — that's
  // the same person's other account (an employee legitimately holds both a
  // CrmUser and a User identity on one device), not a stale/foreign session.
  // Without this exclusion, this CrmUser subscribe and the main-site /api/push
  // subscribe race on every load of the shared dashboard and silently strip
  // each other's subscription, breaking push delivery for that person.
  await Promise.all([
    CrmUser.updateMany(
      { _id: { $ne: user._id }, 'pushSubscriptions.endpoint': subscription.endpoint },
      { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } }
    ),
    User.updateMany(
      { email: { $ne: user.email }, 'pushSubscriptions.endpoint': subscription.endpoint },
      { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } }
    ),
  ]);
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

  // Unlike screenshots, ActivityIntervals are posted immediately when
  // committed — there is no offline queue/deferred retry for this endpoint —
  // so `endAt` should always land within moments of the server's own clock.
  // A large gap means the tray machine's system clock was wrong at the
  // moment it stamped this interval (seen in production: a ~12-hour clock
  // glitch on one machine filed a real, otherwise-normal work segment onto
  // the wrong calendar day even though it fell in the middle of an
  // uninterrupted Monday shift). Trust the SERVER's current date for
  // bucketing when that happens instead of propagating the bad client
  // timestamp — the segment's duration is still correct either way since
  // it's a relative (end - start) delta from the same clock.
  const CLOCK_DRIFT_TOLERANCE_MS = 60 * 60 * 1000; // 1 hour
  const serverNow = new Date();
  const clientClockLooksWrong = Math.abs(serverNow.getTime() - end.getTime()) > CLOCK_DRIFT_TOLERANCE_MS;
  const shiftDate = toLocalDateStr(clientClockLooksWrong ? serverNow : start, COMPANY_TZ_OFFSET_MINUTES);

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
 * POST /api/crm/timeproof/client-diagnostics
 * Tray app reports otherwise-invisible local failures here (e.g.
 * desktopCapturer returning zero screen sources, capture/upload exceptions).
 * The tray runs hidden with no visible console, so without this there is no
 * way to find out WHY a specific user's screenshots silently stopped short
 * of asking them to dig up a log file themselves. Piped through the existing
 * logger, which already persists to SystemLog in Mongo — queryable by
 * userId/organizationId the same way any other server log is.
 */
export const postClientDiagnostic = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { event, message, meta } = req.body;

  if (!event || typeof event !== 'string') {
    throw new ApiError(400, 'event is required');
  }

  logger.warn(
    {
      context: 'tray-client-diagnostic',
      userId: user._id.toString(),
      organizationId: user.organizationId?.toString(),
      event,
      meta,
    },
    message || event,
  );

  res.json(new ApiResponse(200, {}, 'Logged'));
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