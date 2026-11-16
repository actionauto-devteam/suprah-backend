import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import Appointment from '../models/Appointment.model';
import Customer from '../models/Customer.model';
import CustomerPurchase from '../models/CustomerPurchase.model';
import WebChatMessage from '../models/WebChatMessage.model';
import UserActivity from '../models/UserActivity.model';
import { CallLog, CommunicationMessage } from '../models/communication.model';
import { UserBadge, BADGE_DEFINITIONS } from '../models/Badge.model';
import { LEAD_STATUS_CATEGORIES } from '../constants/leadStatus';
import { isGenuineDemoLead } from '../constants/leadSource';
import { computeScore, DEFAULT_KPI_WEIGHTS } from './kpiEngine.service';
import { COMPANY_TZ, addDaysToDateStr, getCompanyDayRange, toCompanyDateStr, zoneOffsetMinutes } from '../utils/companyTimezone';
import { ApiError } from '../utils/ApiError';

export const PERIOD_PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const RANK_METRICS = ['calls', 'score', 'leads', 'appointments', 'messages', 'transactions'] as const;
export type RankMetric = (typeof RANK_METRICS)[number];
export const CHECKPOINT_HOURS = [12, 14, 16, 18, 20];

const STAFF_ROLES = ['employee', 'admin', 'super_admin'];
const NOT_APPOINTMENTS = ['event', 'task', 'reminder'];
const SOLD_STATUSES = LEAD_STATUS_CATEGORIES.Sold;
const MAX_RANGE_DAYS = 366;
const RESPONSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FOLLOW_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_ROWS = 10000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StaffEventType =
  | 'call_made'
  | 'call_received'
  | 'message_sent'
  | 'email_sent'
  | 'appointment_created'
  | 'lead_converted'
  | 'transaction_completed'
  | 'onboarding_completed';

export interface ResolvedPeriod {
  preset: PeriodPreset;
  fromDate: string;
  toDate: string;
  start: Date;
  end: Date;
  label: string;
  singleDay: boolean;
  days: number;
}

export interface StaffEvent {
  id: string;
  type: StaffEventType;
  key: string;
  at: Date;
  leadId?: string;
  customer?: string;
  number?: string;
  durationSec?: number;
  connected?: boolean;
  followUp?: boolean;
  responseMin?: number;
  channel?: 'text' | 'chat' | 'email';
  detail?: string;
}

export interface CallRow {
  at: Date;
  key: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  answered: boolean;
  missed: boolean;
  durationSec: number;
  customer: string;
  number: string;
}

export interface LeaderboardKpis {
  callsTotal: number;
  callsMade: number;
  callsAnswered: number;
  callsConnected: number;
  talkTimeSec: number;
  leadsCreated: number;
  leadsContacted: number;
  leadsConverted: number;
  conversionRate: number;
  appointmentsCompleted: number;
  messagesSent: number;
  textsSent: number;
  chatsSent: number;
  emailsSent: number;
  followUpsSent: number;
  transactionsCompleted: number;
  onboardingsCompleted: number;
  avgResponseTimeMin: number;
  responsesCount: number;
  totalScore: number;
}

export interface Person {
  key: string;
  ids: string[];
  primaryId: string;
  name: string;
  username: string;
  email: string;
  avatar: string;
  role: string;
  active: boolean;
}

interface PeopleIndex {
  people: Map<string, Person>;
  idToKey: Map<string, string>;
}

export interface PeriodData {
  people: PeopleIndex;
  events: StaffEvent[];
  calls: CallRow[];
  newLeads: Array<{ key: string | null; at: Date }>;
  start: Date;
  end: Date;
}

export interface LeaderboardEntry {
  rank: number;
  prevRank: number | null;
  rankChange: number | null;
  metricValue: number;
  user: { _id: string; ids: string[]; fullName: string; username: string; avatar: string; role: string; email: string };
  kpis: LeaderboardKpis;
  badges: string[];
  active: boolean;
}

export const EVENT_SCORES: Record<StaffEventType, number> = {
  call_made: DEFAULT_KPI_WEIGHTS.callsMade,
  call_received: DEFAULT_KPI_WEIGHTS.callsMade,
  message_sent: DEFAULT_KPI_WEIGHTS.messagesSent,
  email_sent: DEFAULT_KPI_WEIGHTS.messagesSent,
  appointment_created: DEFAULT_KPI_WEIGHTS.appointmentsCompleted,
  lead_converted: DEFAULT_KPI_WEIGHTS.leadsConverted,
  transaction_completed: DEFAULT_KPI_WEIGHTS.transactionsCompleted,
  onboarding_completed: DEFAULT_KPI_WEIGHTS.onboardingsCompleted,
};

export const EVENT_LABELS: Record<StaffEventType, string> = {
  call_made: 'Call made',
  call_received: 'Call answered',
  message_sent: 'Message sent',
  email_sent: 'Email sent',
  appointment_created: 'Appointment booked',
  lead_converted: 'Lead sold',
  transaction_completed: 'Sale recorded',
  onboarding_completed: 'Customer added',
};

const EVENT_MODULES: Record<StaffEventType, string> = {
  call_made: 'calls',
  call_received: 'calls',
  message_sent: 'messaging',
  email_sent: 'messaging',
  appointment_created: 'appointments',
  lead_converted: 'leads',
  transaction_completed: 'sales',
  onboarding_completed: 'customers',
};

function orgVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

const emailKey = (value: unknown): string => String(value || '').trim().toLowerCase();

