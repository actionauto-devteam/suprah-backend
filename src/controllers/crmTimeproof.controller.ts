import { Request, Response } from 'express';
import crypto from 'crypto';
// v1.4.0
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
import { emitToUser, emitToShiftBoard, isCrmUserOnline, getSocketIO } from '../utils/socketEmitter';
import CrmPushService from '../services/crmPush.service';
import ExcludedScreenshot from '../models/ExcludedScreenshot.model';
import ScreenshotDeduction from '../models/ScreenshotDeduction.model';
import AuditLog from '../models/AuditLog.model';
import { SystemLog } from '../models/SystemLog.model';
import { HourlyRateChangeLog } from '../models/HourlyRateChangeLog.model';
import { PayPeriodLock } from '../models/PayPeriodLock.model';
import { isTimeEditExempt, isIdleDetectionExemptDept } from '../config/departmentMonitoring';
import { resolveScreenshotsRequired } from '../utils/monitoringMode.util';
import { getCompanyDayRange, isPayoutUnblurWindow } from '../utils/companyTimezone';
import { getPayPeriodBounds, getPayPeriodBoundsFor } from '../utils/payPeriod';
import { computeWeeklyOvertime, sumRegularSecondsInPeriod, WEEKLY_OT_THRESHOLD_SECONDS } from '../utils/payrollOvertime';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';
import notificationService from '../services/notification.service';
import sharp from 'sharp';
import logger from '../utils/logger';
import { getShiftStatusForActor } from '../utils/shiftStatus';

const BREAK_LIMIT_SECONDS = 3600;
const BREAK_ADMIN_NOTIFY_SECONDS = BREAK_LIMIT_SECONDS + 5 * 60;

const IDLE_ESCALATION_THRESHOLD_SECONDS = 15 * 60;

const MAX_PUSH_SUBSCRIPTIONS = 6;

const COMPANY_TZ_OFFSET_MINUTES = -360;
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

type ResolvedTargetUser = {
  _id: any;
  fullName: string;
  department?: string;
  organizationId?: any;
  userModel: 'CrmUser' | 'User';
};

async function resolveTargetUserAnyModel(userId: string, requestorOrgId: string | undefined): Promise<ResolvedTargetUser | null> {
  const crmTargetUser = await CrmUser.findOne({ _id: userId, organizationId: requestorOrgId }).select('department fullName organizationId').lean();
  if (crmTargetUser) {
    return {
      _id: crmTargetUser._id,
      fullName: crmTargetUser.fullName,
      department: crmTargetUser.department,
      organizationId: crmTargetUser.organizationId,
      userModel: 'CrmUser',
    };
  }
  const mainTargetUser = await User.findOne({ _id: userId }).lean();
  if (mainTargetUser) {
    return {
      _id: mainTargetUser._id,
      fullName: (mainTargetUser as any).name || (mainTargetUser as any).fullName || mainTargetUser.email || 'Employee',
      department: (mainTargetUser.personalInfo as any)?.department,
      organizationId: requestorOrgId,
      userModel: 'User',
    };
  }
  return null;
}

const MIN_ACTIVITY_COVERAGE = 0.65;

const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;

/* ──────────────────────────────────────────────────────────────────────────
   Helpers — core session/calendar math now lives in utils/timeLogEngine.ts,
   shared with generalTimeclock.controller.ts and crm.controller.ts so the
   three no longer maintain separate copies of the same pairing logic.
────────────────────────────────────────────────────────────────────────── */
import {
  buildSessions, buildBreakSessions, buildCalendarMap, computeStreak,
  buildHourPattern, aggregateSummary, getWeekStart, toDateStr, toLocalDateStr,
  formatHours, buildIdleLog, attachWeekTotals, type CalendarDay,
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

  const deductions = await ScreenshotDeduction.find({
    userId: user._id,
    date: { $in: Object.keys(calendar) },
  }).select('date deductedSeconds').lean();
  for (const d of deductions) {
    if (calendar[d.date]) {
      calendar[d.date].totalSeconds = Math.max(0, calendar[d.date].totalSeconds - d.deductedSeconds);
    }
  }

  attachWeekTotals(calendar);

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

  const idleExempt = await isIdleDetectionExemptDept(user.organizationId?.toString(), user.department);
  const idleLog = idleExempt ? [] : buildIdleLog(logs, activityIntervals, COMPANY_TZ_OFFSET_MINUTES);

  res.json(new ApiResponse(200, { idleLog, range: { startDate: startDateStr, endDate: endDateStr } }, 'Idle log fetched'));
});

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
    payrollLocation?: 'Utah' | 'Philippines';
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
      payrollLocation: u.payrollLocation,
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

      const calendar = buildCalendarMap(logs, COMPANY_TZ_OFFSET_MINUTES);
      const userDeductions = deductionsByUser.get(u._id.toString());
      if (userDeductions) {
        for (const [date, seconds] of userDeductions) {
          if (calendar[date]) calendar[date].totalSeconds = Math.max(0, calendar[date].totalSeconds - seconds);
        }
      }
      const summary = aggregateSummary(calendar, COMPANY_TZ_OFFSET_MINUTES);
      const { streak } = computeStreak(calendar, COMPANY_TZ_OFFSET_MINUTES);
      const isLive = !!calendar[todayStr]?.sessions.find(s => s.isLive);

      let isOnShift = false;
      let shiftStartedAt: string | null = null;
      for (const log of logs) {
        if (log.type === 'time-in') { isOnShift = true; shiftStartedAt = new Date(log.timestamp).toISOString(); }
        else if (log.type === 'time-out') { isOnShift = false; shiftStartedAt = null; }
      }

      const totalBreakSeconds = calendar[todayStr]?.breakSeconds ?? 0;
      const todayTotalWorkedSeconds = (calendar[todayStr]?.totalSeconds ?? 0) + totalBreakSeconds;
      const today = formatHours(calendar[todayStr]?.totalSeconds ?? 0);

      return {
        email: u.email,
        user: {
          _id: u._id,
          fullName: u.fullName,
          username: u.username,
          avatar: u.avatar,
          role: u.role,
          department: u.department,
          payrollLocation: u.payrollLocation,
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

  const byEmail = new Map<string, (typeof results)[number]>();
  const noEmail: typeof results = [];
  for (const r of results) {
    if (!r.email) { noEmail.push(r); continue; }
    const key = r.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, r); continue; }
    const payrollLocation = r.user.payrollLocation ?? existing.user.payrollLocation;
    const winner = r.thisMonth.totalSeconds > existing.thisMonth.totalSeconds ? r : existing;
    byEmail.set(key, { ...winner, user: { ...winner.user, payrollLocation } });
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

  let targetPerson: { _id: any; fullName: string; username?: string; avatar?: string; role: string; department?: string; accountModel: 'CrmUser' | 'User'; hourlyRate?: number | null } | null = null;
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
      hourlyRate: crmTargetUser.hourlyRate ?? null,
    };
  } else {
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
  const userDeductions = await ScreenshotDeduction.find({
    userId,
    date: { $in: Object.keys(calendar) },
  }).select('date deductedSeconds').lean();
  for (const d of userDeductions) {
    if (calendar[d.date]) {
      calendar[d.date].totalSeconds = Math.max(0, calendar[d.date].totalSeconds - d.deductedSeconds);
    }
  }

  attachWeekTotals(calendar);

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

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('_id department organizationId');
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

  const idleExempt = await isIdleDetectionExemptDept(targetUser.organizationId?.toString(), targetUser.department);
  const idleLog = idleExempt ? [] : buildIdleLog(logs, activityIntervals, COMPANY_TZ_OFFSET_MINUTES);

  res.json(new ApiResponse(200, { idleLog, range: { startDate: startDateStr, endDate: endDateStr } }, 'Idle log fetched'));
});

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

