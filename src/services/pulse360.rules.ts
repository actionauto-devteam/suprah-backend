import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import PulseAlert, { PULSE_SEVERITY } from '../models/PulseAlert.model';
import PulseHealth from '../models/PulseHealth.model';
import { IPulseSetting } from '../models/PulseSetting.model';
import pulse from './pulse360.service';
import taskAdapter, { PulseTask, hoursUntilDue } from './pulse360.taskAdapter';

/**
 * Suprah Pulse360 — rules engine.
 *
 * Each rule is a small async function that inspects context and *may* raise an
 * alert. Two principles hold across all of them:
 *
 *   1. Context before intervention. Inactivity alone is never sufficient — a
 *      user with no assigned work and no deadlines does not get chased for
 *      being quiet. Every rule checks whether there is actually something the
 *      person is failing to do.
 *   2. One concern, one alert. Escalation happens by raising the priority of
 *      the existing row (see raiseAlert), never by adding another row.
 */

// ── Deadlines ───────────────────────────────────────────────────────────────

/**
 * Reminder ladder. For each open task with a due date we work out which rung
 * it currently sits on, and use that rung in the dedupe key so moving from
 * "24h" to "4h" escalates the same alert rather than spawning a new one.
 */
function deadlineRung(hours: number, offsets: number[]): { label: string; priority: 'reminder' | 'deadline' | 'critical' } | null {
  if (hours < 0) return { label: 'overdue', priority: 'critical' };
  const sorted = [...offsets].sort((a, b) => a - b);
  for (const offset of sorted) {
    if (hours <= offset) {
      return {
        label: `${offset}h`,
        priority: offset <= 4 ? 'deadline' : 'reminder',
      };
    }
  }
  return null;
}

function formatDue(task: PulseTask, hours: number): string {
  if (hours < 0) {
    const overdueHours = Math.round(-hours);
    return overdueHours >= 48
      ? `overdue by ${Math.round(overdueHours / 24)} days`
      : `overdue by ${overdueHours}h`;
  }
  if (hours <= 1) return 'due within the hour';
  if (hours <= 24) return `due in ${Math.round(hours)}h`;
  return `due in ${Math.round(hours / 24)} days`;
}

export async function evaluateDeadlines(organizationId: string, settings: IPulseSetting) {
  const offsets = settings.deadlineOffsetsHours?.length
    ? settings.deadlineOffsetsHours
    : [72, 24, 4, 1];
  const horizon = Math.max(...offsets);

  const tasks = await taskAdapter.getUpcomingAndOverdueTasks(organizationId, horizon);
  if (!tasks.length) return 0;

  // Resolve departments once for the whole batch instead of per task.
  const userIds = Array.from(new Set(tasks.flatMap((t) => t.assigneeIds)));
  const users = await CrmUser.find({ _id: { $in: userIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) } })
    .select('department fullName isActive')
    .lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  let raised = 0;

  for (const task of tasks) {
    const hours = hoursUntilDue(task);
    if (hours === null) continue;

    const rung = deadlineRung(hours, offsets);
    if (!rung) continue;

    for (const assigneeId of task.assigneeIds) {
      const user = userMap.get(assigneeId);
      if (!user || user.isActive === false) continue;

      const isOverdue = hours < 0;

      await pulse.raiseAlert({
        organizationId,
        userId: assigneeId,
        department: user.department,
        kind: isOverdue ? 'task.overdue' : 'task.deadline_approaching',
        priority: rung.priority,
        // Escalate as the rung climbs; raiseAlert only acts when severity rises.
        escalateTo: isOverdue ? 'critical' : rung.priority,
        title: isOverdue ? `Overdue: ${task.title}` : `Deadline approaching: ${task.title}`,
        reason: `"${task.title}"${task.projectName ? ` in ${task.projectName}` : ''} is ${formatDue(task, hours)}.`,
        recommendedAction: isOverdue
          ? 'Update the status or move the due date — leaving it silent is what keeps this escalating.'
          : 'Open the task and either finish it or flag a blocker before the deadline lands.',
        actionUrl: task.url,
        actionLabel: 'Open task',
        refType: 'Task',
        refId: task.id,
        // Rung is NOT in the dedupe key — same task, same alert, rising priority.
        dedupeKey: `deadline:${task.id}:${assigneeId}`,
        context: {
          taskTitle: task.title,
          projectName: task.projectName,
          dueAt: task.dueAt,
          hoursUntilDue: Math.round(hours),
          rung: rung.label,
          taskPriority: task.priority,
        },
      });
      raised += 1;
    }
  }

  return raised;
}

