/**
 * Finance Manager assignment — the 5-minute rotation.
 *
 *  - Eligible pool: FMs listed in settings, marked available, under their
 *    active-deal cap. Ordered round-robin by last assignment time.
 *  - Each offer lasts settings.acceptWindowSeconds (default 300). The timer
 *    lives in the database (offer.expiresAt) and is enforced by the
 *    scheduler, so it survives restarts and refreshes — never a browser timer.
 *  - Accept is atomic: only the offered FM, only before expiry, only once.
 *  - Decline or expiry moves to the next FM. After every eligible FM has
 *    passed in a round, a new round starts; past maxRoundsBeforeEscalation
 *    the deal is escalated to managers (and keeps rotating).
 */
import { Types } from 'mongoose';
import DealDeskDeal from '../../models/DealDeskDeal.model';
import { DealDeskFmPresence } from '../../models/DealDeskSupport.model';
import { ApiError } from '../../utils/ApiError';
import { getSettings, Actor } from './access';
import { transition, postSystemMessage, logEvent } from './queue';
import { emitToStaff, emitToUser, emitDealChanged } from './realtime';
import { toDealSummary } from './serialize';

const oid = (v: string | Types.ObjectId) => (typeof v === 'string' ? new Types.ObjectId(v) : v);

export async function offerNext(dealId: string | Types.ObjectId): Promise<'offered' | 'waiting' | 'skipped'> {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal || deal.stage !== 'ready_for_fi') return 'skipped';

  const orgId = String(deal.organizationId);
  const settings = await getSettings(orgId);
  const fmIds = (settings.financeManagerIds || []).map((x) => String(x));
  if (!fmIds.length) return 'waiting';

  const eligible = await DealDeskFmPresence.find({
    organizationId: deal.organizationId,
    userId: { $in: fmIds.map((id) => oid(id)) },
    available: true,
    activeDealCount: { $lt: settings.maxActiveDealsPerFm || 3 },
  })
    .sort({ lastAssignedAt: 1, updatedAt: 1 })
    .lean();

  if (!eligible.length) return 'waiting';

  let round = deal.offer?.round || 1;
  const triedThisRound = new Set(
    (deal.offerAttempts || []).filter((a) => (a.round || 1) === round).map((a) => String(a.fmId)),
  );
  let candidates = eligible.filter((p) => !triedThisRound.has(String(p.userId)));

  if (!candidates.length) {
    round += 1;
    candidates = eligible;
    if (round > (settings.maxRoundsBeforeEscalation || 1) && !deal.escalatedAt) {
      await DealDeskDeal.updateOne({ _id: deal._id }, { $set: { escalatedAt: new Date() } });
      deal.escalatedAt = new Date();
      await postSystemMessage(deal, `⚠️ No Finance Manager accepted after a full rotation. Escalated to managers.`);
      await logEvent(deal, null, 'escalated', { round });
      emitToStaff(orgId, 'deal:escalated', toDealSummary(deal));
    }
  }

  const pick = candidates[0];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (settings.acceptWindowSeconds || 300) * 1000);

  const updated = await transition(deal, 'offered', null, {
    set: { offer: { fmId: pick.userId, fmName: pick.name, offeredAt: now, expiresAt, round } },
    action: 'offered',
    meta: { fmId: String(pick.userId), fmName: pick.name, round, expiresAt },
    quietConflict: true,
  });
  if (!updated) return 'skipped';

  emitToUser(String(pick.userId), 'offer:new', {
    deal: toDealSummary(updated),
    expiresAt,
    windowSeconds: settings.acceptWindowSeconds || 300,
  });
  return 'offered';
}

export async function acceptOffer(dealId: string, actor: Actor) {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal || String(deal.organizationId) !== actor.orgId) throw new ApiError(404, 'Deal not found');
  if (deal.stage !== 'offered' || String(deal.offer?.fmId) !== actor.id) {
    throw new ApiError(409, 'This offer is no longer yours.');
  }
  const now = new Date();
  if (deal.offer?.expiresAt && deal.offer.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(409, 'This offer has expired and moved to the next Finance Manager.');
  }

  const updated = await transition(deal, 'in_fi', actor, {
    match: { 'offer.fmId': oid(actor.id), 'offer.expiresAt': { $gt: now } },
    set: {
      financeManager: { id: oid(actor.id), name: actor.name },
      offer: { round: deal.offer?.round || 1 },
    },
    push: {
      offerAttempts: {
        fmId: oid(actor.id),
        fmName: actor.name,
        offeredAt: deal.offer?.offeredAt,
        outcome: 'accepted',
        at: now,
        round: deal.offer?.round || 1,
      },
    },
    action: 'offer_accepted',
    meta: { acceptSeconds: deal.offer?.offeredAt ? Math.round((now.getTime() - deal.offer.offeredAt.getTime()) / 1000) : undefined },
    systemMessage: `✅ ${actor.name} accepted the deal.`,
  });

  await DealDeskFmPresence.updateOne(
    { organizationId: deal.organizationId, userId: oid(actor.id) },
    { $inc: { activeDealCount: 1 }, $set: { lastAssignedAt: now } },
    { upsert: true },
  );
  emitToUser(actor.id, 'offer:cleared', { dealId, reason: 'accepted' });
  emitPresence(String(deal.organizationId)).catch(() => {});
  return updated;
}