export const getShiftState = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - 2);
  lookbackStart.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({
    userId: user._id,
    timestamp: { $gte: lookbackStart },
  }).sort({ timestamp: 1 }).lean();

  const timeIns  = logs.filter(l => l.type === 'time-in');
  const timeOuts = logs.filter(l => l.type === 'time-out');

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

  const nowMDT = new Date(Date.now() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const todayMDTStr = nowMDT.toISOString().split('T')[0];
  const todayMDTStartUTC = new Date(todayMDTStr + 'T00:00:00.000Z').getTime()
    - COMPANY_TZ_OFFSET_MINUTES * 60_000;

  const allSessions = buildSessions(logs);
  const todayTotalWorkedSeconds = allSessions
    .filter(s => !s.isLive && new Date(s.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, s) => sum + s.duration, 0);

  const todayTotalWorkedSecondsIncludingLive = allSessions
    .filter(s => new Date(s.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, s) => sum + s.duration, 0);

  const allBreakSessions = buildBreakSessions(logs);
  const todayBreakTotalSeconds = allBreakSessions
    .filter(b => new Date(b.in).getTime() >= todayMDTStartUTC)
    .reduce((sum, b) => sum + b.duration, 0);

  const wallClockRenderedSeconds = Math.max(0, todayTotalWorkedSecondsIncludingLive - todayBreakTotalSeconds);

  const activityIntervals = await ActivityInterval.find({
    userId: user._id,
    shiftDate: todayMDTStr,
  }).lean();
  const activityIntervalTotal = activityIntervals.reduce((sum, i) => sum + i.durationSeconds, 0);
  const wallClockNetSeconds = Math.max(0, todayTotalWorkedSeconds - todayBreakTotalSeconds);
  const trustActivityIntervals =
    activityIntervalTotal > 0 &&
    activityIntervalTotal < wallClockNetSeconds &&
    activityIntervalTotal / wallClockNetSeconds >= MIN_ACTIVITY_COVERAGE;
  const todayTotalActiveSeconds = trustActivityIntervals ? activityIntervalTotal : wallClockNetSeconds;
  const lastIntervalEndMs = activityIntervals.length
    ? Math.max(...activityIntervals.map((i) => new Date(i.endAt).getTime()))
    : null;

  const heartbeat = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  const rawIntervalStart = heartbeat?.currentIntervalStartAt?.toISOString() ?? null;
  const isShiftFromToday = shiftStartedAt
    ? new Date(shiftStartedAt).getTime() >= todayMDTStartUTC
    : false;

  const heartbeatFresh = heartbeat
    ? Date.now() - new Date(heartbeat.lastSeenAt).getTime() < HEARTBEAT_FRESH_MS
    : false;
  const fallbackShiftedStart = isOnShift && !isOnBreak && isShiftFromToday && shiftStartedAt
    ? new Date(new Date(shiftStartedAt).getTime() + (totalBreakSeconds * 1000)).toISOString()
    : null;
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

export const postHeartbeat = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const {
    isIdle: rawIsIdle = false,
    platform = 'win32',
    isOnBreak = false,
    breakDurationSeconds = 0,
    isOnShift = false,
    currentIntervalStartAt,
    screenRecordingGranted = null,
    appVersion = null,
  } = req.body;

  const idleExempt = await isIdleDetectionExemptDept(user.organizationId?.toString(), user.department);
  const isIdle = idleExempt ? false : rawIsIdle;

  const screenshotsRequired = await resolveScreenshotsRequired({
    userId: user._id.toString(),
    organizationId: user.organizationId?.toString(),
    department: user.department,
    monitoringModeOverride: user.monitoringModeOverride,
    screenshotExempt: user.screenshotExempt,
  });

  const existing = await AgentHeartbeat.findOne({ userId: user._id });
  const wasIdle = existing?.isIdle ?? false;
  const wasOnBreak = existing?.isOnBreak ?? false;
  const hadBreakNotification = existing?.lastBreakNotifiedAt ?? null;

  let lastBreakNotifiedAt = hadBreakNotification;
  if (!isOnBreak && wasOnBreak) {
    lastBreakNotifiedAt = null;
  }

  let idleSince = existing?.idleSince ?? null;
  if (isIdle && !wasIdle) idleSince = new Date();
  if (!isIdle) idleSince = null;

  let lastIdleEscalationNotifiedAt = existing?.lastIdleEscalationNotifiedAt ?? null;
  if (!isIdle) lastIdleEscalationNotifiedAt = null;

  let lastIdleChannelPostedAt = existing?.lastIdleChannelPostedAt ?? null;
  if (!isIdle) lastIdleChannelPostedAt = null;

  const wasScreenRecordingGranted = existing?.screenRecordingGranted ?? null;
  let lastScreenRecordingNotifiedAt = existing?.lastScreenRecordingNotifiedAt ?? null;
  if (screenRecordingGranted === true) lastScreenRecordingNotifiedAt = null;

  await AgentHeartbeat.findOneAndUpdate(
    { userId: user._id },
    {
      isIdle,
      idleSince,
      lastIdleEscalationNotifiedAt,
      lastIdleChannelPostedAt,
      isOnBreak,
      breakStartedAt: isOnBreak && !wasOnBreak ? new Date() : (isOnBreak ? existing?.breakStartedAt ?? null : null),
      lastBreakNotifiedAt,
      platform,
      screenRecordingGranted,
      lastScreenRecordingNotifiedAt,
      appVersion,
      lastSeenAt: new Date(),
      ...(currentIntervalStartAt !== undefined && {
        currentIntervalStartAt: currentIntervalStartAt ? new Date(currentIntervalStartAt) : null,
      }),
    },
    { upsert: true, new: true }
  );

  // ── Notify: macOS Screen Recording permission is missing ──────────────────
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
  if (!wasIdle && isIdle && isOnShift) {
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

    const idleChannelCooldownMs = 5 * 60 * 1000;
    const dueForIdleChannelPost = !existing?.lastIdleChannelPostedAt
      || Date.now() - new Date(existing.lastIdleChannelPostedAt).getTime() > idleChannelCooldownMs;
    if (dueForIdleChannelPost) {
      await AgentHeartbeat.updateOne({ userId: user._id }, { lastIdleChannelPostedAt: new Date() });
      postBatchedShiftAlertMessages(user.organizationId.toString(), [`⚪ ${user.fullName} has been idle for 10 minutes.`])
        .catch((err) => logger.error({ err, userId: user._id.toString() }, '[shiftAlerts] Failed to post idle alert'));
    }
  }

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
      notifyBody: `You've exceeded your 1-hour break — please wrap up.`,
      adminNotifyBody: `${user.fullName} exceeded their break time.`,
      notifyTag: `crm-break-${user._id}`,
      url: '/crm/timeproof/users',
    })
      .then(() => logger.info({ userId: user._id.toString() }, '[break-escalation] fireShiftAlert completed'))
      .catch((err) => logger.error({ err, userId: user._id.toString() }, '[break-escalation] fireShiftAlert failed'));
  }

  res.json(new ApiResponse(200, { received: true, screenshotsRequired }, 'Heartbeat recorded'));
});