// ── Idle during shift ───────────────────────────────────────────────────────

/**
 * The rule most likely to be resented if it's dumb, so it is deliberately
 * conservative: it only fires for someone who is clocked in, off break, has
 * open work waiting, and has produced no meaningful signal for longer than the
 * department's threshold. Quiet with an empty queue is not a problem.
 */
export async function evaluateIdle(organizationId: string, settings: IPulseSetting) {
  const rows = await PulseHealth.find({
    organizationId,
    isOnShift: true,
    workState: { $in: ['working', 'idle'] },
  }).lean();

  let raised = 0;

  for (const row of rows) {
    const limits = pulse.thresholdsFor(settings, row.department);
    const idleMinutes = row.stats?.minutesSinceMeaningfulWork;
    const openTasks = row.stats?.openTasks ?? 0;

    if (idleMinutes === null || idleMinutes === undefined) continue;

    // No assigned responsibilities → nothing to be behind on.
    if (openTasks === 0) {
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'idle.during_shift', 'no open responsibilities');
      continue;
    }

    if (idleMinutes < limits.idleWarningMinutes) {
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'idle.during_shift', 'activity resumed');
      continue;
    }

    const critical = idleMinutes >= limits.idleCriticalMinutes;
    const next = await pulse.getNextBestActions(organizationId, String(row.userId), 1);
    const suggestion = next[0];

    await pulse.raiseAlert({
      organizationId,
      userId: String(row.userId),
      department: row.department,
      kind: 'idle.during_shift',
      priority: 'productivity',
      escalateTo: critical ? 'critical' : 'warning',
      title: critical ? 'No tracked work for a while' : 'Your shift has gone quiet',
      reason: `You have been clocked in with no tracked activity for ${idleMinutes} minutes, and ${openTasks} responsibilit${openTasks === 1 ? 'y is' : 'ies are'} still open.`,
      recommendedAction: suggestion
        ? `Pick up "${suggestion.title}" — ${suggestion.why}`
        : 'Open your task board and move something forward, or start a break if you are stepping away.',
      actionUrl: suggestion?.url ?? '/crm/projects',
      actionLabel: suggestion ? 'Open task' : 'Open my tasks',
      dedupeKey: `idle:${row.userId}:${pulse.companyDayStart().toISOString().slice(0, 10)}`,
      // Today's idle concern is not tomorrow's problem.
      expiresAt: new Date(pulse.companyDayStart().getTime() + 86_400_000),
      context: { idleMinutes, openTasks, suggestion: suggestion ?? null },
    });
    raised += 1;
  }

  return raised;
}

// ── Stalled work ────────────────────────────────────────────────────────────

