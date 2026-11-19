/**
 * Deal Queue metrics — how long every deal takes to get worked.
 * Built entirely from stageHistory + milestone timestamps.
 */
import { Types } from 'mongoose';
import DealDeskDeal from '../../models/DealDeskDeal.model';
import { OPEN_STAGES, STAGE_LABELS, DealStage } from './constants';
import { slaStatus } from './queue';
import { getSettings, slaFor } from './access';
import { listPresence } from './assignment';

export type MetricsRange = 'today' | '7d' | '30d' | '90d';

function rangeStart(range: MetricsRange, tzOffsetMinutes = 0): Date {
  const now = new Date();
  if (range === 'today') {
    // "today" in the caller's timezone (minutes east of UTC, e.g. Utah MDT = -360)
    const local = new Date(now.getTime() + tzOffsetMinutes * 60000);
    local.setUTCHours(0, 0, 0, 0);
    return new Date(local.getTime() - tzOffsetMinutes * 60000);
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return new Date(now.getTime() - days * 86400000);
}

interface Stat {
  count: number;
  avgMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
}

function stat(values: number[]): Stat {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { count: 0, avgMs: null, medianMs: null, p90Ms: null };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))];
  return { count: v.length, avgMs: Math.round(avg), medianMs: Math.round(at(0.5)), p90Ms: Math.round(at(0.9)) };
}

const diff = (a?: Date, b?: Date) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : NaN);