export const getAgentStatus = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied');
  }

  const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
  const now = new Date();

  const crmUsers = await CrmUser.find({ isActive: true, organizationId: requestor.organizationId }).select('-password').lean();

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
      appVersion: hb?.appVersion ?? null,
    };
  });

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
      appVersion: null,
    };
  }));

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

export const submitScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;

  if (!req.file) throw new ApiError(400, 'Screenshot file is required');

  const { capturedAt, shiftDate, idleDetected = 'false', breakEvent } = req.body;
  if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new ApiError(400, 'shiftDate is required (YYYY-MM-DD)');
  }
  if (breakEvent !== undefined && breakEvent !== 'break-in' && breakEvent !== 'break-out') {
    throw new ApiError(400, 'breakEvent must be break-in or break-out');
  }

  const capturedAtDate = capturedAt ? new Date(capturedAt) : new Date();
  const flag = breakEvent ? breakEvent : (idleDetected === 'true' ? 'idle' : 'active');
  const customFileName = `${capturedAtDate.getTime()}-${flag}.jpg`;
  const fileWithName: Express.Multer.File = { ...req.file, originalname: customFileName };

  const r2Key = await storageService.upload(
    fileWithName,
    `screenshots/${user._id.toString()}/${shiftDate}`,
    BucketType.PRIVATE,
    { allowLocalFallback: true, preserveFilename: true }
  );

  res.json(new ApiResponse(201, { r2Key }, 'Screenshot uploaded'));
});

/**
 * POST /api/crm/timeproof/screenshots/placeholder
 */
export const submitScreenshotPlaceholder = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { capturedAt, shiftDate, reason } = req.body as { capturedAt?: string; shiftDate?: string; reason?: string };

  if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new ApiError(400, 'shiftDate is required (YYYY-MM-DD)');
  }
  if (reason !== 'screen-recording-permission-missing') {
    throw new ApiError(400, 'Unrecognized placeholder reason');
  }

  const capturedAtDate = capturedAt ? new Date(capturedAt) : new Date();
  const placeholderJpeg = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 39, g: 39, b: 42 } },
  }).jpeg({ quality: 60 }).toBuffer();

  const customFileName = `${capturedAtDate.getTime()}-noaccess.jpg`;
  const fileWithName = {
    buffer: placeholderJpeg,
    originalname: customFileName,
    mimetype: 'image/jpeg',
  } as Express.Multer.File;

  const r2Key = await storageService.upload(
    fileWithName,
    `screenshots/${user._id.toString()}/${shiftDate}`,
    BucketType.PRIVATE,
    { allowLocalFallback: true, preserveFilename: true }
  );

  res.json(new ApiResponse(201, { r2Key }, 'Placeholder recorded'));
});

