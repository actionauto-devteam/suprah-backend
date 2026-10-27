import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import { ApiError } from '../utils/ApiError';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import { TERMINAL_LEAD_STATUSES } from '../constants/leadStatus';
import { normalizeLeadSourceForDisplay } from '../constants/leadSource';
import { resolveContactRestriction } from './contactRestriction.service';
import { isSmsOptedOut } from './communication.service';
import { buildLeadTimeline, sendManualLeadSms, type actor } from '../controllers/communication.controller';
import { sendLeadEmailReply } from '../controllers/lead.controller';
import { addLeadNoteAndNotify } from '../utils/leadNote';
import { AI_AGENT_AUTO_PAUSE_MS, recordHumanTakeover } from '../utils/aiAutoPause';
import { extensionMessagingServerEnabled } from '../utils/extensionMessagingSwitch';
import { COMPOSER_MESSAGES, getLeadReplyOptions, normalizeClientRequestId, type ReplyChannelOption } from './leadComposer.service';
import { channelStateFor } from './leadConversation.service';
import { resolveAiChannelModes, type AiChannel } from './aiOperatingMode.service';
import { resolveAiAgentSettings } from './aiAgent.service';

const MAX_PHONE_INPUT = 40;
const MAX_EMAIL_INPUT = 254;
const LOOKUP_EMAIL_SHAPE = /^[a-z0-9._%+'-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const MAX_MATCHES = 10;
const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 1000;
const MAX_NEW_NOTE_LENGTH = 5000;
const HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_TEXT = 600;
const MAX_HISTORY_CURSOR = 300;
const DUPLICATE_NOTE_WINDOW_MS = 15000;
const MAX_TEXT_LENGTH = 1600;
const MAX_EMAIL_LENGTH = 5000;
const MESSAGING_OFF_SERVER = "Sending texts and emails from the extension isn't turned on for this server yet.";
const MESSAGING_OFF_DEALERSHIP = 'Sending texts and emails from the extension is turned off for this dealership. An admin can turn it on in Suprah CRM settings.';
const EMAIL_CHANGED = "This lead's email address changed. Reload the lead and check the address before sending.";
const BLOCKED_STATUS: Record<string, number> = {
  NO_PHONE: 400,
  SMS_INVALID_DESTINATION: 400,
  NO_CUSTOMER_EMAIL: 400,
  SMS_OPTED_OUT: 403,
  CONTACT_RESTRICTED: 403,
  CONTACT_RESTRICTION_UNAVAILABLE: 503,
};
const MATCH_FIELDS = 'firstName lastName status source sourceProvider channel vehicle assignedTo location createdAt updatedAt followUp.lastCustomerActivityAt notes._id customerId customerLink.status';

const AI_CHANNEL_LABELS: Record<AiChannel, string> = {
  sms: 'Text messages',
  email: 'Email replies',
  webchat: 'Website chat',
};

const orgObjectId = (orgId: string) => new mongoose.Types.ObjectId(orgId);

const latest = (...values: Array<Date | string | null | undefined>) => {
  const times = values.map((value) => (value ? new Date(value).getTime() : 0)).filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? new Date(Math.max(...times)) : null;
};

export function displayPhone(normalized: string) {
  const [number, ext] = normalized.split(';ext=');
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  const base = us ? `(${us[1]}) ${us[2]}-${us[3]}` : number;
  return ext ? `${base} ext. ${ext}` : base;
}

export function normalizeLookupPhone(raw: unknown) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_PHONE_INPUT) return null;
  const cleaned = text.replace(/^tel:/i, '');
  if (!/^[0-9+().\-\s]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return normalizeIdentityPhone(cleaned);
}

export function normalizeLookupEmail(raw: unknown) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_EMAIL_INPUT + 7) return null;
  let cleaned = text.replace(/^mailto:/i, '').split('?')[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    return null;
  }
  if (cleaned.length > MAX_EMAIL_INPUT) return null;
  const normalized = normalizeIdentityEmail(cleaned);
  return normalized && LOOKUP_EMAIL_SHAPE.test(normalized) && !/^\.|\.@|\.\./.test(normalized) ? normalized : null;
}

