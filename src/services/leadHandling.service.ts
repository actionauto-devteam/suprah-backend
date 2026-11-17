import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import WebChatMessage from '../models/WebChatMessage.model';
import WebChatSession from '../models/WebChatSession.model';
import MailConversation from '../models/MailConversation.model';
import MailMessage from '../models/MailMessage.model';
import LeadHandlingEvent, { LeadHandlingAction, LeadHandlingChannel } from '../models/LeadHandlingEvent.model';
import { CallLog, CommunicationMessage, Conversation } from '../models/communication.model';
import { normalizePhone } from './communication.service';
import { getLeadIntakeMode } from './leadIntakeControl.service';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

export const AI_ACTOR_ID = 'ai-agent';
const AUTOMATED_ACTOR_IDS = ['system', 'system-webchat-ack'];
const HANDLED_BY_CACHE_MS = 30_000;

export type LeadHandlerCountKey = 'texts' | 'chats' | 'emails' | 'callsMade' | 'callsAnswered' | 'notes' | 'statusChanges';
export type LeadHandlerRole = 'first_reply' | 'took_over' | 'follow_up' | 'assigned' | 'was_assigned';

export interface LeadHandlerPerson {
  key: string;
  name: string;
  isAi: boolean;
  firstAt: string | null;
  lastAt: string | null;
  firstContactAt: string | null;
  tookOverAt: string | null;
  assignedAt: string | null;
  roles: LeadHandlerRole[];
  counts: Record<LeadHandlerCountKey, number>;
}

export interface LeadHandlerAssignment {
  toName: string | null;
  fromName: string | null;
  byName: string | null;
  at: string;
}

export interface LeadHandlersResult {
  people: LeadHandlerPerson[];
  assignedTo: { name: string; at: string | null } | null;
  assignments: LeadHandlerAssignment[];
}

export interface LeadHandlingTimelineEntry {
  id: string;
  channel: 'appointment' | 'email';
  title: string;
  body?: string;
  actor: string;
  occurredAt: Date;
}

interface Identity {
  name: string;
  email: string;
}

interface Touch {
  actorId: string;
  actorName: string;
  actorEmail: string;
  kind: LeadHandlerCountKey | 'took_over' | 'assigned_to';
  at: Date;
}

const COMMUNICATION_KINDS = new Set<Touch['kind']>(['texts', 'chats', 'emails', 'callsMade', 'callsAnswered']);
const ROLE_ORDER: LeadHandlerRole[] = ['first_reply', 'took_over', 'follow_up', 'assigned', 'was_assigned'];
const CHANNEL_LABELS: Record<LeadHandlingChannel, string> = { sms: 'Text messages', webchat: 'Web chat', email: 'Email' };

const handledByCache = new Map<string, { at: number; ids: mongoose.Types.ObjectId[] }>();

const emailKey = (value: unknown): string => String(value || '').trim().toLowerCase();
const actorIdOf = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());
const isAutomatedId = (id: string): boolean => id === AI_ACTOR_ID || AUTOMATED_ACTOR_IDS.includes(id);

function orgVariants(orgId: string): any {
  return mongoose.isValidObjectId(orgId) ? { $in: [orgId, new mongoose.Types.ObjectId(orgId)] } : orgId;
}

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clearHandledByCache(orgId?: string): void {
  if (!orgId) {
    handledByCache.clear();
    return;
  }
  for (const key of Array.from(handledByCache.keys())) {
    if (key.startsWith(`${orgId}:`)) handledByCache.delete(key);
  }
}