/**
 * GET /api/crm/timeproof/screenshots?date=YYYY-MM-DD&userId=...
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

  const isSelf = targetId === requestor._id.toString();
  let shouldBlur = false;
  if (!isSelf) {
    const targetUser = await CrmUser.findOne({ _id: targetId, organizationId: requestor.organizationId })
      .select('screenshotBlurUntilPayout').lean();
    if (!targetUser) throw new ApiError(404, 'User not found');
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

  const parsed = objects
    .filter((obj) => !excludedKeys.has(obj.key))
    .map((obj) => {
      const tail = obj.key.slice(prefix.length).replace(/\.jpg$/i, '');
      const dashIdx = tail.indexOf('-');
      if (dashIdx < 0) return null;
      const msStr = tail.slice(0, dashIdx);
      const flag = tail.slice(dashIdx + 1);
      const ms = parseInt(msStr, 10);
      if (!Number.isFinite(ms)) return null;
      return {
        r2Key: obj.key,
        capturedAt: new Date(ms),
        idleDetected: flag === 'idle',
        isPlaceholder: flag === 'noaccess',
        breakEvent: (flag === 'break-in' || flag === 'break-out') ? flag as 'break-in' | 'break-out' : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());

  const withUrls = await Promise.all(
    parsed.map(async (s) => ({
      _id: s.r2Key,
      capturedAt: s.capturedAt,
      idleDetected: s.idleDetected,
      isPlaceholder: s.isPlaceholder,
      breakEvent: s.breakEvent,
      isBlurred: shouldBlur,
      url: shouldBlur
        ? `/api/crm/timeproof/screenshot-blurred?key=${encodeURIComponent(s.r2Key)}&t=${encodeURIComponent(requestToken)}`
        : await getSignedProofUrl(s.r2Key),
    }))
  );

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
 */
export const getBlurredScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { key } = req.query;

  if (!key || typeof key !== 'string' || !key.startsWith('screenshots/')) {
    throw new ApiError(400, 'Valid key query param required');
  }

  const targetUserId = key.split('/')[1];
  const isSelf = targetUserId === requestor._id.toString();
  if (!isSelf) {
    if (!['admin', 'manager'].includes(requestor.role)) {
      throw new ApiError(403, 'Access denied');
    }
    const targetUser = await CrmUser.findOne({ _id: targetUserId, organizationId: requestor.organizationId }).select('_id').lean();
    if (!targetUser) throw new ApiError(404, 'Screenshot not found');
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

const SCREENSHOT_DELETE_DEDUCTION_SECONDS = 10 * 60;

/**
 * DELETE /api/crm/timeproof/screenshots?key=...
 */
export const deleteMyScreenshot = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  const { key } = req.query;

  if (!key || typeof key !== 'string' || !key.startsWith('screenshots/')) {
    throw new ApiError(400, 'Valid key query param required');
  }

  const [, targetUserId, date] = key.split('/');
  const isSelf = targetUserId === requestor._id.toString();
  if (!isSelf) {
    if (!['admin', 'manager'].includes(requestor.role)) {
      throw new ApiError(403, 'You can only delete your own screenshots');
    }
    const targetUser = await CrmUser.findOne({ _id: targetUserId, organizationId: requestor.organizationId }).select('_id').lean();
    if (!targetUser) throw new ApiError(404, 'User not found');
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
 */
async function getPeriodLockStatus(userId: string, date: Date): Promise<{
  locked: boolean;
  status: 'paid' | 'auto-locked' | 'unlocked' | 'open';
}> {
  const { periodStart, periodEnd, payDayDate } = getPayPeriodBounds(date);
  const lock = await PayPeriodLock.findOne({ userId, periodStart, periodEnd }).lean();
  if (lock) {
    return { locked: lock.status !== 'unlocked', status: lock.status };
  }
  const pastPayday = new Date() >= payDayDate;
  return { locked: pastPayday, status: pastPayday ? 'auto-locked' : 'open' };
}

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

  const targetUser = await resolveTargetUserAnyModel(userId, requestor.organizationId?.toString());
  if (!targetUser) throw new ApiError(404, 'User not found');
  if (await isTimeEditExempt(targetUser.organizationId?.toString(), targetUser.department)) {
    throw new ApiError(403, `${targetUser.fullName}'s time logs are exempt from admin correction`);
  }

  const { start, end } = getCompanyDayRange(date);

  const { locked } = await getPeriodLockStatus(userId, start);
  if (locked) {
    throw new ApiError(403, 'This pay period has already been processed and is locked for corrections. Use the emergency unlock on the Payroll Status page if a correction is truly necessary.');
  }
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
      userId, userModel: targetUser.userModel, type: 'time-out',
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
 * GET /api/crm/timeproof/admin/day-logs?userId=&date=
 */
export const getAdminDayLogs = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (requestor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can use the manual time-override tool');
  }
  if (!(await isTimeEditExempt(requestor.organizationId?.toString(), requestor.department))) {
    throw new ApiError(403, 'This tool is only available to admins in an exempt department');
  }
  const userId = req.query.userId as string;
  const date = req.query.date as string;
  if (!userId || !date) throw new ApiError(400, 'userId and date are required');

  const targetUser = await resolveTargetUserAnyModel(userId, requestor.organizationId?.toString());
  if (!targetUser) throw new ApiError(404, 'User not found');

  const { start, end } = getCompanyDayRange(date);
  const logs = await TimeLog.find({ userId, timestamp: { $gte: start, $lt: end } })
    .sort({ timestamp: 1 })
    .select('type timestamp note')
    .lean();

  res.json(new ApiResponse(200, { logs }, 'Day logs fetched'));
});

/**
 * POST /api/crm/timeproof/admin/time-override
 */
