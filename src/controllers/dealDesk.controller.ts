/**
 * Deal Desk API — /api/crm/deal-desk
 * AI Deal Builder · Supra New Deal channel · Deal Queue · F&I rotation
 */
import { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import Organization from '../models/Organization.model';
import DealDeskDeal from '../models/DealDeskDeal.model';
import {
  DealDeskEvent,
  DealDeskLender,
  DealDeskMessage,
  DealDeskSettings,
  nextDealNumber,
} from '../models/DealDeskSupport.model';
import {
  CLOSED_STAGES,
  CONSENT_TEXT,
  DEAL_STAGES,
  DOCUMENT_KINDS,
  OPEN_STAGES,
  REQUIRED_DOCUMENTS,
  DealStage,
} from '../services/dealDesk/constants';
import {
  assertAdmin,
  assertCanView,
  assertManager,
  assertReviewer,
  contextFromRequest,
  invalidateSettings,
  slaFor,
} from '../services/dealDesk/access';
import { transition, postSystemMessage, logEvent } from '../services/dealDesk/queue';
import {
  acceptOffer,
  declineOffer,
  emitPresence,
  listPresence,
  offerNext,
  onLeaveFi,
  releaseDeal,
  setAvailability,
} from '../services/dealDesk/assignment';
import { startAnalysis, recomputeNumbers } from '../services/dealDesk/pipeline';
import { getQueueMetrics, MetricsRange } from '../services/dealDesk/metrics';
import { toDealDetail, toDealSummary, toMessageDTO } from '../services/dealDesk/serialize';
import { emitDealChanged, emitDealMessage, emitToStaff, emitToUser } from '../services/dealDesk/realtime';
import { decryptPii, encryptPii, normalizeSsn, piiEncryptionAvailable } from '../services/dealDesk/pii';
import { deleteDealFile, getDealFileStream, putDealFile } from '../services/dealDesk/storage';
import { hasBlockingFlags } from '../services/dealDesk/analysis';
import { aiProvider } from '../services/dealDesk/ai';
import { DealDeskFmPresence } from '../models/DealDeskSupport.model';

/* ───────────────────────── validation ───────────────────────── */

const num = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/[$,\s]/g, ''))),
  z.number().finite().min(-10_000_000).max(10_000_000).optional(),
);
const str = (max = 200) => z.preprocess((v) => (v === null || v === undefined ? undefined : String(v).trim()), z.string().max(max).optional());
const bool = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v === true || v === 'true'), z.boolean().optional());

const dealInputSchema = z.object({
  customer: z
    .object({
      firstName: str(80),
      lastName: str(80),
      email: str(160),
      phone: str(40),
      dob: str(30),
      leadId: str(40),
      address: z.object({ street: str(160), city: str(80), state: str(40), zip: str(20) }).partial().optional(),
    })
    .partial()
    .optional(),
  coBuyer: z.object({ present: bool, firstName: str(80), lastName: str(80), grossMonthlyIncome: num }).partial().optional(),
  vehicle: z
    .object({
      vin: str(20),
      stockNumber: str(40),
      year: num,
      make: str(60),
      model: str(60),
      trim: str(80),
      mileage: num,
      condition: z.enum(['new', 'used', 'cpo']).optional(),
      price: num,
      bookValue: num,
      bookSource: str(60),
    })
    .partial()
    .optional(),
  tradeIn: z
    .object({ present: bool, vin: str(20), year: num, make: str(60), model: str(60), mileage: num, allowance: num, payoff: num, lienholder: str(120) })
    .partial()
    .optional(),
  fourSquare: z
    .object({ salePrice: num, docFee: num, otherFees: num, taxRate: num, downPayment: num, backendProducts: num, desiredPayment: num, desiredTerm: num })
    .partial()
    .optional(),
  creditApp: z
    .object({
      employer: str(120),
      jobTitle: str(120),
      employmentMonths: num,
      grossMonthlyIncome: num,
      otherMonthlyIncome: num,
      housingStatus: z.enum(['own', 'rent', 'family', 'other']).optional(),
      housingPayment: num,
      residenceMonths: num,
      monthlyDebt: num,
      creditScore: num,
      creditScoreSource: z.enum(['self_reported', 'bureau', 'lender']).optional(),
      ssn: str(20),
      consentGranted: bool,
    })
    .partial()
    .optional(),
  salespersonId: str(40),
  source: z.enum(['supra', 'crm']).optional(),
});

type DealInput = z.infer<typeof dealInputSchema>;