const assertOrg = (orgId: string) => {
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(403, 'Your account is not linked to a dealership');
};

function toMatch(lead: any) {
  const source = normalizeLeadSourceForDisplay({ source: lead.source, sourceProvider: lead.sourceProvider, channel: lead.channel });
  return {
    id: String(lead._id),
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unnamed lead',
    status: lead.status || 'New',
    closed: TERMINAL_LEAD_STATUSES.includes(String(lead.status || '')),
    source: source.sourceProvider ? `${source.source} · ${source.sourceProvider}` : source.source,
    vehicle: [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' '),
    assignedTo: lead.assignedTo && typeof lead.assignedTo === 'object' ? String(lead.assignedTo.name || '') : '',
    location: String(lead.location || ''),
    createdAt: lead.createdAt,
    lastActivity: latest(lead.followUp?.lastCustomerActivityAt, lead.createdAt),
    noteCount: Array.isArray(lead.notes) ? lead.notes.length : 0,
    customerRecordId: lead.customerId && lead.customerLink?.status === 'linked' ? String(lead.customerId) : null,
  };
}

async function findMatches(orgId: string, filter: Record<string, unknown>) {
  const [total, leads, organization] = await Promise.all([
    Lead.countDocuments(filter).maxTimeMS(5000),
    Lead.find(filter)
      .select(MATCH_FIELDS)
      .populate('assignedTo', 'name')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(MAX_MATCHES)
      .maxTimeMS(5000)
      .lean(),
    Organization.findById(orgId).select('name').lean(),
  ]);
  return {
    organization: { name: String((organization as any)?.name || '') },
    total,
    truncated: total > MAX_MATCHES,
    matches: (leads as any[]).map(toMatch),
  };
}

export async function lookupLeadsByPhone(orgId: string, rawPhone: unknown) {
  assertOrg(orgId);
  const normalizedPhone = normalizeLookupPhone(rawPhone);
  if (!normalizedPhone) throw new ApiError(400, "That doesn't look like a complete phone number");

  const [found, restriction, optedOut] = await Promise.all([
    findMatches(orgId, { organizationId: orgObjectId(orgId), normalizedPhone }),
    resolveContactRestriction({ organizationId: orgId, phone: normalizedPhone }),
    isSmsOptedOut(orgId, normalizedPhone).catch(() => null),
  ]);

  const display = displayPhone(normalizedPhone);
  return {
    query: { kind: 'phone' as const, normalizedPhone, displayPhone: display, display },
    ...found,
    contact: {
      doNotContact: restriction.status === 'restricted',
      restrictionUnknown: restriction.status === 'unavailable',
      textOptOut: optedOut === true,
    },
  };
}

export async function lookupLeadsByEmail(orgId: string, rawEmail: unknown) {
  assertOrg(orgId);
  const normalizedEmail = normalizeLookupEmail(rawEmail);
  if (!normalizedEmail) throw new ApiError(400, "That doesn't look like a complete email address");

  const [found, restriction] = await Promise.all([
    findMatches(orgId, { organizationId: orgObjectId(orgId), normalizedEmail }),
    resolveContactRestriction({ organizationId: orgId, email: normalizedEmail }),
  ]);

  return {
    query: { kind: 'email' as const, normalizedEmail, display: normalizedEmail },
    ...found,
    contact: {
      doNotContact: restriction.status === 'restricted',
      restrictionUnknown: restriction.status === 'unavailable',
      textOptOut: false,
    },
  };
}

export function cleanHistoryText(value: unknown) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^\s*</.test(text)) {
    text = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&');
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return text.length > MAX_HISTORY_TEXT ? `${text.slice(0, MAX_HISTORY_TEXT - 1)}…` : text;
}