export const adminTimeOverride = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (requestor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can use the manual time-override tool');
  }
  if (!(await isTimeEditExempt(requestor.organizationId?.toString(), requestor.department))) {
    throw new ApiError(403, 'This tool is only available to admins in an exempt department');
  }

  const { userId, date, action, logId, type, timestamp, reason } = req.body as {
    userId?: string; date?: string; action?: 'edit' | 'delete' | 'create';
    logId?: string; type?: 'time-in' | 'time-out'; timestamp?: string; reason?: string;
  };
  if (!userId || !date || !action) {
    throw new ApiError(400, 'userId, date and action are all required');
  }
  const auditReason = reason?.trim() || '(no reason provided)';
  const noteSuffix = reason?.trim() ? `: ${reason.trim()}` : '';

  const targetUser = await resolveTargetUserAnyModel(userId, requestor.organizationId?.toString());
  if (!targetUser) throw new ApiError(404, 'User not found');

  const { start } = getCompanyDayRange(date);
  const { locked } = await getPeriodLockStatus(userId, start);
  if (locked) {
    throw new ApiError(403, 'This pay period has already been processed and is locked for corrections. Use the emergency unlock on the Payroll Status page if a correction is truly necessary.');
  }

  let logResultId: string;
  let before: unknown = null;
  let after: unknown = null;

  if (action === 'edit') {
    if (!logId || !timestamp) throw new ApiError(400, 'logId and timestamp are required to edit an entry');
    const existing = await TimeLog.findOne({ _id: logId, userId }).lean();
    if (!existing) throw new ApiError(404, 'Time log entry not found');
    before = existing.timestamp;
    after = new Date(timestamp);
    await TimeLog.updateOne({ _id: logId }, { timestamp: after, note: `Admin override by ${requestor.fullName}${noteSuffix}` });
    logResultId = logId;
  } else if (action === 'delete') {
    if (!logId) throw new ApiError(400, 'logId is required to delete an entry');
    const existing = await TimeLog.findOne({ _id: logId, userId }).lean();
    if (!existing) throw new ApiError(404, 'Time log entry not found');
    before = { type: existing.type, timestamp: existing.timestamp };
    await TimeLog.deleteOne({ _id: logId });
    logResultId = logId;
  } else if (action === 'create') {
    if (!type || !timestamp) throw new ApiError(400, 'type and timestamp are required to create an entry');
    const created = await TimeLog.create({
      userId, userModel: targetUser.userModel, type, timestamp: new Date(timestamp),
      note: `Added by ${requestor.fullName} (admin time-override)${noteSuffix}`,
    });
    after = created.timestamp;
    logResultId = created._id.toString();
  } else {
    throw new ApiError(400, 'action must be edit, delete, or create');
  }

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: logResultId,
    action: 'ADMIN_TIME_OVERRIDE',
    changes: { userId, date, action, type, before, after },
    reason: auditReason,
    performedBy: requestor._id,
    organizationId: targetUser.organizationId?.toString(),
  });

  res.json(new ApiResponse(200, { logId: logResultId }, 'Time override applied'));
});

/**
 * PATCH /api/crm/timeproof/user/:userId/hourly-rate
 */
export const updateHourlyRate = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can set hourly rates');
  }
  const { userId } = req.params;
  const { rate } = req.body as { rate?: number };
  if (rate === undefined || rate === null || isNaN(Number(rate)) || Number(rate) < 0) {
    throw new ApiError(400, 'A valid non-negative rate is required');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId });
  if (!targetUser) throw new ApiError(404, 'User not found');

  const previousRate = targetUser.hourlyRate ?? null;
  targetUser.hourlyRate = Number(rate);
  await targetUser.save();

  await HourlyRateChangeLog.create({
    organizationId: targetUser.organizationId,
    userId: targetUser._id,
    previousRate,
    newRate: Number(rate),
    changedByAdminId: requestor._id,
    changedByAdminName: requestor.fullName,
  });

  res.json(new ApiResponse(200, { hourlyRate: targetUser.hourlyRate }, 'Hourly rate updated'));
});

/**
 * PATCH /api/crm/timeproof/user/:userId/payroll-location
 * Utah (ADP) vs Philippines/Online (PayPal) classification, admin-set.
 */
/**
 * GET /api/crm/timeproof/user/:userId/hourly-rate-history
 */
export const getHourlyRateHistory = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can view rate history');
  }
  const { userId } = req.params;
  const history = await HourlyRateChangeLog.find({ userId, organizationId: requestor.organizationId })
    .sort({ createdAt: -1 })
    .lean();
  res.json(new ApiResponse(200, { history }, 'Hourly rate history'));
});

/**
 * POST /api/crm/timeproof/user/:userId/mark-paid
 */
export const markPeriodPaid = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can mark payroll as paid');
  }
  const { userId } = req.params;
  const { year, month, periodNumber } = req.body as { year?: number; month?: number; periodNumber?: 1 | 2 };
  if (year === undefined || month === undefined || (periodNumber !== 1 && periodNumber !== 2)) {
    throw new ApiError(400, 'year, month, and periodNumber (1 or 2) are required');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('organizationId fullName').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');

  const { periodStart, periodEnd } = getPayPeriodBoundsFor(year, month, periodNumber);

  const lock = await PayPeriodLock.findOneAndUpdate(
    { userId, periodStart, periodEnd },
    {
      organizationId: targetUser.organizationId,
      userId,
      periodStart,
      periodEnd,
      status: 'paid',
      lockedAt: new Date(),
      lockedBy: requestor._id,
      lockedByName: requestor.fullName,
      unlockedAt: null,
      unlockedBy: null,
      unlockedByName: null,
      unlockReason: null,
    },
    { upsert: true, new: true },
  );

  res.json(new ApiResponse(200, { lock }, `Marked ${targetUser.fullName} as paid for this period`));
});

/**
 * POST /api/crm/timeproof/user/:userId/unlock-period
 */
export const unlockPayPeriod = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (requestor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can use the emergency unlock');
  }
  const { userId } = req.params;
  const { year, month, periodNumber, reason } = req.body as {
    year?: number; month?: number; periodNumber?: 1 | 2; reason?: string;
  };
  if (year === undefined || month === undefined || (periodNumber !== 1 && periodNumber !== 2) || !reason?.trim()) {
    throw new ApiError(400, 'year, month, periodNumber (1 or 2), and reason are all required');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('organizationId fullName').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');

  const { periodStart, periodEnd, payDayDate } = getPayPeriodBoundsFor(year, month, periodNumber);

  let lock = await PayPeriodLock.findOne({ userId, periodStart, periodEnd });
  const wasAutoLockedOnly = !lock && new Date() >= payDayDate;
  if (!lock && !wasAutoLockedOnly) {
    throw new ApiError(400, 'This period is not currently locked');
  }
  if (lock && lock.status === 'unlocked') {
    throw new ApiError(400, 'This period is already unlocked');
  }

  if (!lock) {
    lock = new PayPeriodLock({ organizationId: targetUser.organizationId, userId, periodStart, periodEnd });
  }
  lock.status = 'unlocked';
  lock.unlockedAt = new Date();
  lock.unlockedBy = requestor._id as any;
  lock.unlockedByName = requestor.fullName;
  lock.unlockReason = reason.trim();
  await lock.save();

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: userId,
    action: 'UPDATE',
    changes: { periodStart, periodEnd, action: 'emergency-unlock-pay-period' },
    reason: reason.trim(),
    performedBy: requestor._id,
    organizationId: targetUser.organizationId?.toString(),
  });

  res.json(new ApiResponse(200, { lock }, `Unlocked ${targetUser.fullName}'s period for correction`));
});