/** Assigned to a project but nothing has moved on it for N days. */
export async function evaluateStalledWork(organizationId: string, settings: IPulseSetting) {
  const rows = await PulseHealth.find({ organizationId, 'stats.openTasks': { $gt: 0 } }).lean();
  let raised = 0;

  for (const row of rows) {
    const limits = pulse.thresholdsFor(settings, row.department);
    const staleDays = limits.stalledProjectDays;
    const lastMeaningful = row.stats?.minutesSinceMeaningfulWork;

    // minutesSinceMeaningfulWork is null when nothing has ever been recorded.
    const daysSince = lastMeaningful === null || lastMeaningful === undefined ? null : lastMeaningful / (60 * 24);
    if (daysSince === null || daysSince < staleDays) {
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'work.stalled', 'progress recorded');
      continue;
    }

    const next = await pulse.getNextBestActions(organizationId, String(row.userId), 1);

    await pulse.raiseAlert({
      organizationId,
      userId: String(row.userId),
      department: row.department,
      kind: 'work.stalled',
      priority: 'productivity',
      escalateTo: 'warning',
      title: 'No progress recorded on your assigned work',
      reason: `Nothing has moved on your ${row.stats?.openTasks} open item${(row.stats?.openTasks ?? 0) === 1 ? '' : 's'} for ${Math.floor(daysSince)} days, across ${row.stats?.activeProjects ?? 0} active project${(row.stats?.activeProjects ?? 0) === 1 ? '' : 's'}.`,
      recommendedAction: next[0]
        ? `Start with "${next[0].title}" — ${next[0].why}`
        : 'Update the status on your open items so the board reflects reality.',
      actionUrl: next[0]?.url ?? '/crm/projects',
      actionLabel: 'Open my tasks',
      dedupeKey: `stalled:${row.userId}`,
      context: { daysSinceProgress: Math.floor(daysSince), openTasks: row.stats?.openTasks },
    });
    raised += 1;
  }

  return raised;
}

// ── Attendance ──────────────────────────────────────────────────────────────

export async function evaluateAttendance(organizationId: string, settings: IPulseSetting) {
  const hour = pulse.companyHour();
  let raised = 0;

  const rows = await PulseHealth.find({ organizationId }).lean();

  for (const row of rows) {
    const limits = pulse.thresholdsFor(settings, row.department);

    // Break overrun — fires while it is happening, not in a post-mortem.
    const breakMinutes = row.stats?.shiftMinutesToday !== undefined ? row.stats?.idleMinutesToday ?? 0 : 0;
    if (row.workState === 'on_break') {
      const facts = await pulse.getAttendanceFacts(String(row.userId), pulse.companyDayStart());
      if (facts.breakMinutesToday > limits.breakLimitMinutes) {
        await pulse.raiseAlert({
          organizationId,
          userId: String(row.userId),
          department: row.department,
          kind: 'attendance.break_overrun',
          priority: 'attendance',
          escalateTo: 'warning',
          title: 'Break has run past the limit',
          reason: `You have been on break for ${facts.breakMinutesToday} minutes; the allowance is ${limits.breakLimitMinutes}.`,
          recommendedAction: 'Resume your shift from the TimeProof Clock, or let your manager know if something came up.',
          actionUrl: '/crm/timeproof-clock',
          actionLabel: 'Open TimeProof Clock',
          dedupeKey: `break:${row.userId}:${pulse.companyDayStart().toISOString().slice(0, 10)}`,
          expiresAt: new Date(pulse.companyDayStart().getTime() + 86_400_000),
          context: { breakMinutes: facts.breakMinutesToday, limit: limits.breakLimitMinutes },
        });
        raised += 1;
      }
      continue;
    }

    // Expected but not clocked in. Only checked once the workday is properly
    // underway, and only on weekdays, so it never fires on a rest day.
    const dayOfWeek = new Date(pulse.companyDayStart().getTime() + 12 * 3600_000).getUTCDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

    if (isWeekday && hour >= limits.expectedClockInHour && hour < 18 && !row.isOnShift) {
      const hasWork = (row.stats?.openTasks ?? 0) > 0;
      if (!hasWork) continue; // no responsibilities pending, no chase

      await pulse.raiseAlert({
        organizationId,
        userId: String(row.userId),
        department: row.department,
        kind: 'attendance.not_clocked_in',
        priority: 'attendance',
        title: 'Not clocked in yet today',
        reason: `It is past ${limits.expectedClockInHour}:00 and there is no time-in recorded for today, with ${row.stats?.openTasks} open item${(row.stats?.openTasks ?? 0) === 1 ? '' : 's'} waiting.`,
        recommendedAction: 'Start your shift from the TimeProof Clock, or file the absence in Team Pulse.',
        actionUrl: '/crm/timeproof-clock',
        actionLabel: 'Start shift',
        dedupeKey: `noclockin:${row.userId}:${pulse.companyDayStart().toISOString().slice(0, 10)}`,
        expiresAt: new Date(pulse.companyDayStart().getTime() + 86_400_000),
        context: { openTasks: row.stats?.openTasks },
      });
      raised += 1;
    } else if (row.isOnShift) {
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'attendance.not_clocked_in', 'shift started');
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'attendance.break_overrun', 'break ended');
    }
  }

  return raised;
}

