import { IPulseComponents, bandForScore, PulseBand } from '../models/PulseHealth.model';
import { PulseTask, isTaskOverdue, hoursUntilDue } from './pulse360.taskAdapter';

/**
 * Suprah Pulse360 — scoring engine.
 *
 * Deliberately pure: every function here takes plain data and returns numbers.
 * No database, no clock beyond an injectable `now`. That keeps the scoring
 * rules readable, unit-testable, and cheap enough to run for a whole org on a
 * five-minute cadence.
 *
 * Every component returns 0..1. The service applies org weights and scales to
 * 0..100.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface AttendanceInput {
  /** Distinct days with a time-in inside the window. */
  daysAttended: number;
  /** Days the user was actually expected (window minus approved absences). */
  daysExpected: number;
  /** Total break minutes on the current shift. */
  breakMinutesToday: number;
  breakLimitMinutes: number;
  /** Shifts in the window that ended before the 8h minimum. */
  shortShifts: number;
}

export function scoreAttendance(input: AttendanceInput): number {
  const expected = Math.max(input.daysExpected, 1);
  const presence = clamp01(input.daysAttended / expected);

  // Break overrun is a soft penalty — being 10 minutes over is not the same
  // failure as not showing up, and shouldn't be scored like it.
  const overrun = Math.max(0, input.breakMinutesToday - input.breakLimitMinutes);
  const breakPenalty = clamp01(overrun / 60) * 0.15;

  const shortShiftPenalty = clamp01(input.shortShifts / expected) * 0.2;

  return clamp01(presence - breakPenalty - shortShiftPenalty);
}

export interface TaskCompletionInput {
  completedInWindow: number;
  openTasks: number;
  /** Tasks that entered the user's queue during the window. */
  assignedInWindow: number;
}

export function scoreTaskCompletion(input: TaskCompletionInput): number {
  const { completedInWindow, openTasks, assignedInWindow } = input;

  // Nobody assigned anything. That's not the employee's failure, so a neutral
  // score rather than a zero — otherwise every user in a department that
  // doesn't use the task board reads as "critical" forever.
  if (assignedInWindow === 0 && openTasks === 0) return 0.75;

  const throughput = assignedInWindow > 0 ? completedInWindow / assignedInWindow : 0;

  // Backlog pressure: a growing pile of open work drags the score even when
  // throughput looks fine.
  const backlogPenalty = clamp01((openTasks - 5) / 20) * 0.25;

  // Cap throughput at 1 so clearing an old backlog can't inflate past perfect.
  return clamp01(Math.min(throughput, 1) - backlogPenalty);
}

export interface TimelinessInput {
  overdueTasks: number;
  openTasks: number;
  /** Of tasks completed in the window, how many landed on or before due. */
  onTimeCompletions: number;
  completedWithDueDate: number;
  /** Hours past due on the single worst overdue item. */
  worstOverdueHours: number;
}

export function scoreTimeliness(input: TimelinessInput): number {
  const { overdueTasks, openTasks, onTimeCompletions, completedWithDueDate, worstOverdueHours } = input;

  if (openTasks === 0 && completedWithDueDate === 0) return 0.75;

  const onTimeRate = completedWithDueDate > 0 ? onTimeCompletions / completedWithDueDate : 1;

  // Each overdue item costs real score; the ratio alone under-reads a user
  // with 30 open tasks and 6 overdue.
  const overdueRatio = openTasks > 0 ? overdueTasks / openTasks : 0;
  const overduePenalty = clamp01(overdueRatio) * 0.6 + clamp01(overdueTasks / 10) * 0.2;

  // One item a week late is worse than three items an hour late.
  const agePenalty = clamp01(worstOverdueHours / (14 * 24)) * 0.2;

  return clamp01(onTimeRate - overduePenalty - agePenalty);
}

export interface EngagementInput {
  /** Sum of signal weights in the window, passive signals included. */
  weightedPoints: number;
  /** Distinct modules touched. Breadth guards against one-tab busywork. */
  distinctModules: number;
  /** Hours actually clocked in during the window. */
  activeHours: number;
  /** Minutes since the last non-passive signal, null if never. */
  minutesSinceMeaningfulWork: number | null;
  idleWarningMinutes: number;
  isOnShift: boolean;
}

