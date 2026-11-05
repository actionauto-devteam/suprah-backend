import mongoose from 'mongoose';
import CrmAutomation from '../models/CrmAutomation.model';
import CrmAutomationRun, { CrmAutomationRunLog, ICrmAutomationRun } from '../models/CrmAutomationRun.model';
import CrmAutomationCursor from '../models/CrmAutomationCursor.model';
import CrmLocation from '../models/CrmLocation.model';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import WebChatSession from '../models/WebChatSession.model';
import AiAgentTask from '../models/AiAgentTask.model';
import User from '../models/User.model';
import { CallLog, CommunicationMessage, Conversation } from '../models/communication.model';
import emailService from './email.service';
import {
  buildReviewRequestMessage,
  formatApptTimeForSms,
  normalizePhone,
  resolveDealerName,
  resolveReviewLink,
  sendAutomatedSms,
  senderIntro,
} from './communication.service';
import { isContactRestrictedError } from './contactRestriction.service';
import { isSmsDestinationError } from '../utils/smsDestination';
import { notifyUsers } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { createAiAgentTaskAndNotify } from '../utils/aiAgentTask';
import { resolveAiAgentIdentity } from '../utils/aiAgentIdentity';
import { emitToOrg } from '../utils/socketEmitter';
import { normalizeLocationKey } from '../utils/locationKey';
import { dialedKey, dialedNumberLocations, locationDisplayName } from './crmAutomationCalls.service';
import { COMPANY_TZ, addDaysToDateStr, toCompanyDateStr, zoneMidnightUtc } from '../utils/companyTimezone';
import { AI_AGENT_ASSIGNEE, ENGINE_EVENTS, isAutomationEngineEnabled, teamQuery } from './crmAutomation.service';
import logger from '../utils/logger';

const MINUTE = 60 * 1000;
const OVERLAP_MS = 2 * MINUTE;
const MAX_CATCH_UP_MS = 60 * MINUTE;
const RECENT_CALL_WINDOW_MS = 6 * 60 * MINUTE;
const LEASE_MS = 5 * MINUTE;
const STALE_BEFORE_MS = 15 * MINUTE;
const RECORD_LIMIT = 500;
const RUN_BATCH = 50;
const SEND_START_HOUR = 9;
const SEND_END_HOUR = 20;
const MESSAGE_STEPS = new Set(['send_message', 'send_review_invitation', 'send_appointment_confirmation', 'send_email']);
const UNIT_MS: Record<string, number> = { minutes: MINUTE, hours: 60 * MINUTE, days: 24 * 60 * MINUTE };
const LEAD_FIELDS = 'firstName lastName email phone normalizedPhone normalizedEmail channel source status tags assignedTo location vehicle createdAt intakeIdentity organizationId';
const APPOINTMENT_STATUS_EVENTS: Record<string, string> = {
  confirmed: 'appointment_confirmed',
  cancelled: 'appointment_cancelled',
  'no-show': 'appointment_no_show',
  completed: 'appointment_completed',
};

export interface EngineEvent {
  eventKey: string;
  triggerAt: Date;
  leadId: string | null;
  phone: string;
  email: string;
  name: string;
  targetAt?: Date | null;
  appointmentId?: string | null;
  location?: string;
}

interface ActionResult {
  status: CrmAutomationRunLog['status'];
  detail: string;
}

function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function fullName(first?: unknown, last?: unknown): string {
  return [first, last].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function denverHour(date: Date): number {
  return parseInt(date.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: COMPANY_TZ }), 10) % 24;
}

export function nextSendingTime(due: Date): Date {
  const hour = denverHour(due);
  if (hour >= SEND_START_HOUR && hour < SEND_END_HOUR) return due;
  const day = toCompanyDateStr(due);
  const startDay = hour < SEND_START_HOUR ? day : addDaysToDateStr(day, 1);
  return new Date(zoneMidnightUtc(startDay, COMPANY_TZ).getTime() + SEND_START_HOUR * 60 * MINUTE);
}

async function readCursor(key: string, now: Date): Promise<Date | null> {
  const cursor = await CrmAutomationCursor.findOne({ key }).lean();
  if (!cursor) {
    await CrmAutomationCursor.updateOne({ key }, { $setOnInsert: { at: now } }, { upsert: true });
    return null;
  }
  return new Date(Math.max(new Date(cursor.at).getTime() - OVERLAP_MS, now.getTime() - MAX_CATCH_UP_MS));
}

async function moveCursor(key: string, now: Date) {
  await CrmAutomationCursor.updateOne({ key }, { $set: { at: now } }, { upsert: true });
}

function leadEvent(lead: any, eventKey: string, triggerAt: Date): EngineEvent {
  return {
    eventKey,
    triggerAt,
    leadId: String(lead._id),
    phone: String(lead.phone || ''),
    email: String(lead.email || ''),
    name: fullName(lead.firstName, lead.lastName),
  };
}

function leadMatches(event: string, lead: any): boolean {
  if (lead.source === 'Demo' || lead.intakeIdentity === 'unverified') return false;
  if (event === 'website_form_lead') return ['Website Inquiry', 'Website Booking'].includes(lead.source) || lead.channel === 'web';
  if (event === 'adf_lead_received') return lead.channel === 'adf' || lead.source === 'Third-Party Lead';
  if (event === 'email_lead_received') return lead.channel === 'email' || lead.source === 'Email Inquiry';
  return true;
}