const PAYROLL_DE_MINIMIS_SECONDS = 0;

function computeExactPayout(totalSeconds: number, hourlyRate: number): number {
  const wholeHourSeconds = Math.floor(totalSeconds / 3600) * 3600;
  const remainderSeconds = totalSeconds - wholeHourSeconds;
  const payableSeconds = wholeHourSeconds + (remainderSeconds < PAYROLL_DE_MINIMIS_SECONDS ? 0 : remainderSeconds);
  return (payableSeconds / 3600) * hourlyRate;
}

export const getPayrollStatus = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can view payroll status');
  }
  const now = new Date();
  const year = req.query.year ? parseInt(req.query.year as string, 10) : now.getUTCFullYear();
  const month = req.query.month !== undefined ? parseInt(req.query.month as string, 10) : now.getUTCMonth();
  const periodNumber = (req.query.periodNumber === '2' ? 2 : 1) as 1 | 2;

  const { periodStart, periodEnd, payDayDate } = getPayPeriodBoundsFor(year, month, periodNumber);

  const users = await CrmUser.find({ organizationId: requestor.organizationId, isActive: true, hourlyTrackingExempt: { $ne: true } })
    .select('fullName username avatar role department hourlyRate payrollLocation otWarningExempt')
    .lean();
  const userIds = users.map((u) => u._id);

  const weeklyLookbackStart = new Date(periodStart.getTime() - 6 * 24 * 60 * 60 * 1000);

  const [logs, locks] = await Promise.all([
    TimeLog.find({ userId: { $in: userIds }, timestamp: { $gte: weeklyLookbackStart, $lt: periodEnd } }).sort({ timestamp: 1 }).lean(),
    PayPeriodLock.find({ userId: { $in: userIds }, periodStart, periodEnd }).lean(),
  ]);

  const logsByUser = new Map<string, typeof logs>();
  for (const log of logs) {
    const key = log.userId.toString();
    if (!logsByUser.has(key)) logsByUser.set(key, []);
    logsByUser.get(key)!.push(log);
  }
  const lockByUser = new Map(locks.map((l) => [l.userId.toString(), l]));
  const pastPayday = new Date() >= payDayDate;

  const results = users.map((u) => {
    const uLogs = logsByUser.get(u._id.toString()) || [];
    const calendar = buildCalendarMap(uLogs, COMPANY_TZ_OFFSET_MINUTES);
    const totalSeconds = sumRegularSecondsInPeriod(calendar, periodStart, periodEnd);
    const lock = lockByUser.get(u._id.toString());
    const rate = u.hourlyRate ?? null;
    const status = lock ? lock.status : pastPayday ? 'auto-locked' : 'open';

    const isUtah = u.payrollLocation === 'Utah';
    const { otPremiumSeconds, otPremiumPay, flaggedWeeks } = isUtah
      ? computeWeeklyOvertime(calendar, periodStart, periodEnd, rate, !!u.otWarningExempt)
      : { otPremiumSeconds: 0, otPremiumPay: 0, flaggedWeeks: [] };
    const basePay = rate ? computeExactPayout(totalSeconds, rate) : null;

    return {
      userId: u._id.toString(),
      fullName: u.fullName,
      username: u.username,
      avatar: u.avatar,
      role: u.role,
      department: u.department,
      payrollLocation: u.payrollLocation,
      totalSeconds,
      hourlyRate: rate,
      payout: basePay !== null ? basePay + otPremiumPay : null,
      otPremiumSeconds,
      otPremiumPay,
      flaggedWeeks,
      status,
      lockedAt: lock?.lockedAt ?? null,
      lockedByName: lock?.lockedByName ?? null,
      unlockReason: status === 'unlocked' ? lock?.unlockReason ?? null : null,
    };
  });

  res.json(new ApiResponse(200, { periodStart, periodEnd, payDayDate, users: results }, 'Payroll status'));
});

/**
 * GET /api/crm/timeproof/weekly-overtime-report?weekStart=YYYY-MM-DD
 */