export async function getLeadHistory(orgId: string, leadId: string, rawBefore?: unknown) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  let before: string | undefined;
  if (rawBefore !== undefined && rawBefore !== null && rawBefore !== '') {
    before = String(rawBefore);
    if (before.length > MAX_HISTORY_CURSOR || !/^[A-Za-z0-9_-]+$/.test(before)) {
      throw new ApiError(400, 'That page of history is not valid. Reload the history and try again.');
    }
  }
  const result = await buildLeadTimeline(orgId, leadId, { limit: HISTORY_PAGE_SIZE, before });
  return {
    leadId,
    items: result.items.map((item) => ({
      id: String(item.id),
      channel: item.channel,
      direction: item.direction || null,
      title: String(item.title || ''),
      body: cleanHistoryText(item.body),
      status: item.status ? String(item.status) : null,
      actor: item.actor ? String(item.actor) : '',
      occurredAt: item.occurredAt,
    })),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    partial: result.unavailableSources.length > 0,
  };
}

function toNote(note: any) {
  return {
    id: note?._id ? String(note._id) : '',
    text: String(note?.text || '').slice(0, MAX_NOTE_LENGTH),
    author: String(note?.authorName || (note?.authorType === 'ai' ? 'AI agent' : 'Team member')),
    byAi: note?.authorType === 'ai',
    createdAt: note?.createdAt || null,
  };
}

export async function addExtensionLeadNote(orgId: string, author: { id: string; name: string }, leadId: string, rawNote: unknown) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  if (typeof rawNote !== 'string' || !rawNote.trim()) throw new ApiError(400, 'Write a note before saving.');
  const text = rawNote.trim();
  if (text.length > MAX_NEW_NOTE_LENGTH) throw new ApiError(400, 'Note cannot exceed 5000 characters');

  const existing: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) }).select('notes').maxTimeMS(5000).lean();
  if (!existing) throw new ApiError(404, 'Lead not found');
  const recent = (Array.isArray(existing.notes) ? existing.notes : [])
    .filter((note: any) => note
      && String(note.createdBy || '') === author.id
      && note.text === text
      && Date.now() - new Date(note.createdAt || 0).getTime() < DUPLICATE_NOTE_WINDOW_MS)
    .pop();
  if (recent) return { duplicate: true, note: toNote(recent) };

  try {
    const result: any = await addLeadNoteAndNotify({
      organizationId: orgId,
      leadId,
      text,
      authorType: 'user',
      createdBy: author.id,
      authorName: author.name || 'Team member',
      mentionedUserIds: [],
      mentionedGroupIds: [],
    });
    return { duplicate: false, note: toNote(result.note) };
  } catch (error: any) {
    if (error?.message === 'Lead not found') throw new ApiError(404, 'Lead not found');
    if (error?.message === 'Note cannot exceed 5000 characters') throw new ApiError(400, error.message);
    throw error;
  }
}

function aiLeadChannel(lead: any): AiChannel | null {
  const channel = String(lead.channel || '').toLowerCase();
  if (channel === 'webchat') return 'webchat';
  if (channel === 'sms' || channel === 'phone') return 'sms';
  if (String(lead.phone || '').replace(/\D/g, '').length >= 7) return 'sms';
  return lead.email ? 'email' : null;
}

