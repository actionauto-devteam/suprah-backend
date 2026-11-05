import mongoose from 'mongoose';
import CrmAutomation from '../models/CrmAutomation.model';
import CrmAutomationRun from '../models/CrmAutomationRun.model';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import Appointment from '../models/Appointment.model';
import { CommunicationMessage } from '../models/communication.model';
import { ApiError } from '../utils/ApiError';
import { COMPANY_TZ, addDaysToDateStr, toCompanyDateStr, zoneMidnightUtc } from '../utils/companyTimezone';
import { AUTOMATION_ACTIONS, isAutomationEngineEnabled } from './crmAutomation.service';

export const MONITOR_STATUSES = ['message_sent', 'processed', 'scheduled', 'filtered', 'failed'] as const;
export const MONITOR_RANGES = ['today', 'last_7_days', 'last_30_days', 'month_to_date', 'last_month'] as const;
export const MONITOR_GROUPS = ['day', 'week', 'month'] as const;
type MonitorStatus = (typeof MONITOR_STATUSES)[number];
type MonitorRange = (typeof MONITOR_RANGES)[number];
type MonitorGroup = (typeof MONITOR_GROUPS)[number];

const PAGE_SIZE = 25;
const EXPORT_LIMIT = 5000;
const MAX_CUSTOM_DAYS = 366;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEARCH = 80;
const TEXT_STEPS = new Set(['send_message', 'send_review_invitation', 'send_appointment_confirmation', 'send_ai_follow_up']);
const DELIVERED = new Set(['sent', 'test']);
const REENGAGE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_LABELS: Record<MonitorStatus, string> = {
  message_sent: 'Message Sent',
  processed: 'Processed',
  scheduled: 'Scheduled',
  filtered: 'Filtered',
  failed: 'Failed',
};

const LOG_LABELS: Record<string, string> = { sent: 'Sent', test: 'Test only', skipped: 'Skipped', failed: 'Failed', done: 'Done' };

const STATUS_MATCH: Record<MonitorStatus, Record<string, unknown>> = {
  message_sent: { status: { $in: ['completed', 'stopped'] }, sentAnyMessage: true },
  processed: { status: { $in: ['completed', 'stopped'] }, sentAnyMessage: { $ne: true } },
  scheduled: { status: { $in: ['waiting', 'running'] } },
  filtered: { status: 'filtered' },
  failed: { status: 'failed' },
};

const STATUS_EXPR = {
  $switch: {
    branches: [
      { case: { $in: ['$status', ['waiting', 'running']] }, then: 'scheduled' },
      { case: { $eq: ['$status', 'filtered'] }, then: 'filtered' },
      { case: { $eq: ['$status', 'failed'] }, then: 'failed' },
      { case: { $eq: ['$sentAnyMessage', true] }, then: 'message_sent' },
    ],
    default: 'processed',
  },
};

export interface MonitorQuery {
  mode?: string;
  automationId?: string;
  tag?: string;
  status?: string;
  q?: string;
  name?: string;
  range?: string;
  group?: string;
  page?: number;
  view?: string;
  from?: string;
  to?: string;
}

function bad(message: string): never {
  throw new ApiError(400, message);
}

export function monitorStatus(run: { status: string; sentAnyMessage?: boolean }): MonitorStatus {
  if (run.status === 'waiting' || run.status === 'running') return 'scheduled';
  if (run.status === 'filtered' || run.status === 'failed') return run.status;
  return run.sentAnyMessage ? 'message_sent' : 'processed';
}

export function rangeBounds(range: MonitorRange, now: Date = new Date()) {
  const today = toCompanyDateStr(now);
  let from = today;
  let to = today;
  if (range === 'last_7_days') from = addDaysToDateStr(today, -6);
  if (range === 'last_30_days') from = addDaysToDateStr(today, -29);
  if (range === 'month_to_date') from = `${today.slice(0, 8)}01`;
  if (range === 'last_month') {
    to = addDaysToDateStr(`${today.slice(0, 8)}01`, -1);
    from = `${to.slice(0, 8)}01`;
  }
  return { key: range, from, to, start: zoneMidnightUtc(from, COMPANY_TZ), end: zoneMidnightUtc(addDaysToDateStr(to, 1), COMPANY_TZ) };
}

function isCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function customBounds(from: string, to: string) {
  if (!isCalendarDay(from) || !isCalendarDay(to)) bad('Pick a valid start and end date');
  if (from > to) bad('The start date must be on or before the end date');
  const days = Math.round((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / DAY_MS) + 1;
  if (days > MAX_CUSTOM_DAYS) bad('Pick a date range of one year or less');
  return { key: 'custom' as const, from, to, start: zoneMidnightUtc(from, COMPANY_TZ), end: zoneMidnightUtc(addDaysToDateStr(to, 1), COMPANY_TZ) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function monitorMatch(orgId: string, query: MonitorQuery) {
  const mode = query.mode === 'test' ? 'test' : 'live';
  const range = (MONITOR_RANGES as readonly string[]).includes(String(query.range)) ? (query.range as MonitorRange) : 'month_to_date';
  if (query.status && !(MONITOR_STATUSES as readonly string[]).includes(query.status)) bad('That status is not valid');
  const match: Record<string, unknown> = { organizationId: orgId, mode };
  let ids: mongoose.Types.ObjectId[] | null = null;
  if (query.automationId) {
    if (!mongoose.isValidObjectId(query.automationId)) bad('That automation is not valid');
    ids = [new mongoose.Types.ObjectId(query.automationId)];
  }
  const tag = String(query.tag || '').trim();
  if (tag) {
    const tagged = await CrmAutomation.find({ organizationId: orgId, tags: tag }).select('_id').lean();
    const taggedIds = tagged.map((doc: any) => String(doc._id));
    ids = (ids || tagged.map((doc: any) => doc._id)).filter((id) => taggedIds.includes(String(id)));
  }
  if (ids) match.automationId = { $in: ids };
  const text = String(query.q || '').trim().slice(0, MAX_SEARCH);
  if (text) {
    const pattern = new RegExp(escapeRegex(text), 'i');
    const or: Record<string, unknown>[] = [{ 'contact.name': pattern }, { 'contact.email': pattern }, { 'contact.phone': pattern }];
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 3) or.push({ 'contact.phone': new RegExp(digits) });
    match.$or = or;
  }
  const name = String(query.name || '').trim().slice(0, MAX_SEARCH);
  if (name) match.automationName = new RegExp(escapeRegex(name), 'i');
  const status = query.status ? STATUS_MATCH[query.status as MonitorStatus] : {};
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  return { mode, match, status, range: from || to ? customBounds(from, to) : rangeBounds(range) };
}

function actionLabel(type: string | undefined): string {
  if (!type) return '';
  return AUTOMATION_ACTIONS.find((action) => action.key === type)?.label || type;
}

function channelOf(entries: Array<{ type: string; status: string }>): string {
  const channels = new Set<string>();
  for (const entry of entries) {
    if (!DELIVERED.has(entry.status)) continue;
    if (TEXT_STEPS.has(entry.type)) channels.add('Text');
    if (entry.type === 'send_email') channels.add('Email');
  }
  return Array.from(channels).join(', ');
}

function serializeRun(run: any) {
  const log = run.log || [];
  const pending = run.status === 'waiting' || run.status === 'running' ? (run.steps || [])[run.stepIndex] : null;
  const stepType = pending?.type || log[log.length - 1]?.type || (run.steps || []).find((step: any) => step.type !== 'wait')?.type;
  return {
    id: String(run._id),
    automationId: String(run.automationId),
    automationName: run.automationName,
    mode: run.mode,
    event: run.event,
    status: run.status,
    display: monitorStatus(run),
    step: actionLabel(stepType),
    channel: channelOf(log),
    reason: run.reason,
    contact: run.contact,
    triggerAt: run.triggerAt,
    nextRunAt: run.nextRunAt,
    createdAt: run.createdAt,
    log: log.map((entry: any) => ({ type: entry.type, status: entry.status, detail: entry.detail, at: entry.at })),
  };
}

type MonitorScope = Awaited<ReturnType<typeof monitorMatch>>;

function runFilter({ match, status, range }: MonitorScope) {
  return { ...match, ...status, createdAt: { $gte: range.start, $lt: range.end } };
}

function logStages({ match, status, range }: MonitorScope): any[] {
  const inRange = { $gte: range.start, $lt: range.end };
  return [
    { $match: { ...match, ...status, log: { $elemMatch: { at: inRange } } } },
    { $project: { automationId: 1, automationName: 1, contact: 1, log: 1 } },
    { $unwind: { path: '$log', includeArrayIndex: 'position' } },
    { $match: { 'log.at': inRange } },
  ];
}

async function findRuns(orgId: string, query: MonitorQuery, skip: number, limit: number) {
  const scope = await monitorMatch(orgId, query);
  const filter = runFilter(scope);
  const [items, total] = await Promise.all([
    CrmAutomationRun.find(filter).select('-settings').sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmAutomationRun.countDocuments(filter),
  ]);
  return { mode: scope.mode, range: scope.range, total, items: items.map(serializeRun) };
}

async function findLogs(orgId: string, query: MonitorQuery, skip: number, limit: number) {
  const scope = await monitorMatch(orgId, query);
  const { mode, range } = scope;
  const [result] = await CrmAutomationRun.aggregate([
    ...logStages(scope),
    { $sort: { 'log.at': -1, _id: -1, position: -1 } },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'count' }] } },
  ]);
  const rows: any[] = result?.items || [];
  const items = rows.map((row) => ({
    id: `${row._id}:${row.position}`,
    runId: String(row._id),
    automationId: String(row.automationId),
    automationName: row.automationName,
    contact: row.contact,
    type: row.log.type,
    step: actionLabel(row.log.type) || (row.log.type === 'wait' ? 'Wait' : row.log.type),
    status: row.log.status,
    channel: channelOf([row.log]),
    detail: row.log.detail,
    at: row.log.at,
  }));
  return { mode, range, total: result?.total?.[0]?.count || 0, items };
}