async function collectEvents(orgId: string, event: string, since: Date, now: Date): Promise<EngineEvent[]> {
  const orgIds = orgIdVariants(orgId);
  if (['lead_created', 'website_form_lead', 'adf_lead_received', 'email_lead_received'].includes(event)) {
    const leads = await Lead.find({ organizationId: { $in: orgIds }, createdAt: { $gt: since, $lte: now } }).select(LEAD_FIELDS).limit(RECORD_LIMIT).lean();
    return leads.filter((lead: any) => leadMatches(event, lead)).map((lead: any) => leadEvent(lead, `lead:${lead._id}`, new Date(lead.createdAt)));
  }
  if (event === 'lead_status_changed' || event === 'lead_assigned') {
    const path = event === 'lead_status_changed' ? 'statusHistory' : 'assignmentHistory';
    const leads = await Lead.find({ organizationId: { $in: orgIds }, updatedAt: { $gt: since }, [`${path}.changedAt`]: { $gt: since, $lte: now } })
      .select(`${LEAD_FIELDS} ${path}`)
      .limit(RECORD_LIMIT)
      .lean();
    return leads.flatMap((lead: any) => (lead[path] || [])
      .filter((entry: any) => entry.changedAt && new Date(entry.changedAt) > since && new Date(entry.changedAt) <= now && (event === 'lead_status_changed' || entry.to))
      .map((entry: any) => leadEvent(lead, `${path}:${lead._id}:${new Date(entry.changedAt).getTime()}`, new Date(entry.changedAt))));
  }
  if (event === 'ai_handoff') {
    const tasks = await AiAgentTask.find({ organizationId: orgId, createdAt: { $gt: since, $lte: now }, attentionKind: { $ne: 'technical' } }).select('leadId createdAt').limit(RECORD_LIMIT).lean();
    return tasks.map((task: any) => ({ eventKey: `handoff:${task._id}`, triggerAt: new Date(task.createdAt), leadId: String(task.leadId), phone: '', email: '', name: '' }));
  }
  if (event === 'text_received') {
    const conversations = await Conversation.find({ orgId: { $in: orgIds }, lastMessageAt: { $gt: since } }).select('_id').limit(RECORD_LIMIT).lean();
    if (!conversations.length) return [];
    const messages = await CommunicationMessage.find({ conversationId: { $in: conversations.map((item: any) => item._id) }, direction: 'inbound', createdAt: { $gt: since, $lte: now } })
      .select('from leadId createdAt')
      .limit(RECORD_LIMIT)
      .lean();
    return messages.map((message: any) => ({ eventKey: `sms:${message._id}`, triggerAt: new Date(message.createdAt), leadId: message.leadId ? String(message.leadId) : null, phone: String(message.from || ''), email: '', name: '' }));
  }
  if (event === 'call_missed' || event === 'call_ended' || event === 'call_any') {
    const calls = await CallLog.find({
      orgId: { $in: orgIds },
      createdAt: { $gt: new Date(since.getTime() - RECENT_CALL_WINDOW_MS) },
      direction: 'inbound',
      status: event === 'call_any' ? { $in: ['missed', 'completed'] } : event === 'call_missed' ? 'missed' : 'completed',
      endedAt: { $gt: since, $lte: now },
    }).select('from to customerName leadId endedAt').limit(RECORD_LIMIT).lean();
    const dialed = await dialedNumberLocations(orgId, calls.map((call: any) => String(call.to || '')));
    return calls.map((call: any) => ({ eventKey: `${event}:${call._id}`, triggerAt: new Date(call.endedAt), leadId: call.leadId ? String(call.leadId) : null, phone: String(call.from || ''), email: '', name: String(call.customerName || ''), location: dialed.get(dialedKey(call.to)) || '' }));
  }
  if (event === 'website_chat_started') {
    const sessions = await WebChatSession.find({ organizationId: orgId, createdAt: { $gt: since, $lte: now } }).select('leadId visitorName visitorPhone visitorEmail createdAt').limit(RECORD_LIMIT).lean();
    return sessions.map((session: any) => ({ eventKey: `chat:${session._id}`, triggerAt: new Date(session.createdAt), leadId: session.leadId ? String(session.leadId) : null, phone: String(session.visitorPhone || ''), email: String(session.visitorEmail || ''), name: String(session.visitorName || '') }));
  }
  if (event.startsWith('appointment_')) {
    const appointmentEvent = (appointment: any, eventKey: string, triggerAt: Date): EngineEvent => ({
      eventKey,
      triggerAt,
      leadId: appointment.leadId ? String(appointment.leadId) : null,
      phone: String(appointment.customerBooking?.phone || ''),
      email: String(appointment.customerBooking?.email || ''),
      name: fullName(appointment.customerBooking?.firstName, appointment.customerBooking?.lastName),
      targetAt: appointment.startTime ? new Date(appointment.startTime) : null,
      appointmentId: String(appointment._id),
    });
    const fields = 'leadId customerBooking startTime createdAt statusHistory rescheduleNotice';
    if (event === 'appointment_booked') {
      const appointments = await Appointment.find({ organizationId: orgId, entryType: 'appointment', createdAt: { $gt: since, $lte: now } }).select(fields).limit(RECORD_LIMIT).lean();
      return appointments.map((appointment: any) => appointmentEvent(appointment, `booked:${appointment._id}`, new Date(appointment.createdAt)));
    }
    if (event === 'appointment_rescheduled') {
      const appointments = await Appointment.find({ organizationId: orgId, entryType: 'appointment', 'rescheduleNotice.updatedAt': { $gt: since, $lte: now } }).select(fields).limit(RECORD_LIMIT).lean();
      return appointments.map((appointment: any) => appointmentEvent(appointment, `moved:${appointment._id}:${new Date(appointment.rescheduleNotice.forStartTime).getTime()}`, new Date(appointment.rescheduleNotice.updatedAt)));
    }
    const status = Object.keys(APPOINTMENT_STATUS_EVENTS).find((key) => APPOINTMENT_STATUS_EVENTS[key] === event);
    if (!status) return [];
    const appointments = await Appointment.find({ organizationId: orgId, entryType: 'appointment', updatedAt: { $gt: since }, statusHistory: { $elemMatch: { to: status, changedAt: { $gt: since, $lte: now } } } })
      .select(fields)
      .limit(RECORD_LIMIT)
      .lean();
    return appointments.flatMap((appointment: any) => (appointment.statusHistory || [])
      .filter((entry: any) => entry.to === status && new Date(entry.changedAt) > since && new Date(entry.changedAt) <= now)
      .map((entry: any) => appointmentEvent(appointment, `${status}:${appointment._id}:${new Date(entry.changedAt).getTime()}`, new Date(entry.changedAt))));
  }
  return [];
}

