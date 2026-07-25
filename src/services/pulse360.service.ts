import mongoose from 'mongoose';
import PulseSignal, { IPulseSignal, PulseSignalType } from '../models/PulseSignal.model';
import PulseAlert, { IPulseAlert, PulsePriority, PULSE_SEVERITY } from '../models/PulseAlert.model';
import PulseHealth, { IPulseHealth, bandForScore } from '../models/PulseHealth.model';
import PulseSetting, { IPulseSetting, PULSE_DEFAULTS } from '../models/PulseSetting.model';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import { getSocketIO } from '../utils/socketEmitter';
import { buildSessions, buildBreakSessions } from '../utils/timeLogEngine';
import CrmPushService from '../services/crmPush.service';
import logger from '../utils/logger';
import scoring from './pulse360.scoring';
import taskAdapter, { PulseTask, urgencyScore, hoursUntilDue } from './pulse360.taskAdapter';

/**
 * Suprah Pulse360 — core service.
 *
 * Responsibilities:
 *   • ingest signals (cheap, fire-and-forget)
 *   • compute Work Health Scores
 *   • raise / escalate / close alerts with dedupe + suppression
 *   • build the org-level operational overview
 *   • push everything over the existing Socket.io infrastructure
 *
 * Rule of thumb followed throughout: request-path work is O(1) writes, and
 * anything that scans is done by the scheduler in jobs/pulse360.scheduler.ts.
 */

const COMPANY_TZ_OFFSET_MINUTES = -360; // MDT, matching crm.controller.ts
const SETTINGS_TTL_MS = 60_000;
const HEALTH_TREND_CAP = 60;

// ── Socket rooms ────────────────────────────────────────────────────────────
// `user:{id}` already exists and is already joined by every client, so
// per-user delivery needs no new plumbing. The org room is new and is joined
// explicitly by managers via socket/pulse360.socket.ts.
export const pulseOrgRoom = (orgId: string) => `pulse:org:${orgId}`;
export const pulseUserRoom = (userId: string) => `user:${userId}`;

// ── Settings ────────────────────────────────────────────────────────────────

const settingsCache = new Map<string, { at: number; value: IPulseSetting }>();

export async function getSettings(organizationId: string): Promise<IPulseSetting> {
  const cached = settingsCache.get(organizationId);
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;

  let doc = await PulseSetting.findOne({ organizationId });
  if (!doc) {
    doc = await PulseSetting.create({ organizationId });
  }

  settingsCache.set(organizationId, { at: Date.now(), value: doc });
  return doc;
}

export function invalidateSettings(organizationId: string) {
  settingsCache.delete(organizationId);
}

/** Effective thresholds for a user, applying any department override. */
export function thresholdsFor(settings: IPulseSetting, department?: string | null) {
  const base = settings.thresholds ?? PULSE_DEFAULTS.thresholds;
  if (!department) return base;
  const override = (settings.departmentOverrides ?? {})[department];
  return override ? { ...base, ...override } : base;
}

export function isMonitored(settings: IPulseSetting, department?: string | null): boolean {
  if (!settings.enabled) return false;
  if (!department) return true;
  if ((settings.exemptDepartments ?? []).includes(department)) return false;
  const override = (settings.departmentOverrides ?? {})[department];
  return override?.enabled !== false;
}

// ── Time helpers ────────────────────────────────────────────────────────────