function pageOf(query: MonitorQuery) {
  return Math.max(1, Math.min(1000, Number(query.page) || 1));
}

export async function listAutomationActivity(orgId: string, query: MonitorQuery) {
  const page = pageOf(query);
  const data = await findRuns(orgId, query, (page - 1) * PAGE_SIZE, PAGE_SIZE);
  return { mode: data.mode, engineEnabled: isAutomationEngineEnabled(), range: { key: data.range.key, from: data.range.from, to: data.range.to }, page, pages: Math.max(1, Math.ceil(data.total / PAGE_SIZE)), total: data.total, items: data.items };
}

export async function listAutomationLogs(orgId: string, query: MonitorQuery) {
  const page = pageOf(query);
  const data = await findLogs(orgId, query, (page - 1) * PAGE_SIZE, PAGE_SIZE);
  return { mode: data.mode, range: { key: data.range.key, from: data.range.from, to: data.range.to }, page, pages: Math.max(1, Math.ceil(data.total / PAGE_SIZE)), total: data.total, items: data.items };
}

function emptyCounts(): Record<MonitorStatus, number> {
  return { message_sent: 0, processed: 0, scheduled: 0, filtered: 0, failed: 0 };
}

function bucketKey(day: string, group: MonitorGroup): string {
  if (group === 'month') return day.slice(0, 7);
  if (group === 'day') return day;
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addDaysToDateStr(day, -weekday);
}

export async function getActivitySummary(orgId: string, query: MonitorQuery, now: Date = new Date()) {
  const { mode, match, range } = await monitorMatch(orgId, { ...query, status: undefined });
  const group = (MONITOR_GROUPS as readonly string[]).includes(String(query.group)) ? (query.group as MonitorGroup) : 'day';
  const today = rangeBounds('today', now);
  const month = rangeBounds('month_to_date', now);
  const [rows, dayToDate, monthToDate] = await Promise.all([
    CrmAutomationRun.aggregate([
      { $match: { ...match, createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: COMPANY_TZ } }, status: STATUS_EXPR }, count: { $sum: 1 } } },
    ]),
    CrmAutomationRun.countDocuments({ ...match, createdAt: { $gte: today.start, $lt: today.end } }),
    CrmAutomationRun.countDocuments({ ...match, createdAt: { $gte: month.start, $lt: month.end } }),
  ]);
  const buckets = new Map<string, { from: string; to: string; counts: Record<MonitorStatus, number>; total: number }>();
  for (let day = range.from; day <= range.to; day = addDaysToDateStr(day, 1)) {
    const key = bucketKey(day, group);
    const bucket = buckets.get(key) || { from: day, to: day, counts: emptyCounts(), total: 0 };
    bucket.to = day;
    buckets.set(key, bucket);
  }
  const counts = emptyCounts();
  for (const row of rows) {
    const bucket = buckets.get(bucketKey(row._id.day, group));
    const status = row._id.status as MonitorStatus;
    if (!bucket || !(status in counts)) continue;
    bucket.counts[status] += row.count;
    bucket.total += row.count;
    counts[status] += row.count;
  }
  return {
    mode,
    engineEnabled: isAutomationEngineEnabled(),
    range: { key: range.key, from: range.from, to: range.to },
    group,
    buckets: Array.from(buckets.values()),
    counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    dayToDate,
    monthToDate,
  };
}

function timesByLead(rows: Array<{ leadId?: unknown; createdAt?: unknown }>): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    const key = String(row.leadId);
    const list = map.get(key) || [];
    list.push(new Date(row.createdAt as string).getTime());
    map.set(key, list);
  }
  return map;
}