/** Flatten validated input into dotted $set paths, applying PII rules. */
function buildDealSet(input: DealInput, req: Request): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const sections = ['customer', 'coBuyer', 'vehicle', 'tradeIn', 'fourSquare', 'creditApp'] as const;
  for (const section of sections) {
    const obj: any = (input as any)[section];
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (section === 'creditApp' && (k === 'ssn' || k === 'consentGranted')) continue;
      if (section === 'customer' && k === 'address') {
        for (const [ak, av] of Object.entries(v as object)) if (av !== undefined) set[`customer.address.${ak}`] = av;
        continue;
      }
      if (section === 'customer' && k === 'dob') {
        const d = v ? new Date(String(v)) : null;
        if (d && !Number.isNaN(d.getTime())) set['customer.dob'] = d;
        continue;
      }
      if (section === 'customer' && k === 'leadId') {
        if (v && mongoose.isValidObjectId(v)) set['customer.leadId'] = new Types.ObjectId(String(v));
        continue;
      }
      if (k === 'vin' && typeof v === 'string') {
        set[`${section}.vin`] = v.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
        continue;
      }
      if (section === 'customer' && k === 'email' && typeof v === 'string') {
        set['customer.email'] = v.toLowerCase();
        continue;
      }
      set[`${section}.${k}`] = v === '' ? undefined : v;
    }
  }
  const ca = input.creditApp;
  if (ca?.ssn !== undefined) {
    const ssn = normalizeSsn(ca.ssn);
    if (ca.ssn && !ssn) throw new ApiError(400, 'SSN must be 9 digits.');
    if (ssn) {
      set['creditApp.ssnLast4'] = ssn.slice(-4);
      const enc = encryptPii(ssn);
      if (enc) set['creditApp.ssnEncrypted'] = enc;
      else unset.push('creditApp.ssnEncrypted');
    }
  }
  if (ca?.consentGranted === true) {
    set['creditApp.consent'] = { granted: true, at: new Date(), ip: String(req.ip || ''), text: CONSENT_TEXT };
  } else if (ca?.consentGranted === false) {
    set['creditApp.consent'] = { granted: false };
  }
  for (const [k, v] of Object.entries(set)) if (v === undefined) {
    delete set[k];
    unset.push(k);
  }
  return { set, unset };
}

const EDITABLE_BY_SALES: DealStage[] = ['draft', 'needs_info', 'submitted'];
const EDITABLE_BY_REVIEWER: DealStage[] = ['draft', 'submitted', 'picked_up', 'needs_info', 'structured', 'ready_for_fi'];

async function loadDeal(req: Request, id: string = String(req.params.id)) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Deal not found');
  const ctx = await contextFromRequest(req);
  const deal = await DealDeskDeal.findOne({ _id: id, organizationId: new Types.ObjectId(ctx.actor.orgId) });
  if (!deal) throw new ApiError(404, 'Deal not found');
  assertCanView(ctx.actor, ctx.roles, deal);
  return { ...ctx, deal };
}

function submitProblems(d: any, requireDocs: boolean): string[] {
  const missing: string[] = [];
  if (!d.customer?.firstName || !d.customer?.lastName) missing.push('Customer name');
  if (!d.customer?.phone && !d.customer?.email) missing.push('Customer phone or email');
  if (!d.vehicle?.vin && !(d.vehicle?.year && d.vehicle?.make && d.vehicle?.model)) missing.push('Vehicle (VIN or year/make/model)');
  if (!(d.fourSquare?.salePrice > 0) && !(d.vehicle?.price > 0)) missing.push('Sale price');
  if (!(d.creditApp?.grossMonthlyIncome > 0)) missing.push('Gross monthly income');
  if (!d.creditApp?.consent?.granted) missing.push('Credit authorization');
  if (requireDocs) {
    const kinds = new Set((d.documents || []).map((x: any) => x.kind));
    for (const k of REQUIRED_DOCUMENTS) if (!kinds.has(k)) missing.push(`Document: ${k.replace(/_/g, ' ')}`);
  }
  return missing;
}

const ok = (res: Response, data: unknown, message = 'OK', status = 200) => res.status(status).json(new ApiResponse(status, data, message));

/* ───────────────────────── bootstrap ───────────────────────── */

