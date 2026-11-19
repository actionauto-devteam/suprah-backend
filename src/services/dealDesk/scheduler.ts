/**
 * Deal Desk background loop.
 *   every 3s   expire Finance Manager offers past their 5-minute window
 *   every 15s  place deals waiting in ready_for_fi with an available FM
 *   every 30s  SLA breach alerts (a deal turning red in its stage)
 *
 * Safe with several API instances: every write is an atomic conditional
 * update, so two instances can never expire or offer the same deal twice.
 */
import { Types } from 'mongoose';
import DealDeskDeal from '../../models/DealDeskDeal.model';
import { OPEN_STAGES, STAGE_LABELS, DealStage } from './constants';
import { expireOffer, offerNext } from './assignment';
import { getSettings, slaFor } from './access';
import { slaStatus, postSystemMessage } from './queue';
import { emitToStaff, emitToUser } from './realtime';
import { toDealSummary } from './serialize';

let started = false;
const busy = { expire: false, waiting: false, sla: false };

async function guarded(key: keyof typeof busy, fn: () => Promise<void>) {
  if (busy[key]) return;
  busy[key] = true;
  try {
    await fn();
  } catch (err: any) {
    // Mongo not connected yet during boot — stay quiet, retry next tick.
    if (!/buffering timed out|ECONNREFUSED|topology/i.test(String(err?.message))) console.error(`[deal-desk] scheduler ${key} failed`, err);
  } finally {
    busy[key] = false;
  }
}

async function expireTick() {
  const due = await DealDeskDeal.find({ stage: 'offered', 'offer.expiresAt': { $lte: new Date() } })
    .select('_id offer')
    .limit(50)
    .lean();
  for (const d of due as any[]) {
    await expireOffer(String(d._id), String(d.offer?.fmId), d.offer?.offeredAt ? new Date(d.offer.offeredAt) : undefined);
  }
}

async function waitingTick() {
  const waiting = await DealDeskDeal.find({ stage: 'ready_for_fi' }).sort({ stageEnteredAt: 1 }).select('_id organizationId').limit(100).lean();
  const stalledOrgs = new Set<string>();
  for (const d of waiting as any[]) {
    const org = String(d.organizationId);
    if (stalledOrgs.has(org)) continue;
    const r = await offerNext(d._id as Types.ObjectId);
    if (r === 'waiting') stalledOrgs.add(org);
  }
}

async function slaTick() {
  const open = await DealDeskDeal.find({ stage: { $in: OPEN_STAGES.filter((s) => s !== 'offered') } })
    .select('_id organizationId stage stageEnteredAt slaNotifiedStage dealNumber customer vehicle salesperson reviewer financeManager offer analysis offerAttempts escalatedAt documents timestamps createdAt updatedAt lastActivityAt source')
    .limit(2000)
    .lean();
  const now = Date.now();
  for (const d of open as any[]) {
    if (d.slaNotifiedStage === d.stage) continue;
    const settings = await getSettings(String(d.organizationId));
    if (slaStatus(d.stage, d.stageEnteredAt, slaFor(settings), now) !== 'late') continue;
    const res = await DealDeskDeal.updateOne(
      { _id: d._id, stage: d.stage, stageEnteredAt: d.stageEnteredAt, slaNotifiedStage: { $ne: d.stage } },
      { $set: { slaNotifiedStage: d.stage } },
    );
    if (!res.modifiedCount) continue;
    const mins = Math.round((now - new Date(d.stageEnteredAt).getTime()) / 60000);
    const summary = toDealSummary(d);
    emitToStaff(String(d.organizationId), 'deal:sla', { deal: summary, minutes: mins });
    const owner = d.stage === 'needs_info' ? d.salesperson?.id : d.stage === 'in_fi' ? d.financeManager?.id : d.reviewer?.id;
    if (owner) emitToUser(String(owner), 'deal:sla', { deal: summary, minutes: mins });
    await postSystemMessage(d, `🔴 Over target: ${mins} min in "${STAGE_LABELS[d.stage as DealStage]}".`);
  }
}

export function startDealDeskScheduler() {
  if (started || process.env.DEAL_DESK_SCHEDULER === 'off') return;
  started = true;
  const timers = [
    setInterval(() => guarded('expire', expireTick), 3000),
    setInterval(() => guarded('waiting', waitingTick), 15000),
    setInterval(() => guarded('sla', slaTick), 30000),
  ];
  timers.forEach((t) => (t as any).unref?.());
}
