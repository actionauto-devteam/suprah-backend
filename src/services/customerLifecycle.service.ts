import mongoose from 'mongoose';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import LeadInquiry from '../models/LeadInquiry.model';
import Vehicle from '../models/Vehicle.model';
import User from '../models/User.model';
import { LEAD_STATUS_CATEGORIES, TERMINAL_LEAD_STATUSES } from '../constants/leadStatus';
import { normalizeLeadSourceForDisplay } from '../constants/leadSource';
import { ApiError } from '../utils/ApiError';

export type LifecycleCategory = 'record' | 'inquiry' | 'appointment' | 'status' | 'assignment';
export type LifecycleFilter = 'all' | Exclude<LifecycleCategory, 'record'>;

export interface LifecycleEvent {
  id: string;
  at: string;
  category: LifecycleCategory;
  type: string;
  title: string;
  detail: string;
  leadId: string | null;
  appointmentId: string | null;
  meta: Record<string, unknown>;
}

export interface ReturningVisit {
  leadId: string;
  at: Date;
  previousLeadId: string;
  previousStatus: string;
  previousClosedAt: Date;
}

const LINKED = 'linked';
const SOLD_STATUSES = LEAD_STATUS_CATEGORIES.Sold;
const FILTERS: LifecycleFilter[] = ['all', 'inquiry', 'appointment', 'status', 'assignment'];
const CREATED_LEAD_OUTCOMES = ['created_lead', 'manual_create'];
const SAME_EVENT_WINDOW_MS = 60 * 1000;
const MAX_LEADS = 200;
const MAX_INQUIRIES = 500;
const MAX_APPOINTMENTS = 200;
const MAX_STATUS_ENTRIES = 100;
const MAX_ASSIGNMENT_ENTRIES = 50;
const MAX_APPOINTMENT_ENTRIES = 50;

export const orgObjectId = (orgId: string) => new mongoose.Types.ObjectId(orgId);
export const isTerminalStatus = (status: unknown) => TERMINAL_LEAD_STATUSES.includes(String(status || ''));
export const isSoldStatus = (status: unknown) => SOLD_STATUSES.includes(String(status || ''));

const time = (value: unknown) => {
  if (!value) return NaN;
  const parsed = new Date(value as any).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
};

const toInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const vehicleText = (vehicle: any) =>
  [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.trim].map((part) => String(part || '').trim()).filter(Boolean).join(' ');

const historyEntries = (entries: unknown, max: number) =>
  (Array.isArray(entries) ? entries : [])
    .filter((entry: any) => Number.isFinite(time(entry?.changedAt)))
    .slice(-max);

const lastStatusBefore = (lead: any, before: number) => {
  let found: any = null;
  for (const entry of historyEntries(lead.statusHistory, MAX_STATUS_ENTRIES)) {
    const at = time(entry.changedAt);
    if (at < before && (!found || at >= time(found.changedAt))) found = entry;
  }
  return found;
};

export function findReturningVisits(leads: any[]): ReturningVisit[] {
  const ordered = leads
    .filter((lead) => Number.isFinite(time(lead.createdAt)))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const visits: ReturningVisit[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const lead = ordered[index];
    const createdAt = time(lead.createdAt);
    let previous: { lead: any; entry: any } | null = null;
    for (let earlier = 0; earlier < index; earlier += 1) {
      const entry = lastStatusBefore(ordered[earlier], createdAt);
      if (!entry || !isTerminalStatus(entry.to)) continue;
      if (!previous || time(entry.changedAt) > time(previous.entry.changedAt)) previous = { lead: ordered[earlier], entry };
    }
    if (previous) {
      visits.push({
        leadId: String(lead._id),
        at: new Date(createdAt),
        previousLeadId: String(previous.lead._id),
        previousStatus: String(previous.entry.to),
        previousClosedAt: new Date(time(previous.entry.changedAt)),
      });
    }
  }
  return visits;
}

export const soldStatusDate = (lead: any) => {
  const entries = historyEntries(lead.statusHistory, MAX_STATUS_ENTRIES).filter((entry: any) => entry.to === lead.status);
  const last = entries[entries.length - 1];
  return last ? new Date(time(last.changedAt)) : null;
};