export const getBootstrap = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles, settings } = await contextFromRequest(req);
  const presence = roles.isFm
    ? await DealDeskFmPresence.findOne({ organizationId: actor.orgId, userId: actor.id }).lean()
    : null;
  ok(res, {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    roles,
    settings: {
      sla: slaFor(settings),
      acceptWindowSeconds: settings.acceptWindowSeconds,
      requireDocsToSubmit: settings.requireDocsToSubmit,
      defaultTaxRate: settings.defaultTaxRate,
      defaultDocFee: settings.defaultDocFee,
      aiEnabled: settings.aiEnabled,
    },
    capabilities: { aiProvider: aiProvider(), piiEncryption: piiEncryptionAvailable() },
    myPresence: presence ? { available: !!(presence as any).available, activeDealCount: (presence as any).activeDealCount || 0 } : null,
    consentText: CONSENT_TEXT,
    requiredDocuments: REQUIRED_DOCUMENTS,
    documentKinds: DOCUMENT_KINDS,
  });
});

/* ───────────────────────── deals: list / read ───────────────────────── */

export const listDeals = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  const scope = String(req.query.scope || 'open');
  const filter: Record<string, any> = { organizationId: new Types.ObjectId(actor.orgId) };
  const me = new Types.ObjectId(actor.id);

  if (!roles.isStaff || scope === 'mine') filter.$or = [{ 'salesperson.id': me }, { 'createdBy.id': me }];

  if (scope === 'open') filter.stage = { $in: OPEN_STAGES };
  else if (scope === 'closed') filter.stage = { $in: CLOSED_STAGES };
  else if (scope === 'drafts') filter.stage = 'draft';
  else if (scope === 'mine') filter.stage = { $ne: 'cancelled' };
  else if (scope === 'needs_me') {
    const ors: any[] = [{ stage: 'needs_info', 'salesperson.id': me }];
    if (roles.isReviewer) ors.push({ stage: 'submitted' }, { stage: { $in: ['picked_up', 'structured'] }, 'reviewer.id': me });
    if (roles.isFm) ors.push({ stage: 'offered', 'offer.fmId': me }, { stage: 'in_fi', 'financeManager.id': me });
    if (roles.isManager) ors.push({ escalatedAt: { $ne: null }, stage: { $in: ['ready_for_fi', 'offered'] } });
    filter.$and = [{ $or: ors }];
    delete filter.$or;
    if (!roles.isStaff) filter.$and.push({ $or: [{ 'salesperson.id': me }, { 'createdBy.id': me }] });
  }

  const stages = String(req.query.stage || '')
    .split(',')
    .filter((s) => (DEAL_STAGES as readonly string[]).includes(s));
  if (stages.length) filter.stage = { $in: stages };
  if (['supra', 'web', 'crm'].includes(String(req.query.source))) filter.source = String(req.query.source);

  const q = String(req.query.q || '').trim();
  if (q) {
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const ors: any[] = [{ 'customer.firstName': rx }, { 'customer.lastName': rx }, { 'customer.phone': rx }, { 'customer.email': rx }, { 'vehicle.vin': rx }, { 'vehicle.stockNumber': rx }, { 'vehicle.make': rx }, { 'vehicle.model': rx }];
    const asNum = Number(q.replace(/^#/, ''));
    if (Number.isInteger(asNum)) ors.push({ dealNumber: asNum });
    filter.$and = [...(filter.$and || []), { $or: ors }];
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const sort: Record<string, 1 | -1> = scope === 'open' || scope === 'needs_me' ? { stageEnteredAt: 1 } : { updatedAt: -1 };

  const [deals, total] = await Promise.all([
    DealDeskDeal.find(filter)
      .select('-stageHistory -creditApp.ssnEncrypted -analysis.extraction -analysis.aiSummary')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DealDeskDeal.countDocuments(filter),
  ]);

  ok(res, { deals: deals.map(toDealSummary), total, page, limit });
});

export const getDeal = asyncHandler(async (req: Request, res: Response) => {
  const { deal, roles, actor } = await loadDeal(req);
  const [messages, events] = await Promise.all([
    DealDeskMessage.find({ dealId: deal._id }).sort({ createdAt: -1 }).limit(300).lean(),
    roles.isStaff || String(deal.salesperson?.id) === actor.id
      ? DealDeskEvent.find({ dealId: deal._id }).sort({ createdAt: -1 }).limit(200).lean()
      : Promise.resolve([]),
  ]);
  ok(res, {
    deal: toDealDetail(deal),
    messages: messages.reverse().map(toMessageDTO),
    events: (events as any[]).map((e) => ({ id: String(e._id), action: e.action, actorName: e.actorName, from: e.from, to: e.to, meta: e.meta, createdAt: e.createdAt })),
    permissions: permissionsFor(deal, actor, roles),
  });
});

function permissionsFor(deal: any, actor: any, roles: any) {
  const isOwner = String(deal.salesperson?.id) === actor.id || String(deal.createdBy?.id) === actor.id;
  const isOfferedToMe = deal.stage === 'offered' && String(deal.offer?.fmId) === actor.id;
  const isMyFi = String(deal.financeManager?.id) === actor.id;
  const stage = deal.stage as DealStage;
  return {
    edit: (isOwner && EDITABLE_BY_SALES.includes(stage)) || (roles.isReviewer && EDITABLE_BY_REVIEWER.includes(stage)) || (isMyFi && stage === 'in_fi'),
    submit: (isOwner || roles.isReviewer) && ['draft', 'needs_info'].includes(stage),
    pickup: roles.isReviewer && stage === 'submitted',
    returnToQueue: roles.isReviewer && stage === 'picked_up',
    analyze: roles.isReviewer && ['picked_up', 'structured'].includes(stage),
    requestInfo: roles.isReviewer && ['submitted', 'picked_up', 'structured'].includes(stage),
    approve: roles.isReviewer && stage === 'structured',
    approveOverride: roles.isManager,
    acceptOffer: isOfferedToMe,
    declineOffer: isOfferedToMe,
    release: (isMyFi || roles.isManager) && stage === 'in_fi',
    markSigned: (isMyFi || roles.isManager) && stage === 'in_fi',
    markFunded: (isMyFi || roles.isManager) && stage === 'signed',
    cancel: (roles.isReviewer || isOwner || isMyFi) && !['funded', 'cancelled', 'signed'].includes(stage),
    backToStructured: roles.isReviewer && stage === 'ready_for_fi',
    revealSsn: (isMyFi || roles.isManager) && !!deal.creditApp?.ssnLast4,
    uploadDocs: (isOwner || roles.isStaff) && !['funded', 'cancelled'].includes(stage),
    message: true,
  };
}

/* ───────────────────────── deals: write ───────────────────────── */

export const createDeal = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  const input = dealInputSchema.parse(req.body || {});
  const { set } = buildDealSet(input, req);

  let salesperson = { id: new Types.ObjectId(actor.id), name: actor.name };
  if (input.salespersonId && input.salespersonId !== actor.id) {
    if (!roles.isReviewer) throw new ApiError(403, 'Only the online sales team can create deals for someone else.');
    const sp: any = await CrmUser.findOne({ _id: input.salespersonId, organizationId: actor.orgId }).select('fullName').lean();
    if (!sp) throw new ApiError(400, 'Salesperson not found');
    salesperson = { id: sp._id, name: sp.fullName };
  }

  const now = new Date();
  const dealNumber = await nextDealNumber(actor.orgId);
  const deal = new DealDeskDeal({
    organizationId: new Types.ObjectId(actor.orgId),
    dealNumber,
    source: input.source || 'supra',
    stage: 'draft',
    stageEnteredAt: now,
    stageHistory: [{ stage: 'draft', enteredAt: now, actorId: new Types.ObjectId(actor.id), actorName: actor.name }],
    salesperson,
    createdBy: { id: new Types.ObjectId(actor.id), name: actor.name },
    lastActivityAt: now,
  });
  deal.set(set);
  await deal.save();
  await logEvent(deal, actor, 'created', { source: deal.source });
  emitDealChanged(deal, 'created');
  ok(res, { deal: toDealDetail(deal) }, 'Deal created', 201);
});

