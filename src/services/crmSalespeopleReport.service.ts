import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import Appointment from '../models/Appointment.model';
import { CallLog, CommunicationMessage } from '../models/communication.model';
import { LEAD_STATUS_CATEGORY_OF } from '../constants/leadStatus';
import { isGenuineDemoLead, normalizeLeadSourceForDisplay, UNMAPPED_LEAD_SOURCE_LABEL } from '../constants/leadSource';

export const UNASSIGNED_KEY = 'unassigned';
export const MAX_SALESPEOPLE_LEAD_ROWS = 5000;
const STAFF_ROLES = ['employee', 'admin', 'super_admin'];
const EVERYONE_ROLES = new Set(['manager', 'admin', 'super_admin']);
const NOT_APPOINTMENTS = ['event', 'task', 'reminder'];

const COUNT_KEYS = ['leads', 'notWorked', 'working', 'appointments', 'sold', 'lost', 'textsSent', 'callsMade', 'callsAnswered'] as const;
type CountKey = (typeof COUNT_KEYS)[number];
export type SalespersonCounts = Record<CountKey, number>;

export interface SalespersonRow extends SalespersonCounts {
  key: string;
  name: string;
  email: string;
  active: boolean;
}

export interface SalespersonLeadRow {
  salesperson: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  source: string;
  status: string;
  location: string;
  createdAt: string;
}

export interface SalespeopleReport {
  range: { from: string; to: string };
  scope: 'everyone' | 'self';
  rows: SalespersonRow[];
  totals: SalespersonCounts;
  leads?: SalespersonLeadRow[];
  leadsTruncated?: boolean;
}

interface Person {
  key: string;
  name: string;
  email: string;
  active: boolean;
}

const emailKey = (value: unknown): string => String(value || '').trim().toLowerCase();

function sourceLabel(lead: any): string {
  const normalized = normalizeLeadSourceForDisplay({ source: lead.source, channel: lead.channel, sourceProvider: lead.sourceProvider });
  const source = normalized.source || UNMAPPED_LEAD_SOURCE_LABEL;
  return normalized.sourceProvider ? `${source} (${normalized.sourceProvider})` : source;
}

function orgVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function zeroCounts(): SalespersonCounts {
  return COUNT_KEYS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {} as SalespersonCounts);
}

export function leadStatusBucket(status: unknown): 'notWorked' | 'working' | 'sold' | 'lost' {
  const value = String(status || '');
  const category = LEAD_STATUS_CATEGORY_OF[value];
  if (!value || category === 'None') return 'notWorked';
  if (category === 'Sold') return 'sold';
  if (category === 'MissedOpportunity' || category === 'DeadLead' || category === 'ClosedLegacy') return 'lost';
  return 'working';
}

function actorGroup(field: string) {
  return {
    _id: { userId: { $toString: `$${field}.userId` }, email: { $toLower: { $ifNull: [`$${field}.email`, ''] } } },
    count: { $sum: 1 },
  };
}