export const getWeeklyOvertimeReport = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can view the weekly overtime report');
  }

  const weekStartStr = req.query.weekStart as string | undefined;
  if (!weekStartStr || !/^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
    throw new ApiError(400, 'weekStart is required (YYYY-MM-DD, must be a Sunday)');
  }
  if (new Date(weekStartStr + 'T12:00:00Z').getUTCDay() !== 0) {
    throw new ApiError(400, 'weekStart must be a Sunday');
  }
  const weekStartDate = getCompanyDayRange(weekStartStr).start;
  const weekEndExclusive = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  const saturdayStr = toLocalDateStr(new Date(weekStartDate.getTime() + 6 * 24 * 60 * 60 * 1000), COMPANY_TZ_OFFSET_MINUTES);

  const crmUsersRaw = await CrmUser.find({ organizationId: requestor.organizationId, isActive: true, hourlyTrackingExempt: { $ne: true } })
    .select('fullName username department payrollLocation email')
    .lean();

  const mainOnlyUsersRaw = await User.find({
    role: { $in: ['employee', 'admin', 'super_admin'] },
  }).select('fullName name email personalInfo lastActive updatedAt').lean();
  const mainOnlyUsers = dedupeUsersByEmail(mainOnlyUsersRaw);

  type OvertimeReportPerson = {
    _id: any;
    fullName: string;
    username?: string;
    department?: string;
    payrollLocation?: 'Utah' | 'Philippines';
    email?: string;
  };

  const users: OvertimeReportPerson[] = [
    ...crmUsersRaw.map((u): OvertimeReportPerson => ({
      _id: u._id, fullName: u.fullName, username: u.username,
      department: u.department, payrollLocation: u.payrollLocation, email: u.email,
    })),
    ...mainOnlyUsers.map((u): OvertimeReportPerson => ({
      _id: u._id,
      fullName: (u as any).name || (u as any).fullName || u.email || 'Employee',
      department: (u.personalInfo as any)?.department,
      email: u.email,
    })),
  ];
  const userIds = users.map((u) => u._id);

  const logs = await TimeLog.find({ userId: { $in: userIds }, timestamp: { $gte: weekStartDate, $lt: weekEndExclusive } })
    .sort({ timestamp: 1 })
    .lean();
  const logsByUser = new Map<string, typeof logs>();
  for (const log of logs) {
    const key = log.userId.toString();
    if (!logsByUser.has(key)) logsByUser.set(key, []);
    logsByUser.get(key)!.push(log);
  }

  const allDeductions = await ScreenshotDeduction.find({
    userId: { $in: userIds },
    date: { $gte: weekStartStr, $lte: saturdayStr },
  }).select('userId date deductedSeconds').lean();
  const deductionsByUser = new Map<string, typeof allDeductions>();
  for (const d of allDeductions) {
    const key = d.userId.toString();
    if (!deductionsByUser.has(key)) deductionsByUser.set(key, []);
    deductionsByUser.get(key)!.push(d);
  }

  const employees = users.map((u) => {
    const uLogs = logsByUser.get(u._id.toString()) || [];
    const calendar = buildCalendarMap(uLogs, COMPANY_TZ_OFFSET_MINUTES);

    for (const d of deductionsByUser.get(u._id.toString()) || []) {
      if (calendar[d.date]) {
        calendar[d.date].totalSeconds = Math.max(0, calendar[d.date].totalSeconds - d.deductedSeconds);
      }
    }
    attachWeekTotals(calendar);

    const totalWorkedSeconds = calendar[saturdayStr]?.weekTotalSeconds ?? 0;
    const overtimeSeconds = Math.max(0, totalWorkedSeconds - WEEKLY_OT_THRESHOLD_SECONDS);

    return {
      userId: u._id.toString(),
      fullName: u.fullName,
      username: u.username,
      department: u.department,
      payrollLocation: u.payrollLocation,
      email: u.email,
      totalWorkedSeconds,
      overtimeSeconds,
    };
  });

  const byEmail = new Map<string, (typeof employees)[number]>();
  const noEmail: typeof employees = [];
  for (const e of employees) {
    if (!e.email) { noEmail.push(e); continue; }
    const key = e.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, e); continue; }
    const payrollLocation = e.payrollLocation ?? existing.payrollLocation;
    const winner = e.totalWorkedSeconds > existing.totalWorkedSeconds ? e : existing;
    byEmail.set(key, { ...winner, payrollLocation });
  }
  const dedupedEmployees = [...byEmail.values(), ...noEmail].map(({ email: _email, ...rest }) => rest);

  dedupedEmployees.sort((a, b) => b.totalWorkedSeconds - a.totalWorkedSeconds);

  res.json(new ApiResponse(200, {
    weekStart: weekStartStr,
    weekEnd: toLocalDateStr(new Date(weekEndExclusive.getTime() - 1), COMPANY_TZ_OFFSET_MINUTES),
    employees: dedupedEmployees,
  }, 'Weekly overtime report generated'));
});

/**
 * POST /api/crm/timeproof/users/:userId/clock-out
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
  ).catch(() => {});

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

  const { subscription, deviceHint, appSource } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new ApiError(400, 'Invalid push subscription object');
  }
  const safeAppSource = appSource === 'supraspace' ? 'supraspace' : 'main';

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
          appSource: safeAppSource,
          createdAt: new Date(),
        },
      },
    }
  );

  await CrmUser.updateOne(
    { _id: user._id, 'pushSubscriptions.endpoint': { $ne: subscription.endpoint } },
    {
      $push: {
        pushSubscriptions: {
          $each: [{
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            deviceHint: deviceHint ?? 'unknown',
            appSource: safeAppSource,
            createdAt: new Date(),
          }],
          $sort: { createdAt: -1 },
          $slice: MAX_PUSH_SUBSCRIPTIONS,
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
 * GET /api/crm/timeproof/push/status
 */
export const getCrmPushStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const fresh = await CrmUser.findById(user._id).select('pushSubscriptions').lean();
  const subscriptions = fresh?.pushSubscriptions || [];

  res.json(new ApiResponse(200, {
    subscribed: subscriptions.length > 0,
    devices: subscriptions.map((s: any) => ({
      deviceHint: s.deviceHint || 'unknown',
      createdAt: s.createdAt,
      lastSuccessAt: s.lastSuccessAt || null,
      failureCount: s.failureCount || 0,
      endpointFingerprint: crypto.createHash('sha256').update(s.endpoint).digest('hex').slice(0, 12),
    })),
  }, 'Push subscription status'));
});

/**
 * GET /api/crm/timeproof/push/org-health
 */
export const getOrgPushHealth = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can view org push health');
  }

  const users = await CrmUser.find({ organizationId: requestor.organizationId, isActive: true })
    .select('fullName username role pushSubscriptions')
    .sort({ fullName: 1 })
    .lean();

  const STALE_DAYS = 7;
  const staleThreshold = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  const rows = users.map((u: any) => {
    const subs = u.pushSubscriptions || [];
    const devices = subs.map((s: any) => {
      const lastSuccessMs = s.lastSuccessAt ? new Date(s.lastSuccessAt).getTime() : null;
      const createdMs = s.createdAt ? new Date(s.createdAt).getTime() : null;
      const neverConfirmed = !lastSuccessMs && createdMs !== null && createdMs < staleThreshold;
      const stale = !!lastSuccessMs && lastSuccessMs < staleThreshold;
      return {
        deviceHint: s.deviceHint || 'unknown',
        appSource: s.appSource || null,
        endpointHost: (() => { try { return new URL(s.endpoint).host; } catch { return 'invalid'; } })(),
        createdAt: s.createdAt,
        lastSuccessAt: s.lastSuccessAt || null,
        failureCount: s.failureCount || 0,
        status: (s.failureCount || 0) > 0 ? 'failing' : neverConfirmed ? 'never-confirmed' : stale ? 'stale' : 'healthy',
      };
    });
    return {
      userId: u._id,
      fullName: u.fullName,
      username: u.username,
      role: u.role,
      subscriptionCount: devices.length,
      devices,
    };
  });

  res.json(new ApiResponse(200, { staleDaysThreshold: STALE_DAYS, users: rows }, 'Org push health'));
});

