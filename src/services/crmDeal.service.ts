import mongoose from 'mongoose';
import CrmDeal, { CRM_DEAL_STAGES, CrmDealStage, DealActor, ICrmDeal } from '../models/CrmDeal.model';
import Lead from '../models/lead.model';
import { ApiError } from '../utils/ApiError';
import { CrmStaff, isManagerOrAdmin, listStaffTeam, orgIdVariants, requireTeamMember, staffName, staffTeamQuery } from '../utils/crmStaff';
import { isContactRestrictedStatus } from '../constants/leadStatus';
import User from '../models/User.model';

export const DEAL_STAGE_LABELS: Record<CrmDealStage, string> = {
  new: 'New',
  working: 'Working',
  offer_sent: 'Offer sent',
  negotiating: 'Negotiating',
  won: 'Won',
  lost: 'Lost',
};

export const OPEN_DEAL_STAGES: CrmDealStage[] = ['new', 'working', 'offer_sent', 'negotiating'];
const MAX_AMOUNT = 10_000_000;
const MAX_TITLE = 150;
const MAX_NOTE = 500;
const MAX_REASON = 300;
const LIST_LIMIT = 300;

function fullName(lead: any): string {
  return [lead?.firstName, lead?.lastName].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function vehicleFromLead(lead: any) {
  const vehicle = lead?.vehicle || {};
  return {
    vehicleId: lead?.vehicleId || null,
    label: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ').slice(0, 160),
    vin: String(vehicle.vin || '').trim(),
    stock: String(vehicle.stock || '').trim(),
  };
}

function cleanAmount(value: unknown, label: string, required = false): number | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ApiError(400, `Enter the ${label}`);
    return null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw new ApiError(400, `The ${label} must be between $0 and $${MAX_AMOUNT.toLocaleString('en-US')}`);
  return Math.round(amount * 100) / 100;
}

function cleanText(value: unknown, max: number, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw new ApiError(400, `Keep the ${label} under ${max} characters`);
  return text;
}

function cleanStage(value: unknown): CrmDealStage {
  if (!CRM_DEAL_STAGES.includes(value as CrmDealStage)) throw new ApiError(400, 'Pick a stage from the list');
  return value as CrmDealStage;
}

export function canSeeDealAmounts(staff: CrmStaff, deal: { assignedTo?: unknown }): boolean {
  if (isManagerOrAdmin(staff)) return true;
  return Boolean(staff.userId && deal.assignedTo && String(deal.assignedTo) === staff.userId);
}