function weekdayIndex(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

function mondayOf(dateStr: string): string {
  return addDaysToDateStr(dateStr, -((weekdayIndex(dateStr) + 6) % 7));
}

function firstOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 8)}01`;
}

function lastDayOfPreviousMonth(dateStr: string): string {
  return addDaysToDateStr(firstOfMonth(dateStr), -1);
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 1;
}

function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function rangeLabel(fromDate: string, toDate: string): string {
  return fromDate === toDate ? shortDate(fromDate) : `${shortDate(fromDate)} - ${shortDate(toDate)}`;
}

const PRESET_NAMES: Record<PeriodPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom dates',
};

function buildPeriod(preset: PeriodPreset, fromDate: string, toDate: string): ResolvedPeriod {
  const days = daysBetween(fromDate, toDate);
  return {
    preset,
    fromDate,
    toDate,
    start: getCompanyDayRange(fromDate).start,
    end: getCompanyDayRange(toDate).end,
    label: `${PRESET_NAMES[preset]} (${rangeLabel(fromDate, toDate)})`,
    singleDay: days === 1,
    days,
  };
}

export function resolvePeriod(input: { period?: unknown; from?: unknown; to?: unknown; periodType?: unknown }, now: Date = new Date()): ResolvedPeriod {
  const legacy: Record<string, PeriodPreset> = { daily: 'today', weekly: 'this_week', monthly: 'this_month' };
  const raw = String(input.period || legacy[String(input.periodType || '')] || 'today');
  if (!(PERIOD_PRESETS as readonly string[]).includes(raw)) throw new ApiError(400, 'Unknown period');
  const preset = raw as PeriodPreset;
  const today = toCompanyDateStr(now);

  if (preset === 'today') return buildPeriod(preset, today, today);
  if (preset === 'yesterday') {
    const day = addDaysToDateStr(today, -1);
    return buildPeriod(preset, day, day);
  }
  if (preset === 'this_week') return buildPeriod(preset, mondayOf(today), today);
  if (preset === 'last_week') {
    const monday = addDaysToDateStr(mondayOf(today), -7);
    return buildPeriod(preset, monday, addDaysToDateStr(monday, 6));
  }
  if (preset === 'this_month') return buildPeriod(preset, firstOfMonth(today), today);
  if (preset === 'last_month') {
    const lastDay = lastDayOfPreviousMonth(today);
    return buildPeriod(preset, firstOfMonth(lastDay), lastDay);
  }

  const fromDate = String(input.from || '');
  const toDate = String(input.to || '');
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || Number.isNaN(Date.parse(`${fromDate}T00:00:00Z`)) || Number.isNaN(Date.parse(`${toDate}T00:00:00Z`))) {
    throw new ApiError(400, 'Pick a start and end date');
  }
  if (fromDate > toDate) throw new ApiError(400, 'The start date must be before the end date');
  if (toDate > today) throw new ApiError(400, 'The end date cannot be in the future');
  if (daysBetween(fromDate, toDate) > MAX_RANGE_DAYS) throw new ApiError(400, 'Pick a range of one year or less');
  return buildPeriod(preset, fromDate, toDate);
}

export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
  if (period.preset === 'today' || period.preset === 'yesterday') {
    const day = addDaysToDateStr(period.fromDate, -1);
    return buildPeriod('custom', day, day);
  }
  if (period.preset === 'this_week' || period.preset === 'last_week') {
    const monday = addDaysToDateStr(period.fromDate, -7);
    return buildPeriod('custom', monday, addDaysToDateStr(monday, 6));
  }
  if (period.preset === 'this_month' || period.preset === 'last_month') {
    const lastDay = addDaysToDateStr(period.fromDate, -1);
    return buildPeriod('custom', firstOfMonth(lastDay), lastDay);
  }
  const toDate = addDaysToDateStr(period.fromDate, -1);
  return buildPeriod('custom', addDaysToDateStr(toDate, -(period.days - 1)), toDate);
}

export function companyWallTimeUtc(dateStr: string, hour: number): Date {
  const wall = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - zoneOffsetMinutes(new Date(guess), COMPANY_TZ) * 60_000;
  return new Date(guess);
}

async function loadPeople(orgId: string): Promise<PeopleIndex> {
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const [users, crmUsers] = await Promise.all([
    User.find({ organizationId: orgObjectId, role: { $in: STAFF_ROLES } })
      .select('name email avatar role organizationRole isActive')
      .lean(),
    CrmUser.find({ organizationId: orgObjectId, isSystem: { $ne: true } })
      .select('fullName username email avatar role isActive isOffboarded')
      .lean(),
  ]);

  const people = new Map<string, Person>();
  const idToKey = new Map<string, string>();

  for (const crm of crmUsers as any[]) {
    const id = String(crm._id);
    const key = emailKey(crm.email) || `crm:${id}`;
    idToKey.set(id, key);
    const active = crm.isActive !== false && crm.isOffboarded !== true;
    const existing = people.get(key);
    if (existing) {
      existing.ids.push(id);
      existing.active = existing.active || active;
      continue;
    }
    people.set(key, {
      key,
      ids: [id],
      primaryId: id,
      name: String(crm.fullName || crm.email || 'Team member').trim(),
      username: String(crm.username || ''),
      email: String(crm.email || ''),
      avatar: String(crm.avatar || ''),
      role: String(crm.role || 'employee'),
      active,
    });
  }

  for (const user of users as any[]) {
    const id = String(user._id);
    const key = emailKey(user.email) || `user:${id}`;
    idToKey.set(id, key);
    const existing = people.get(key);
    if (existing) {
      existing.ids.push(id);
      continue;
    }
    const isAdmin = ['admin', 'super_admin'].includes(user.role) || user.organizationRole === 'admin';
    people.set(key, {
      key,
      ids: [id],
      primaryId: id,
      name: String(user.name || user.email || 'Team member').trim(),
      username: String(user.email || ''),
      email: String(user.email || ''),
      avatar: String(user.avatar || ''),
      role: isAdmin ? 'admin' : String(user.organizationRole || 'employee'),
      active: user.isActive !== false,
    });
  }

  return { people, idToKey };
}

function keyOf(index: PeopleIndex, id: unknown, email?: unknown): string | null {
  const byId = index.idToKey.get(String(id || ''));
  if (byId) return byId;
  const byEmail = emailKey(email);
  return byEmail && index.people.has(byEmail) ? byEmail : null;
}

function leadName(lead: any): string {
  if (!lead) return '';
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
  return name || String(lead.phone || lead.email || '');
}

function inRange(at: Date, start: Date, end: Date): boolean {
  return at >= start && at < end;
}

function markResponses(
  messages: any[],
  groupField: string,
  staffKeyOf: (message: any) => string | null,
  isCounted: (message: any) => boolean,
  start: Date,
  end: Date,
): Map<string, number> {
  const minutes = new Map<string, number>();
  const groups = new Map<string, any[]>();
  for (const message of messages) {
    const group = String(message[groupField] || '');
    if (!group) continue;
    const list = groups.get(group) || [];
    list.push(message);
    groups.set(group, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let waitingSince: number | null = null;
    for (const message of list) {
      const at = new Date(message.createdAt).getTime();
      if (message.direction === 'inbound') {
        if (waitingSince === null) waitingSince = at;
        continue;
      }
      const staffKey = staffKeyOf(message);
      if (!staffKey || !isCounted(message)) continue;
      if (waitingSince !== null && at - waitingSince <= RESPONSE_WINDOW_MS && inRange(new Date(at), start, end)) {
        minutes.set(String(message._id), Math.max(0, (at - waitingSince) / 60000));
      }
      waitingSince = null;
    }
  }
  return minutes;
}

export async function loadPeriodData(orgId: string, start: Date, end: Date): Promise<PeriodData> {
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const orgIds = orgVariants(orgId);
  const range = { $gte: start, $lt: end };
  const lookback = { $gte: new Date(start.getTime() - RESPONSE_WINDOW_MS), $lt: end };

  const [people, callDocs, textDocs, chatDocs, emailDocs, newLeadDocs, soldLeadDocs, appointmentDocs, purchaseDocs, customerDocs] = await Promise.all([
    loadPeople(orgId),
    CallLog.find({ orgId: { $in: orgIds }, createdAt: range })
      .select('direction status placedBy answeredBy answeredAt durationSec createdAt leadId customerName from to')
      .lean(),
    CommunicationMessage.find({ orgId: { $in: orgIds }, createdAt: lookback })
      .select('conversationId direction status sentBy leadId to createdAt')
      .lean(),
    WebChatMessage.find({ organizationId: { $in: orgIds.map(String) }, createdAt: lookback })
      .select('sessionId direction sentBy leadId createdAt')
      .lean(),
    UserActivity.find({ organizationId: { $in: orgIds }, title: 'Lead Replied', createdAt: range })
      .select('userId metadata.leadId createdAt')
      .lean(),
    Lead.find({ organizationId: orgObjectId, createdAt: range, 'combinedInto.leadId': { $exists: false } })
      .select('assignedTo source phone createdAt')
      .lean(),
    Lead.find({ organizationId: orgObjectId, statusHistory: { $elemMatch: { to: { $in: SOLD_STATUSES }, changedAt: range } } })
      .select('assignedTo statusHistory firstName lastName phone email')
      .lean(),
    Appointment.find({ organizationId: { $in: orgIds.map(String) }, createdAt: range, status: { $ne: 'cancelled' }, entryType: { $nin: NOT_APPOINTMENTS } })
      .select('salesperson createdBy createdAt startTime customerBooking leadId title')
      .lean(),
    CustomerPurchase.find({ organizationId: { $in: orgIds.map(String) }, soldAt: range })
      .select('salespersonId createdBy soldAt vehicle customerId leadId')
      .lean(),
    Customer.find({ organizationId: { $in: orgIds.map(String) }, createdAt: range, source: { $ne: 'import' } })
      .select('createdBy createdAt firstName lastName')
      .lean(),
  ]);

  const leadIds = new Set<string>();
  for (const call of callDocs as any[]) if (call.leadId) leadIds.add(String(call.leadId));
  for (const text of textDocs as any[]) if (text.leadId && text.direction === 'outbound') leadIds.add(String(text.leadId));
  for (const chat of chatDocs as any[]) if (chat.leadId && chat.direction === 'outbound') leadIds.add(String(chat.leadId));
  for (const email of emailDocs as any[]) if (email.metadata?.leadId && mongoose.isValidObjectId(email.metadata.leadId)) leadIds.add(String(email.metadata.leadId));
  for (const appointment of appointmentDocs as any[]) if (appointment.leadId) leadIds.add(String(appointment.leadId));
  for (const purchase of purchaseDocs as any[]) if (purchase.leadId) leadIds.add(String(purchase.leadId));

  const leadInfo = new Map<string, any>();
  if (leadIds.size) {
    const leads = await Lead.find({ _id: { $in: Array.from(leadIds) }, organizationId: orgObjectId })
      .select('firstName lastName phone email createdAt')
      .lean();
    for (const lead of leads as any[]) leadInfo.set(String(lead._id), lead);
  }

  const isFollowUp = (leadId: unknown, at: Date): boolean => {
    const lead = leadInfo.get(String(leadId || ''));
    return Boolean(lead?.createdAt && at.getTime() - new Date(lead.createdAt).getTime() >= FOLLOW_UP_AFTER_MS);
  };

  const events: StaffEvent[] = [];
  const calls: CallRow[] = [];

  for (const call of callDocs as any[]) {
    const at = new Date(call.createdAt);
    const answered = Boolean(call.answeredAt);
    const lead = leadInfo.get(String(call.leadId || ''));
    const number = String(call.direction === 'outbound' ? call.to || '' : call.from || '');
    const customer = String(call.customerName || leadName(lead) || number);
    const durationSec = answered ? Math.max(0, Number(call.durationSec) || 0) : 0;
    let key: string | null = null;
    if (call.direction === 'outbound') {
      key = call.placedBy?.userId ? keyOf(people, call.placedBy.userId, call.placedBy.email) : null;
      if (key) {
        events.push({
          id: String(call._id),
          type: 'call_made',
          key,
          at,
          leadId: call.leadId ? String(call.leadId) : undefined,
          customer,
          number,
          durationSec,
          connected: answered,
          followUp: call.leadId ? isFollowUp(call.leadId, at) : false,
        });
      }
    } else if (answered && call.answeredBy?.userId) {
      key = keyOf(people, call.answeredBy.userId, call.answeredBy.email);
      if (key) {
        events.push({
          id: String(call._id),
          type: 'call_received',
          key,
          at,
          leadId: call.leadId ? String(call.leadId) : undefined,
          customer,
          number,
          durationSec,
          connected: true,
        });
      }
    }
    calls.push({
      at,
      key,
      direction: call.direction,
      status: String(call.status || ''),
      answered,
      missed: call.direction === 'inbound' && !answered && ['missed', 'canceled'].includes(String(call.status || '')),
      durationSec,
      customer,
      number,
    });
  }

  const textStaffKey = (message: any): string | null => (message.sentBy?.userId ? keyOf(people, message.sentBy.userId, message.sentBy.email) : null);
  const textResponses = markResponses(textDocs as any[], 'conversationId', textStaffKey, (message) => message.status !== 'failed', start, end);
  for (const text of textDocs as any[]) {
    if (text.direction !== 'outbound' || text.status === 'failed') continue;
    const at = new Date(text.createdAt);
    if (!inRange(at, start, end)) continue;
    const key = textStaffKey(text);
    if (!key) continue;
    const lead = leadInfo.get(String(text.leadId || ''));
    events.push({
      id: String(text._id),
      type: 'message_sent',
      key,
      at,
      leadId: text.leadId ? String(text.leadId) : undefined,
      customer: leadName(lead) || String(text.to || ''),
      number: String(text.to || ''),
      channel: 'text',
      followUp: text.leadId ? isFollowUp(text.leadId, at) : false,
      responseMin: textResponses.get(String(text._id)),
    });
  }

  const chatStaffKey = (message: any): string | null => (message.sentBy?.userId ? keyOf(people, message.sentBy.userId) : null);
  const chatResponses = markResponses(chatDocs as any[], 'sessionId', chatStaffKey, () => true, start, end);
  for (const chat of chatDocs as any[]) {
    if (chat.direction !== 'outbound') continue;
    const at = new Date(chat.createdAt);
    if (!inRange(at, start, end)) continue;
    const key = chatStaffKey(chat);
    if (!key) continue;
    const lead = leadInfo.get(String(chat.leadId || ''));
    events.push({
      id: String(chat._id),
      type: 'message_sent',
      key,
      at,
      leadId: chat.leadId ? String(chat.leadId) : undefined,
      customer: leadName(lead),
      channel: 'chat',
      followUp: chat.leadId ? isFollowUp(chat.leadId, at) : false,
      responseMin: chatResponses.get(String(chat._id)),
    });
  }

  for (const email of emailDocs as any[]) {
    const key = keyOf(people, email.userId);
    if (!key) continue;
    const at = new Date(email.createdAt);
    const leadId = email.metadata?.leadId ? String(email.metadata.leadId) : undefined;
    events.push({
      id: String(email._id),
      type: 'email_sent',
      key,
      at,
      leadId,
      customer: leadName(leadInfo.get(leadId || '')),
      channel: 'email',
      followUp: leadId ? isFollowUp(leadId, at) : false,
    });
  }

  const newLeads: PeriodData['newLeads'] = [];
  for (const lead of newLeadDocs as any[]) {
    if (isGenuineDemoLead(lead.source, lead.phone)) continue;
    newLeads.push({ key: lead.assignedTo ? keyOf(people, lead.assignedTo) : null, at: new Date(lead.createdAt) });
  }

  for (const lead of soldLeadDocs as any[]) {
    const entry = (lead.statusHistory || [])
      .filter((item: any) => SOLD_STATUSES.includes(item.to) && item.changedAt && inRange(new Date(item.changedAt), start, end))
      .sort((a: any, b: any) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime())[0];
    if (!entry) continue;
    const key = (lead.assignedTo && keyOf(people, lead.assignedTo)) || (entry.changedBy && keyOf(people, entry.changedBy));
    if (!key) continue;
    events.push({
      id: `${String(lead._id)}:sold`,
      type: 'lead_converted',
      key,
      at: new Date(entry.changedAt),
      leadId: String(lead._id),
      customer: leadName(lead),
      detail: String(entry.to),
    });
  }

  for (const appointment of appointmentDocs as any[]) {
    const key = (appointment.salesperson?.crmUserId && keyOf(people, appointment.salesperson.crmUserId))
      || (appointment.salesperson?.userId && keyOf(people, appointment.salesperson.userId))
      || keyOf(people, appointment.createdBy);
    if (!key) continue;
    const booking = appointment.customerBooking;
    const customer = booking ? [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim() : leadName(leadInfo.get(String(appointment.leadId || '')));
    events.push({
      id: String(appointment._id),
      type: 'appointment_created',
      key,
      at: new Date(appointment.createdAt),
      leadId: appointment.leadId ? String(appointment.leadId) : undefined,
      customer: customer || String(appointment.title || ''),
      detail: appointment.startTime ? new Date(appointment.startTime).toISOString() : undefined,
    });
  }

  for (const purchase of purchaseDocs as any[]) {
    const key = (purchase.salespersonId && keyOf(people, purchase.salespersonId)) || keyOf(people, purchase.createdBy?.userId);
    if (!key) continue;
    const vehicle = purchase.vehicle || {};
    events.push({
      id: String(purchase._id),
      type: 'transaction_completed',
      key,
      at: new Date(purchase.soldAt),
      leadId: purchase.leadId ? String(purchase.leadId) : undefined,
      customer: leadName(leadInfo.get(String(purchase.leadId || ''))),
      detail: String(vehicle.label || [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')),
    });
  }

  for (const customer of customerDocs as any[]) {
    const key = keyOf(people, customer.createdBy);
    if (!key) continue;
    events.push({
      id: String(customer._id),
      type: 'onboarding_completed',
      key,
      at: new Date(customer.createdAt),
      customer: [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim(),
    });
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  calls.sort((a, b) => b.at.getTime() - a.at.getTime());

  return { people, events, calls, newLeads, start, end };
}

const dataCache = new Map<string, { expires: number; promise: Promise<PeriodData> }>();
const DATA_CACHE_MS = 20_000;

export function cachedPeriodData(orgId: string, start: Date, end: Date): Promise<PeriodData> {
  const now = Date.now();
  for (const [cacheKey, entry] of dataCache) if (entry.expires <= now) dataCache.delete(cacheKey);
  const cacheKey = `${orgId}:${start.toISOString()}:${end.toISOString()}`;
  const cached = dataCache.get(cacheKey);
  if (cached) return cached.promise;
  const promise = loadPeriodData(orgId, start, end);
  dataCache.set(cacheKey, { expires: now + DATA_CACHE_MS, promise });
  promise.catch(() => dataCache.delete(cacheKey));
  return promise;
}

export function clearLeaderboardCache(): void {
  dataCache.clear();
  badgeChecks.clear();
}

export function emptyKpis(): LeaderboardKpis {
  return {
    callsTotal: 0,
    callsMade: 0,
    callsAnswered: 0,
    callsConnected: 0,
    talkTimeSec: 0,
    leadsCreated: 0,
    leadsContacted: 0,
    leadsConverted: 0,
    conversionRate: 0,
    appointmentsCompleted: 0,
    messagesSent: 0,
    textsSent: 0,
    chatsSent: 0,
    emailsSent: 0,
    followUpsSent: 0,
    transactionsCompleted: 0,
    onboardingsCompleted: 0,
    avgResponseTimeMin: 0,
    responsesCount: 0,
    totalScore: 0,
  };
}

function finishKpis(kpis: LeaderboardKpis, responseTotal: number, contacted: Set<string>): LeaderboardKpis {
  kpis.callsTotal = kpis.callsMade + kpis.callsAnswered;
  kpis.messagesSent = kpis.textsSent + kpis.chatsSent + kpis.emailsSent;
  kpis.leadsContacted = contacted.size;
  kpis.conversionRate = kpis.leadsCreated > 0 ? Math.min(100, Math.round((kpis.leadsConverted / kpis.leadsCreated) * 100)) : 0;
  kpis.avgResponseTimeMin = kpis.responsesCount > 0 ? Math.round((responseTotal / kpis.responsesCount) * 10) / 10 : 0;
  kpis.totalScore = computeScore({
    leadsCreated: kpis.leadsCreated,
    leadsContacted: kpis.leadsContacted,
    leadsConverted: kpis.leadsConverted,
    conversionRate: kpis.conversionRate,
    appointmentsCompleted: kpis.appointmentsCompleted,
    appointmentShowRate: 0,
    callsMade: kpis.callsTotal,
    messagesSent: kpis.messagesSent,
    followUpsSent: kpis.followUpsSent,
    avgResponseTimeMin: kpis.avgResponseTimeMin,
    transactionsCompleted: kpis.transactionsCompleted,
    onboardingsCompleted: kpis.onboardingsCompleted,
  });
  return kpis;
}

export function kpisByPerson(data: PeriodData): Map<string, LeaderboardKpis> {
  const result = new Map<string, LeaderboardKpis>();
  const responseTotals = new Map<string, number>();
  const contacted = new Map<string, Set<string>>();
  const get = (key: string) => {
    let kpis = result.get(key);
    if (!kpis) {
      kpis = emptyKpis();
      result.set(key, kpis);
      responseTotals.set(key, 0);
      contacted.set(key, new Set());
    }
    return kpis;
  };

  for (const lead of data.newLeads) if (lead.key) get(lead.key).leadsCreated += 1;

  for (const event of data.events) {
    const kpis = get(event.key);
    if (event.type === 'call_made') {
      kpis.callsMade += 1;
      if (event.connected) kpis.callsConnected += 1;
      kpis.talkTimeSec += event.durationSec || 0;
    } else if (event.type === 'call_received') {
      kpis.callsAnswered += 1;
      kpis.talkTimeSec += event.durationSec || 0;
    } else if (event.type === 'message_sent') {
      if (event.channel === 'chat') kpis.chatsSent += 1;
      else kpis.textsSent += 1;
    } else if (event.type === 'email_sent') {
      kpis.emailsSent += 1;
    } else if (event.type === 'appointment_created') {
      kpis.appointmentsCompleted += 1;
    } else if (event.type === 'lead_converted') {
      kpis.leadsConverted += 1;
    } else if (event.type === 'transaction_completed') {
      kpis.transactionsCompleted += 1;
    } else if (event.type === 'onboarding_completed') {
      kpis.onboardingsCompleted += 1;
    }
    if (event.followUp) kpis.followUpsSent += 1;
    if (typeof event.responseMin === 'number') {
      kpis.responsesCount += 1;
      responseTotals.set(event.key, (responseTotals.get(event.key) || 0) + event.responseMin);
    }
    if (event.leadId && ['call_made', 'message_sent', 'email_sent'].includes(event.type)) contacted.get(event.key)!.add(event.leadId);
  }

  for (const [key, kpis] of result) finishKpis(kpis, responseTotals.get(key) || 0, contacted.get(key)!);
  return result;
}

export function teamTotals(data: PeriodData, byPerson: Map<string, LeaderboardKpis>) {
  const totals = emptyKpis();
  let responseTotal = 0;
  const contacted = new Set<string>();
  totals.leadsCreated = data.newLeads.length;
  for (const event of data.events) {
    if (typeof event.responseMin === 'number') responseTotal += event.responseMin;
    if (event.leadId && ['call_made', 'message_sent', 'email_sent'].includes(event.type)) contacted.add(event.leadId);
  }
  for (const kpis of byPerson.values()) {
    totals.callsMade += kpis.callsMade;
    totals.callsAnswered += kpis.callsAnswered;
    totals.callsConnected += kpis.callsConnected;
    totals.talkTimeSec += kpis.talkTimeSec;
    totals.leadsConverted += kpis.leadsConverted;
    totals.appointmentsCompleted += kpis.appointmentsCompleted;
    totals.textsSent += kpis.textsSent;
    totals.chatsSent += kpis.chatsSent;
    totals.emailsSent += kpis.emailsSent;
    totals.followUpsSent += kpis.followUpsSent;
    totals.transactionsCompleted += kpis.transactionsCompleted;
    totals.onboardingsCompleted += kpis.onboardingsCompleted;
    totals.responsesCount += kpis.responsesCount;
  }
  finishKpis(totals, responseTotal, contacted);
  const activeUsers = Array.from(byPerson.entries()).filter(([key, kpis]) =>
    data.people.people.has(key) && (kpis.callsTotal + kpis.messagesSent + kpis.appointmentsCompleted + kpis.leadsConverted + kpis.transactionsCompleted + kpis.onboardingsCompleted) > 0,
  ).length;
  return {
    ...totals,
    missedCalls: data.calls.filter((call) => call.missed).length,
    incomingCalls: data.calls.filter((call) => call.direction === 'inbound').length,
    activeUsers,
  };
}

export function metricOf(kpis: LeaderboardKpis, metric: RankMetric): number {
  if (metric === 'score') return kpis.totalScore;
  if (metric === 'leads') return kpis.leadsCreated;
  if (metric === 'appointments') return kpis.appointmentsCompleted;
  if (metric === 'messages') return kpis.messagesSent;
  if (metric === 'transactions') return kpis.transactionsCompleted;
  return kpis.callsTotal;
}

function rankRows<T extends { name: string; kpis: LeaderboardKpis }>(rows: T[], metric: RankMetric): Array<T & { rank: number; metricValue: number }> {
  const sorted = rows
    .map((row) => ({ ...row, metricValue: metricOf(row.kpis, metric) }))
    .sort((a, b) => b.metricValue - a.metricValue || b.kpis.totalScore - a.kpis.totalScore || a.name.localeCompare(b.name));
  let rank = 0;
  let previous: number | null = null;
  return sorted.map((row, index) => {
    if (previous === null || row.metricValue !== previous) rank = index + 1;
    previous = row.metricValue;
    return { ...row, rank };
  });
}

export function buildEntries(data: PeriodData, metric: RankMetric, previous?: PeriodData): LeaderboardEntry[] {
  const byPerson = kpisByPerson(data);
  const visible = Array.from(data.people.people.values()).filter((person) => person.active || byPerson.has(person.key));
  const ranked = rankRows(visible.map((person) => ({ person, name: person.name, kpis: byPerson.get(person.key) || emptyKpis() })), metric);

  const previousRanks = new Map<string, number>();
  if (previous) {
    const prevByPerson = kpisByPerson(previous);
    const prevRanked = rankRows(Array.from(previous.people.people.values())
      .filter((person) => prevByPerson.has(person.key))
      .map((person) => ({ person, name: person.name, kpis: prevByPerson.get(person.key)! })), metric);
    for (const row of prevRanked) if (row.metricValue > 0) previousRanks.set(row.person.key, row.rank);
  }

  return ranked.map((row) => {
    const prevRank = row.metricValue > 0 ? previousRanks.get(row.person.key) ?? null : null;
    return {
      rank: row.rank,
      prevRank,
      rankChange: prevRank ? prevRank - row.rank : null,
      metricValue: row.metricValue,
      user: {
        _id: row.person.primaryId,
        ids: row.person.ids,
        fullName: row.person.name,
        username: row.person.username,
        avatar: row.person.avatar,
        role: row.person.role,
        email: row.person.email,
      },
      kpis: row.kpis,
      badges: [],
      active: row.person.active,
    };
  });
}

export function buildCheckpoints(data: PeriodData, period: ResolvedPeriod, now: Date = new Date()) {
  if (!period.singleDay) return null;
  const marks = CHECKPOINT_HOURS.map((hour) => ({
    hour,
    label: hour === 12 ? '12 PM' : `${hour - 12} PM`,
    at: companyWallTimeUtc(period.fromDate, hour),
  }));
  const callEvents = data.events.filter((event) => event.type === 'call_made' || event.type === 'call_received');
  const byKey = new Map<string, Date[]>();
  for (const event of callEvents) {
    const list = byKey.get(event.key) || [];
    list.push(event.at);
    byKey.set(event.key, list);
  }
  const rows = Array.from(data.people.people.values())
    .filter((person) => person.active || byKey.has(person.key))
    .map((person) => {
      const times = byKey.get(person.key) || [];
      return {
        userId: person.primaryId,
        fullName: person.name,
        counts: marks.map((mark) => (mark.at > now ? null : times.filter((at) => at < mark.at).length)),
        total: times.length,
      };
    })
    .sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName));
  const teamCounts = marks.map((mark) => (mark.at > now ? null : callEvents.filter((event) => event.at < mark.at).length));
  return {
    date: period.fromDate,
    times: marks.map((mark) => mark.label),
    rows,
    teamCounts,
    teamTotal: callEvents.length,
  };
}

export function buildTrend(data: PeriodData, fromDate: string, days: number) {
  const buckets = new Map<string, { count: number; score: number }>();
  for (let i = 0; i < days; i++) buckets.set(addDaysToDateStr(fromDate, i), { count: 0, score: 0 });
  for (const event of data.events) {
    const bucket = buckets.get(toCompanyDateStr(event.at));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.score += EVENT_SCORES[event.type];
  }
  return Array.from(buckets.entries()).map(([day, value]) => ({ _id: day, count: value.count, score: Math.round(value.score * 10) / 10 }));
}

export function buildByAction(data: PeriodData) {
  const counts = new Map<string, number>();
  for (const event of data.events) counts.set(event.type, (counts.get(event.type) || 0) + 1);
  const followUps = data.events.filter((event) => event.followUp).length;
  if (followUps) counts.set('follow_up_sent', followUps);
  return Array.from(counts.entries())
    .map(([type, count]) => ({ _id: type, count }))
    .sort((a, b) => b.count - a.count);
}

function eventDetail(event: StaffEvent): string {
  if (event.type === 'call_made') return event.connected ? `Talked ${formatDuration(event.durationSec || 0)}` : 'No answer';
  if (event.type === 'call_received') return `Talked ${formatDuration(event.durationSec || 0)}`;
  if (event.type === 'message_sent') return event.channel === 'chat' ? 'Website chat' : 'Text';
  if (event.type === 'email_sent') return 'Email';
  if (event.type === 'appointment_created' && event.detail) {
    return `For ${new Date(event.detail).toLocaleString('en-US', { timeZone: COMPANY_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }
  return event.detail || '';
}

export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function buildFeed(data: PeriodData, limit: number) {
  return data.events.slice(0, limit).map((event) => {
    const person = data.people.people.get(event.key);
    return {
      _id: `${event.type}:${event.id}`,
      actionType: event.type,
      sourceModule: EVENT_MODULES[event.type],
      timestamp: event.at.toISOString(),
      score: EVENT_SCORES[event.type],
      followUp: Boolean(event.followUp),
      customer: event.customer || '',
      detail: eventDetail(event),
      user: person ? { fullName: person.name, username: person.username, avatar: person.avatar } : undefined,
    };
  });
}

function denverDateTime(at: Date): string {
  return at.toLocaleString('en-US', { timeZone: COMPANY_TZ, month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function buildRecords(data: PeriodData, period: ResolvedPeriod, scope: 'calls' | 'full', metric: RankMetric) {
  const entries = buildEntries(data, metric);
  const byPerson = kpisByPerson(data);
  const totals = teamTotals(data, byPerson);
  const nameOf = (key: string | null) => (key ? data.people.people.get(key)?.name || 'Former team member' : '');

  const callRows = data.calls.slice(0, MAX_RECORD_ROWS).map((call) => ({
    when: denverDateTime(call.at),
    employee: call.key ? nameOf(call.key) : call.missed ? 'Nobody (missed)' : '',
    direction: call.direction === 'outbound' ? 'Outgoing' : 'Incoming',
    result: call.answered ? 'Answered' : call.missed ? 'Missed' : call.direction === 'outbound' ? 'No answer' : 'Not answered',
    customer: call.customer,
    number: call.number,
    duration: call.answered ? formatDuration(call.durationSec) : '',
  }));

  const activityRows = scope === 'full'
    ? data.events.slice(0, MAX_RECORD_ROWS).map((event) => ({
        when: denverDateTime(event.at),
        employee: nameOf(event.key),
        action: EVENT_LABELS[event.type] + (event.followUp ? ' (follow-up)' : ''),
        customer: event.customer || '',
        detail: eventDetail(event),
      }))
    : [];

  return {
    period: { label: period.label, from: period.fromDate, to: period.toDate, timezone: COMPANY_TZ },
    scope,
    generatedAt: new Date().toISOString(),
    totals,
    people: entries.map((entry) => ({
      rank: entry.rank,
      name: entry.user.fullName,
      email: entry.user.email,
      role: entry.user.role,
      kpis: entry.kpis,
    })),
    checkpoints: buildCheckpoints(data, period),
    calls: callRows,
    callsTruncated: data.calls.length > MAX_RECORD_ROWS,
    activity: activityRows,
    activityTruncated: scope === 'full' && data.events.length > MAX_RECORD_ROWS,
  };
}

const badgeChecks = new Map<string, number>();
const BADGE_CHECK_MS = 5 * 60_000;

function badgeMetric(kpis: LeaderboardKpis, metric: string): number {
  return Number((kpis as any)[metric] ?? 0);
}

export async function awardBadges(orgId: string, now: Date = new Date()): Promise<void> {
  const last = badgeChecks.get(orgId) || 0;
  if (now.getTime() - last < BADGE_CHECK_MS) return;
  badgeChecks.set(orgId, now.getTime());

  const periods = [
    { kind: 'weekly', period: resolvePeriod({ period: 'this_week' }, now) },
    { kind: 'weekly', period: resolvePeriod({ period: 'last_week' }, now) },
    { kind: 'monthly', period: resolvePeriod({ period: 'this_month' }, now) },
    { kind: 'monthly', period: resolvePeriod({ period: 'last_month' }, now) },
  ];
  const [everAssigned, ...datas] = await Promise.all([
    Lead.distinct('assignedTo', { organizationId: new mongoose.Types.ObjectId(orgId), assignedTo: { $ne: null } }),
    ...periods.map((item) => cachedPeriodData(orgId, item.period.start, item.period.end)),
  ]);
  const windows = periods.map((item, index) => {
    const data = datas[index] as PeriodData;
    return {
      kind: item.kind,
      periodKey: item.kind === 'weekly' ? `week-${item.period.fromDate}` : `month-${item.period.fromDate.slice(0, 7)}`,
      kpis: kpisByPerson(data),
      ranks: new Map(buildEntries(data, 'score').filter((entry) => entry.kpis.totalScore > 0).map((entry) => [entry.user._id, entry.rank])),
    };
  });
  const people = (datas[0] as PeriodData).people;
  const firstLeadKeys = new Set((everAssigned as any[]).map((id) => keyOf(people, id)).filter(Boolean) as string[]);

  const awards: Array<{ person: Person; badgeId: string; periodKey: string; value: number; threshold: number }> = [];
  const check = (person: Person, badge: (typeof BADGE_DEFINITIONS)[number], periodKey: string, value: number | undefined) => {
    if (value === undefined || value === null) return;
    const cond = badge.condition;
    let earned = false;
    if (cond.operator === 'gte') earned = value >= cond.value;
    if (cond.operator === 'lte') earned = value > 0 && value <= cond.value;
    if (cond.operator === 'eq') earned = value === cond.value;
    if (earned) awards.push({ person, badgeId: badge.id, periodKey, value, threshold: cond.value });
  };

  for (const person of people.people.values()) {
    if (!person.active || !mongoose.isValidObjectId(person.primaryId)) continue;
    for (const badge of BADGE_DEFINITIONS) {
      const cond = badge.condition;
      if (cond.period === 'alltime') {
        if (cond.metric === 'leadsCreated') check(person, badge, 'alltime', firstLeadKeys.has(person.key) ? 1 : 0);
        continue;
      }
      for (const window of windows) {
        if (window.kind !== cond.period) continue;
        if (cond.metric === 'rank') {
          check(person, badge, window.periodKey, window.ranks.get(person.primaryId));
          continue;
        }
        const kpis = window.kpis.get(person.key);
        if (cond.metric === 'avgResponseTimeMin' && (!kpis || kpis.responsesCount === 0)) continue;
        if (badge.id === 'converter' && (!kpis || kpis.leadsCreated < 5)) continue;
        check(person, badge, window.periodKey, kpis ? badgeMetric(kpis, cond.metric) : 0);
      }
    }
  }

  if (!awards.length) return;
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  await UserBadge.bulkWrite(
    awards.map((award) => ({
      updateOne: {
        filter: { organizationId: orgObjectId, userId: new mongoose.Types.ObjectId(award.person.primaryId), badgeId: award.badgeId, periodKey: award.periodKey },
        update: { $setOnInsert: { awardedAt: now, metadata: { metricValue: award.value, threshold: award.threshold } } },
        upsert: true,
      },
    })),
    { ordered: false },
  ).catch((err: any) => {
    if (err?.code !== 11000 && !err?.writeErrors?.every?.((item: any) => item.code === 11000)) throw err;
  });
}

export async function badgesByKey(orgId: string, index: PeopleIndex): Promise<Map<string, string[]>> {
  const rows = await UserBadge.find({ organizationId: new mongoose.Types.ObjectId(orgId) }).select('userId badgeId').lean();
  const result = new Map<string, Set<string>>();
  for (const row of rows as any[]) {
    const key = keyOf(index, row.userId);
    if (!key) continue;
    const set = result.get(key) || new Set<string>();
    set.add(String(row.badgeId));
    result.set(key, set);
  }
  return new Map(Array.from(result.entries()).map(([key, set]) => [key, Array.from(set)]));
}