export const updateDeal = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  const perms = permissionsFor(deal, actor, roles);
  if (!perms.edit) throw new ApiError(403, 'You can’t edit this deal at its current stage.');
  const input = dealInputSchema.parse(req.body || {});
  const { set, unset } = buildDealSet(input, req);

  // FMs in F&I may only adjust the structure (products, rate-affecting fields).
  const isMyFiOnly = deal.stage === 'in_fi' && !roles.isReviewer;
  const allowed = Object.keys(set).filter((k) => !isMyFiOnly || k.startsWith('fourSquare.') || k.startsWith('vehicle.bookValue'));
  if (!allowed.length && !unset.length) return ok(res, { deal: toDealDetail(deal) }, 'No changes');

  const changedKeys = allowed;
  for (const k of allowed) deal.set(k, set[k]);
  for (const k of unset) deal.set(k, undefined);
  deal.lastActivityAt = new Date();
  await deal.save();
  await logEvent(deal, actor, 'edited', { fields: changedKeys.filter((k) => !k.includes('ssn')) });

  let fresh: any = deal;
  if (deal.analysis?.computedAt && ['structured', 'ready_for_fi', 'in_fi'].includes(deal.stage)) {
    fresh = (await recomputeNumbers(String(deal._id))) || deal;
  }
  emitDealChanged(fresh, 'edited');
  ok(res, { deal: toDealDetail(fresh) }, 'Deal updated');
});