async function loadLead(orgId: string, event: EngineEvent): Promise<any | null> {
  const orgIds = orgIdVariants(orgId);
  if (event.leadId && mongoose.isValidObjectId(event.leadId)) {
    const lead = await Lead.findOne({ _id: event.leadId, organizationId: { $in: orgIds } }).select(LEAD_FIELDS).lean();
    if (lead) return lead;
  }
  if (event.phone) {
    return Lead.findOne({ organizationId: { $in: orgIds }, normalizedPhone: normalizePhone(event.phone) }).sort({ createdAt: -1 }).select(LEAD_FIELDS).lean();
  }
  return null;
}

async function isNewContact(orgId: string, lead: any): Promise<boolean> {
  if (!lead) return true;
  const identity = [lead.normalizedPhone ? { normalizedPhone: lead.normalizedPhone } : null, lead.normalizedEmail ? { normalizedEmail: lead.normalizedEmail } : null].filter(Boolean) as any[];
  if (!identity.length) return true;
  const older = await Lead.exists({ organizationId: { $in: orgIdVariants(orgId) }, _id: { $ne: lead._id }, createdAt: { $lt: lead.createdAt }, $or: identity });
  return !older;
}

function fieldValue(field: string, ctx: { lead: any; event: EngineEvent; afterHours: boolean; newContact: boolean }): unknown {
  const { lead, event } = ctx;
  switch (field) {
    case 'after_hours': return ctx.afterHours;
    case 'new_contact': return ctx.newContact;
    case 'channel': return lead?.channel;
    case 'lead_source': return lead?.source;
    case 'lead_status': return lead?.status;
    case 'lead_tags': return lead?.tags || [];
    case 'assigned_to': return lead?.assignedTo ? String(lead.assignedTo) : '';
    case 'location': return event.location || lead?.location || '';
    case 'customer_name': return lead ? fullName(lead.firstName, lead.lastName) : event.name;
    case 'customer_email': return lead?.email || event.email;
    case 'customer_phone': return lead?.phone || event.phone;
    case 'vehicle_make': return lead?.vehicle?.make;
    case 'vehicle_model': return lead?.vehicle?.model;
    case 'vehicle_condition': return lead?.vehicle?.condition;
    default: return undefined;
  }
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function filterPasses(filter: { field: string; operator: string; value: string | null }, value: unknown, locationKeys: Map<string, string[]>): boolean {
  const target = String(filter.value || '').trim().toLowerCase();
  if (filter.operator === 'is_true') return value === true;
  if (filter.operator === 'is_false') return value === false;
  if (filter.operator === 'present') return present(value);
  if (filter.operator === 'not_present') return !present(value);
  if (Array.isArray(value)) {
    const has = value.some((item) => String(item).trim().toLowerCase() === target);
    return filter.operator === 'contains' ? has : filter.operator === 'not_contains' ? !has : false;
  }
  const actual = String(value ?? '').trim().toLowerCase();
  if (filter.field === 'location') {
    const keys = locationKeys.get(String(filter.value)) || [];
    const matches = keys.includes(normalizeLocationKey(actual));
    return filter.operator === 'is' ? matches : !matches;
  }
  if (filter.operator === 'is') return actual === target;
  if (filter.operator === 'is_not') return actual !== target;
  if (filter.operator === 'contains') return actual.includes(target);
  if (filter.operator === 'not_contains') return !actual.includes(target);
  return false;
}

function repeatValue(field: string, ctx: { lead: any; event: EngineEvent; afterHours: boolean; newContact: boolean }): string {
  const value = fieldValue(field, ctx);
  if (field === 'customer_phone') return value ? normalizePhone(String(value)) : '';
  if (Array.isArray(value)) return value.map(String).sort().join(',');
  return String(value ?? '').trim().toLowerCase();
}

export async function locationKeyMap(orgId: string): Promise<Map<string, string[]>> {
  const locations = await CrmLocation.find({ organizationId: orgId }).select('aliasKeys').lean();
  return new Map(locations.map((location: any) => [String(location._id), (location.aliasKeys || []).map((key: string) => normalizeLocationKey(key))]));
}

export async function decideRun(automation: any, event: EngineEvent, orgId: string, locationKeys: Map<string, string[]>) {
  const lead = await loadLead(orgId, event);
  const ctx = { lead, event, afterHours: (() => { const hour = denverHour(event.triggerAt); return hour < SEND_START_HOUR || hour >= SEND_END_HOUR; })(), newContact: false };
  const filters = automation.trigger?.filters || [];
  if (filters.some((filter: any) => filter.field === 'new_contact')) ctx.newContact = await isNewContact(orgId, lead);
  const contact = {
    leadId: lead ? String(lead._id) : event.leadId,
    name: lead ? fullName(lead.firstName, lead.lastName) : event.name,
    firstName: lead ? String(lead.firstName || '').trim() : event.name.split(/\s+/)[0] || '',
    phone: String(lead?.phone || event.phone || ''),
    email: String(lead?.email || event.email || ''),
  };
  let reason: string | null = null;
  const rawLocation = String(event.location || lead?.location || '');
  if (automation.locations?.mode === 'specific') {
    const key = normalizeLocationKey(rawLocation);
    const allowed = (automation.locations.ids || []).some((id: string) => (locationKeys.get(String(id)) || []).includes(key));
    if (!key || !allowed) reason = 'Not at one of the selected locations';
  }
  if (!reason && !filters.every((filter: any) => filterPasses(filter, fieldValue(filter.field, ctx), locationKeys))) reason = 'Did not match the audience';
  let repeatKey: string | null = null;
  const repeat = automation.trigger?.repeat;
  if (!reason && repeat?.mode === 'once_per_days') {
    const values = (repeat.per || ['customer_phone']).map((field: string) => repeatValue(field, ctx));
    if (values.some(Boolean)) {
      repeatKey = `${automation._id}:${values.join('|')}`;
      const since = new Date(event.triggerAt.getTime() - (repeat.days || 365) * UNIT_MS.days);
      const already = await CrmAutomationRun.exists({ automationId: automation._id, mode: automation.status === 'test' ? 'test' : 'live', repeatKey, status: { $ne: 'filtered' }, createdAt: { $gte: since } });
      if (already) reason = `Already ran for this contact in the last ${repeat.days || 365} days`;
    }
  }
  return { contact, rawLocation, reason, repeatKey };
}

async function startRun(automation: any, event: EngineEvent, orgId: string, locationKeys: Map<string, string[]>): Promise<boolean> {
  if (await CrmAutomationRun.exists({ automationId: automation._id, eventKey: event.eventKey })) return false;
  const { contact, rawLocation, reason, repeatKey } = await decideRun(automation, event, orgId, locationKeys);
  try {
    await CrmAutomationRun.create({
      organizationId: orgId,
      automationId: automation._id,
      automationName: automation.name,
      mode: automation.status === 'test' ? 'test' : 'live',
      event: automation.trigger.event,
      eventKey: event.eventKey,
      triggerAt: event.triggerAt,
      targetAt: event.targetAt || null,
      appointmentId: event.appointmentId || null,
      contact,
      location: await locationDisplayName(orgId, rawLocation),
      repeatKey: reason ? null : repeatKey,
      settings: {
        sendingHours: automation.trigger.sendingHours || 'sending_hours',
        stopOnReply: automation.trigger.stopOnReply !== false,
        cancelFirstOnReply: automation.trigger.cancelFirstOnReply !== false,
        aiContinuesOnReply: Boolean(automation.trigger.aiContinuesOnReply),
        stopOnFailure: Boolean(automation.trigger.stopOnFailure),
      },
      steps: automation.steps || [],
      status: reason ? 'filtered' : 'waiting',
      reason,
      nextRunAt: reason ? null : event.triggerAt,
    });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    return false;
  }
  return true;
}

export async function sweepTriggers(now = new Date()): Promise<number> {
  const automations = await CrmAutomation.find({ status: { $in: ['active', 'test'] }, 'trigger.event': { $in: Array.from(ENGINE_EVENTS) } }).lean();
  const groups = new Map<string, any[]>();
  for (const automation of automations as any[]) {
    const key = `${automation.organizationId}|${automation.trigger.event}`;
    groups.set(key, [...(groups.get(key) || []), automation]);
  }
  let created = 0;
  const locationCache = new Map<string, Map<string, string[]>>();
  for (const [key, list] of groups) {
    const [orgId, event] = key.split('|');
    const cursorKey = `${orgId}:${event}`;
    const since = await readCursor(cursorKey, now);
    if (!since) continue;
    try {
      const events = await collectEvents(orgId, event, since, now);
      if (!locationCache.has(orgId)) locationCache.set(orgId, await locationKeyMap(orgId));
      for (const item of events) {
        for (const automation of list) {
          if (automation.statusChangedAt && item.triggerAt < new Date(automation.statusChangedAt)) continue;
          if (await startRun(automation, item, orgId, locationCache.get(orgId) as Map<string, string[]>)) created += 1;
        }
      }
      await moveCursor(cursorKey, now);
    } catch (err) {
      logger.error({ err, orgId, event }, '[CrmAutomation] Trigger sweep failed');
    }
  }
  return created;
}

export async function sweepReplies(now = new Date()): Promise<number> {
  const since = await readCursor('replies', now);
  if (!since) return 0;
  const waiting = await CrmAutomationRun.find({ status: { $in: ['waiting', 'running'] }, 'settings.stopOnReply': true, 'contact.leadId': { $ne: null } }).select('organizationId contact.leadId').limit(5000).lean();
  let stopped = 0;
  if (waiting.length) {
    const leadIds = Array.from(new Set(waiting.map((run: any) => String(run.contact.leadId)).filter((id) => mongoose.isValidObjectId(id))));
    const replied = await Lead.find({ _id: { $in: leadIds }, 'followUp.lastCustomerActivityAt': { $gt: since } }).select('followUp.lastCustomerActivityAt').lean();
    for (const lead of replied as any[]) {
      const repliedAt = new Date(lead.followUp.lastCustomerActivityAt);
      const runs = await CrmAutomationRun.find({ 'contact.leadId': String(lead._id), status: { $in: ['waiting', 'running'] }, 'settings.stopOnReply': true, createdAt: { $lt: repliedAt } });
      for (const run of runs) {
        if (run.sentAnyMessage || run.settings.cancelFirstOnReply || run.status === 'running') {
          if (run.status === 'running') {
            await CrmAutomationRun.updateOne({ _id: run._id }, { $set: { stopAfterMessage: true } });
            continue;
          }
          run.status = 'stopped';
          run.reason = run.settings.aiContinuesOnReply ? 'The contact replied. The AI agent continues the conversation.' : 'The contact replied';
          run.nextRunAt = null;
        } else {
          run.stopAfterMessage = true;
        }
        await run.save();
        stopped += 1;
      }
    }
  }
  await moveCursor('replies', now);
  return stopped;
}

function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (match, key) => (key in values ? values[key] : match));
}