/**
 * POST /api/crm/timeproof/push/nudge/:userId
 */
export const nudgeEnableNotifications = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Only admins/managers can send this reminder');
  }

  const { userId } = req.params;
  const target = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId, isActive: true })
    .select('fullName')
    .lean();
  if (!target) throw new ApiError(404, 'User not found in your organization');

  await notificationService.createNotification({
    userId,
    organizationId: requestor.organizationId.toString(),
    type: 'reminder',
    title: 'Please check your notification settings',
    message: `Hi ${target.fullName}, we noticed you may not be receiving push notifications. Please check your device/browser notification permissions and re-enable them so you don't miss important messages.`,
    metadata: { route: '/crm/settings', pushSource: 'Suprah' },
    dedupeKey: `push-nudge:${userId}`,
    groupWindowMinutes: 60,
  });

  res.json(new ApiResponse(200, { sent: true }, `Reminder sent to ${target.fullName}`));
});

/**
 * POST /api/crm/timeproof/activity-interval
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

  const CLOCK_DRIFT_TOLERANCE_MS = 60 * 60 * 1000;
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
 */
export const postClientDiagnostic = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const { event, message, meta } = req.body;

  if (!event || typeof event !== 'string') {
    throw new ApiError(400, 'event is required');
  }

  const isIdleDiagnosticEvent = event === 'idle_detected' || event === 'idle_periodic_check';
  if (isIdleDiagnosticEvent && await isIdleDetectionExemptDept(user.organizationId?.toString(), user.department)) {
    res.json(new ApiResponse(200, {}, 'Skipped (idle-detection-exempt department)'));
    return;
  }

  logger.warn(
    {
      context: 'tray-client-diagnostic',
      req: { userId: user._id.toString(), organizationId: user.organizationId?.toString() },
      event,
      meta,
    },
    message || event,
  );

  res.json(new ApiResponse(200, {}, 'Logged'));
});

/**
 * GET /api/crm/timeproof/user/:userId/idle-diagnostics?date=YYYY-MM-DD
 */
export const getUserIdleDiagnostics = asyncHandler(async (req: Request, res: Response) => {
  const requestor = req.crmUser!;
  if (!['admin', 'manager'].includes(requestor.role)) {
    throw new ApiError(403, 'Access denied — admin or manager role required');
  }
  const { userId } = req.params;
  const { date: dateStr } = req.query;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr as string)) {
    throw new ApiError(400, 'date is required (YYYY-MM-DD)');
  }

  const targetUser = await CrmUser.findOne({ _id: userId, organizationId: requestor.organizationId }).select('department organizationId').lean();
  if (!targetUser) throw new ApiError(404, 'User not found');

  const { start, end } = getCompanyDayRange(dateStr as string);

  const logs = await SystemLog.find({
    event: { $in: ['idle_detected', 'idle_periodic_check'] },
    'req.userId': userId,
    timestamp: { $gte: start, $lte: end },
  })
    .sort({ timestamp: -1 })
    .select('timestamp event meta')
    .lean();

  const entries = logs.map((l) => ({
    at: l.timestamp,
    event: l.event,
    idleSeconds: l.meta?.idleSeconds ?? null,
    idleSecondsHistory: l.meta?.idleSecondsHistory ?? [],
    idleDetectionExempt: l.meta?.idleDetectionExempt ?? null,
    platform: l.meta?.platform ?? null,
    wasTracking: l.meta?.wasTracking ?? null,
  }));

  const idleExempt = await isIdleDetectionExemptDept(targetUser.organizationId?.toString(), targetUser.department);
  const filteredEntries = idleExempt ? [] : entries;

  res.json(new ApiResponse(200, { entries: filteredEntries }, 'Idle diagnostics fetched'));
});

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

const AUTO_SILENCE_CLOCKOUT_NOTES = [
  'Auto clock-out — device went idle/offline after rendering 8+ hours',
  'Auto clock-out — device went idle/offline for 30+ minutes',
];

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

  const isOnShift = timeIns.length > timeOuts.length;
  const hasClockOutToday = timeOuts.length > 0;
  const resumable = !isOnShift && hasClockOutToday;

  const originalClockIn = resumable && timeIns.length > 0
    ? new Date(timeIns[0].timestamp).toISOString()
    : null;

  const lastTimeOut = resumable ? timeOuts[timeOuts.length - 1] : null;
  const canSeamlessResume = !!lastTimeOut && AUTO_SILENCE_CLOCKOUT_NOTES.includes((lastTimeOut as any).note);

  res.json(new ApiResponse(200, { resumable, originalClockIn, canSeamlessResume }, 'Resumable shift checked'));
});

export const resumeShift = asyncHandler(async (req: Request, res: Response) => {
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
  const isOnShift = timeIns.length > timeOuts.length;
  if (isOnShift) throw new ApiError(400, 'Already on shift');
  if (timeOuts.length === 0) throw new ApiError(400, 'No shift to resume today');

  const lastTimeOut = todayLogs[todayLogs.length - 1];
  if (lastTimeOut.type !== 'time-out' || !AUTO_SILENCE_CLOCKOUT_NOTES.includes((lastTimeOut as any).note)) {
    throw new ApiError(400, 'This shift was not auto-ended and cannot be seamlessly resumed');
  }

  await TimeLog.deleteOne({ _id: lastTimeOut._id });

  const originalTimeIn = timeIns[timeIns.length - 1];
  try {
    getSocketIO()?.to(`user:${user._id.toString()}`).emit('time-in', {
      _id: originalTimeIn._id,
      type: 'time-in',
      timestamp: originalTimeIn.timestamp,
      shiftStartedAt: originalTimeIn.timestamp,
    });
  } catch {
  }

  res.json(new ApiResponse(200, { resumed: true, shiftStartedAt: originalTimeIn.timestamp }, 'Shift resumed'));
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
  resumeShift,
  getAdminDayLogs,
  adminTimeOverride,
  submitScreenshot,
  getScreenshots,
  getBlurredScreenshot,
  deleteMyScreenshot,
  wipeAllScreenshotsHandler,
  subscribeCrmPush,
  unsubscribeCrmPush,
  getCrmPushStatus,
};