export const submitDeal = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles, settings } = await loadDeal(req);
  if (!permissionsFor(deal, actor, roles).submit) throw new ApiError(403, 'You can’t submit this deal.');
  const problems = submitProblems(deal, settings.requireDocsToSubmit);
  if (problems.length) throw new ApiError(400, `Complete these before submitting: ${problems.join(', ')}.`);
  const resubmit = deal.stage === 'needs_info';
  const updated = await transition(deal, 'submitted', actor, {
    action: resubmit ? 'resubmitted' : 'submitted',
    unset: resubmit ? ['needsInfoNote'] : [],
    systemMessage: resubmit ? `📨 ${actor.name} updated the deal and sent it back to the queue.` : `📥 ${actor.name} submitted Deal #${deal.dealNumber}.`,
  });
  if (resubmit && deal.reviewer?.id) emitToUser(String(deal.reviewer.id), 'deal:resubmitted', toDealSummary(updated));
  ok(res, { deal: toDealDetail(updated) }, 'Deal submitted');
});

export const pickupDeal = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  assertReviewer(roles);
  const updated = await transition(deal, 'picked_up', actor, {
    set: { reviewer: { id: new Types.ObjectId(actor.id), name: actor.name } },
    action: 'picked_up',
    systemMessage: `👋 ${actor.name} picked up the deal.`,
  });
  ok(res, { deal: toDealDetail(updated) }, 'Deal picked up');
});

export const returnToQueue = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  assertReviewer(roles);
  const updated = await transition(deal, 'submitted', actor, {
    unset: ['reviewer'],
    action: 'returned_to_queue',
    systemMessage: `↩ ${actor.name} put the deal back in the queue.`,
  });
  ok(res, { deal: toDealDetail(updated) }, 'Returned to queue');
});

export const analyzeDealHandler = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  assertReviewer(roles);
  const updated = await startAnalysis(String(deal._id), actor);
  ok(res, { deal: toDealDetail(updated) }, 'Deal Builder started', 202);
});

export const requestInfo = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  assertReviewer(roles);
  const note = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body || {}).note;
  const updated = await transition(deal, 'needs_info', actor, {
    set: { needsInfoNote: note },
    action: 'needs_info',
    meta: { note },
    systemMessage: `📝 ${actor.name} needs more info: ${note}`,
  });
  if (deal.salesperson?.id) emitToUser(String(deal.salesperson.id), 'deal:needs_info', { deal: toDealSummary(updated), note });
  ok(res, { deal: toDealDetail(updated) }, 'Sent back to salesperson');
});

export const approveDeal = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  assertReviewer(roles);
  const { override, note } = z.object({ override: z.boolean().optional(), note: z.string().max(500).optional() }).parse(req.body || {});
  if (hasBlockingFlags(deal.analysis?.flags as any)) {
    if (!override) throw new ApiError(400, 'This deal has blocking issues. Fix them, or a manager can approve with override.');
    assertManager(roles);
  }
  const updated = await transition(deal, 'ready_for_fi', actor, {
    set: { offer: { round: 1 }, escalatedAt: null },
    action: 'approved',
    meta: { override: !!override, note },
    systemMessage: `🚀 ${actor.name} approved the deal for F&I${override ? ' (manager override)' : ''}. Finding a Finance Manager…`,
  });
  if (updated) await offerNext(updated._id as Types.ObjectId);
  const fresh = await DealDeskDeal.findById(deal._id);
  ok(res, { deal: toDealDetail(fresh) }, 'Approved for F&I');
});

export const acceptOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor } = await loadDeal(req);
  const updated = await acceptOffer(String(deal._id), actor);
  ok(res, { deal: toDealDetail(updated) }, 'Deal accepted');
});

export const declineOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor } = await loadDeal(req);
  await declineOffer(String(deal._id), actor);
  const fresh = await DealDeskDeal.findById(deal._id);
  ok(res, { deal: toDealDetail(fresh) }, 'Passed to the next Finance Manager');
});

export const releaseHandler = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  if (!permissionsFor(deal, actor, roles).release) throw new ApiError(403, 'You can’t release this deal.');
  const reason = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {}).reason;
  await releaseDeal(String(deal._id), actor, reason);
  const fresh = await DealDeskDeal.findById(deal._id);
  ok(res, { deal: toDealDetail(fresh) }, 'Released to the F&I queue');
});