async function moveOn(dealId: string, fmId: string, outcome: 'declined' | 'expired' | 'withdrawn', actor: Actor | null, offeredAt?: Date) {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal || deal.stage !== 'offered' || String(deal.offer?.fmId) !== fmId) return null;
  if (offeredAt && deal.offer?.offeredAt && deal.offer.offeredAt.getTime() !== offeredAt.getTime()) return null;

  const now = new Date();
  const name = deal.offer?.fmName || 'Finance Manager';
  const updated = await transition(deal, 'ready_for_fi', actor, {
    match: { 'offer.fmId': oid(fmId), 'offer.offeredAt': deal.offer?.offeredAt },
    set: { offer: { round: deal.offer?.round || 1 } },
    push: {
      offerAttempts: { fmId: oid(fmId), fmName: name, offeredAt: deal.offer?.offeredAt, outcome, at: now, round: deal.offer?.round || 1 },
    },
    action: `offer_${outcome}`,
    systemMessage:
      outcome === 'expired'
        ? `⏱ ${name} didn't accept in time. Moving to the next Finance Manager.`
        : outcome === 'declined'
          ? `↪ ${name} passed. Moving to the next Finance Manager.`
          : undefined,
    quietConflict: outcome === 'expired',
  });
  emitToUser(fmId, 'offer:cleared', { dealId, reason: outcome });
  if (updated) await offerNext(updated._id as Types.ObjectId);
  return updated;
}

export async function declineOffer(dealId: string, actor: Actor) {
  const res = await moveOn(dealId, actor.id, 'declined', actor);
  if (!res) throw new ApiError(409, 'This offer is no longer yours.');
  return res;
}

export async function expireOffer(dealId: string, fmId: string, offeredAt?: Date) {
  return moveOn(dealId, fmId, 'expired', null, offeredAt);
}

/** FM hands a deal back (in_fi → ready_for_fi) — it goes back into rotation. */
export async function releaseDeal(dealId: string, actor: Actor, reason?: string) {
  const deal = await DealDeskDeal.findById(dealId);
  if (!deal || String(deal.organizationId) !== actor.orgId) throw new ApiError(404, 'Deal not found');
  const fmId = String(deal.financeManager?.id || '');
  const updated = await transition(deal, 'ready_for_fi', actor, {
    unset: ['financeManager'],
    set: { offer: { round: 1 }, escalatedAt: null },
    action: 'released',
    meta: { reason },
    systemMessage: `↩ ${actor.name} released the deal back to the F&I queue${reason ? `: ${reason}` : '.'}`,
  });
  if (fmId) await decrementFm(String(deal.organizationId), fmId);
  if (updated) await offerNext(updated._id as Types.ObjectId);
  return updated;
}

export async function decrementFm(orgId: string, fmId: string) {
  await DealDeskFmPresence.updateOne(
    { organizationId: oid(orgId), userId: oid(fmId), activeDealCount: { $gt: 0 } },
    { $inc: { activeDealCount: -1 } },
  );
  emitPresence(orgId).catch(() => {});
}

export async function setAvailability(actor: Actor, available: boolean) {
  const presence = await DealDeskFmPresence.findOneAndUpdate(
    { organizationId: oid(actor.orgId), userId: oid(actor.id) },
    { $set: { available, name: actor.name } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await emitPresence(actor.orgId);
  if (available) await offerWaitingDeals(actor.orgId);
  return presence;
}

/** Try to place every ready_for_fi deal in an org (oldest first). */
export async function offerWaitingDeals(orgId: string) {
  const waiting = await DealDeskDeal.find({ organizationId: oid(orgId), stage: 'ready_for_fi' })
    .sort({ stageEnteredAt: 1 })
    .select('_id')
    .limit(50)
    .lean();
  for (const d of waiting) {
    const r = await offerNext(d._id as Types.ObjectId);
    if (r === 'waiting') break; // nobody free — stop early
  }
}

export async function listPresence(orgId: string) {
  const settings = await getSettings(orgId);
  const ids = (settings.financeManagerIds || []).map((x) => String(x));
  const rows = await DealDeskFmPresence.find({ organizationId: oid(orgId), userId: { $in: ids.map((i) => oid(i)) } }).lean();
  const byId = new Map(rows.map((r) => [String(r.userId), r]));
  return ids.map((id) => {
    const r: any = byId.get(id);
    return {
      userId: id,
      name: r?.name || '',
      available: !!r?.available,
      activeDealCount: r?.activeDealCount || 0,
      lastAssignedAt: r?.lastAssignedAt || null,
    };
  });
}

export async function emitPresence(orgId: string) {
  emitToStaff(orgId, 'fm:presence', await listPresence(orgId));
}

/** Called when a deal leaves in_fi for signed/cancelled. */
export async function onLeaveFi(deal: any) {
  if (deal.financeManager?.id) await decrementFm(String(deal.organizationId), String(deal.financeManager.id));
}

export { emitDealChanged };