// ── Health escalation ───────────────────────────────────────────────────────

/**
 * Surfaces a sustained low score to management. Requires a streak so a single
 * bad day (one sick afternoon, one deploy freeze) never generates a
 * performance escalation.
 */
export async function evaluateHealthEscalations(organizationId: string, settings: IPulseSetting) {
  const rows = await PulseHealth.find({ organizationId }).lean();
  let raised = 0;

  const managers = await CrmUser.find({
    organizationId,
    role: { $in: ['admin', 'manager'] },
    isActive: true,
  })
    .select('_id department role')
    .lean();

  for (const row of rows) {
    const limits = pulse.thresholdsFor(settings, row.department);
    const recent = (row.trend ?? []).slice(-limits.lowHealthStreak);

    const sustainedLow =
      recent.length >= limits.lowHealthStreak && recent.every((t: any) => t.score < limits.lowHealthScore);

    if (!sustainedLow) {
      await pulse.closeAlertsByKind(organizationId, String(row.userId), 'health.sustained_low', 'score recovered');
      continue;
    }

    const weakest = Object.entries(row.components ?? {}).sort((a, b) => (a[1] as number) - (b[1] as number))[0];
    const componentLabels: Record<string, string> = {
      attendance: 'attendance consistency',
      taskCompletion: 'task completion',
      timeliness: 'meeting deadlines',
      engagement: 'day-to-day CRM engagement',
      responsiveness: 'picking up newly assigned work',
    };

    // To the employee first — they get a chance to correct it themselves.
    await pulse.raiseAlert({
      organizationId,
      userId: String(row.userId),
      department: row.department,
      kind: 'health.sustained_low',
      priority: 'escalation',
      title: 'Your work health score needs attention',
      reason: `Your score has stayed below ${limits.lowHealthScore} across the last ${limits.lowHealthStreak} checks (currently ${row.score}). The weakest area is ${componentLabels[weakest?.[0] ?? 'engagement'] ?? 'engagement'}.`,
      recommendedAction: 'Clear your overdue items first — that moves the score fastest. Your manager can see this too.',
      actionUrl: '/crm/pulse360',
      actionLabel: 'View my Pulse',
      dedupeKey: `lowhealth:${row.userId}`,
      context: { score: row.score, band: row.band, weakestComponent: weakest?.[0], components: row.components },
    });
    raised += 1;

    if (settings.notifications?.escalateToManagers) {
      // Escalate to this person's own department managers, plus admins as the
      // catch-all for anyone with no departmental manager. The earlier version
      // OR'd on "is not the subject", which resolved to true for essentially
      // every manager in the org and would have carpet-bombed the whole
      // management team with each individual's escalation.
      const departmentManagers = managers.filter(
        (m) =>
          String(m._id) !== String(row.userId) &&
          (m.role === 'admin' || (!!row.department && m.department === row.department))
      );
      for (const manager of departmentManagers.slice(0, 5)) {
        if (String(manager._id) === String(row.userId)) continue;
        await pulse.raiseAlert({
          organizationId,
          userId: String(manager._id),
          department: manager.department,
          kind: 'health.team_escalation',
          priority: 'escalation',
          title: `${row.fullName} needs support`,
          reason: `${row.fullName}'s work health has stayed below ${limits.lowHealthScore} for ${limits.lowHealthStreak} consecutive checks (currently ${row.score}, ${row.stats?.overdueTasks ?? 0} overdue).`,
          recommendedAction: 'Review their timeline and check whether the workload or a blocker is the real cause.',
          actionUrl: `/crm/pulse360?user=${row.userId}`,
          actionLabel: 'Review timeline',
          dedupeKey: `lowhealth-mgr:${row.userId}:${manager._id}`,
          context: { subjectUserId: String(row.userId), subjectName: row.fullName, score: row.score },
        });
      }
    }
  }

  return raised;
}