function serialize(doc: any, staff: CrmStaff) {
  const visible = canSeeDealAmounts(staff, doc);
  return {
    id: String(doc._id),
    leadId: String(doc.leadId),
    customerId: doc.customerId ? String(doc.customerId) : null,
    title: doc.title,
    customerName: doc.customerName || '',
    vehicle: { label: doc.vehicle?.label || '', vin: doc.vehicle?.vin || '', stock: doc.vehicle?.stock || '' },
    stage: doc.stage,
    stageLabel: DEAL_STAGE_LABELS[doc.stage as CrmDealStage] || doc.stage,
    amountsVisible: visible,
    canEdit: visible,
    amount: visible ? doc.amount ?? null : null,
    offers: (doc.offers || []).map((offer: any) => ({
      id: String(offer._id),
      from: offer.from,
      amount: visible ? offer.amount : null,
      note: visible ? offer.note || '' : '',
      by: offer.by,
      at: offer.at,
    })),
    assignedTo: doc.assignedTo ? String(doc.assignedTo) : null,
    assignedName: doc.assignedName || '',
    lostReason: doc.lostReason || '',
    wonAt: doc.wonAt || null,
    lostAt: doc.lostAt || null,
    createdBy: { name: doc.createdBy?.name || '', kind: doc.createdBy?.kind || 'staff' },
    history: (doc.history || []).slice(-30).map((entry: any) => ({
      action: entry.action,
      from: entry.action === 'amount' && !visible ? null : entry.from,
      to: entry.action === 'amount' && !visible ? null : entry.to,
      by: entry.by,
      at: entry.at,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function loadDeal(orgId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Deal not found');
  const doc = await CrmDeal.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new ApiError(404, 'Deal not found');
  return doc;
}

function requireEditor(staff: CrmStaff, doc: ICrmDeal) {
  if (!canSeeDealAmounts(staff, doc)) throw new ApiError(403, 'Only managers, admins and the assigned team member can change this deal');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listDeals(orgId: string, staff: CrmStaff, query: any) {
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (query?.customerId) {
    if (!mongoose.isValidObjectId(String(query.customerId))) throw new ApiError(400, 'That customer is not valid');
    const leads = await Lead.find({ organizationId: { $in: orgIdVariants(orgId) }, customerId: query.customerId }).select('_id').lean();
    filter.$or = [{ customerId: new mongoose.Types.ObjectId(String(query.customerId)) }, { leadId: { $in: leads.map((lead: any) => lead._id) } }];
  }
  if (query?.leadId) {
    if (!mongoose.isValidObjectId(String(query.leadId))) throw new ApiError(400, 'That lead is not valid');
    filter.leadId = new mongoose.Types.ObjectId(String(query.leadId));
  }
  if (query?.mine === 'true') filter.assignedTo = staff.userId && mongoose.isValidObjectId(staff.userId) ? new mongoose.Types.ObjectId(staff.userId) : { $in: [] };
  const search = typeof query?.search === 'string' ? query.search.trim().slice(0, 80) : '';
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$and = [{ $or: [{ title: pattern }, { customerName: pattern }, { 'vehicle.label': pattern }, { 'vehicle.vin': pattern }, { 'vehicle.stock': pattern }] }];
  }
  const [docs, team] = await Promise.all([
    CrmDeal.find(filter).sort({ updatedAt: -1 }).limit(LIST_LIMIT).lean(),
    listStaffTeam(orgId),
  ]);
  return {
    items: docs.map((doc) => serialize(doc, staff)),
    stages: CRM_DEAL_STAGES.map((value) => ({ value, label: DEAL_STAGE_LABELS[value] })),
    team,
    canAssign: isManagerOrAdmin(staff),
    viewerUserId: staff.userId,
  };
}

export async function getDeal(orgId: string, staff: CrmStaff, id: string) {
  return serialize((await loadDeal(orgId, id)).toObject(), staff);
}

export async function searchDealLeads(orgId: string, raw: unknown) {
  const search = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  if (search.length < 2) return [];
  const pattern = new RegExp(escapeRegex(search), 'i');
  const digits = search.replace(/\D/g, '');
  const or: any[] = [{ firstName: pattern }, { lastName: pattern }, { email: pattern }];
  const words = search.split(/\s+/).filter(Boolean);
  if (words.length >= 2) or.push({ firstName: new RegExp(`^${escapeRegex(words[0])}`, 'i'), lastName: new RegExp(`^${escapeRegex(words.slice(1).join(' '))}`, 'i') });
  if (digits.length >= 4) or.push({ normalizedPhone: new RegExp(escapeRegex(digits.slice(-10))) });
  const leads = await Lead.find({ organizationId: { $in: orgIdVariants(orgId) }, source: { $ne: 'Demo' }, $or: or })
    .select('firstName lastName phone email status vehicle createdAt')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  return leads.map((lead: any) => ({
    id: String(lead._id),
    name: fullName(lead) || 'Unnamed lead',
    phone: lead.phone || '',
    email: lead.email || '',
    status: lead.status || '',
    vehicle: vehicleFromLead(lead).label,
    createdAt: lead.createdAt,
  }));
}

export async function createDeal(orgId: string, staff: CrmStaff, body: any) {
  const leadId = String(body?.leadId || '');
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(400, 'Pick the lead for this deal');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: { $in: orgIdVariants(orgId) } }).select('firstName lastName customerId vehicle vehicleId assignedTo').lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  const name = fullName(lead) || 'Customer';
  const leadVehicle = vehicleFromLead(lead);
  const vehicleLabel = body?.vehicle?.label !== undefined ? cleanText(body.vehicle.label, 160, 'vehicle') : leadVehicle.label;
  const title = cleanText(body?.title, MAX_TITLE, 'title') || `${name}${vehicleLabel ? ` - ${vehicleLabel}` : ''}`.slice(0, MAX_TITLE);
  const stage = body?.stage === undefined ? 'new' : cleanStage(body.stage);
  if (!OPEN_DEAL_STAGES.includes(stage)) throw new ApiError(400, 'A new deal starts in an open stage. Mark it Won or Lost after it is created.');
  let assignee: { id: mongoose.Types.ObjectId; name: string } | null = null;
  if (isManagerOrAdmin(staff)) {
    assignee = body?.assignedTo !== undefined ? await requireTeamMember(orgId, body.assignedTo) : lead.assignedTo ? await requireTeamMember(orgId, lead.assignedTo).catch(() => null) : null;
  } else if (staff.userId) {
    assignee = await requireTeamMember(orgId, staff.userId).catch(() => null);
  }
  if (!isManagerOrAdmin(staff) && !assignee) throw new ApiError(403, 'Your Suprah login is not linked to a team member, so you cannot own a deal. Ask a manager to create it.');
  const amount = cleanAmount(body?.amount, 'deal amount');
  const by: DealActor = { userId: staff.actorId, name: staff.name };
  const doc = await CrmDeal.create({
    organizationId: orgId,
    leadId: lead._id,
    customerId: lead.customerId || null,
    title,
    customerName: name,
    vehicle: {
      vehicleId: leadVehicle.vehicleId,
      label: vehicleLabel,
      vin: body?.vehicle?.vin !== undefined ? cleanText(body.vehicle.vin, 40, 'VIN') : leadVehicle.vin,
      stock: body?.vehicle?.stock !== undefined ? cleanText(body.vehicle.stock, 40, 'stock number') : leadVehicle.stock,
    },
    stage,
    amount,
    assignedTo: assignee?.id || null,
    assignedName: assignee?.name || '',
    history: [{ action: 'created', from: null, to: stage, by, at: new Date() }],
    createdBy: { ...by, kind: 'staff' },
  });
  return serialize(doc.toObject(), staff);
}

async function markLeadSold(orgId: string, leadId: unknown, by: DealActor): Promise<'changed' | 'already' | 'do_not_contact' | 'missing' | 'conflict'> {
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: { $in: orgIdVariants(orgId) } }).select('status').lean();
  if (!lead) return 'missing';
  if (lead.status === 'Sold') return 'already';
  if (isContactRestrictedStatus(lead.status)) return 'do_not_contact';
  const changedBy = mongoose.isValidObjectId(by.userId) ? new mongoose.Types.ObjectId(by.userId) : undefined;
  const updated = await Lead.updateOne(
    { _id: lead._id, status: lead.status },
    { $set: { status: 'Sold', isPending: false }, $push: { statusHistory: { from: lead.status, to: 'Sold', changedAt: new Date(), changedBy, reason: `Deal won (by ${by.name})` } } },
  );
  return updated.modifiedCount ? 'changed' : 'conflict';
}

export async function updateDeal(orgId: string, staff: CrmStaff, id: string, body: any) {
  const doc = await loadDeal(orgId, id);
  requireEditor(staff, doc);
  const by: DealActor = { userId: staff.actorId, name: staff.name };
  const now = new Date();
  let leadSold: string | null = null;
  if (body?.title !== undefined) {
    const title = cleanText(body.title, MAX_TITLE, 'title');
    if (!title) throw new ApiError(400, 'Give the deal a title');
    doc.title = title;
  }
  if (body?.vehicle !== undefined) {
    doc.vehicle = {
      vehicleId: doc.vehicle?.vehicleId || null,
      label: body.vehicle?.label !== undefined ? cleanText(body.vehicle.label, 160, 'vehicle') : doc.vehicle?.label || '',
      vin: body.vehicle?.vin !== undefined ? cleanText(body.vehicle.vin, 40, 'VIN') : doc.vehicle?.vin || '',
      stock: body.vehicle?.stock !== undefined ? cleanText(body.vehicle.stock, 40, 'stock number') : doc.vehicle?.stock || '',
    } as any;
  }
  if (body?.amount !== undefined) {
    const amount = cleanAmount(body.amount, 'deal amount');
    if (amount !== (doc.amount ?? null)) {
      doc.history.push({ action: 'amount', from: doc.amount === null || doc.amount === undefined ? null : String(doc.amount), to: amount === null ? null : String(amount), by, at: now });
      doc.amount = amount;
    }
  }
  if (body?.assignedTo !== undefined) {
    if (!isManagerOrAdmin(staff)) throw new ApiError(403, 'Only managers and admins can change who owns a deal');
    const assignee = await requireTeamMember(orgId, body.assignedTo);
    const next = assignee ? String(assignee.id) : null;
    if (next !== (doc.assignedTo ? String(doc.assignedTo) : null)) {
      doc.history.push({ action: 'assigned', from: doc.assignedName || null, to: assignee?.name || null, by, at: now });
      doc.assignedTo = assignee?.id || null;
      doc.assignedName = assignee?.name || '';
    }
  }
  if (body?.stage !== undefined) {
    const stage = cleanStage(body.stage);
    if (stage === 'lost') {
      const reason = cleanText(body.lostReason, MAX_REASON, 'reason');
      if (!reason) throw new ApiError(400, 'Say why the deal was lost');
      doc.lostReason = reason;
    }
    if (stage !== doc.stage) {
      doc.history.push({ action: 'stage', from: doc.stage, to: stage, by, at: now });
      doc.stage = stage;
      doc.wonAt = stage === 'won' ? now : null;
      doc.lostAt = stage === 'lost' ? now : null;
      if (stage !== 'lost') doc.lostReason = '';
    }
    if (stage === 'won' && body?.markLeadSold === true) {
      leadSold = await markLeadSold(orgId, doc.leadId, by);
      if (leadSold === 'changed') doc.history.push({ action: 'lead_sold', from: null, to: 'Sold', by, at: now });
    }
  }
  await doc.save();
  return { deal: serialize(doc.toObject(), staff), leadSold };
}

export async function addDealOffer(orgId: string, staff: CrmStaff, id: string, body: any) {
  const doc = await loadDeal(orgId, id);
  requireEditor(staff, doc);
  const amount = cleanAmount(body?.amount, 'offer amount', true) as number;
  const from = body?.from === 'customer' || body?.from === 'dealership' ? body.from : null;
  if (!from) throw new ApiError(400, 'Choose who made the offer');
  const note = cleanText(body?.note, MAX_NOTE, 'note');
  const by: DealActor = { userId: staff.actorId, name: staff.name };
  const now = new Date();
  doc.offers.push({ amount, from, note, by, at: now } as any);
  doc.history.push({ action: 'offer', from: null, to: from, by, at: now });
  await doc.save();
  return serialize(doc.toObject(), staff);
}

export async function deleteDeal(orgId: string, staff: CrmStaff, id: string) {
  if (!isManagerOrAdmin(staff)) throw new ApiError(403, 'Only managers and admins can delete a deal');
  const doc = await loadDeal(orgId, id);
  await doc.deleteOne();
}

export async function createDealFromAutomation(input: { organizationId: string; leadId: string | null; stage: CrmDealStage; automationId: string; automationName: string; test: boolean }): Promise<{ status: 'done' | 'skipped' | 'test'; detail: string }> {
  if (!input.leadId || !mongoose.isValidObjectId(input.leadId)) return { status: 'skipped', detail: 'No lead for the deal' };
  const lead: any = await Lead.findOne({ _id: input.leadId, organizationId: { $in: orgIdVariants(input.organizationId) } }).select('firstName lastName customerId vehicle vehicleId assignedTo').lean();
  if (!lead) return { status: 'skipped', detail: 'The lead was not found' };
  const open = await CrmDeal.exists({ organizationId: input.organizationId, leadId: lead._id, stage: { $in: OPEN_DEAL_STAGES } });
  if (open) return { status: 'skipped', detail: 'This lead already has an open deal' };
  const stageLabel = DEAL_STAGE_LABELS[input.stage];
  if (input.test) return { status: 'test', detail: `Would create a deal in ${stageLabel}` };
  const assignee: any = lead.assignedTo ? await User.findOne({ _id: lead.assignedTo, ...staffTeamQuery(input.organizationId) }).select('name email').lean() : null;
  const name = fullName(lead) || 'Customer';
  const vehicle = vehicleFromLead(lead);
  const by: DealActor = { userId: 'automation', name: `Automation - ${input.automationName}`.slice(0, 160) };
  await CrmDeal.create({
    organizationId: input.organizationId,
    leadId: lead._id,
    customerId: lead.customerId || null,
    title: `${name}${vehicle.label ? ` - ${vehicle.label}` : ''}`.slice(0, MAX_TITLE),
    customerName: name,
    vehicle,
    stage: input.stage,
    assignedTo: assignee?._id || null,
    assignedName: assignee ? staffName(assignee) : '',
    history: [{ action: 'created', from: null, to: input.stage, by, at: new Date() }],
    createdBy: { ...by, kind: 'automation' },
    automationId: input.automationId,
  });
  return { status: 'done', detail: `Created a deal in ${stageLabel}` };
}

export async function moveDealFromAutomation(input: { organizationId: string; leadId: string | null; stage: CrmDealStage; automationName: string; test: boolean }): Promise<{ status: 'done' | 'skipped' | 'test'; detail: string }> {
  if (!input.leadId || !mongoose.isValidObjectId(input.leadId)) return { status: 'skipped', detail: 'No lead for the deal' };
  const doc = await CrmDeal.findOne({ organizationId: input.organizationId, leadId: input.leadId, stage: { $in: OPEN_DEAL_STAGES } }).sort({ updatedAt: -1 });
  if (!doc) return { status: 'skipped', detail: 'This lead has no open deal to move' };
  const stageLabel = DEAL_STAGE_LABELS[input.stage];
  if (doc.stage === input.stage) return { status: 'done', detail: `The deal is already in ${stageLabel}` };
  if (input.test) return { status: 'test', detail: `Would move the deal from ${DEAL_STAGE_LABELS[doc.stage]} to ${stageLabel}` };
  const from = doc.stage;
  const now = new Date();
  const by: DealActor = { userId: 'automation', name: `Automation - ${input.automationName}`.slice(0, 160) };
  doc.history.push({ action: 'stage', from, to: input.stage, by, at: now });
  doc.stage = input.stage;
  doc.wonAt = input.stage === 'won' ? now : null;
  doc.lostAt = input.stage === 'lost' ? now : null;
  doc.lostReason = input.stage === 'lost' ? `Moved by the automation "${input.automationName}"`.slice(0, MAX_REASON) : '';
  await doc.save();
  return { status: 'done', detail: `Moved the deal from ${DEAL_STAGE_LABELS[from]} to ${stageLabel}` };
}