/** Start of "today" in company time, expressed as a UTC Date. */
export function companyDayStart(ref = new Date()): Date {
  const shifted = new Date(ref.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const dayStr = shifted.toISOString().split('T')[0];
  return new Date(new Date(`${dayStr}T00:00:00.000Z`).getTime() - COMPANY_TZ_OFFSET_MINUTES * 60_000);
}

export function companyHour(ref = new Date()): number {
  return new Date(ref.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000).getUTCHours();
}

// ── Signals ─────────────────────────────────────────────────────────────────

export interface RecordSignalInput {
  organizationId: string | mongoose.Types.ObjectId;
  userId: string | mongoose.Types.ObjectId;
  userModel?: 'CrmUser' | 'User';
  department?: string | null;
  type: PulseSignalType;
  module: string;
  title: string;
  description?: string;
  refType?: string;
  refId?: string;
  url?: string;
  weight?: number;
  passive?: boolean;
  meta?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Default weights by signal type. Passive navigation is intentionally near
 * zero-value so that clicking around the CRM all afternoon never scores like
 * finishing work.
 */
const SIGNAL_WEIGHTS: Partial<Record<PulseSignalType, number>> = {
  'crm.navigation': 1,
  'crm.mutation': 4,
  'task.created': 5,
  'task.assigned': 2,
  'task.status_changed': 6,
  'task.completed': 12,
  'task.commented': 5,
  'task.attachment': 5,
  'project.milestone': 10,
  'approval.granted': 8,
  'approval.rejected': 8,
  'document.updated': 6,
  'customer.interaction': 8,
  'lead.touched': 6,
  'deal.moved': 8,
  'message.sent': 3,
  'feed.posted': 3,
  'attendance.time_in': 4,
  'attendance.time_out': 2,
};

/** Signal types that count as *real work* for idle detection. */
export const MEANINGFUL_SIGNALS: PulseSignalType[] = [
  'crm.mutation',
  'task.created',
  'task.status_changed',
  'task.completed',
  'task.commented',
  'task.attachment',
  'project.milestone',
  'approval.granted',
  'approval.rejected',
  'document.updated',
  'customer.interaction',
  'lead.touched',
  'deal.moved',
  'message.sent',
  'feed.posted',
];

export async function recordSignal(input: RecordSignalInput): Promise<IPulseSignal | null> {
  try {
    if (!input.organizationId || !input.userId) return null;

    const signal = await PulseSignal.create({
      organizationId: input.organizationId,
      userId: input.userId,
      userModel: input.userModel ?? 'CrmUser',
      department: input.department ?? null,
      type: input.type,
      module: input.module,
      title: input.title,
      description: input.description,
      refType: input.refType,
      refId: input.refId,
      url: input.url,
      weight: input.weight ?? SIGNAL_WEIGHTS[input.type] ?? 1,
      passive: input.passive ?? false,
      meta: input.meta,
      occurredAt: input.occurredAt ?? new Date(),
    });

    // Progress on a thing closes any open alert about that thing. This is what
    // makes "recurring until resolved" resolve without the user ever clicking
    // a dismiss button.
    if (input.refId && MEANINGFUL_SIGNALS.includes(input.type)) {
      void closeAlertsForRef(String(input.organizationId), input.refType, input.refId, 'progress detected');
    }

    // Live timeline for anyone watching this user in the dashboard.
    emitToOrg(String(input.organizationId), 'pulse:signal', {
      userId: String(input.userId),
      type: signal.type,
      module: signal.module,
      title: signal.title,
      url: signal.url,
      occurredAt: signal.occurredAt,
    });

    return signal;
  } catch (error) {
    // Never let telemetry break a real request.
    console.error('[PULSE360] recordSignal failed:', error);
    return null;
  }
}

// ── Socket emitters ─────────────────────────────────────────────────────────

export function emitToUser(userId: string, event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (io) io.to(pulseUserRoom(userId)).emit(event, payload);
  } catch (error) {
    console.error('[PULSE360] emitToUser failed:', error);
  }
}

export function emitToOrg(organizationId: string, event: string, payload: unknown) {
  try {
    const io = getSocketIO();
    if (io) io.to(pulseOrgRoom(organizationId)).emit(event, payload);
  } catch (error) {
    console.error('[PULSE360] emitToOrg failed:', error);
  }
}

// ── Alerts ──────────────────────────────────────────────────────────────────

export interface RaiseAlertInput {
  organizationId: string;
  userId: string;
  userModel?: 'CrmUser' | 'User';
  department?: string | null;
  kind: string;
  priority: PulsePriority;
  title: string;
  reason: string;
  recommendedAction: string;
  actionUrl?: string;
  actionLabel?: string;
  refType?: string;
  refId?: string;
  /** Defaults to `${kind}:${refId ?? userId}`. */
  dedupeKey?: string;
  expiresAt?: Date;
  context?: Record<string, unknown>;
  raisedBy?: string;
  /** Escalate priority if the concern re-fires while still open. */
  escalateTo?: PulsePriority;
}

/**
 * Raise or escalate an alert.
 *
 * Re-firing an open alert does NOT create a second row and does NOT re-notify
 * unless the cooldown has elapsed or the priority actually climbed. This is
 * the whole anti-spam story in one function.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<IPulseAlert | null> {
  try {
    const settings = await getSettings(input.organizationId);
    if (!isMonitored(settings, input.department)) return null;

    const dedupeKey = input.dedupeKey ?? `${input.kind}:${input.refId ?? input.userId}`;
    const now = new Date();

    const existing = await PulseAlert.findOne({
      organizationId: input.organizationId,
      dedupeKey,
      isOpen: true,
    });

    if (existing) {
      const escalating =
        !!input.escalateTo && PULSE_SEVERITY[input.escalateTo] > existing.severity;
      const cooledDown =
        now.getTime() - existing.lastFiredAt.getTime() >
        (settings.notifications?.cooldownMinutes ?? 90) * 60_000;

      // A snooze that has expired puts the alert back in play.
      const snoozeExpired = existing.status === 'snoozed' && existing.snoozedUntil && existing.snoozedUntil <= now;

      if (!escalating && !cooledDown && !snoozeExpired) {
        return existing; // suppressed — still open, just not re-announced
      }

      existing.occurrences += 1;
      existing.lastFiredAt = now;
      existing.reason = input.reason;
      existing.recommendedAction = input.recommendedAction;
      existing.context = input.context ?? existing.context;
      if (escalating && input.escalateTo) {
        existing.priority = input.escalateTo;
        existing.severity = PULSE_SEVERITY[input.escalateTo];
      }
      if (snoozeExpired || existing.status === 'snoozed') {
        existing.status = 'pending';
        existing.snoozedUntil = undefined;
      }
      await existing.save();

      await deliverAlert(existing, settings);
      return existing;
    }

    const created = await PulseAlert.create({
      organizationId: input.organizationId,
      userId: input.userId,
      userModel: input.userModel ?? 'CrmUser',
      department: input.department ?? null,
      kind: input.kind,
      priority: input.priority,
      severity: PULSE_SEVERITY[input.priority],
      title: input.title,
      reason: input.reason,
      recommendedAction: input.recommendedAction,
      actionUrl: input.actionUrl,
      actionLabel: input.actionLabel,
      refType: input.refType,
      refId: input.refId,
      dedupeKey,
      status: 'pending',
      isOpen: true,
      firstFiredAt: now,
      lastFiredAt: now,
      expiresAt: input.expiresAt,
      context: input.context,
      raisedBy: input.raisedBy,
    });

    await recordSignal({
      organizationId: input.organizationId,
      userId: input.userId,
      department: input.department,
      type: 'pulse.alert_raised',
      module: 'Pulse360',
      title: input.title,
      description: input.reason,
      refType: 'PulseAlert',
      refId: String(created._id),
      url: input.actionUrl,
      weight: 0,
      passive: true,
    });

    await deliverAlert(created, settings);
    return created;
  } catch (error: any) {
    // A duplicate-key race means a concurrent sweep already raised it, which
    // is exactly the outcome we wanted anyway.
    if (error?.code === 11000) return null;
    console.error('[PULSE360] raiseAlert failed:', error);
    return null;
  }
}

/** Quiet hours suppress popups but never suppress the alert itself. */
function inQuietHours(settings: IPulseSetting, ref = new Date()): boolean {
  const hour = companyHour(ref);
  const start = settings.notifications?.quietHoursStart ?? 20;
  const end = settings.notifications?.quietHoursEnd ?? 7;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

async function deliverAlert(alert: IPulseAlert, settings: IPulseSetting) {
  const minSeverity = settings.notifications?.popupMinSeverity ?? 50;
  const quiet = inQuietHours(settings);

  // Critical and escalation always break through quiet hours; nothing else does.
  const breaksThrough = alert.severity >= PULSE_SEVERITY.critical;
  const shouldPopup = alert.severity >= minSeverity && (!quiet || breaksThrough);

  alert.status = 'delivered';
  alert.deliveredAt = new Date();
  await alert.save();

  emitToUser(String(alert.userId), 'pulse:alert', {
    alert: serializeAlert(alert),
    popup: shouldPopup,
  });

  emitToOrg(String(alert.organizationId), 'pulse:alert:org', {
    alert: serializeAlert(alert),
  });

  if (settings.notifications?.webPushEnabled && alert.severity >= PULSE_SEVERITY.deadline) {
    try {
      // sendToUsers takes an array — a single-element array is the one-user case.
      await CrmPushService.sendToUsers([String(alert.userId)], {
        title: alert.title,
        body: alert.reason,
        url: alert.actionUrl || '/crm/pulse360',
        tag: `pulse360-${alert.dedupeKey}`,
        topic: `pulse360-${alert.dedupeKey}`,
        source: 'Pulse360',
      });
    } catch (err) {
      // Push is best-effort — the in-app popup is the primary channel — but
      // still log it. Pulse360 alerts have no fallback bell/list entry (they
      // live only in the PulseAlert collection + this push), so a silently
      // swallowed failure here means the alert is genuinely lost for anyone
      // whose app isn't open, with zero trace to debug from.
      logger.error({ err, userId: String(alert.userId), alertId: String(alert._id) }, '[Pulse360] Push delivery failed');
    }
  }
}

export function serializeAlert(alert: IPulseAlert) {
  return {
    _id: String(alert._id),
    kind: alert.kind,
    priority: alert.priority,
    severity: alert.severity,
    title: alert.title,
    reason: alert.reason,
    recommendedAction: alert.recommendedAction,
    actionUrl: alert.actionUrl,
    actionLabel: alert.actionLabel,
    refType: alert.refType,
    refId: alert.refId,
    status: alert.status,
    occurrences: alert.occurrences,
    firstFiredAt: alert.firstFiredAt,
    lastFiredAt: alert.lastFiredAt,
    snoozedUntil: alert.snoozedUntil,
    context: alert.context ?? {},
    userId: String(alert.userId),
    department: alert.department,
  };
}

/** Close every open alert pointing at a resource. Used when progress lands. */
export async function closeAlertsForRef(
  organizationId: string,
  refType: string | undefined,
  refId: string,
  reason: string
) {
  const query: any = { organizationId, refId, isOpen: true };
  if (refType) query.refType = refType;

  const alerts = await PulseAlert.find(query);
  for (const alert of alerts) {
    alert.status = 'resolved';
    alert.isOpen = false;
    alert.resolvedAt = new Date();
    alert.context = { ...(alert.context ?? {}), resolvedBecause: reason };
    await alert.save();
    emitToUser(String(alert.userId), 'pulse:alert:resolved', { alertId: String(alert._id) });
    emitToOrg(organizationId, 'pulse:alert:resolved', { alertId: String(alert._id), userId: String(alert.userId) });
  }
  return alerts.length;
}

export async function closeAlertsByKind(organizationId: string, userId: string, kind: string, reason: string) {
  const alerts = await PulseAlert.find({ organizationId, userId, kind, isOpen: true });
  for (const alert of alerts) {
    alert.status = 'resolved';
    alert.isOpen = false;
    alert.resolvedAt = new Date();
    alert.context = { ...(alert.context ?? {}), resolvedBecause: reason };
    await alert.save();
    emitToUser(userId, 'pulse:alert:resolved', { alertId: String(alert._id) });
  }
  return alerts.length;
}

// ── Attendance facts ────────────────────────────────────────────────────────

export interface AttendanceFacts {
  isOnShift: boolean;
  isOnBreak: boolean;
  shiftStartedAt: Date | null;
  breakStartedAt: Date | null;
  shiftMinutesToday: number;
  breakMinutesToday: number;
  daysAttended: number;
  shortShifts: number;
}

/**
 * Walks TimeLog chronologically, exactly like getMe/getShiftState do, so
 * Pulse360's idea of "on shift" can never disagree with the TimeProof Clock's.
 */
export async function getAttendanceFacts(userId: string, windowStart: Date): Promise<AttendanceFacts> {
  const dayStart = companyDayStart();
  // Two-day lookback so an overnight shift still reads as open.
  const lookback = new Date(dayStart.getTime() - 2 * 86_400_000);
  const from = windowStart < lookback ? windowStart : lookback;

  const logs = await TimeLog.find({ userId, timestamp: { $gte: from } })
    .sort({ timestamp: 1 })
    .lean();

  let isOnShift = false;
  let isOnBreak = false;
  let shiftStartedAt: Date | null = null;
  let breakStartedAt: Date | null = null;

  for (const log of logs) {
    if (log.type === 'time-in') {
      isOnShift = true;
      shiftStartedAt = log.timestamp;
    } else if (log.type === 'time-out') {
      isOnShift = false;
      isOnBreak = false;
      shiftStartedAt = null;
      breakStartedAt = null;
    } else if (log.type === 'break-in') {
      isOnBreak = true;
      breakStartedAt = log.timestamp;
    } else if (log.type === 'break-out') {
      isOnBreak = false;
      breakStartedAt = null;
    }
  }

  const sessionStart = shiftStartedAt ?? dayStart;

  const todayWorkLogs = logs.filter((l) => l.timestamp >= dayStart && (l.type === 'time-in' || l.type === 'time-out'));
  const shiftSeconds = buildSessions(todayWorkLogs).reduce((sum: number, s: any) => sum + (s.out ? s.duration : 0), 0);
  const liveSeconds = isOnShift && shiftStartedAt ? (Date.now() - Math.max(shiftStartedAt.getTime(), dayStart.getTime())) / 1000 : 0;

  const breakLogs = logs.filter(
    (l) => (l.type === 'break-in' || l.type === 'break-out') && l.timestamp >= sessionStart
  );
  const breakSeconds = buildBreakSessions(breakLogs).reduce((sum: number, b: any) => sum + (b.out ? b.duration : 0), 0);
  const liveBreakSeconds = isOnBreak && breakStartedAt ? (Date.now() - breakStartedAt.getTime()) / 1000 : 0;

  // Distinct company-days with a time-in inside the window.
  const attendedDays = new Set(
    logs
      .filter((l) => l.type === 'time-in' && l.timestamp >= windowStart)
      .map((l) => new Date(l.timestamp.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000).toISOString().split('T')[0])
  );

  const windowSessions = buildSessions(
    logs.filter((l) => l.timestamp >= windowStart && (l.type === 'time-in' || l.type === 'time-out'))
  );
  const shortShifts = windowSessions.filter((s: any) => s.out && s.duration < 8 * 3600).length;

  return {
    isOnShift,
    isOnBreak,
    shiftStartedAt,
    breakStartedAt,
    shiftMinutesToday: Math.round((shiftSeconds + liveSeconds) / 60),
    breakMinutesToday: Math.round((breakSeconds + liveBreakSeconds) / 60),
    daysAttended: attendedDays.size,
    shortShifts,
  };
}

// ── Health computation ──────────────────────────────────────────────────────

export interface ComputeHealthOptions {
  /** Skip the socket emit when recomputing a whole org in a loop. */
  silent?: boolean;
}

export async function computeUserHealth(
  organizationId: string,
  userId: string,
  options: ComputeHealthOptions = {}
): Promise<IPulseHealth | null> {
  const settings = await getSettings(organizationId);
  const user = await CrmUser.findById(userId).select('fullName email avatar role department organizationId isActive').lean();
  if (!user || !user.isActive) return null;
  if (!isMonitored(settings, user.department)) return null;

  const limits = thresholdsFor(settings, user.department);
  const windowDays = settings.windowDays ?? PULSE_DEFAULTS.windowDays;
  const windowStart = new Date(Date.now() - windowDays * 86_400_000);
  const now = new Date();

  const [tasks, attendance, signals, alertStats] = await Promise.all([
    taskAdapter.getTasksForUser(organizationId, userId, { includeCompletedSince: windowStart }),
    getAttendanceFacts(userId, windowStart),
    PulseSignal.find({ organizationId, userId, occurredAt: { $gte: windowStart } })
      .select('type module weight passive occurredAt refId refType')
      .lean(),
    PulseAlert.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          open: { $sum: { $cond: ['$isOpen', 1, 0] } },
          critical: { $sum: { $cond: [{ $and: ['$isOpen', { $gte: ['$severity', PULSE_SEVERITY.critical] }] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $gte: ['$deliveredAt', windowStart] }, 1, 0] } },
          acknowledged: { $sum: { $cond: [{ $gte: ['$acknowledgedAt', windowStart] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const taskSummary = scoring.summarizeTasks(tasks, windowStart, now);
  const alerts = alertStats[0] ?? { open: 0, critical: 0, delivered: 0, acknowledged: 0 };

  const meaningful = signals.filter((s: any) => !s.passive && MEANINGFUL_SIGNALS.includes(s.type));
  const lastMeaningful = meaningful.length ? meaningful[meaningful.length - 1].occurredAt : null;
  const lastAny = signals.length ? signals[signals.length - 1].occurredAt : null;

  const minutesSinceMeaningfulWork = lastMeaningful
    ? Math.round((now.getTime() - new Date(lastMeaningful).getTime()) / 60_000)
    : null;

  const weightedPoints = signals.reduce((sum: number, s: any) => sum + (s.weight ?? 1), 0);
  const distinctModules = new Set(signals.map((s: any) => s.module)).size;

  // First-touch latency: gap between a task being created and the first signal
  // that references it.
  const firstTouchByRef = new Map<string, Date>();
  for (const s of signals as any[]) {
    if (!s.refId || s.passive) continue;
    const existing = firstTouchByRef.get(s.refId);
    if (!existing || new Date(s.occurredAt) < existing) firstTouchByRef.set(s.refId, new Date(s.occurredAt));
  }
  const firstTouchSamples = tasks
    .filter((t) => t.createdAt && firstTouchByRef.has(t.id))
    .map((t) => (firstTouchByRef.get(t.id)!.getTime() - t.createdAt!.getTime()) / 3600_000)
    .filter((h) => h >= 0);
  const medianFirstTouchHours = scoring.median(firstTouchSamples);

  const components = {
    attendance: scoring.scoreAttendance({
      daysAttended: attendance.daysAttended,
      // Weekdays in the window as the expected baseline.
      daysExpected: Math.max(Math.round((windowDays * 5) / 7), 1),
      breakMinutesToday: attendance.breakMinutesToday,
      breakLimitMinutes: limits.breakLimitMinutes,
      shortShifts: attendance.shortShifts,
    }),
    taskCompletion: scoring.scoreTaskCompletion({
      completedInWindow: taskSummary.completedInWindow.length,
      openTasks: taskSummary.open.length,
      assignedInWindow: taskSummary.assignedInWindow,
    }),
    timeliness: scoring.scoreTimeliness({
      overdueTasks: taskSummary.overdue.length,
      openTasks: taskSummary.open.length,
      onTimeCompletions: taskSummary.onTime.length,
      completedWithDueDate: taskSummary.completedWithDue.length,
      worstOverdueHours: taskSummary.worstOverdueHours,
    }),
    engagement: scoring.scoreEngagement({
      weightedPoints,
      distinctModules,
      activeHours: Math.max(attendance.daysAttended * 8, 1),
      minutesSinceMeaningfulWork,
      idleWarningMinutes: limits.idleWarningMinutes,
      isOnShift: attendance.isOnShift,
    }),
    responsiveness: scoring.scoreResponsiveness({
      medianFirstTouchHours,
      targetFirstTouchHours: limits.firstTouchHours,
      alertsAcknowledged: alerts.acknowledged,
      alertsDelivered: alerts.delivered,
      approvalsBreached: 0,
    }),
  };

  const { score, band } = scoring.composite({ components, weights: settings.weights as any });

  const previous = await PulseHealth.findOne({ organizationId, userId });
  const delta = previous ? score - previous.score : 0;

  const workState: IPulseHealth['workState'] = attendance.isOnBreak
    ? 'on_break'
    : attendance.isOnShift
      ? minutesSinceMeaningfulWork !== null && minutesSinceMeaningfulWork > limits.idleWarningMinutes
        ? 'idle'
        : 'working'
      : 'off_shift';

  const trend = [...(previous?.trend ?? []), { at: now, score, band }].slice(-HEALTH_TREND_CAP);

  const health = await PulseHealth.findOneAndUpdate(
    { organizationId, userId },
    {
      $set: {
        organizationId,
        userId,
        userModel: 'CrmUser',
        fullName: user.fullName,
        email: user.email,
        avatar: user.avatar,
        department: user.department,
        role: user.role,
        score,
        band,
        delta,
        components,
        stats: {
          openTasks: taskSummary.open.length,
          overdueTasks: taskSummary.overdue.length,
          dueSoonTasks: taskSummary.dueSoon.length,
          completedInWindow: taskSummary.completedInWindow.length,
          activeProjects: taskSummary.activeProjects,
          openAlerts: alerts.open,
          criticalAlerts: alerts.critical,
          engagementPoints: weightedPoints,
          minutesSinceMeaningfulWork,
          idleMinutesToday: workState === 'idle' ? minutesSinceMeaningfulWork ?? 0 : 0,
          shiftMinutesToday: attendance.shiftMinutesToday,
          daysAttendedInWindow: attendance.daysAttended,
          onTimeCompletionRate: taskSummary.onTimeCompletionRate,
          medianFirstTouchHours,
        },
        workState,
        isOnShift: attendance.isOnShift,
        shiftStartedAt: attendance.shiftStartedAt ?? undefined,
        lastSignalAt: lastAny ?? undefined,
        trend,
        windowDays,
        computedAt: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (!options.silent) {
    emitToUser(userId, 'pulse:health', serializeHealth(health));
    emitToOrg(organizationId, 'pulse:health:org', serializeHealth(health));
  }

  return health;
}

export function serializeHealth(health: IPulseHealth) {
  return {
    userId: String(health.userId),
    fullName: health.fullName,
    email: health.email,
    avatar: health.avatar,
    department: health.department,
    role: health.role,
    score: health.score,
    band: health.band,
    delta: health.delta,
    components: health.components,
    stats: health.stats,
    workState: health.workState,
    isOnShift: health.isOnShift,
    shiftStartedAt: health.shiftStartedAt,
    lastSignalAt: health.lastSignalAt,
    trend: (health.trend ?? []).map((t) => ({ at: t.at, score: t.score })),
    computedAt: health.computedAt,
  };
}

// ── Recommendations ─────────────────────────────────────────────────────────

export interface NextAction {
  taskId: string;
  title: string;
  projectName: string | null;
  dueAt: Date | null;
  hoursUntilDue: number | null;
  priority: PulseTask['priority'];
  urgency: number;
  url: string;
  /** Plain-language justification shown under the recommendation. */
  why: string;
}

export async function getNextBestActions(
  organizationId: string,
  userId: string,
  limit = 3
): Promise<NextAction[]> {
  const tasks = await taskAdapter.getTasksForUser(organizationId, userId);
  const now = new Date();

  return tasks
    .filter((t) => !t.isDone)
    .map((t) => {
      const hours = hoursUntilDue(t, now);
      let why: string;
      if (hours === null) why = 'No deadline set, but it has been sitting in your queue.';
      else if (hours < 0) why = `Overdue by ${Math.round(-hours)}h — this is the oldest thing blocking your score.`;
      else if (hours <= 4) why = `Due in under ${Math.max(1, Math.round(hours))}h.`;
      else if (hours <= 24) why = `Due today, in about ${Math.round(hours)}h.`;
      else why = `Due in ${Math.round(hours / 24)} days.`;

      if (t.priority === 'urgent') why += ' Marked urgent.';

      return {
        taskId: t.id,
        title: t.title,
        projectName: t.projectName,
        dueAt: t.dueAt,
        hoursUntilDue: hours,
        priority: t.priority,
        urgency: Math.round(urgencyScore(t, now)),
        url: t.url,
        why,
      };
    })
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, limit);
}

// ── Org rollup ──────────────────────────────────────────────────────────────

export interface OverviewFilters {
  department?: string;
  band?: string;
  workState?: string;
}

export async function getOrgOverview(organizationId: string, filters: OverviewFilters = {}) {
  const match: any = { organizationId: new mongoose.Types.ObjectId(organizationId) };
  if (filters.department && filters.department !== 'all') match.department = filters.department;
  if (filters.band && filters.band !== 'all') match.band = filters.band;
  if (filters.workState && filters.workState !== 'all') match.workState = filters.workState;

  const [rows, alertRows] = await Promise.all([
    PulseHealth.find(match).lean(),
    PulseAlert.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), isOpen: true } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
  ]);

  const totals = {
    monitored: rows.length,
    working: rows.filter((r) => r.workState === 'working').length,
    onBreak: rows.filter((r) => r.workState === 'on_break').length,
    idle: rows.filter((r) => r.workState === 'idle').length,
    offShift: rows.filter((r) => r.workState === 'off_shift').length,
    withOverdue: rows.filter((r) => (r.stats?.overdueTasks ?? 0) > 0).length,
    atRisk: rows.filter((r) => r.band === 'at_risk' || r.band === 'critical').length,
    openTasks: rows.reduce((s, r) => s + (r.stats?.openTasks ?? 0), 0),
    overdueTasks: rows.reduce((s, r) => s + (r.stats?.overdueTasks ?? 0), 0),
    dueSoonTasks: rows.reduce((s, r) => s + (r.stats?.dueSoonTasks ?? 0), 0),
    completedInWindow: rows.reduce((s, r) => s + (r.stats?.completedInWindow ?? 0), 0),
    averageScore: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0,
  };

  const byDepartment = new Map<
    string,
    { department: string; headcount: number; totalScore: number; overdue: number; idle: number; working: number; atRisk: number }
  >();

  for (const row of rows) {
    const key = row.department || 'unassigned';
    const entry =
      byDepartment.get(key) ??
      { department: key, headcount: 0, totalScore: 0, overdue: 0, idle: 0, working: 0, atRisk: 0 };
    entry.headcount += 1;
    entry.totalScore += row.score;
    entry.overdue += row.stats?.overdueTasks ?? 0;
    if (row.workState === 'idle') entry.idle += 1;
    if (row.workState === 'working') entry.working += 1;
    if (row.band === 'at_risk' || row.band === 'critical') entry.atRisk += 1;
    byDepartment.set(key, entry);
  }

  const departments = Array.from(byDepartment.values())
    .map((d) => ({
      department: d.department,
      headcount: d.headcount,
      averageScore: Math.round(d.totalScore / Math.max(d.headcount, 1)),
      band: bandForScore(Math.round(d.totalScore / Math.max(d.headcount, 1))),
      overdueTasks: d.overdue,
      idle: d.idle,
      working: d.working,
      atRisk: d.atRisk,
    }))
    .sort((a, b) => a.averageScore - b.averageScore);

  const alertsByPriority: Record<string, number> = {};
  for (const row of alertRows) alertsByPriority[row._id] = row.count;

  // Bottlenecks: the specific things a manager should look at first.
  const bottlenecks = rows
    .filter((r) => (r.stats?.overdueTasks ?? 0) > 0 || r.band === 'critical' || r.workState === 'idle')
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map((r) => ({
      userId: String(r.userId),
      fullName: r.fullName,
      avatar: r.avatar,
      department: r.department,
      score: r.score,
      band: r.band,
      workState: r.workState,
      overdueTasks: r.stats?.overdueTasks ?? 0,
      openTasks: r.stats?.openTasks ?? 0,
      reason:
        (r.stats?.overdueTasks ?? 0) > 0
          ? `${r.stats?.overdueTasks} overdue deliverable${(r.stats?.overdueTasks ?? 0) === 1 ? '' : 's'}`
          : r.workState === 'idle'
            ? `No tracked work for ${r.stats?.minutesSinceMeaningfulWork ?? 0} min while on shift`
            : `Health score at ${r.score}`,
    }));

  return {
    totals,
    departments,
    alertsByPriority,
    openAlerts: Object.values(alertsByPriority).reduce((s, n) => s + n, 0),
    bottlenecks,
    users: rows
      .sort((a, b) => a.score - b.score)
      .map((r) => ({
        userId: String(r.userId),
        fullName: r.fullName,
        email: r.email,
        avatar: r.avatar,
        department: r.department,
        role: r.role,
        score: r.score,
        band: r.band,
        delta: r.delta,
        workState: r.workState,
        isOnShift: r.isOnShift,
        stats: r.stats,
        components: r.components,
        computedAt: r.computedAt,
      })),
    computedAt: new Date(),
  };
}

export default {
  getSettings,
  invalidateSettings,
  thresholdsFor,
  isMonitored,
  recordSignal,
  raiseAlert,
  closeAlertsForRef,
  closeAlertsByKind,
  computeUserHealth,
  getNextBestActions,
  getOrgOverview,
  getAttendanceFacts,
  serializeAlert,
  serializeHealth,
  emitToUser,
  emitToOrg,
  companyDayStart,
  companyHour,
};