function withStopLine(body: string): string {
  return /reply stop/i.test(body) ? body : `${body.trim()} Reply STOP to opt out.`;
}

async function assignLead(orgId: string, leadId: string | null, userId: string | null): Promise<string> {
  if (!leadId || !mongoose.isValidObjectId(leadId)) return 'No lead to assign';
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: { $in: orgIdVariants(orgId) } }).select('assignedTo').lean();
  if (!lead) return 'The lead was not found';
  const previous = lead.assignedTo ? String(lead.assignedTo) : null;
  if (previous === userId) return userId ? 'Already assigned to that team member' : 'Already unassigned';
  if (userId && !(await User.exists({ _id: userId, ...teamQuery(orgId) }))) return 'That team member is no longer active';
  const history = { from: lead.assignedTo || undefined, to: userId ? new mongoose.Types.ObjectId(userId) : undefined, changedAt: new Date() };
  await Lead.updateOne(
    { _id: lead._id },
    userId
      ? { $set: { assignedTo: new mongoose.Types.ObjectId(userId), assignedAt: new Date() }, $push: { assignmentHistory: history } }
      : { $unset: { assignedTo: '', assignedAt: '' }, $push: { assignmentHistory: history } },
  );
  emitToOrg(orgId, 'lead:update', { leadId: String(lead._id) });
  return userId ? 'Assigned the lead' : 'Removed the assigned team member';
}

