/**
 * The Deal Queue engine. EVERY stage change goes through transition():
 *   - validates the move against STAGE_TRANSITIONS
 *   - closes the current stageHistory entry with its exact duration
 *   - stamps milestone timestamps (first pickup, approved, accepted, …)
 *   - uses an optimistic lock (stage + stageEnteredAt) so two people or two
 *     server instances can never both move the same deal
 *   - writes an audit event, optional system message, and broadcasts live
 */
import { Types } from 'mongoose';
import DealDeskDeal, { IDealDeskDeal } from '../../models/DealDeskDeal.model';
import { DealDeskEvent, DealDeskMessage } from '../../models/DealDeskSupport.model';
import { ApiError } from '../../utils/ApiError';
import { DealStage, STAGE_LABELS, STAGE_TRANSITIONS } from './constants';
import { emitDealChanged, emitDealMessage } from './realtime';
import type { Actor } from './access';

export interface TransitionOptions {
  /** Extra filter conditions that must still hold (e.g. offer.fmId). */
  match?: Record<string, unknown>;
  set?: Record<string, unknown>;
  unset?: string[];
  push?: Record<string, unknown>;
  action?: string;
  meta?: Record<string, unknown>;
  systemMessage?: string;
  /** Skip the STAGE_TRANSITIONS check (internal, e.g. admin repair). */
  force?: boolean;
  /** Return null instead of throwing when the lock is lost (scheduler use). */
  quietConflict?: boolean;
}

const MILESTONE: Partial<Record<DealStage, { field: string; firstOnly: boolean }>> = {
  submitted: { field: 'timestamps.submittedAt', firstOnly: true },
  picked_up: { field: 'timestamps.firstPickedUpAt', firstOnly: true },
  structured: { field: 'timestamps.analyzedAt', firstOnly: false },
  ready_for_fi: { field: 'timestamps.approvedAt', firstOnly: false },
  offered: { field: 'timestamps.firstOfferedAt', firstOnly: true },
  in_fi: { field: 'timestamps.acceptedAt', firstOnly: false },
  signed: { field: 'timestamps.signedAt', firstOnly: false },
  funded: { field: 'timestamps.fundedAt', firstOnly: false },
  cancelled: { field: 'timestamps.cancelledAt', firstOnly: false },
};

function getPath(obj: any, path: string) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export async function transition(
  dealOrId: IDealDeskDeal | string | Types.ObjectId,
  to: DealStage,
  actor: Actor | null,
  opts: TransitionOptions = {},
): Promise<IDealDeskDeal | null> {
  const deal =
    typeof dealOrId === 'string' || dealOrId instanceof Types.ObjectId
      ? await DealDeskDeal.findById(dealOrId)
      : dealOrId;
  if (!deal) throw new ApiError(404, 'Deal not found');

  const from = deal.stage as DealStage;
  if (!opts.force && !STAGE_TRANSITIONS[from]?.includes(to)) {
    if (opts.quietConflict) return null;
    throw new ApiError(409, `This deal is "${STAGE_LABELS[from]}" and can't move to "${STAGE_LABELS[to]}".`);
  }

  const now = new Date();
  const history = (deal.stageHistory || []).map((h: any) => (typeof h.toObject === 'function' ? h.toObject() : { ...h }));
  const last = history[history.length - 1];
  if (last && !last.exitedAt) {
    last.exitedAt = now;
    last.durationMs = Math.max(0, now.getTime() - new Date(last.enteredAt).getTime());
  }
  history.push({
    stage: to,
    enteredAt: now,
    actorId: actor ? new Types.ObjectId(actor.id) : undefined,
    actorName: actor ? actor.name : 'System',
  });

  const $set: Record<string, unknown> = {
    stage: to,
    stageEnteredAt: now,
    stageHistory: history,
    lastActivityAt: now,
    ...(opts.set || {}),
  };
  const milestone = MILESTONE[to];
  if (milestone && (!milestone.firstOnly || !getPath(deal, milestone.field))) $set[milestone.field] = now;

  const update: Record<string, unknown> = { $set };
  const $unset: Record<string, ''> = { slaNotifiedStage: '' };
  for (const k of opts.unset || []) $unset[k] = '';
  update.$unset = $unset;
  if (opts.push) update.$push = opts.push;

  const updated = await DealDeskDeal.findOneAndUpdate(
    { _id: deal._id, stage: from, stageEnteredAt: deal.stageEnteredAt, ...(opts.match || {}) },
    update,
    { new: true },
  );

  if (!updated) {
    if (opts.quietConflict) return null;
    throw new ApiError(409, 'Someone else just updated this deal. Refresh and try again.');
  }

  await DealDeskEvent.create({
    organizationId: updated.organizationId,
    dealId: updated._id,
    action: opts.action || 'stage_changed',
    actorId: actor ? new Types.ObjectId(actor.id) : undefined,
    actorName: actor?.name || 'System',
    from,
    to,
    meta: opts.meta,
  }).catch((err: unknown) => console.error('[deal-desk] audit write failed', err));

  if (opts.systemMessage) await postSystemMessage(updated, opts.systemMessage);

  emitDealChanged(updated, opts.action || 'stage_changed');
  return updated;
}

export async function postSystemMessage(deal: { _id: any; organizationId: any }, body: string, kind: 'system' | 'ai' = 'system') {
  try {
    const msg = await DealDeskMessage.create({
      organizationId: deal.organizationId,
      dealId: deal._id,
      kind,
      authorName: kind === 'ai' ? 'Deal Builder AI' : 'Deal Desk',
      body,
    });
    emitDealMessage(msg);
    return msg;
  } catch (err) {
    console.error('[deal-desk] system message failed', err);
    return null;
  }
}

export async function logEvent(deal: any, actor: Actor | null, action: string, meta?: Record<string, unknown>) {
  await DealDeskEvent.create({
    organizationId: deal.organizationId,
    dealId: deal._id,
    action,
    actorId: actor ? new Types.ObjectId(actor.id) : undefined,
    actorName: actor?.name || 'System',
    meta,
  }).catch((err: unknown) => console.error('[deal-desk] audit write failed', err));
}

/** Time a deal has been in its current stage, in ms. */
export function ageInStage(deal: { stageEnteredAt?: Date }, now = Date.now()): number {
  return deal.stageEnteredAt ? Math.max(0, now - new Date(deal.stageEnteredAt).getTime()) : 0;
}

/** green until target, amber until 2× target, red after. */
export function slaStatus(stage: string, enteredAt: Date | undefined, sla: Record<string, number>, now = Date.now()): 'ok' | 'warn' | 'late' | 'none' {
  const target = sla[stage];
  if (!target || !enteredAt) return 'none';
  const mins = (now - new Date(enteredAt).getTime()) / 60000;
  if (mins <= target) return 'ok';
  if (mins <= target * 2) return 'warn';
  return 'late';
}