export async function inventoryStatusFor(orgId: string, leads: any[]) {
  const ids = [...new Set(leads.map((lead) => (lead.vehicleId ? String(lead.vehicleId) : '')).filter((id) => mongoose.isValidObjectId(id)))];
  const vins = [...new Set(leads.map((lead) => String(lead.vehicle?.vin || '').trim().toUpperCase()).filter((vin) => vin.length >= 11))];
  const byId = new Map<string, any>();
  const byVin = new Map<string, any>();
  if (!ids.length && !vins.length) return { byId, byVin };
  const or: Record<string, unknown>[] = [];
  if (ids.length) or.push({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } });
  if (vins.length) or.push({ vin: { $in: vins } });
  const vehicles = await Vehicle.find({ organizationId: orgId, $or: or })
    .select('status vin isDeleted isArchived')
    .limit(MAX_LEADS * 2)
    .maxTimeMS(3000)
    .lean()
    .catch(() => [] as any[]);
  for (const vehicle of vehicles as any[]) {
    const state = vehicle.isDeleted || vehicle.isArchived ? 'Removed' : String(vehicle.status || '');
    byId.set(String(vehicle._id), state);
    const vin = String(vehicle.vin || '').trim().toUpperCase();
    if (vin && !byVin.has(vin)) byVin.set(vin, state);
  }
  return { byId, byVin };
}

export const inventoryStatusOf = (lookup: { byId: Map<string, any>; byVin: Map<string, any> }, lead: any) => {
  if (lead.vehicleId && lookup.byId.has(String(lead.vehicleId))) return lookup.byId.get(String(lead.vehicleId)) as string;
  const vin = String(lead.vehicle?.vin || '').trim().toUpperCase();
  if (vin && lookup.byVin.has(vin)) return lookup.byVin.get(vin) as string;
  return null;
};

export async function countAdditionalInquiries(orgId: string, leadIds: mongoose.Types.ObjectId[]) {
  if (!leadIds.length) return 0;
  return LeadInquiry.countDocuments({
    organizationId: orgObjectId(orgId),
    'association.leadId': { $in: leadIds },
    'association.state': 'associated',
    'association.outcome': 'appended',
  }).maxTimeMS(3000).catch(() => null);
}

const appointmentNoun = (appointment: any) => (appointment.type === 'test-drive' ? 'Test drive' : 'Appointment');

const appointmentStatusTitle = (noun: string, to: string) => {
  if (to === 'completed') return `${noun} completed`;
  if (to === 'cancelled') return `${noun} cancelled`;
  if (to === 'no-show') return `${noun} missed (no-show)`;
  if (to === 'confirmed') return `${noun} confirmed`;
  if (to === 'scheduled') return `${noun} set back to scheduled`;
  return `${noun} status: ${to}`;
};

const leadStatusEvent = (from: string, to: string) => {
  if (isSoldStatus(to)) return { type: 'lead_marked_sold', title: `Lead marked ${to}`, notPurchase: true };
  if (isTerminalStatus(to)) return { type: 'lead_closed', title: `Lead closed: ${to}`, notPurchase: false };
  if (isTerminalStatus(from)) return { type: 'lead_reopened', title: `Lead reopened: ${to}`, notPurchase: false };
  return { type: 'lead_status', title: `Lead status: ${to}`, notPurchase: false };
};

const ORIGIN_LABELS: Record<string, string> = {
  lead: 'Created from a lead',
  manual: 'Added by staff',
  import: 'Imported',
  booking: 'Created from a booking',
};