async function recipientsFor(orgId: string, config: any, leadId: string | null): Promise<string[]> {
  if (config.recipients === 'people') return (config.userIds || []).map(String);
  if (config.recipients === 'assigned' && leadId && mongoose.isValidObjectId(leadId)) {
    const lead: any = await Lead.findById(leadId).select('assignedTo').lean();
    if (lead?.assignedTo) return [String(lead.assignedTo)];
  }
  const admins = await User.find({ ...teamQuery(orgId), role: { $in: ['admin', 'super_admin'] } }).select('_id').lean();
  return admins.map((admin: any) => String(admin._id));
}

function smsOutcome(err: any): ActionResult {
  if (isContactRestrictedError(err) || isSmsDestinationError(err)) return { status: 'skipped', detail: String(err.message || 'This contact cannot get texts') };
  return { status: 'failed', detail: String(err?.message || err).slice(0, 300) };
}

async function sendText(run: ICrmAutomationRun, body: string): Promise<ActionResult> {
  if (!run.contact.phone) return { status: 'skipped', detail: 'No phone number' };
  const text = withStopLine(body);
  if (run.mode === 'test') return { status: 'test', detail: `Would text ${run.contact.phone}: ${text}` };
  try {
    const sent = await sendAutomatedSms({ orgId: run.organizationId, toPhone: run.contact.phone, body: text, leadId: run.contact.leadId || undefined, senderName: `Automation - ${run.automationName}` });
    return sent ? { status: 'sent', detail: text } : { status: 'skipped', detail: 'The customer replied STOP' };
  } catch (err) {
    return smsOutcome(err);
  }
}