export async function recordLeadHandling(input: {
  organizationId: unknown;
  leadId: unknown;
  action: LeadHandlingAction;
  channel: LeadHandlingChannel;
  actor: { userId?: unknown; name?: unknown } | null | undefined;
  at?: Date;
}): Promise<void> {
  try {
    const organizationId = String(input.organizationId || '');
    const leadId = String(input.leadId || '');
    const userId = actorIdOf(input.actor?.userId);
    if (!organizationId || !mongoose.isValidObjectId(leadId) || !userId || isAutomatedId(userId)) return;
    const name = typeof input.actor?.name === 'string' ? input.actor.name.trim().slice(0, 120) : '';
    await LeadHandlingEvent.create({
      organizationId,
      leadId: new mongoose.Types.ObjectId(leadId),
      action: input.action,
      channel: input.channel,
      actor: { userId, ...(name ? { name } : {}) },
      at: input.at || new Date(),
    });
    clearHandledByCache(organizationId);
  } catch (err) {
    logger.warn({ err, leadId: String(input.leadId || '') }, '[LeadHandling] Could not record a handling event');
  }
}

async function loadIdentities(ids: Iterable<string>): Promise<Map<string, Identity>> {
  const valid = Array.from(new Set(Array.from(ids).filter((id) => mongoose.isValidObjectId(id))));
  const result = new Map<string, Identity>();
  if (!valid.length) return result;
  const [users, crmUsers] = await Promise.all([
    User.find({ _id: { $in: valid } }).select('name email').lean(),
    CrmUser.find({ _id: { $in: valid } }).select('fullName email').lean(),
  ]);
  for (const user of users as any[]) {
    result.set(String(user._id), { name: String(user.name || user.email || '').trim(), email: emailKey(user.email) });
  }
  for (const crmUser of crmUsers as any[]) {
    result.set(String(crmUser._id), { name: String(crmUser.fullName || crmUser.email || '').trim(), email: emailKey(crmUser.email) });
  }
  return result;
}

function personKey(actorId: string, actorName: string, actorEmail: string, identities: Map<string, Identity>): string {
  if (actorId === AI_ACTOR_ID) return 'ai';
  const identity = identities.get(actorId);
  const email = identity?.email || emailKey(actorEmail);
  if (email) return `email:${email}`;
  if (actorId && mongoose.isValidObjectId(actorId)) return `id:${actorId}`;
  return `name:${emailKey(actorName) || 'team member'}`;
}

function displayName(actorId: string, actorName: string, identities: Map<string, Identity>): string {
  if (actorId === AI_ACTOR_ID) return actorName || 'AI agent';
  return identities.get(actorId)?.name || actorName || 'Team member';
}

function emptyCounts(): Record<LeadHandlerCountKey, number> {
  return { texts: 0, chats: 0, emails: 0, callsMade: 0, callsAnswered: 0, notes: 0, statusChanges: 0 };
}