export function scoreEngagement(input: EngagementInput): number {
  const { weightedPoints, distinctModules, activeHours, minutesSinceMeaningfulWork, idleWarningMinutes, isOnShift } =
    input;

  // Points per clocked hour, normalised against a target of 12 — roughly a
  // handful of real actions plus normal navigation each hour.
  const hours = Math.max(activeHours, 1);
  const density = clamp01(weightedPoints / hours / 12);

  const breadth = clamp01(distinctModules / 4);

  // Recency only counts against someone who is currently on the clock. Being
  // quiet at 9pm off-shift is not a productivity problem.
  let recency = 1;
  if (isOnShift) {
    if (minutesSinceMeaningfulWork === null) recency = 0.3;
    else recency = clamp01(1 - minutesSinceMeaningfulWork / (idleWarningMinutes * 2));
  }

  return clamp01(density * 0.45 + breadth * 0.2 + recency * 0.35);
}

export interface ResponsivenessInput {
  /** Median hours between assignment and first touch, null if no samples. */
  medianFirstTouchHours: number | null;
  targetFirstTouchHours: number;
  /** Alerts acknowledged vs alerts delivered in the window. */
  alertsAcknowledged: number;
  alertsDelivered: number;
  /** Approvals still sitting past SLA. */
  approvalsBreached: number;
}

export function scoreResponsiveness(input: ResponsivenessInput): number {
  const { medianFirstTouchHours, targetFirstTouchHours, alertsAcknowledged, alertsDelivered, approvalsBreached } =
    input;

  const touch =
    medianFirstTouchHours === null
      ? 0.75
      : clamp01(1 - Math.max(0, medianFirstTouchHours - targetFirstTouchHours) / (targetFirstTouchHours * 3));

  const ackRate = alertsDelivered > 0 ? clamp01(alertsAcknowledged / alertsDelivered) : 0.85;

  const approvalPenalty = clamp01(approvalsBreached / 5) * 0.3;

  return clamp01(touch * 0.55 + ackRate * 0.45 - approvalPenalty);
}

export interface CompositeInput {
  components: IPulseComponents;
  weights: { attendance: number; taskCompletion: number; timeliness: number; engagement: number; responsiveness: number };
}

export interface CompositeResult {
  score: number;
  band: PulseBand;
  /** Component contributions in points, for the segmented ring in the UI. */
  contributions: Record<keyof IPulseComponents, number>;
}

export function composite(input: CompositeInput): CompositeResult {
  const { components, weights } = input;
  const totalWeight =
    weights.attendance + weights.taskCompletion + weights.timeliness + weights.engagement + weights.responsiveness || 1;

  const contributions = {
    attendance: (components.attendance * weights.attendance * 100) / totalWeight,
    taskCompletion: (components.taskCompletion * weights.taskCompletion * 100) / totalWeight,
    timeliness: (components.timeliness * weights.timeliness * 100) / totalWeight,
    engagement: (components.engagement * weights.engagement * 100) / totalWeight,
    responsiveness: (components.responsiveness * weights.responsiveness * 100) / totalWeight,
  };

  const score = Math.round(
    contributions.attendance +
      contributions.taskCompletion +
      contributions.timeliness +
      contributions.engagement +
      contributions.responsiveness
  );

  return { score, band: bandForScore(score), contributions };
}

/** Median helper that returns null for an empty sample rather than NaN. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Task-derived inputs, computed once and shared by several components. */
export function summarizeTasks(tasks: PulseTask[], windowStart: Date, now = new Date()) {
  const open = tasks.filter((t) => !t.isDone);
  const overdue = open.filter((t) => isTaskOverdue(t, now));
  const dueSoon = open.filter((t) => {
    const h = hoursUntilDue(t, now);
    return h !== null && h >= 0 && h <= 72;
  });

  const completedInWindow = tasks.filter(
    (t) => t.isDone && t.completedAt && t.completedAt >= windowStart
  );
  const completedWithDue = completedInWindow.filter((t) => t.dueAt);
  const onTime = completedWithDue.filter((t) => t.completedAt! <= t.dueAt!);

  const assignedInWindow = tasks.filter((t) => t.createdAt && t.createdAt >= windowStart).length;

  const worstOverdueHours = overdue.reduce((worst, t) => {
    const h = -(hoursUntilDue(t, now) ?? 0);
    return h > worst ? h : worst;
  }, 0);

  const projects = new Set(open.map((t) => t.projectId).filter(Boolean));

  return {
    open,
    overdue,
    dueSoon,
    completedInWindow,
    completedWithDue,
    onTime,
    assignedInWindow,
    worstOverdueHours,
    activeProjects: projects.size,
    onTimeCompletionRate: completedWithDue.length ? onTime.length / completedWithDue.length : 0,
  };
}

export default {
  scoreAttendance,
  scoreTaskCompletion,
  scoreTimeliness,
  scoreEngagement,
  scoreResponsiveness,
  composite,
  median,
  summarizeTasks,
};