// ── Workload imbalance ──────────────────────────────────────────────────────

/**
 * Org-level rule. Flags a department where the load is lopsided enough that
 * the fix is redistribution, not chasing the individual who is drowning.
 */
export async function evaluateWorkloadBalance(organizationId: string, settings: IPulseSetting) {
  const rows = await PulseHealth.find({ organizationId }).lean();
  const byDept = new Map<string, typeof rows>();

  for (const row of rows) {
    const key = row.department || 'unassigned';
    byDept.set(key, [...(byDept.get(key) ?? []), row]);
  }

  // `role` must be selected — it is read in the filter below. Leaving it out
  // compiles fine (mongoose doesn't narrow types on .select()) but silently
  // yields undefined at runtime, which would quietly drop every admin.
  const managers = await CrmUser.find({ organizationId, role: { $in: ['admin', 'manager'] }, isActive: true })
    .select('_id department role')
    .lean();

  let raised = 0;

  for (const [department, members] of byDept.entries()) {
    if (members.length < 3) continue;

    const loads = members.map((m) => m.stats?.openTasks ?? 0);
    const total = loads.reduce((s, n) => s + n, 0);
    if (total < 10) continue;

    const mean = total / members.length;
    const max = Math.max(...loads);
    const heaviest = members.find((m) => (m.stats?.openTasks ?? 0) === max);

    // Heaviest carrying more than 2.5x the department average.
    if (!heaviest || mean === 0 || max < mean * 2.5) continue;

    for (const manager of managers.filter((m) => m.department === department || m.role === 'admin').slice(0, 3)) {
      await pulse.raiseAlert({
        organizationId,
        userId: String(manager._id),
        department: manager.department,
        kind: 'workload.imbalance',
        priority: 'warning',
        title: `Workload is lopsided in ${department}`,
        reason: `${heaviest.fullName} is holding ${max} open items against a department average of ${Math.round(mean)}.`,
        recommendedAction: 'Redistribute a few items before the deadlines start slipping.',
        actionUrl: `/crm/pulse360?department=${encodeURIComponent(department)}`,
        actionLabel: 'Open department view',
        dedupeKey: `imbalance:${department}:${manager._id}`,
        expiresAt: new Date(Date.now() + 3 * 86_400_000),
        context: { department, heaviestUserId: String(heaviest.userId), heaviestName: heaviest.fullName, max, mean: Math.round(mean) },
      });
      raised += 1;
    }
  }

  return raised;
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/** Wake snoozed alerts and retire expired ones. */
export async function sweepAlertLifecycle() {
  const now = new Date();

  const waking = await PulseAlert.find({ status: 'snoozed', snoozedUntil: { $lte: now } });
  for (const alert of waking) {
    alert.status = 'pending';
    alert.snoozedUntil = undefined;
    alert.lastFiredAt = now;
    await alert.save();
    pulse.emitToUser(String(alert.userId), 'pulse:alert', {
      alert: pulse.serializeAlert(alert),
      popup: alert.severity >= PULSE_SEVERITY.warning,
    });
  }

  const expired = await PulseAlert.updateMany(
    { isOpen: true, expiresAt: { $lte: now } },
    { $set: { status: 'expired', isOpen: false } }
  );

  return { woken: waking.length, expired: expired.modifiedCount ?? 0 };
}

export default {
  evaluateDeadlines,
  evaluateIdle,
  evaluateStalledWork,
  evaluateAttendance,
  evaluateHealthEscalations,
  evaluateWorkloadBalance,
  sweepAlertLifecycle,
};