export async function getReengagementSummary(orgId: string, now: Date = new Date()) {
  const range = rangeBounds('last_30_days', now);
  const logs = await VehicleReengagementLog.find({ organizationId: orgId, status: 'sent', sentAt: { $gte: range.start, $lt: range.end } }).select('leadId sentAt').lean();
  const days = new Map<string, { day: string; sent: number; engaged: number; booked: number }>();
  for (let day = range.from; day <= range.to; day = addDaysToDateStr(day, 1)) days.set(day, { day, sent: 0, engaged: 0, booked: 0 });
  const leadIds = Array.from(new Set(logs.map((log) => String(log.leadId)))).filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const orgIds: unknown[] = mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
  const [replies, bookings] = leadIds.length
    ? await Promise.all([
        CommunicationMessage.find({ orgId: { $in: orgIds }, leadId: { $in: leadIds }, direction: 'inbound', createdAt: { $gte: range.start } }).select('leadId createdAt').lean(),
        Appointment.find({ organizationId: orgId, leadId: { $in: leadIds }, createdAt: { $gte: range.start } }).select('leadId createdAt').lean(),
      ])
    : [[], []];
  const replyTimes = timesByLead(replies as any[]);
  const bookingTimes = timesByLead(bookings as any[]);
  const windowMs = REENGAGE_WINDOW_DAYS * DAY_MS;
  const within = (times: number[] | undefined, start: number) => Boolean(times?.some((time) => time > start && time <= start + windowMs));
  for (const log of logs) {
    if (!log.sentAt) continue;
    const bucket = days.get(toCompanyDateStr(new Date(log.sentAt)));
    if (!bucket) continue;
    const start = new Date(log.sentAt).getTime();
    bucket.sent += 1;
    if (within(replyTimes.get(String(log.leadId)), start)) bucket.engaged += 1;
    if (within(bookingTimes.get(String(log.leadId)), start)) bucket.booked += 1;
  }
  const list = Array.from(days.values());
  const totals = list.reduce((sum, day) => ({ sent: sum.sent + day.sent, engaged: sum.engaged + day.engaged, booked: sum.booked + day.booked }), { sent: 0, engaged: 0, booked: 0 });
  return {
    range: { from: range.from, to: range.to },
    enabled: process.env.VEHICLE_REENGAGEMENT_ENABLED === 'true',
    windowDays: REENGAGE_WINDOW_DAYS,
    days: list,
    totals,
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function denverTime(value: unknown): string {
  if (!value) return '';
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { timeZone: COMPANY_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function countAutomationExport(orgId: string, query: MonitorQuery) {
  const view = query.view === 'logs' ? 'logs' : 'events';
  const scope = await monitorMatch(orgId, query);
  let total: number;
  if (view === 'logs') {
    const [result] = await CrmAutomationRun.aggregate([...logStages(scope), { $count: 'count' }]);
    total = result?.count || 0;
  } else {
    total = await CrmAutomationRun.countDocuments(runFilter(scope));
  }
  return { view, mode: scope.mode, range: { from: scope.range.from, to: scope.range.to }, total, limit: EXPORT_LIMIT, rows: Math.min(total, EXPORT_LIMIT) };
}

export async function exportAutomationActivity(orgId: string, query: MonitorQuery) {
  const view = query.view === 'logs' ? 'logs' : 'events';
  const rows: unknown[][] = [];
  let header: string[];
  let range: { from: string; to: string };
  if (view === 'logs') {
    const data = await findLogs(orgId, query, 0, EXPORT_LIMIT);
    range = data.range;
    header = ['Contact', 'Phone', 'Email', 'Automation', 'Step', 'Result', 'Channel', 'Detail', 'Time (Mountain)'];
    for (const item of data.items) rows.push([item.contact?.name, item.contact?.phone, item.contact?.email, item.automationName, item.step, LOG_LABELS[item.status] || item.status, item.channel, item.detail, denverTime(item.at)]);
  } else {
    const data = await findRuns(orgId, query, 0, EXPORT_LIMIT);
    range = data.range;
    header = ['Contact', 'Phone', 'Email', 'Automation', 'Action', 'Status', 'Reason', 'Channel', 'Created At (Mountain)'];
    for (const item of data.items) rows.push([item.contact?.name, item.contact?.phone, item.contact?.email, item.automationName, item.step, STATUS_LABELS[item.display], item.reason, item.channel, denverTime(item.createdAt)]);
  }
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const suffix = query.mode === 'test' ? '-test-mode' : '';
  return { filename: `automation-${view}${suffix}-${range.from}-to-${range.to}.csv`, csv: `\uFEFF${csv}\r\n` };
}