export const changeStage = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  const { to, reason } = z
    .object({ to: z.enum(['signed', 'funded', 'cancelled', 'structured']), reason: z.string().max(500).optional() })
    .parse(req.body || {});
  const perms = permissionsFor(deal, actor, roles);
  const allowed = (to === 'signed' && perms.markSigned) || (to === 'funded' && perms.markFunded) || (to === 'cancelled' && perms.cancel) || (to === 'structured' && perms.backToStructured);
  if (!allowed) throw new ApiError(403, 'You can’t make that change.');
  if (to === 'cancelled' && !reason) throw new ApiError(400, 'Add a reason for cancelling.');

  const wasInFi = deal.stage === 'in_fi';
  const wasOffered = deal.stage === 'offered' ? String(deal.offer?.fmId || '') : '';
  const messages: Record<string, string> = {
    signed: `🖊 ${actor.name} marked the deal signed.`,
    funded: `💰 ${actor.name} marked the deal funded.`,
    cancelled: `🛑 ${actor.name} cancelled the deal: ${reason}`,
    structured: `↩ ${actor.name} pulled the deal back from the F&I queue.`,
  };
  const updated = await transition(deal, to, actor, {
    set: to === 'cancelled' ? { cancelReason: reason, offer: { round: 1 } } : to === 'structured' ? { offer: { round: 1 }, escalatedAt: null } : {},
    action: to,
    meta: { reason },
    systemMessage: messages[to],
  });
  if (wasInFi && (to === 'signed' || to === 'cancelled')) await onLeaveFi(deal);
  if (wasOffered) emitToUser(wasOffered, 'offer:cleared', { dealId: String(deal._id), reason: 'withdrawn' });
  ok(res, { deal: toDealDetail(updated) }, 'Deal updated');
});

export const revealSsn = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  if (!permissionsFor(deal, actor, roles).revealSsn) throw new ApiError(403, 'Not allowed');
  const withSecret: any = await DealDeskDeal.findById(deal._id).select('+creditApp.ssnEncrypted').lean();
  const ssn = decryptPii(withSecret?.creditApp?.ssnEncrypted);
  await logEvent(deal, actor, 'ssn_revealed');
  if (!ssn) throw new ApiError(404, 'Only the last 4 digits are on file.');
  res.setHeader('Cache-Control', 'no-store');
  ok(res, { ssn: `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}` }, 'Revealed — this view was logged');
});

/* ───────────────────────── documents ───────────────────────── */

export const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  if (!permissionsFor(deal, actor, roles).uploadDocs) throw new ApiError(403, 'You can’t add documents to this deal.');
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) throw new ApiError(400, 'Choose a file to upload.');
  const kind = String(req.body?.kind || 'other');
  if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, 'Unknown document type.');

  let key: string;
  try {
    key = await putDealFile(actor.orgId, String(deal._id), file);
  } catch (err: any) {
    console.error('[deal-desk] document upload failed', err?.message);
    throw new ApiError(503, 'Couldn’t save the document to storage. Please try again in a moment.');
  }
  deal.documents.push({
    kind: kind as any,
    name: file.originalname.slice(0, 200),
    key,
    mime: file.mimetype,
    size: file.size,
    uploadedBy: { id: new Types.ObjectId(actor.id), name: actor.name },
    uploadedAt: new Date(),
  } as any);
  deal.lastActivityAt = new Date();
  await deal.save();
  await logEvent(deal, actor, 'document_uploaded', { kind, name: file.originalname });
  emitDealChanged(deal, 'document_uploaded');
  ok(res, { deal: toDealDetail(deal) }, 'Document uploaded', 201);
});

export const getDocument = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor } = await loadDeal(req);
  const doc: any = deal.documents.id(String(req.params.docId));
  if (!doc) throw new ApiError(404, 'Document not found');
  const file = await getDealFileStream(doc.key);
  if (!file) throw new ApiError(404, 'This document is missing from storage.');
  const { stream } = file;
  await logEvent(deal, actor, 'document_viewed', { docId: String(doc._id), kind: doc.kind });
  // storage.service guesses image/jpeg for private files — the type saved at upload is exact
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

export const deleteDocument = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor, roles } = await loadDeal(req);
  const doc: any = deal.documents.id(String(req.params.docId));
  if (!doc) throw new ApiError(404, 'Document not found');
  const isUploader = String(doc.uploadedBy?.id) === actor.id;
  if (!(roles.isReviewer || (isUploader && EDITABLE_BY_SALES.includes(deal.stage as DealStage)))) throw new ApiError(403, 'You can’t remove this document.');
  const key = doc.key;
  doc.deleteOne();
  await deal.save();
  deleteDealFile(key).catch(() => {});
  await logEvent(deal, actor, 'document_deleted', { kind: doc.kind, name: doc.name });
  emitDealChanged(deal, 'document_deleted');
  ok(res, { deal: toDealDetail(deal) }, 'Document removed');
});