export async function getLeadHandlers(orgId: string, leadId: string): Promise<LeadHandlersResult> {
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgId })
    .select('phone email normalizedEmail notes statusHistory assignmentHistory assignedTo assignedAt aiPausedAt aiPausedBy')
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const orgIds = orgVariants(orgId);
  const phone = lead.phone ? normalizePhone(String(lead.phone)) : null;
  const leadEmail = emailKey(lead.email || lead.normalizedEmail);

  const conversations: any[] = await Conversation.find({
    orgId: orgIds,
    $or: [{ leadId: lead._id }, ...(phone ? [{ customerPhone: phone }] : [])],
  }).select('_id leadId aiPausedAt aiPausedBy').lean();
  const conversationIds = conversations.map((item) => item._id);
  const ownedOnly = (await getLeadIntakeMode(orgId).catch(() => 'off')) !== 'off';
  const ownedBy = (entry: any) => !ownedOnly || String(entry?.leadId || '') === String(lead._id);

  const mailConversations: any[] = leadEmail
    ? await MailConversation.find({ organizationId: orgId, 'participants.email': leadEmail }).select('_id').lean()
    : [];

  const [messages, calls, chats, mails, events, sessions] = await Promise.all([
    CommunicationMessage.find({
      orgId: orgIds,
      direction: 'outbound',
      $or: [{ leadId: lead._id }, ...(conversationIds.length ? [{ conversationId: { $in: conversationIds } }] : [])],
    }).select('leadId sentBy createdAt').lean(),
    CallLog.find({
      orgId: orgIds,
      $or: [{ leadId: lead._id }, ...(phone ? [{ from: phone }, { to: phone }] : [])],
    }).select('leadId direction status placedBy answeredBy answeredAt createdAt').lean(),
    WebChatMessage.find({
      organizationId: orgId,
      leadId: lead._id,
      direction: 'outbound',
      aiDispatchPending: { $ne: true },
    }).select('sentBy createdAt').lean(),
    mailConversations.length
      ? MailMessage.find({
          organizationId: orgId,
          conversationId: { $in: mailConversations.map((item) => item._id) },
          direction: 'outbound',
        }).select('ownerCrmUserId fromName sentAt createdAt').lean()
      : Promise.resolve([] as any[]),
    LeadHandlingEvent.find({ organizationId: orgId, leadId: lead._id }).sort({ at: 1 }).lean(),
    WebChatSession.find({ organizationId: orgId, leadId: lead._id }).select('aiPausedAt aiPausedBy').lean(),
  ]);

  const touches: Touch[] = [];
  const addTouch = (kind: Touch['kind'], ref: any, when: unknown) => {
    const at = validDate(when);
    const actorId = actorIdOf(ref?.userId);
    const actorName = typeof ref?.name === 'string' ? ref.name.trim() : '';
    if (!at || (!actorId && !actorName)) return;
    if (AUTOMATED_ACTOR_IDS.includes(actorId)) return;
    touches.push({ actorId, actorName, actorEmail: emailKey(ref?.email), kind, at });
  };

  for (const message of (messages as any[]).filter(ownedBy)) addTouch('texts', message.sentBy, message.createdAt);
  for (const call of (calls as any[]).filter(ownedBy)) {
    if (call.direction === 'outbound') addTouch('callsMade', call.placedBy, call.createdAt);
    else if (call.answeredBy) addTouch('callsAnswered', call.answeredBy, call.answeredAt || call.createdAt);
  }
  for (const chat of chats as any[]) addTouch('chats', chat.sentBy, chat.createdAt);
  for (const mail of mails as any[]) {
    addTouch('emails', { userId: mail.ownerCrmUserId, name: mail.fromName }, mail.sentAt || mail.createdAt);
  }
  for (const event of events as any[]) {
    if (event.action === 'took_over') addTouch('took_over', event.actor, event.at);
    if (event.action === 'email_sent') addTouch('emails', event.actor, event.at);
  }
  const pauseHolders = [lead, ...conversations, ...(sessions as any[])];
  for (const holder of pauseHolders) {
    const pausedBy = holder?.aiPausedBy;
    const pausedId = actorIdOf(pausedBy?.userId);
    if (!holder?.aiPausedAt || !pausedId || isAutomatedId(pausedId) || pausedId === 'staff') continue;
    addTouch('took_over', pausedBy, holder.aiPausedAt);
  }
  for (const note of lead.notes || []) {
    if (note?.authorType === 'ai') continue;
    addTouch('notes', { userId: note.createdBy, name: note.authorName }, note.createdAt);
  }
  for (const entry of lead.statusHistory || []) {
    if (!entry?.changedBy) continue;
    addTouch('statusChanges', { userId: entry.changedBy }, entry.changedAt);
  }
  for (const entry of lead.assignmentHistory || []) {
    if (!entry?.to) continue;
    addTouch('assigned_to', { userId: entry.to }, entry.changedAt);
  }

  const assignmentIds = (lead.assignmentHistory || []).flatMap((entry: any) => [entry?.to, entry?.from, entry?.changedBy]);
  const identities = await loadIdentities([
    ...touches.map((touch) => touch.actorId),
    ...assignmentIds.filter(Boolean).map(String),
    ...(lead.assignedTo ? [String(lead.assignedTo)] : []),
  ]);

  const people = new Map<string, LeadHandlerPerson & { firstMs: number; lastMs: number; contactMs: number; tookOverMs: number; assignedEver: boolean }>();
  for (const touch of touches) {
    const key = personKey(touch.actorId, touch.actorName, touch.actorEmail, identities);
    let person = people.get(key);
    if (!person) {
      person = {
        key,
        name: displayName(touch.actorId, touch.actorName, identities),
        isAi: key === 'ai',
        firstAt: null,
        lastAt: null,
        firstContactAt: null,
        tookOverAt: null,
        assignedAt: null,
        roles: [],
        counts: emptyCounts(),
        firstMs: Infinity,
        lastMs: -Infinity,
        contactMs: Infinity,
        tookOverMs: Infinity,
        assignedEver: false,
      };
      people.set(key, person);
    } else if (person.name === 'Team member' && touch.actorName) {
      person.name = displayName(touch.actorId, touch.actorName, identities);
    }
    const ms = touch.at.getTime();
    person.firstMs = Math.min(person.firstMs, ms);
    person.lastMs = Math.max(person.lastMs, ms);
    if (touch.kind === 'took_over') person.tookOverMs = Math.min(person.tookOverMs, ms);
    else if (touch.kind === 'assigned_to') person.assignedEver = true;
    else {
      person.counts[touch.kind] += 1;
      if (COMMUNICATION_KINDS.has(touch.kind)) person.contactMs = Math.min(person.contactMs, ms);
    }
  }

  const assigneeId = lead.assignedTo ? String(lead.assignedTo) : '';
  const assigneeKey = assigneeId ? personKey(assigneeId, '', '', identities) : '';
  const assigneeName = assigneeId ? identities.get(assigneeId)?.name || 'Former team member' : '';
  const assignedAt = validDate(lead.assignedAt);
  if (assigneeKey && !people.has(assigneeKey)) {
    const ms = assignedAt?.getTime() ?? Date.now();
    people.set(assigneeKey, {
      key: assigneeKey,
      name: assigneeName,
      isAi: false,
      firstAt: null,
      lastAt: null,
      firstContactAt: null,
      tookOverAt: null,
      assignedAt: null,
      roles: [],
      counts: emptyCounts(),
      firstMs: ms,
      lastMs: ms,
      contactMs: Infinity,
      tookOverMs: Infinity,
      assignedEver: true,
    });
  }

  const staff = Array.from(people.values()).filter((person) => !person.isAi && Number.isFinite(person.contactMs));
  const firstReplyKey = staff.sort((a, b) => a.contactMs - b.contactMs)[0]?.key || '';

  const result: LeadHandlerPerson[] = Array.from(people.values())
    .map((person) => {
      const roles = new Set<LeadHandlerRole>();
      if (person.key === firstReplyKey) roles.add('first_reply');
      if (Number.isFinite(person.tookOverMs)) roles.add('took_over');
      if (!person.isAi && Number.isFinite(person.contactMs) && person.key !== firstReplyKey) roles.add('follow_up');
      if (person.key === assigneeKey) roles.add('assigned');
      else if (person.assignedEver) roles.add('was_assigned');
      return {
        key: person.key,
        name: person.name,
        isAi: person.isAi,
        firstAt: Number.isFinite(person.firstMs) ? new Date(person.firstMs).toISOString() : null,
        lastAt: Number.isFinite(person.lastMs) ? new Date(person.lastMs).toISOString() : null,
        firstContactAt: Number.isFinite(person.contactMs) ? new Date(person.contactMs).toISOString() : null,
        tookOverAt: Number.isFinite(person.tookOverMs) ? new Date(person.tookOverMs).toISOString() : null,
        assignedAt: person.key === assigneeKey && assignedAt ? assignedAt.toISOString() : null,
        roles: ROLE_ORDER.filter((role) => roles.has(role)),
        counts: person.counts,
      };
    })
    .sort((a, b) => new Date(a.firstAt || 0).getTime() - new Date(b.firstAt || 0).getTime() || a.name.localeCompare(b.name));

  const nameOf = (id: unknown): string | null => {
    if (!id) return null;
    return identities.get(String(id))?.name || 'Former team member';
  };
  const assignments: LeadHandlerAssignment[] = (lead.assignmentHistory || [])
    .filter((entry: any) => validDate(entry?.changedAt))
    .map((entry: any) => ({
      toName: nameOf(entry.to),
      fromName: nameOf(entry.from),
      byName: nameOf(entry.changedBy),
      at: (validDate(entry.changedAt) as Date).toISOString(),
    }))
    .sort((a: LeadHandlerAssignment, b: LeadHandlerAssignment) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    people: result,
    assignedTo: assigneeId ? { name: assigneeName, at: assignedAt ? assignedAt.toISOString() : null } : null,
    assignments,
  };
}