async function executeStep(run: ICrmAutomationRun, step: any, values: Record<string, string>, agentName: string): Promise<ActionResult> {
  const config = step.config || {};
  const orgId = run.organizationId;
  const test = run.mode === 'test';
  switch (step.type) {
    case 'send_message':
      return sendText(run, render(String(config.body || ''), values));
    case 'send_review_invitation': {
      const reviewLink = await resolveReviewLink(orgId);
      return sendText(run, buildReviewRequestMessage(values.dealership_name, values.first_name, reviewLink, String(run._id)));
    }
    case 'send_appointment_confirmation': {
      const upcoming = (appointment: any) => appointment && new Date(appointment.startTime) > new Date() && ['scheduled', 'confirmed'].includes(appointment.status);
      let appointment: any = run.appointmentId && mongoose.isValidObjectId(run.appointmentId)
        ? await Appointment.findOne({ _id: run.appointmentId, organizationId: orgId }).select('title startTime status').lean()
        : null;
      if (!upcoming(appointment) && run.contact.leadId && mongoose.isValidObjectId(run.contact.leadId)) {
        appointment = await Appointment.findOne({ organizationId: orgId, leadId: run.contact.leadId, entryType: 'appointment', status: { $in: ['scheduled', 'confirmed'] }, startTime: { $gt: new Date() } }).sort({ startTime: 1 }).select('title startTime status').lean();
      }
      if (!upcoming(appointment)) return { status: 'skipped', detail: 'No upcoming appointment' };
      const sender = senderIntro(values.dealership_name, values.agent_name_configured || null);
      const asked = await sendText(run, `Hi ${values.first_name}, this is ${sender}. Confirming your appointment "${appointment.title}" on ${formatApptTimeForSms(new Date(appointment.startTime))}. Reply YES to confirm or CANCEL to change it.`);
      if (asked.status === 'sent') await Appointment.updateOne({ _id: appointment._id }, { $set: { confirmationRequestedAt: new Date() } });
      return asked;
    }
    case 'send_email': {
      if (!run.contact.email) return { status: 'skipped', detail: 'No email address' };
      const subject = render(String(config.subject || ''), values);
      const body = render(String(config.body || ''), values);
      if (test) return { status: 'test', detail: `Would email ${run.contact.email}: ${subject}` };
      try {
        const sent = await emailService.sendCampaignEmail({ to: run.contact.email, phone: run.contact.phone || undefined, customerName: run.contact.name, subject, greetingText: '', bodyText: body, organizationId: orgId, leadId: run.contact.leadId || undefined });
        return sent ? { status: 'sent', detail: subject } : { status: 'skipped', detail: 'The customer unsubscribed from emails' };
      } catch (err: any) {
        if (isContactRestrictedError(err)) return { status: 'skipped', detail: err.message };
        return { status: 'failed', detail: String(err?.message || err).slice(0, 300) };
      }
    }
    case 'send_notification': {
      const message = render(String(config.message || ''), values);
      const userIds = await recipientsFor(orgId, config, run.contact.leadId);
      if (!userIds.length) return { status: 'skipped', detail: 'Nobody to notify' };
      if (test) return { status: 'test', detail: `Would notify ${userIds.length} team member${userIds.length === 1 ? '' : 's'}: ${message}` };
      await notifyUsers(userIds, orgId, 'lead_message', `Automation: ${run.automationName}`, message, {
        leadId: run.contact.leadId || undefined,
        customerName: run.contact.name,
        route: run.contact.leadId ? `/crm/leads?leadId=${run.contact.leadId}` : '/crm/leads',
      });
      return { status: 'sent', detail: `Notified ${userIds.length} team member${userIds.length === 1 ? '' : 's'}` };
    }
    case 'assign_team_member':
      if (test) return { status: 'test', detail: 'Would assign the lead' };
      return { status: 'done', detail: await assignLead(orgId, run.contact.leadId, String(config.userId || '') || null) };
    case 'unassign_team_member':
      if (test) return { status: 'test', detail: 'Would remove the assigned team member' };
      return { status: 'done', detail: await assignLead(orgId, run.contact.leadId, null) };
    case 'create_task': {
      if (!run.contact.leadId) return { status: 'skipped', detail: 'No lead for the task' };
      const task = render(String(config.task || ''), values);
      const userIds = config.recipients === 'admins' ? [] : await recipientsFor(orgId, config, run.contact.leadId);
      if (test) return { status: 'test', detail: `Would create a task: ${task}` };
      const targets: Array<string | null> = userIds.length ? userIds : [null];
      for (const assignedTo of targets) {
        await createAiAgentTaskAndNotify({ organizationId: orgId, leadId: run.contact.leadId, channel: 'sms', question: task, agentName, customerName: run.contact.name || 'Customer', assignedTo });
      }
      return { status: 'done', detail: `Created ${targets.length} task${targets.length === 1 ? '' : 's'}` };
    }
    default:
      return { status: 'skipped', detail: 'This step is not live yet' };
  }
}

function stepDue(run: ICrmAutomationRun, step: any, now: Date): Date | 'skip' | string {
  const timing = step.config?.timing;
  let due = run.triggerAt;
  if (timing?.when === 'after') due = new Date(run.triggerAt.getTime() + timing.amount * UNIT_MS[timing.unit]);
  if (timing?.when === 'before') {
    if (!run.targetAt) return 'There is no appointment or date time to count back from';
    due = new Date(run.targetAt.getTime() - timing.amount * UNIT_MS[timing.unit]);
    if (due.getTime() < now.getTime() - STALE_BEFORE_MS) return 'Too late: that time before the appointment already passed';
  }
  if (run.notBefore && run.notBefore > due) due = run.notBefore;
  if (MESSAGE_STEPS.has(step.type) && run.settings.sendingHours !== 'any_time') due = nextSendingTime(due);
  return due;
}