export async function getLeadAiStatus(orgId: string, leadId: string) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) })
    .select('channel phone email aiPausedAt aiPausedBy aiAutoPausedUntil')
    .maxTimeMS(5000)
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const channel = aiLeadChannel(lead);
  const [modes, settings, messaging] = await Promise.all([resolveAiChannelModes(orgId), resolveAiAgentSettings(orgId), getExtensionMessagingStatus(orgId)]);
  const agentName = settings.agentName || 'AI Agent';
  if (!channel) {
    return {
      leadId,
      agentName,
      channel: null,
      channelLabel: '',
      mode: null,
      state: 'none' as const,
      label: `${agentName} has no text, email or chat conversation for this lead`,
      pausedBy: null,
      autoPausedUntil: null,
      canControl: false,
      autoPauseMinutes: Math.round(AI_AGENT_AUTO_PAUSE_MS / 60000),
    };
  }

  const mode = modes[channel];
  const channelState: any = await channelStateFor(orgId, lead);
  const pause = channel === 'sms' ? channelState.sms : channel === 'webchat' ? channelState.webchat : channelState.email;
  const hasConversation = channel === 'email' || (channel === 'sms' ? Boolean(channelState.sms.ownsConversation) : Boolean(channelState.webchat));
  const paused = Boolean(pause?.aiPausedAt);
  const pausedBy = paused && pause?.aiPausedBy?.name ? String(pause.aiPausedBy.name) : null;
  const autoPausedUntil = !paused && pause?.aiAutoPausedUntil && new Date(pause.aiAutoPausedUntil) > new Date()
    ? new Date(pause.aiAutoPausedUntil)
    : null;

  let state: 'off' | 'training' | 'paused' | 'auto_paused' | 'live';
  let label: string;
  if (mode === 'training' || mode === 'testing') {
    state = 'training';
    label = `${agentName}: Training — not sending`;
  } else if (mode !== 'live') {
    state = 'off';
    label = `${agentName}: Off — not sending`;
  } else if (paused) {
    state = 'paused';
    label = pausedBy ? `Paused by ${pausedBy}` : `${agentName} paused`;
  } else if (autoPausedUntil) {
    state = 'auto_paused';
    label = 'Auto-paused';
  } else {
    state = 'live';
    label = `${agentName} live`;
  }

  const canControl = mode === 'live' && hasConversation && messaging.enabled;
  const autoPauseMinutes = Math.round(AI_AGENT_AUTO_PAUSE_MS / 60000);
  return { leadId, agentName, channel, channelLabel: AI_CHANNEL_LABELS[channel], mode, state, label, pausedBy, autoPausedUntil, canControl, autoPauseMinutes };
}

export async function getLeadAiControlChannel(orgId: string, leadId: string): Promise<AiChannel> {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  await assertExtensionMessaging(orgId);
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) })
    .select('channel phone email')
    .maxTimeMS(5000)
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  const channel = aiLeadChannel(lead);
  if (!channel) throw new ApiError(409, 'The AI Agent has no text, email or chat conversation with this lead.');
  return channel;
}

export async function getExtensionMessagingStatus(orgId: string) {
  if (!extensionMessagingServerEnabled()) return { enabled: false, code: 'EXTENSION_MESSAGING_OFF', reason: MESSAGING_OFF_SERVER };
  const organization: any = await Organization.findById(orgId).select('metadata.extensionMessagingEnabled').maxTimeMS(5000).lean();
  if (organization?.metadata?.extensionMessagingEnabled !== true) {
    return { enabled: false, code: 'EXTENSION_MESSAGING_DEALERSHIP_OFF', reason: MESSAGING_OFF_DEALERSHIP };
  }
  return { enabled: true, code: null, reason: null };
}

async function assertExtensionMessaging(orgId: string) {
  const status = await getExtensionMessagingStatus(orgId);
  if (!status.enabled) throw new ApiError(403, String(status.reason), [{ code: status.code }]);
}

function blockedChannel(option: ReplyChannelOption, fallback: string) {
  const code = option.code || 'CHANNEL_UNAVAILABLE';
  return new ApiError(BLOCKED_STATUS[code] ?? 409, option.reason || fallback, [{ code }]);
}

function replyChannel(option: ReplyChannelOption, phone: boolean) {
  return {
    available: option.available,
    code: option.code,
    reason: option.reason,
    recipient: option.recipient,
    recipientDisplay: option.recipient ? (phone ? displayPhone(option.recipient) : option.recipient) : null,
  };
}

export async function getExtensionReplyOptions(orgId: string, leadId: string) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const messaging = await getExtensionMessagingStatus(orgId);
  if (!messaging.enabled) {
    const exists = await Lead.exists({ _id: leadId, organizationId: orgObjectId(orgId) });
    if (!exists) throw new ApiError(404, 'Lead not found');
    return { leadId, messaging, mode: null, defaultChannel: null, sms: null, email: null };
  }
  const options = await getLeadReplyOptions(orgId, leadId);
  return {
    leadId,
    messaging,
    mode: options.mode,
    defaultChannel: options.defaultChannel,
    sms: replyChannel(options.sms, true),
    email: { ...replyChannel(options.email, false), subject: options.email.subject },
  };
}