export async function buildSalespeopleReport(input: {
  orgId: string;
  from: Date;
  to: Date;
  viewer: { role?: string; email?: string };
  includeLeads?: boolean;
}): Promise<SalespeopleReport> {
  const { orgId, from, to } = input;
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const orgIds = orgVariants(orgId);
  const everyone = EVERYONE_ROLES.has(String(input.viewer.role || ''));
  const created = { $gte: from, $lte: to };

  const [leadDocs, textRows, placedRows, answeredRows] = await Promise.all([
    Lead.find({ organizationId: orgObjectId, createdAt: created, 'combinedInto.leadId': { $exists: false } })
      .select('firstName lastName phone email source sourceProvider channel status location assignedTo createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    CommunicationMessage.aggregate([
      { $match: { orgId: { $in: orgIds }, direction: 'outbound', createdAt: created, status: { $ne: 'failed' }, 'sentBy.userId': { $exists: true, $ne: null } } },
      { $group: actorGroup('sentBy') },
    ]),
    CallLog.aggregate([
      { $match: { orgId: { $in: orgIds }, direction: 'outbound', createdAt: created, 'placedBy.userId': { $exists: true, $ne: null } } },
      { $group: actorGroup('placedBy') },
    ]),
    CallLog.aggregate([
      { $match: { orgId: { $in: orgIds }, direction: 'inbound', createdAt: created, answeredAt: { $ne: null }, 'answeredBy.userId': { $exists: true, $ne: null } } },
      { $group: actorGroup('answeredBy') },
    ]),
  ]);

  const leads = (leadDocs as any[]).filter((lead) => !isGenuineDemoLead(lead.source, lead.phone));
  const assignedIds = Array.from(new Set(leads.map((lead) => lead.assignedTo).filter(Boolean).map(String)))
    .filter((id) => mongoose.isValidObjectId(id));

  const [users, crmUsers, appointmentLeadIds] = await Promise.all([
    User.find({ $or: [{ organizationId: { $in: orgIds }, role: { $in: STAFF_ROLES } }, { _id: { $in: assignedIds } }] })
      .select('name email isActive')
      .lean(),
    CrmUser.find({ organizationId: orgObjectId }).select('fullName email isActive').lean(),
    leads.length
      ? Appointment.distinct('leadId', {
        organizationId: orgId,
        leadId: { $in: leads.map((lead) => lead._id) },
        status: { $ne: 'cancelled' },
        entryType: { $nin: NOT_APPOINTMENTS },
      })
      : Promise.resolve([]),
  ]);

  const people = new Map<string, Person>();
  const idToKey = new Map<string, string>();
  const addPerson = (id: unknown, name: unknown, email: unknown, active: unknown, prefix: string) => {
    const key = emailKey(email) || `${prefix}:${String(id)}`;
    idToKey.set(String(id), key);
    const existing = people.get(key);
    const isActive = active !== false;
    if (existing) {
      existing.active = existing.active || isActive;
      return;
    }
    people.set(key, { key, name: String(name || email || 'Team member').trim(), email: String(email || ''), active: isActive });
  };
  for (const user of users as any[]) addPerson(user._id, user.name, user.email, user.isActive, 'user');
  for (const crmUser of crmUsers as any[]) addPerson(crmUser._id, crmUser.fullName, crmUser.email, crmUser.isActive, 'crm');

  const rows = new Map<string, SalespersonRow>();
  const rowFor = (key: string): SalespersonRow => {
    let row = rows.get(key);
    if (!row) {
      const person = people.get(key);
      row = key === UNASSIGNED_KEY
        ? { key, name: 'Unassigned', email: '', active: true, ...zeroCounts() }
        : { key, name: person?.name || 'Former team member', email: person?.email || '', active: person?.active ?? false, ...zeroCounts() };
      rows.set(key, row);
    }
    return row;
  };
  const leadKey = (lead: any): string => {
    if (!lead.assignedTo) return UNASSIGNED_KEY;
    const id = String(lead.assignedTo);
    return idToKey.get(id) || `user:${id}`;
  };
  const actorKey = (id: unknown, email: unknown): string | null => {
    const byId = idToKey.get(String(id || ''));
    if (byId) return byId;
    const byEmail = emailKey(email);
    return byEmail && people.has(byEmail) ? byEmail : null;
  };

  const withAppointment = new Set((appointmentLeadIds as any[]).map(String));
  for (const lead of leads) {
    const row = rowFor(leadKey(lead));
    row.leads += 1;
    row[leadStatusBucket(lead.status)] += 1;
    if (withAppointment.has(String(lead._id))) row.appointments += 1;
  }

  const addActivity = (groups: any[], field: 'textsSent' | 'callsMade' | 'callsAnswered') => {
    for (const group of groups) {
      const key = actorKey(group._id?.userId, group._id?.email);
      if (key) rowFor(key)[field] += group.count;
    }
  };
  addActivity(textRows, 'textsSent');
  addActivity(placedRows, 'callsMade');
  addActivity(answeredRows, 'callsAnswered');

  const viewerKey = emailKey(input.viewer.email);
  let visible = Array.from(rows.values()).filter((row) => COUNT_KEYS.some((key) => row[key] > 0));
  if (!everyone) {
    visible = visible.filter((row) => row.key === viewerKey);
    if (!visible.length && viewerKey) {
      const person = people.get(viewerKey);
      visible = [{ key: viewerKey, name: person?.name || viewerKey, email: person?.email || viewerKey, active: true, ...zeroCounts() }];
    }
  }
  visible.sort((a, b) => {
    if (a.key === UNASSIGNED_KEY) return 1;
    if (b.key === UNASSIGNED_KEY) return -1;
    return b.leads - a.leads
      || (b.textsSent + b.callsMade + b.callsAnswered) - (a.textsSent + a.callsMade + a.callsAnswered)
      || a.name.localeCompare(b.name);
  });

  const totals = zeroCounts();
  for (const row of visible) for (const key of COUNT_KEYS) totals[key] += row[key];

  const report: SalespeopleReport = {
    range: { from: from.toISOString(), to: to.toISOString() },
    scope: everyone ? 'everyone' : 'self',
    rows: visible,
    totals,
  };

  if (input.includeLeads) {
    const visibleKeys = new Set(visible.map((row) => row.key));
    const order = new Map(visible.map((row, index) => [row.key, index]));
    const leadRows = leads
      .map((lead) => ({ lead, key: leadKey(lead) }))
      .filter(({ key }) => visibleKeys.has(key))
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    report.leadsTruncated = leadRows.length > MAX_SALESPEOPLE_LEAD_ROWS;
    report.leads = leadRows.slice(0, MAX_SALESPEOPLE_LEAD_ROWS).map(({ lead, key }) => ({
      salesperson: rows.get(key)?.name || 'Unassigned',
      firstName: String(lead.firstName || ''),
      lastName: String(lead.lastName || ''),
      phone: String(lead.phone || ''),
      email: String(lead.email || ''),
      source: sourceLabel(lead),
      status: String(lead.status || ''),
      location: String(lead.location || ''),
      createdAt: new Date(lead.createdAt).toISOString(),
    }));
  }

  return report;
}