async function chooseBranchPath(run: ICrmAutomationRun, step: any): Promise<{ label: string; steps: any[]; repeatKey: string | null }> {
  const event: EngineEvent = { eventKey: run.eventKey, triggerAt: run.triggerAt, leadId: run.contact.leadId, phone: run.contact.phone, email: run.contact.email, name: run.contact.name, location: run.location || '' };
  const lead = await loadLead(run.organizationId, event);
  const hour = denverHour(run.triggerAt);
  const ctx = { lead, event, afterHours: hour < SEND_START_HOUR || hour >= SEND_END_HOUR, newContact: false };
  const paths = step.config?.paths || [];
  if (paths.some((path: any) => (path.filters || []).some((filter: any) => filter.field === 'new_contact'))) ctx.newContact = await isNewContact(run.organizationId, lead);
  const locationKeys = await locationKeyMap(run.organizationId);
  for (const [index, path] of paths.entries()) {
    if (!(path.filters || []).every((filter: any) => filterPasses(filter, fieldValue(filter.field, ctx), locationKeys))) continue;
    let repeatKey: string | null = null;
    if (path.repeat?.mode === 'once_per_days') {
      const values = (path.repeat.per || ['customer_phone']).map((field: string) => repeatValue(field, ctx));
      if (values.some(Boolean)) {
        repeatKey = `${run.automationId}:${path.id}:${values.join('|')}`;
        const since = new Date(run.triggerAt.getTime() - (path.repeat.days || 365) * UNIT_MS.days);
        if (await CrmAutomationRun.exists({ _id: { $ne: run._id }, automationId: run.automationId, mode: run.mode, pathRepeatKeys: repeatKey, createdAt: { $gte: since } })) continue;
      }
    }
    return { label: `Followed If ${index + 1}`, steps: path.steps || [], repeatKey };
  }
  if (step.config?.else?.doNothing) return { label: 'No condition matched. Else: do nothing', steps: [], repeatKey: null };
  return { label: 'No condition matched. Followed Else', steps: step.config?.else?.steps || [], repeatKey: null };
}

async function processRun(run: ICrmAutomationRun, now: Date) {
  const [dealerName, agent] = await Promise.all([resolveDealerName(run.organizationId), resolveAiAgentIdentity(run.organizationId)]);
  const lead: any = run.contact.leadId && mongoose.isValidObjectId(run.contact.leadId) ? await Lead.findById(run.contact.leadId).select('vehicle').lean() : null;
  const vehicle = [lead?.vehicle?.year, lead?.vehicle?.make, lead?.vehicle?.model].filter(Boolean).join(' ');
  const values: Record<string, string> = {
    first_name: run.contact.firstName || 'there',
    dealership_name: dealerName,
    agent_name: agent.displayName,
    agent_name_configured: agent.name || '',
    vehicle: vehicle || 'your vehicle',
    location_name: run.location || dealerName,
  };
  while (run.stepIndex < run.steps.length) {
    const step: any = run.steps[run.stepIndex];
    if (step.type === 'wait') {
      const until = new Date(Math.max(now.getTime(), run.notBefore?.getTime() || 0) + Number(step.config?.amount || 0) * (UNIT_MS[step.config?.unit] || MINUTE));
      run.log.push({ stepId: step.id, type: step.type, status: 'done', detail: `Waiting until ${until.toISOString()}`, at: now });
      run.notBefore = until;
      run.stepIndex += 1;
      if (until > now) {
        run.status = 'waiting';
        run.nextRunAt = until;
        run.leaseUntil = null;
        await run.save();
        return;
      }
      continue;
    }
    const due = stepDue(run, step, now);
    if (typeof due === 'string') {
      run.log.push({ stepId: step.id, type: step.type, status: 'skipped', detail: due, at: now });
      run.stepIndex += 1;
      await run.save();
      continue;
    }
    if (due > now) {
      run.status = 'waiting';
      run.nextRunAt = due;
      run.leaseUntil = null;
      await run.save();
      return;
    }
    const fresh = await CrmAutomationRun.findById(run._id).select('status stopAfterMessage').lean();
    if (fresh?.status === 'stopped') return;
    if (fresh?.stopAfterMessage) run.stopAfterMessage = true;
    if (step.type === 'branch') {
      const choice = await chooseBranchPath(run, step);
      run.steps = [...run.steps.slice(0, run.stepIndex + 1), ...choice.steps];
      run.markModified('steps');
      if (choice.repeatKey) run.pathRepeatKeys = [...(run.pathRepeatKeys || []), choice.repeatKey];
      run.log.push({ stepId: step.id, type: 'branch', status: 'done', detail: choice.label, at: new Date() });
      run.stepIndex += 1;
      await run.save();
      continue;
    }
    let result: ActionResult;
    try {
      result = await executeStep(run, step, values, agent.displayName);
    } catch (err: any) {
      result = { status: 'failed', detail: String(err?.message || err).slice(0, 300) };
    }
    run.log.push({ stepId: step.id, type: step.type, status: result.status, detail: result.detail.slice(0, 2000), at: new Date() });
    const messaged = MESSAGE_STEPS.has(step.type) && (result.status === 'sent' || result.status === 'test');
    if (messaged) run.sentAnyMessage = true;
    if (messaged && step.config?.assignTo && step.config.assignTo !== AI_AGENT_ASSIGNEE) {
      const detail = run.mode === 'test' ? 'Would assign the lead' : await assignLead(run.organizationId, run.contact.leadId, String(step.config.assignTo)).catch((err) => String(err?.message || err));
      run.log.push({ stepId: step.id, type: 'assign_team_member', status: run.mode === 'test' ? 'test' : 'done', detail, at: new Date() });
    }
    if (messaged && step.config?.assignTo === AI_AGENT_ASSIGNEE) {
      run.log.push({ stepId: step.id, type: 'assign_team_member', status: run.mode === 'test' ? 'test' : 'done', detail: `${agent.displayName} handles the replies`, at: new Date() });
    }
    run.stepIndex += 1;
    if (result.status === 'failed' && run.settings.stopOnFailure) {
      run.status = 'failed';
      run.reason = 'A step failed, so the automation stopped';
      run.nextRunAt = null;
      run.leaseUntil = null;
      await run.save();
      return;
    }
    if (messaged && run.stopAfterMessage) {
      run.status = 'stopped';
      run.reason = 'The contact replied';
      run.nextRunAt = null;
      run.leaseUntil = null;
      await run.save();
      return;
    }
    await run.save();
  }
  run.status = run.log.some((entry) => entry.status === 'failed') ? 'failed' : 'completed';
  run.reason = run.status === 'failed' ? 'One or more steps failed' : null;
  run.nextRunAt = null;
  run.leaseUntil = null;
  await run.save();
}