/* ───────────────────────── thread ───────────────────────── */

export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const { deal } = await loadDeal(req);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const msgs = await DealDeskMessage.find({ dealId: deal._id, ...(before ? { createdAt: { $lt: before } } : {}) })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  ok(res, { messages: msgs.reverse().map(toMessageDTO) });
});

export const postMessage = asyncHandler(async (req: Request, res: Response) => {
  const { deal, actor } = await loadDeal(req);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body || {});
  const msg = await DealDeskMessage.create({
    organizationId: deal.organizationId,
    dealId: deal._id,
    kind: 'user',
    authorId: new Types.ObjectId(actor.id),
    authorName: actor.name,
    body,
  });
  await DealDeskDeal.updateOne({ _id: deal._id }, { $set: { lastActivityAt: new Date() } });
  emitDealMessage(msg);
  // ping the other people on the deal who may not have it open
  const notify = new Set([deal.salesperson?.id, deal.reviewer?.id, deal.financeManager?.id].filter(Boolean).map(String));
  notify.delete(actor.id);
  for (const uid of notify) emitToUser(uid, 'deal:mention', { dealId: String(deal._id), dealNumber: deal.dealNumber, from: actor.name, preview: body.slice(0, 120) });
  ok(res, { message: toMessageDTO(msg) }, 'Sent', 201);
});

/* ───────────────────────── queue metrics ───────────────────────── */

export const getMetrics = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  const range = (['today', '7d', '30d', '90d'].includes(String(req.query.range)) ? req.query.range : '7d') as MetricsRange;
  const tz = Number(req.query.tzOffset);
  const metrics = await getQueueMetrics(actor.orgId, range, roles.isStaff ? {} : { onlySalespersonId: actor.id }, Number.isFinite(tz) ? tz : 0);
  ok(res, metrics);
});

/* ───────────────────────── finance managers ───────────────────────── */

export const getPresence = asyncHandler(async (req: Request, res: Response) => {
  const { actor } = await contextFromRequest(req);
  ok(res, { presence: await listPresence(actor.orgId) });
});

export const updateAvailability = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  if (!roles.isFm) throw new ApiError(403, 'Only Finance Managers set availability.');
  const { available } = z.object({ available: z.boolean() }).parse(req.body || {});
  const p = await setAvailability(actor, available);
  ok(res, { available: p.available, activeDealCount: p.activeDealCount }, available ? 'You’re available for deals' : 'You’re off the rotation');
});

/* ───────────────────────── settings ───────────────────────── */

const idList = z.array(z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id')).max(200);

const settingsSchema = z
  .object({
    reviewerIds: idList,
    financeManagerIds: idList,
    managerIds: idList,
    acceptWindowSeconds: z.number().int().min(60).max(1800),
    maxRoundsBeforeEscalation: z.number().int().min(1).max(5),
    maxActiveDealsPerFm: z.number().int().min(1).max(20),
    slaMinutes: z.record(z.string(), z.number().min(1).max(10080)),
    defaultTaxRate: z.number().min(0).max(20),
    defaultDocFee: z.number().min(0).max(5000),
    maxRateMarkup: z.number().min(0).max(5),
    aiEnabled: z.boolean(),
    requireDocsToSubmit: z.boolean(),
    widget: z
      .object({
        enabled: z.boolean(),
        allowedOrigins: z.array(z.string().url().max(200)).max(20),
        depositAmount: z.number().min(0).max(10000),
        headline: z.string().max(120),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .partial(),
  })
  .partial();

export const getSettingsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { settings, roles } = await contextFromRequest(req);
  if (!roles.isStaff) throw new ApiError(403, 'Not allowed');
  const s: any = settings.toObject ? settings.toObject() : settings;
  const org: any = await Organization.findById(settings.organizationId).select('slug name').lean();
  ok(res, {
    ...s,
    orgKey: org?.slug || '',
    dealerName: org?.name || '',
    reviewerIds: (s.reviewerIds || []).map(String),
    financeManagerIds: (s.financeManagerIds || []).map(String),
    managerIds: (s.managerIds || []).map(String),
    slaMinutes: slaFor(settings),
  });
});

export const updateSettingsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  assertAdmin(roles);
  const body = settingsSchema.parse(req.body || {});
  const org = new Types.ObjectId(actor.orgId);

  const allIds = [...(body.reviewerIds || []), ...(body.financeManagerIds || []), ...(body.managerIds || [])];
  const people: any[] = allIds.length
    ? await CrmUser.find({ _id: { $in: allIds }, organizationId: org }).select('fullName').lean()
    : [];
  const known = new Set(people.map((p) => String(p._id)));
  const unknown = allIds.filter((id) => !known.has(id));
  if (unknown.length) throw new ApiError(400, 'One of the selected people is not in this organization. Refresh and try again.');

  const $set: Record<string, unknown> = { updatedBy: new Types.ObjectId(actor.id) };
  for (const [k, v] of Object.entries(body)) {
    if (k === 'widget' && v) for (const [wk, wv] of Object.entries(v)) $set[`widget.${wk}`] = wv;
    else if (k.endsWith('Ids')) $set[k] = (v as string[]).map((id) => new Types.ObjectId(id));
    else $set[k] = v;
  }
  const saved = await DealDeskSettings.findOneAndUpdate({ organizationId: org }, { $set }, { upsert: true, new: true, setDefaultsOnInsert: true });
  invalidateSettings(actor.orgId);

  if (body.financeManagerIds) {
    const names = new Map(people.map((p) => [String(p._id), p.fullName]));
    await Promise.all(
      body.financeManagerIds.map((id) =>
        DealDeskFmPresence.updateOne({ organizationId: org, userId: new Types.ObjectId(id) }, { $set: { name: names.get(id) || '' } }, { upsert: true }),
      ),
    );
    await emitPresence(actor.orgId);
  }
  emitToStaff(actor.orgId, 'settings:changed', {});
  for (const id of allIds) emitToUser(id, 'settings:changed', {});
  ok(res, saved, 'Deal Desk settings saved');
});