export async function leadHandlingTimeline(
  orgId: string,
  lead: { _id: unknown; statusHistory?: any[]; assignmentHistory?: any[] },
): Promise<{ statusActorOf: (entry: any) => string; entries: LeadHandlingTimelineEntry[] }> {
  const events: any[] = await LeadHandlingEvent.find({
    organizationId: orgId,
    leadId: lead._id,
    action: { $in: ['took_over', 'resumed', 'email_sent'] },
  }).sort({ at: 1 }).lean().catch(() => []);
  const ids = [
    ...(lead.statusHistory || []).map((entry) => entry?.changedBy),
    ...(lead.assignmentHistory || []).flatMap((entry) => [entry?.to, entry?.from, entry?.changedBy]),
    ...events.map((event) => event.actor?.userId),
  ].filter(Boolean).map(String);
  const identities = await loadIdentities(ids).catch(() => new Map<string, Identity>());
  const nameOf = (id: unknown, fallback = 'Team member') => (id ? identities.get(String(id))?.name || fallback : fallback);

  const entries: LeadHandlingTimelineEntry[] = [];
  for (const entry of lead.assignmentHistory || []) {
    const at = validDate(entry?.changedAt);
    if (!at) continue;
    entries.push({
      id: `assignment:${entry._id || at.getTime()}`,
      channel: 'appointment',
      title: entry.to ? `Assigned to ${nameOf(entry.to, 'Former team member')}` : 'Unassigned',
      body: entry.from ? `Before: ${nameOf(entry.from, 'Former team member')}` : undefined,
      actor: nameOf(entry.changedBy),
      occurredAt: at,
    });
  }
  for (const event of events) {
    const at = validDate(event.at);
    if (!at) continue;
    const actor = identities.get(String(event.actor?.userId))?.name || event.actor?.name || 'Team member';
    if (event.action === 'email_sent') {
      entries.push({ id: `handling-email:${event._id}`, channel: 'email', title: 'Email reply sent', actor, occurredAt: at });
      continue;
    }
    const channel = CHANNEL_LABELS[event.channel as LeadHandlingChannel] || 'Conversation';
    entries.push({
      id: `handling:${event._id}`,
      channel: 'appointment',
      title: event.action === 'took_over' ? 'Took over from the AI' : 'Turned the AI back on',
      body: channel,
      actor,
      occurredAt: at,
    });
  }

  return {
    statusActorOf: (entry: any) => (entry?.changedBy ? nameOf(entry.changedBy) : entry?.automationId ? 'Automation' : 'Team member'),
    entries,
  };
}