export async function runDueSteps(now = new Date()): Promise<number> {
  let processed = 0;
  for (let index = 0; index < RUN_BATCH; index += 1) {
    const run = await CrmAutomationRun.findOneAndUpdate(
      { $or: [{ status: 'waiting', nextRunAt: { $lte: now } }, { status: 'running', leaseUntil: { $lt: now } }] },
      { $set: { status: 'running', leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { sort: { nextRunAt: 1 }, new: true },
    );
    if (!run) break;
    try {
      const automation: any = await CrmAutomation.findById(run.automationId).select('status').lean();
      const allowed = automation && (run.mode === 'test' ? automation.status === 'test' : automation.status === 'active');
      if (!allowed) {
        run.status = 'stopped';
        run.reason = 'The automation is no longer on';
        run.nextRunAt = null;
        run.leaseUntil = null;
        await run.save();
      } else {
        await processRun(run, now);
      }
    } catch (err) {
      logger.error({ err, runId: String(run._id) }, '[CrmAutomation] Run failed');
      await CrmAutomationRun.updateOne({ _id: run._id }, { $set: { status: 'failed', reason: 'Something went wrong while running this automation', leaseUntil: null, nextRunAt: null } }).catch(() => undefined);
    }
    processed += 1;
  }
  return processed;
}

export async function checkAutomationAlerts(now = new Date()): Promise<number> {
  if (denverHour(now) < SEND_START_HOUR) return 0;
  const today = toCompanyDateStr(now);
  const automations = await CrmAutomation.find({ status: 'active', 'alerts.enabled': true });
  let sent = 0;
  for (const automation of automations) {
    const alerts: any = automation.alerts;
    if (alerts.lastCheckedAt && toCompanyDateStr(new Date(alerts.lastCheckedAt)) === today) continue;
    const period = (alerts.days || 7) * UNIT_MS.days;
    const activeSince = automation.statusChangedAt ? new Date(automation.statusChangedAt).getTime() : 0;
    const count = (from: number, to: number) => CrmAutomationRun.countDocuments({ automationId: automation._id, mode: 'live', status: { $ne: 'filtered' }, createdAt: { $gte: new Date(from), $lt: new Date(to) } });
    let detail: string | null = null;
    if (alerts.condition === 'percentage_drop') {
      if (activeSince <= now.getTime() - 2 * period) {
        const [recent, before] = await Promise.all([count(now.getTime() - period, now.getTime()), count(now.getTime() - 2 * period, now.getTime() - period)]);
        const drop = before > 0 ? Math.round(((before - recent) / before) * 100) : 0;
        if (before > 0 && drop >= alerts.dropPercent) detail = `It ran ${recent} time${recent === 1 ? '' : 's'} in the last ${alerts.days} days, down ${drop}% from ${before} the ${alerts.days} days before.`;
      }
    } else if (activeSince <= now.getTime() - period) {
      const recent = await count(now.getTime() - period, now.getTime());
      if (recent < alerts.minEvents) detail = `It ran ${recent} time${recent === 1 ? '' : 's'} in the last ${alerts.days} days, below the alert level of ${alerts.minEvents}.`;
    }
    if (detail && alerts.userIds?.length) {
      const { title, message } = notificationTemplates.automation_alert({ automationName: automation.name, detail });
      await notifyUsers(alerts.userIds, automation.organizationId, 'automation_alert', title, message, { automationId: String(automation._id), route: '/crm/settings/ai-agent?tab=automation' });
      alerts.lastAlertAt = now;
      sent += 1;
    }
    alerts.lastCheckedAt = now;
    await CrmAutomation.updateOne({ _id: automation._id }, { $set: { 'alerts.lastCheckedAt': alerts.lastCheckedAt, 'alerts.lastAlertAt': alerts.lastAlertAt || null } });
  }
  return sent;
}

export async function runAutomationTick(now = new Date()) {
  if (!isAutomationEngineEnabled()) return { replies: 0, started: 0, processed: 0, alerts: 0 };
  const replies = await sweepReplies(now);
  const started = await sweepTriggers(now);
  const processed = await runDueSteps(now);
  const alerts = await checkAutomationAlerts(now);
  return { replies, started, processed, alerts };
}