export async function getCustomerTimeline(orgId: string, id: string, query: { filter?: unknown; before?: unknown; limit?: unknown }) {
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Customer not found');
  const customer: any = await Customer.findOne({ _id: id, organizationId: orgId }).select('source createdAt').maxTimeMS(5000).lean();
  if (!customer) throw new ApiError(404, 'Customer not found');

  const filter: LifecycleFilter = FILTERS.includes(String(query.filter) as LifecycleFilter) ? (query.filter as LifecycleFilter) : 'all';
  const limit = toInt(query.limit, 25, 1, 50);

  const leads: any[] = await Lead.find({ organizationId: orgObjectId(orgId), customerId: customer._id, 'customerLink.status': LINKED })
    .select('status source sourceProvider channel createdAt vehicle statusHistory assignmentHistory')
    .sort({ createdAt: 1 })
    .limit(MAX_LEADS)
    .maxTimeMS(5000)
    .lean();
  const leadIds = leads.map((lead) => lead._id);

  const [inquiries, appointments] = await Promise.all([
    leadIds.length
      ? LeadInquiry.find({ organizationId: orgObjectId(orgId), 'association.leadId': { $in: leadIds }, 'association.state': 'associated' })
        .select('kind source sourceProvider channel vehicle receivedAt association.leadId association.outcome')
        .sort({ receivedAt: -1 })
        .limit(MAX_INQUIRIES)
        .maxTimeMS(5000)
        .lean()
      : Promise.resolve([] as any[]),
    leadIds.length
      ? Appointment.find({ organizationId: orgId, leadId: { $in: leadIds }, entryType: { $in: ['appointment', null] } })
        .select('title type status startTime leadId createdAt statusHistory')
        .sort({ createdAt: -1 })
        .limit(MAX_APPOINTMENTS)
        .maxTimeMS(5000)
        .lean()
      : Promise.resolve([] as any[]),
  ]);

  const userIds = new Set<string>();
  for (const lead of leads) {
    for (const entry of historyEntries(lead.assignmentHistory, MAX_ASSIGNMENT_ENTRIES)) {
      if (entry.from && mongoose.isValidObjectId(String(entry.from))) userIds.add(String(entry.from));
      if (entry.to && mongoose.isValidObjectId(String(entry.to))) userIds.add(String(entry.to));
    }
  }
  const users: any[] = userIds.size
    ? await User.find({ _id: { $in: [...userIds].map((userId) => new mongoose.Types.ObjectId(userId)) } }).select('name').maxTimeMS(3000).lean().catch(() => [] as any[])
    : [];
  const names = new Map(users.map((user) => [String(user._id), String(user.name || '').trim()]));
  const nameOf = (userId: unknown) => (userId ? names.get(String(userId)) || 'a team member' : '');

  const events = new Map<string, LifecycleEvent>();
  const add = (event: Omit<LifecycleEvent, 'at'> & { at: unknown }) => {
    const at = time(event.at);
    if (!Number.isFinite(at) || events.has(event.id)) return;
    events.set(event.id, { ...event, at: new Date(at).toISOString() });
  };

  add({
    id: `customer:${customer._id}:created`,
    at: customer.createdAt,
    category: 'record',
    type: 'record_created',
    title: 'Customer record created',
    detail: ORIGIN_LABELS[customer.source] || 'Customer record',
    leadId: null,
    appointmentId: null,
    meta: {},
  });

  const returning = new Map(findReturningVisits(leads).map((visit) => [visit.leadId, visit]));
  const leadCreatedAt = new Map(leads.map((lead) => [String(lead._id), time(lead.createdAt)]));

  leads.forEach((lead, index) => {
    const leadId = String(lead._id);
    const source = normalizeLeadSourceForDisplay({ source: lead.source, sourceProvider: lead.sourceProvider, channel: lead.channel });
    const visit = returning.get(leadId);
    const vehicle = vehicleText(lead.vehicle);
    add({
      id: `lead:${leadId}:created`,
      at: lead.createdAt,
      category: 'inquiry',
      type: index === 0 ? 'first_inquiry' : visit ? 'returning_inquiry' : 'new_inquiry',
      title: index === 0 ? 'First inquiry' : visit ? 'Returned with a new inquiry' : 'New inquiry',
      detail: [source.sourceProvider ? `${source.source} · ${source.sourceProvider}` : source.source, vehicle].filter(Boolean).join(' · '),
      leadId,
      appointmentId: null,
      meta: visit
        ? { newLead: true, previousLeadId: visit.previousLeadId, previousStatus: visit.previousStatus, previousClosedAt: visit.previousClosedAt.toISOString() }
        : { newLead: true },
    });

    historyEntries(lead.statusHistory, MAX_STATUS_ENTRIES).forEach((entry: any, entryIndex: number) => {
      const to = String(entry.to || '');
      if (!to) return;
      const from = String(entry.from || '');
      const status = leadStatusEvent(from, to);
      add({
        id: `lead:${leadId}:status:${time(entry.changedAt)}:${entryIndex}`,
        at: entry.changedAt,
        category: 'status',
        type: status.type,
        title: status.title,
        detail: [from ? `Was ${from}` : '', entry.reason ? String(entry.reason).slice(0, 160) : ''].filter(Boolean).join(' · '),
        leadId,
        appointmentId: null,
        meta: { from, to, notPurchase: status.notPurchase },
      });
    });

    historyEntries(lead.assignmentHistory, MAX_ASSIGNMENT_ENTRIES).forEach((entry: any, entryIndex: number) => {
      const fromName = nameOf(entry.from);
      const toName = nameOf(entry.to);
      add({
        id: `lead:${leadId}:assignment:${time(entry.changedAt)}:${entryIndex}`,
        at: entry.changedAt,
        category: 'assignment',
        type: entry.to ? (entry.from ? 'lead_reassigned' : 'lead_assigned') : 'lead_unassigned',
        title: entry.to ? (entry.from ? `Lead reassigned to ${toName}` : `Lead assigned to ${toName}`) : 'Lead unassigned',
        detail: entry.from ? `Previously ${fromName}` : '',
        leadId,
        appointmentId: null,
        meta: {},
      });
    });
  });

  for (const inquiry of inquiries as any[]) {
    const leadId = String(inquiry.association?.leadId || '');
    const outcome = String(inquiry.association?.outcome || '');
    if (!leadId || CREATED_LEAD_OUTCOMES.includes(outcome)) continue;
    const receivedAt = time(inquiry.receivedAt);
    const createdAt = leadCreatedAt.get(leadId);
    if (outcome !== 'appended' && createdAt !== undefined && Math.abs(receivedAt - createdAt) < SAME_EVENT_WINDOW_MS) continue;
    const source = normalizeLeadSourceForDisplay({ source: inquiry.source, sourceProvider: inquiry.sourceProvider, channel: inquiry.channel });
    add({
      id: `inquiry:${inquiry._id}`,
      at: inquiry.receivedAt,
      category: 'inquiry',
      type: 'additional_inquiry',
      title: 'Another inquiry on the same lead',
      detail: [source.sourceProvider ? `${source.source} · ${source.sourceProvider}` : source.source, vehicleText(inquiry.vehicle)].filter(Boolean).join(' · '),
      leadId,
      appointmentId: null,
      meta: {},
    });
  }

  for (const appointment of appointments as any[]) {
    const appointmentId = String(appointment._id);
    const leadId = appointment.leadId ? String(appointment.leadId) : null;
    const noun = appointmentNoun(appointment);
    add({
      id: `appointment:${appointmentId}:created`,
      at: appointment.createdAt,
      category: 'appointment',
      type: appointment.type === 'test-drive' ? 'test_drive_scheduled' : 'appointment_scheduled',
      title: `${noun} scheduled`,
      detail: String(appointment.title || '').slice(0, 160),
      leadId,
      appointmentId,
      meta: { startTime: appointment.startTime ? new Date(appointment.startTime).toISOString() : null },
    });
    historyEntries(appointment.statusHistory, MAX_APPOINTMENT_ENTRIES).forEach((entry: any, entryIndex: number) => {
      const to = String(entry.to || '');
      if (!to) return;
      add({
        id: `appointment:${appointmentId}:status:${time(entry.changedAt)}:${entryIndex}`,
        at: entry.changedAt,
        category: 'appointment',
        type: `appointment_${to.replace(/[^a-z]/g, '_')}`,
        title: appointmentStatusTitle(noun, to),
        detail: String(appointment.title || '').slice(0, 160),
        leadId,
        appointmentId,
        meta: { from: String(entry.from || ''), to },
      });
    });
  }

  const ordered = [...events.values()].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  const counts = {
    all: ordered.length,
    inquiry: ordered.filter((event) => event.category === 'inquiry').length,
    appointment: ordered.filter((event) => event.category === 'appointment').length,
    status: ordered.filter((event) => event.category === 'status').length,
    assignment: ordered.filter((event) => event.category === 'assignment').length,
  };
  const filtered = filter === 'all' ? ordered : ordered.filter((event) => event.category === filter);

  let start = 0;
  const cursor = String(query.before ?? '');
  const separator = cursor.indexOf('|');
  if (separator > 0) {
    const cursorAt = new Date(Number(cursor.slice(0, separator))).toISOString();
    const cursorId = cursor.slice(separator + 1);
    const position = filtered.findIndex((event) => event.at < cursorAt || (event.at === cursorAt && event.id < cursorId));
    start = position === -1 ? filtered.length : position;
  }
  const items = filtered.slice(start, start + limit);
  const last = items[items.length - 1];
  const hasMore = start + limit < filtered.length;

  return {
    items,
    nextCursor: hasMore && last ? `${new Date(last.at).getTime()}|${last.id}` : null,
    filter,
    counts,
    truncated: leads.length >= MAX_LEADS || (inquiries as any[]).length >= MAX_INQUIRIES || (appointments as any[]).length >= MAX_APPOINTMENTS,
  };
}