export async function getQueueMetrics(orgId: string, range: MetricsRange, scope: { onlySalespersonId?: string } = {}, tzOffsetMinutes = 0) {
  const org = new Types.ObjectId(orgId);
  const since = rangeStart(range, tzOffsetMinutes);
  const settings = await getSettings(orgId);
  const sla = slaFor(settings);
  const scopeFilter = scope.onlySalespersonId ? { 'salesperson.id': new Types.ObjectId(scope.onlySalespersonId) } : {};

  const [open, recent, presence] = await Promise.all([
    DealDeskDeal.find({ organizationId: org, stage: { $in: OPEN_STAGES }, ...scopeFilter })
      .select('stage stageEnteredAt source')
      .lean(),
    DealDeskDeal.find({
      organizationId: org,
      ...scopeFilter,
      $or: [{ createdAt: { $gte: since } }, { 'timestamps.submittedAt': { $gte: since } }, { lastActivityAt: { $gte: since } }],
    })
      .select('stage source stageHistory timestamps offerAttempts salesperson financeManager reviewer createdAt escalatedAt')
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean(),
    listPresence(orgId),
  ]);

  const now = Date.now();
  /* live queue */
  const byStage: Record<string, { count: number; ok: number; warn: number; late: number; oldestMs: number }> = {};
  for (const s of OPEN_STAGES) byStage[s] = { count: 0, ok: 0, warn: 0, late: 0, oldestMs: 0 };
  let lateCount = 0;
  for (const d of open as any[]) {
    const b = byStage[d.stage];
    if (!b) continue;
    b.count++;
    const st = slaStatus(d.stage, d.stageEnteredAt, sla, now);
    if (st === 'ok') b.ok++;
    if (st === 'warn') b.warn++;
    if (st === 'late') {
      b.late++;
      lateCount++;
    }
    b.oldestMs = Math.max(b.oldestMs, now - new Date(d.stageEnteredAt).getTime());
  }

  /* time per stage (entries that finished in range) */
  const stageDurations: Record<string, number[]> = {};
  const pickup: number[] = [];
  const toFi: number[] = [];
  const submitToSigned: number[] = [];
  const acceptTimes: number[] = [];
  const fiTime: number[] = [];
  let declined = 0;
  let expired = 0;
  let rotationsTotal = 0;
  let acceptedDeals = 0;
  let escalated = 0;
  const bySource: Record<string, number> = { supra: 0, web: 0, crm: 0 };
  const fm = new Map<string, { name: string; offers: number; accepted: number; declined: number; expired: number; acceptMs: number[]; signed: number }>();
  const sales = new Map<string, { name: string; submitted: number; needsInfo: number; signed: number; pickupMs: number[] }>();
  const daily = new Map<string, { submitted: number; signed: number; funded: number }>();
  const dayKey = (d: Date) => new Date(new Date(d).getTime() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
  const bumpDay = (d: Date | undefined, key: 'submitted' | 'signed' | 'funded') => {
    if (!d || new Date(d) < since) return;
    const k = dayKey(d);
    const row = daily.get(k) || { submitted: 0, signed: 0, funded: 0 };
    row[key]++;
    daily.set(k, row);
  };

  for (const d of recent as any[]) {
    const ts = d.timestamps || {};
    if (ts.submittedAt && new Date(ts.submittedAt) >= since) bySource[d.source] = (bySource[d.source] || 0) + 1;
    bumpDay(ts.submittedAt, 'submitted');
    bumpDay(ts.signedAt, 'signed');
    bumpDay(ts.fundedAt, 'funded');
    if (d.escalatedAt && new Date(d.escalatedAt) >= since) escalated++;

    for (const h of d.stageHistory || []) {
      if (h.durationMs == null || !h.exitedAt || new Date(h.exitedAt) < since) continue;
      (stageDurations[h.stage] ||= []).push(h.durationMs);
      if (h.stage === 'in_fi') fiTime.push(h.durationMs);
    }
    if (ts.firstPickedUpAt && new Date(ts.firstPickedUpAt) >= since) pickup.push(diff(ts.submittedAt, ts.firstPickedUpAt));
    if (ts.firstOfferedAt && new Date(ts.firstOfferedAt) >= since) toFi.push(diff(ts.submittedAt, ts.firstOfferedAt));
    if (ts.signedAt && new Date(ts.signedAt) >= since) submitToSigned.push(diff(ts.submittedAt, ts.signedAt));

    let dealRotations = 0;
    let dealAccepted = false;
    for (const a of d.offerAttempts || []) {
      if (!a.at || new Date(a.at) < since) continue;
      const key = String(a.fmId);
      const row = fm.get(key) || { name: a.fmName || '', offers: 0, accepted: 0, declined: 0, expired: 0, acceptMs: [] as number[], signed: 0 };
      row.offers++;
      if (a.outcome === 'accepted') {
        row.accepted++;
        const ms = diff(a.offeredAt, a.at);
        row.acceptMs.push(ms);
        acceptTimes.push(ms);
        dealAccepted = true;
      } else {
        dealRotations++;
        if (a.outcome === 'declined') {
          row.declined++;
          declined++;
        }
        if (a.outcome === 'expired') {
          row.expired++;
          expired++;
        }
      }
      fm.set(key, row);
    }
    if (dealAccepted) {
      acceptedDeals++;
      rotationsTotal += dealRotations;
    }
    if (d.financeManager?.id && ts.signedAt && new Date(ts.signedAt) >= since) {
      const key = String(d.financeManager.id);
      const row = fm.get(key) || { name: d.financeManager.name || '', offers: 0, accepted: 0, declined: 0, expired: 0, acceptMs: [] as number[], signed: 0 };
      row.signed++;
      fm.set(key, row);
    }
    if (d.salesperson?.id) {
      const key = String(d.salesperson.id);
      const row = sales.get(key) || { name: d.salesperson.name || '', submitted: 0, needsInfo: 0, signed: 0, pickupMs: [] as number[] };
      if (ts.submittedAt && new Date(ts.submittedAt) >= since) row.submitted++;
      row.needsInfo += (d.stageHistory || []).filter((h: any) => h.stage === 'needs_info' && new Date(h.enteredAt) >= since).length;
      if (ts.signedAt && new Date(ts.signedAt) >= since) row.signed++;
      if (ts.firstPickedUpAt && new Date(ts.firstPickedUpAt) >= since) row.pickupMs.push(diff(ts.submittedAt, ts.firstPickedUpAt));
      sales.set(key, row);
    }
  }

  const days: { date: string; submitted: number; signed: number; funded: number }[] = [];
  const dayCount = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
  for (let i = dayCount - 1; i >= 0; i--) {
    const k = dayKey(new Date(now - i * 86400000));
    days.push({ date: k, ...(daily.get(k) || { submitted: 0, signed: 0, funded: 0 }) });
  }

  return {
    range,
    since,
    generatedAt: new Date(),
    sla,
    live: {
      open: open.length,
      late: lateCount,
      byStage: OPEN_STAGES.map((s) => ({ stage: s, label: STAGE_LABELS[s as DealStage], target: sla[s], ...byStage[s] })),
    },
    timings: {
      firstPickup: stat(pickup),
      submitToFi: stat(toFi),
      submitToSigned: stat(submitToSigned),
      fmAccept: stat(acceptTimes),
      timeInFi: stat(fiTime),
      byStage: Object.keys(STAGE_LABELS)
        .filter((s) => stageDurations[s]?.length)
        .map((s) => ({ stage: s, label: STAGE_LABELS[s as DealStage], target: sla[s], ...stat(stageDurations[s]) })),
    },
    rotation: {
      acceptedDeals,
      declined,
      expired,
      escalated,
      avgRotationsPerDeal: acceptedDeals ? Math.round((rotationsTotal / acceptedDeals) * 10) / 10 : 0,
    },
    bySource,
    byFm: [...fm.entries()]
      .map(([id, r]) => ({ id, name: r.name, offers: r.offers, accepted: r.accepted, declined: r.declined, expired: r.expired, signed: r.signed, acceptRate: r.offers ? Math.round((r.accepted / r.offers) * 100) : 0, avgAcceptMs: stat(r.acceptMs).avgMs }))
      .sort((a, b) => b.accepted - a.accepted),
    bySalesperson: [...sales.entries()]
      .map(([id, r]) => ({ id, name: r.name, submitted: r.submitted, needsInfo: r.needsInfo, signed: r.signed, avgPickupMs: stat(r.pickupMs).avgMs }))
      .sort((a, b) => b.submitted - a.submitted),
    daily: days,
    presence,
  };
}