export async function leadIdsHandledBy(orgId: string, userId: string): Promise<mongoose.Types.ObjectId[]> {
  if (!mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(userId)) return [];
  const cacheKey = `${orgId}:${userId}`;
  const cached = handledByCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HANDLED_BY_CACHE_MS) return cached.ids;

  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const identity = (await loadIdentities([userId])).get(userId);
  const email = identity?.email || '';
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactEmail = email ? new RegExp(`^${escapedEmail}$`, 'i') : null;
  const [sameUsers, sameCrmUsers] = exactEmail
    ? await Promise.all([
        User.find({ email: exactEmail, organizationId: { $in: [orgObjectId, orgId] } }).select('_id').lean(),
        CrmUser.find({ email: exactEmail, organizationId: orgObjectId }).select('_id').lean(),
      ])
    : [[], []];
  const crmIds = (sameCrmUsers as any[]).map((row) => String(row._id));
  const idStrings = Array.from(new Set([userId, ...(sameUsers as any[]).map((row) => String(row._id)), ...crmIds]));
  const idObjects = idStrings.map((id) => new mongoose.Types.ObjectId(id));
  const anyId = { $in: [...idStrings, ...idObjects] };
  const orgIds = orgVariants(orgId);
  const textFilter = { orgId: orgIds, direction: 'outbound', 'sentBy.userId': anyId };

  const [
    textLeadIds,
    textConversationIds,
    callLeadIds,
    chatLeadIds,
    eventLeadIds,
    leadDocIds,
    pausedConversationLeadIds,
    pausedSessionLeadIds,
    mailConversationIds,
  ] = await Promise.all([
    CommunicationMessage.distinct('leadId', textFilter),
    CommunicationMessage.distinct('conversationId', { ...textFilter, leadId: null }),
    CallLog.distinct('leadId', { orgId: orgIds, $or: [{ 'placedBy.userId': anyId }, { 'answeredBy.userId': anyId }] }),
    WebChatMessage.distinct('leadId', { organizationId: orgId, direction: 'outbound', 'sentBy.userId': { $in: idStrings } }),
    LeadHandlingEvent.distinct('leadId', { organizationId: orgId, action: { $in: ['took_over', 'email_sent'] }, 'actor.userId': { $in: idStrings } }),
    Lead.distinct('_id', {
      organizationId: orgObjectId,
      $or: [
        { 'notes.createdBy': { $in: idObjects } },
        { 'statusHistory.changedBy': { $in: idObjects } },
        { 'assignmentHistory.to': { $in: idObjects } },
        { assignedTo: { $in: idObjects } },
        { 'aiPausedBy.userId': anyId },
      ],
    }),
    Conversation.distinct('leadId', { orgId: orgIds, 'aiPausedBy.userId': anyId }),
    WebChatSession.distinct('leadId', { organizationId: orgId, 'aiPausedBy.userId': { $in: idStrings } }),
    crmIds.length
      ? MailMessage.distinct('conversationId', {
          organizationId: orgObjectId,
          direction: 'outbound',
          ownerCrmUserId: { $in: crmIds.map((id) => new mongoose.Types.ObjectId(id)) },
        })
      : Promise.resolve([] as any[]),
  ]);

  const [conversationLeadIds, mailLeadIds] = await Promise.all([
    textConversationIds.length ? Conversation.distinct('leadId', { _id: { $in: textConversationIds } }) : Promise.resolve([] as any[]),
    (async () => {
      if (!(mailConversationIds as any[]).length) return [] as any[];
      const emails = (await MailConversation.distinct('participants.email', { _id: { $in: mailConversationIds } }))
        .map(emailKey)
        .filter(Boolean);
      if (!emails.length) return [] as any[];
      return Lead.distinct('_id', { organizationId: orgObjectId, $or: [{ email: { $in: emails } }, { normalizedEmail: { $in: emails } }] });
    })(),
  ]);

  const unique = new Map<string, mongoose.Types.ObjectId>();
  for (const value of [
    ...textLeadIds,
    ...conversationLeadIds,
    ...callLeadIds,
    ...chatLeadIds,
    ...eventLeadIds,
    ...leadDocIds,
    ...pausedConversationLeadIds,
    ...pausedSessionLeadIds,
    ...mailLeadIds,
  ] as any[]) {
    const id = value ? String(value) : '';
    if (id && mongoose.isValidObjectId(id) && !unique.has(id)) unique.set(id, new mongoose.Types.ObjectId(id));
  }
  const ids = Array.from(unique.values());
  handledByCache.set(cacheKey, { at: Date.now(), ids });
  return ids;
}
