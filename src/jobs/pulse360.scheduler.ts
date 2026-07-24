import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import PulseSetting from '../models/PulseSetting.model';
import pulse from '../services/pulse360.service';
import rules from '../services/pulse360.rules';

/**
 * Suprah Pulse360 — scheduler.
 *
 * All scanning work lives here so request handlers stay O(1). Sweeps are
 * staggered on purpose: nothing lines up on the same tick, and each sweep
 * guards against overlapping runs so a slow pass can't pile up behind itself.
 *
 * Cadences chosen so the dashboard feels live without hammering Atlas:
 *   • lifecycle  — 60s  (wake snoozes, retire expired alerts)
 *   • presence   — 2min (health recompute for anyone currently on shift)
 *   • rules      — 5min (idle, attendance, deadlines)
 *   • full       — 30min (everyone, plus escalations and workload balance)
 */

type SweepName = 'lifecycle' | 'presence' | 'rules' | 'full';

const running: Record<SweepName, boolean> = {
  lifecycle: false,
  presence: false,
  rules: false,
  full: false,
};

const timers: NodeJS.Timeout[] = [];

async function guarded(name: SweepName, fn: () => Promise<void>) {
  if (running[name]) {
    console.warn(`[PULSE360] sweep "${name}" still running, skipping this tick`);
    return;
  }
  running[name] = true;
  const startedAt = Date.now();
  try {
    await fn();
  } catch (error) {
    console.error(`[PULSE360] sweep "${name}" failed:`, error);
  } finally {
    running[name] = false;
    const ms = Date.now() - startedAt;
    if (ms > 15_000) console.warn(`[PULSE360] sweep "${name}" took ${ms}ms`);
  }
}

/** Orgs with Pulse360 switched on. */
async function activeOrgIds(): Promise<string[]> {
  const settings = await PulseSetting.find({ enabled: true }).select('organizationId').lean();
  if (settings.length) return settings.map((s) => String(s.organizationId));

  // Nothing configured yet — bootstrap from orgs that actually have CRM users,
  // so Pulse360 starts working on install without a manual setup step.
  const orgIds = await CrmUser.distinct('organizationId', { isActive: true, isSystem: { $ne: true } });
  return orgIds.filter(Boolean).map((id: any) => String(id));
}

async function monitoredUserIds(organizationId: string): Promise<string[]> {
  const users = await CrmUser.find({
    organizationId,
    isActive: true,
    isSystem: { $ne: true },
    isOffboarded: { $ne: true },
  })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
}

/** Recompute health for a set of users, sequentially to keep Atlas calm. */
async function recomputeMany(organizationId: string, userIds: string[]) {
  for (const userId of userIds) {
    try {
      await pulse.computeUserHealth(organizationId, userId, { silent: userIds.length > 25 });
    } catch (error) {
      console.error(`[PULSE360] health compute failed for ${userId}:`, error);
    }
  }
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

async function lifecycleSweep() {
  await rules.sweepAlertLifecycle();
}

/**
 * Anyone clocked in gets a fresh score every couple of minutes — that's what
 * makes the manager dashboard's "working / idle" column trustworthy.
 */
async function presenceSweep() {
  const orgs = await activeOrgIds();
  for (const orgId of orgs) {
    const PulseHealth = mongoose.models.PulseHealth;
    if (!PulseHealth) continue;

    const onShift = await PulseHealth.find({ organizationId: orgId, isOnShift: true }).select('userId').lean();
    await recomputeMany(orgId, onShift.map((r: any) => String(r.userId)));
  }
}

async function rulesSweep() {
  const orgs = await activeOrgIds();
  for (const orgId of orgs) {
    const settings = await pulse.getSettings(orgId);
    if (!settings.enabled) continue;

    await rules.evaluateDeadlines(orgId, settings);
    await rules.evaluateIdle(orgId, settings);
    await rules.evaluateAttendance(orgId, settings);
  }
}

async function fullSweep() {
  const orgs = await activeOrgIds();
  for (const orgId of orgs) {
    const settings = await pulse.getSettings(orgId);
    if (!settings.enabled) continue;

    await recomputeMany(orgId, await monitoredUserIds(orgId));
    await rules.evaluateStalledWork(orgId, settings);
    await rules.evaluateHealthEscalations(orgId, settings);
    await rules.evaluateWorkloadBalance(orgId, settings);

    // One org-wide push so every open dashboard redraws together.
    const overview = await pulse.getOrgOverview(orgId);
    pulse.emitToOrg(orgId, 'pulse:overview', overview);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function startPulse360Scheduler() {
  if (process.env.PULSE360_ENABLED === 'false') {
    console.log('[PULSE360] scheduler disabled via PULSE360_ENABLED=false');
    return;
  }

  // Only one instance should sweep. On a multi-pod deploy set
  // PULSE360_SCHEDULER=false everywhere except the primary.
  if (process.env.PULSE360_SCHEDULER === 'false') {
    console.log('[PULSE360] scheduler suppressed on this instance');
    return;
  }

  console.log('[PULSE360] scheduler starting');

  timers.push(setInterval(() => void guarded('lifecycle', lifecycleSweep), 60_000));
  timers.push(setInterval(() => void guarded('presence', presenceSweep), 2 * 60_000));
  timers.push(setInterval(() => void guarded('rules', rulesSweep), 5 * 60_000));
  timers.push(setInterval(() => void guarded('full', fullSweep), 30 * 60_000));

  // Warm start, offset so boot isn't a thundering herd.
  setTimeout(() => void guarded('full', fullSweep), 20_000);
  setTimeout(() => void guarded('rules', rulesSweep), 45_000);

  for (const timer of timers) timer.unref?.();
}

export function stopPulse360Scheduler() {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  console.log('[PULSE360] scheduler stopped');
}

/** Exposed so the admin "Run evaluation now" button can force a pass. */
export async function runFullSweepNow(organizationId?: string) {
  if (!organizationId) {
    await guarded('full', fullSweep);
    return;
  }
  const settings = await pulse.getSettings(organizationId);
  await recomputeMany(organizationId, await monitoredUserIds(organizationId));
  await rules.evaluateDeadlines(organizationId, settings);
  await rules.evaluateIdle(organizationId, settings);
  await rules.evaluateAttendance(organizationId, settings);
  await rules.evaluateStalledWork(organizationId, settings);
  await rules.evaluateHealthEscalations(organizationId, settings);
  await rules.evaluateWorkloadBalance(organizationId, settings);

  const overview = await pulse.getOrgOverview(organizationId);
  pulse.emitToOrg(organizationId, 'pulse:overview', overview);
}

export default { startPulse360Scheduler, stopPulse360Scheduler, runFullSweepNow };