export const listPeople = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  if (!roles.isStaff) throw new ApiError(403, 'Not allowed');
  const people = await CrmUser.find({ organizationId: actor.orgId, isActive: true, isSystem: { $ne: true } })
    .select('fullName email role avatar department')
    .sort({ fullName: 1 })
    .limit(1000)
    .lean();
  ok(res, { people: (people as any[]).map((p) => ({ id: String(p._id), name: p.fullName, email: p.email, role: p.role, avatar: p.avatar, department: p.department })) });
});

/* ───────────────────────── lender matrix ───────────────────────── */

const lenderSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['bank', 'credit_union', 'captive', 'subprime', 'other']).default('bank'),
  active: z.boolean().default(true),
  minScore: num,
  maxLtv: num,
  maxDti: num,
  maxPti: num,
  maxTerm: num,
  minAmount: num,
  maxAmount: num,
  maxMileage: num,
  maxVehicleAge: num,
  rateTiers: z.array(z.object({ minScore: z.number().min(0).max(900), rate: z.number().min(0).max(40) })).max(15).default([]),
  notes: z.string().max(1000).optional(),
});

export const listLenders = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  if (!roles.isStaff) throw new ApiError(403, 'Not allowed');
  const lenders = await DealDeskLender.find({ organizationId: actor.orgId }).sort({ active: -1, name: 1 }).lean();
  ok(res, { lenders: lenders.map((l: any) => ({ ...l, id: String(l._id) })) });
});

export const createLender = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  assertAdmin(roles);
  const body = lenderSchema.parse(req.body || {});
  const lender = await DealDeskLender.create({ ...body, organizationId: new Types.ObjectId(actor.orgId) });
  ok(res, { lender: { ...lender.toObject(), id: String(lender._id) } }, 'Lender added', 201);
});

export const updateLender = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  assertAdmin(roles);
  if (!mongoose.isValidObjectId(String(req.params.lenderId))) throw new ApiError(404, 'Lender not found');
  const body = lenderSchema.partial().parse(req.body || {});
  const lender = await DealDeskLender.findOneAndUpdate({ _id: String(req.params.lenderId), organizationId: actor.orgId }, { $set: body }, { new: true });
  if (!lender) throw new ApiError(404, 'Lender not found');
  ok(res, { lender: { ...lender.toObject(), id: String(lender._id) } }, 'Lender updated');
});

export const deleteLender = asyncHandler(async (req: Request, res: Response) => {
  const { actor, roles } = await contextFromRequest(req);
  assertAdmin(roles);
  const r = await DealDeskLender.deleteOne({ _id: String(req.params.lenderId), organizationId: actor.orgId });
  if (!r.deletedCount) throw new ApiError(404, 'Lender not found');
  ok(res, null, 'Lender removed');
});

export const _internal = { buildDealSet, submitProblems, permissionsFor, postSystemMessage };