function outgoingText(raw: unknown, max: number, tooLong: string) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ApiError(400, 'Write a message before sending.');
  if (text.length > max) throw new ApiError(400, tooLong);
  return text;
}

function sendRequestId(raw: unknown) {
  const id = normalizeClientRequestId(raw);
  if (!id) throw new ApiError(400, 'This send request is not valid. Refresh and try again.');
  return id;
}

interface ExtensionSendInput {
  body: unknown;
  clientRequestId: unknown;
  confirmedRecipient: unknown;
}

export async function sendExtensionText(orgId: string, staff: ReturnType<typeof actor>, leadId: string, input: ExtensionSendInput) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  await assertExtensionMessaging(orgId);
  const body = outgoingText(input.body, MAX_TEXT_LENGTH, 'A text can be up to 1,600 characters.');
  const clientRequestId = sendRequestId(input.clientRequestId);
  const options = await getLeadReplyOptions(orgId, leadId);
  if (!options.sms.available || !options.sms.recipient) throw blockedChannel(options.sms, 'A text cannot be sent to this lead.');
  if (String(input.confirmedRecipient ?? '').trim() !== options.sms.recipient) {
    throw new ApiError(409, COMPOSER_MESSAGES.phoneChanged, [{ code: 'RECIPIENT_CHANGED' }]);
  }
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) }).select('firstName lastName').lean();
  const outcome = await sendManualLeadSms({
    orgId,
    user: staff,
    toPhone: options.sms.recipient,
    body,
    customerName: [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim(),
    leadId,
    clientRequestId,
    origin: 'chrome_extension',
  });
  if (outcome.duplicate) return { channel: 'sms' as const, duplicate: true };
  await recordHumanTakeover({
    kind: 'sms',
    organizationId: orgId,
    conversationId: outcome.conversation._id,
    leadId: outcome.conversation.leadId || leadId,
  });
  return { channel: 'sms' as const, duplicate: false };
}

export async function sendExtensionEmail(orgId: string, userId: unknown, leadId: string, input: ExtensionSendInput, ipAddress?: string) {
  assertOrg(orgId);
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  await assertExtensionMessaging(orgId);
  const message = outgoingText(input.body, MAX_EMAIL_LENGTH, 'An email sent from the extension can be up to 5,000 characters.');
  const clientRequestId = sendRequestId(input.clientRequestId);
  const options = await getLeadReplyOptions(orgId, leadId);
  if (!options.email.available || !options.email.recipient) throw blockedChannel(options.email, 'An email cannot be sent to this lead.');
  if (normalizeIdentityEmail(String(input.confirmedRecipient ?? '')) !== normalizeIdentityEmail(options.email.recipient)) {
    throw new ApiError(409, EMAIL_CHANGED, [{ code: 'RECIPIENT_CHANGED' }]);
  }
  const outcome = await sendLeadEmailReply({
    orgId,
    userId,
    leadId,
    message,
    attachments: [],
    rawRequestId: clientRequestId,
    ipAddress,
    source: 'chrome_extension',
  });
  if (outcome.status === 200 && outcome.body?.duplicate) return { channel: 'email' as const, duplicate: true };
  if (outcome.status === 200 && outcome.body?.success) return { channel: 'email' as const, duplicate: false };
  const code = outcome.body?.code;
  throw new ApiError(outcome.status, String(outcome.body?.message || 'The email could not be sent.'), code ? [{ code }] : []);
}

export async function getLeadNotes(orgId: string, leadId: string) {
  if (!orgId || !mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgObjectId(orgId) })
    .select('firstName lastName notes')
    .maxTimeMS(5000)
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  const notes = (Array.isArray(lead.notes) ? lead.notes : [])
    .filter((note: any) => note && typeof note.text === 'string')
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return {
    leadId: String(lead._id),
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unnamed lead',
    total: notes.length,
    notes: notes.slice(0, MAX_NOTES).map(toNote),
  };
}
