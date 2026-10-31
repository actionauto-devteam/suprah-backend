import mongoose from 'mongoose';
import { google } from 'googleapis';
import Lead from '../models/lead.model';
import LeadInquiry from '../models/LeadInquiry.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import SmsOptOut from '../models/SmsOptOut.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { CallLog, CommunicationMessage, Conversation } from '../models/communication.model';
import { CallRecording } from '../models/CallRecording.model';
import { LIFECYCLE_TERMINAL_STATUSES } from '../constants/leadStatus';
import { ApiError } from '../utils/ApiError';
import { cacheService } from './cache.service';
import { describeSmsFailure } from '../utils/smsFailure';
import { customerNumberOf, dealershipNumberOf, isLiveCall } from '../utils/callActivity';
import { extractGmailText, gmailAttachmentNames, gmailHeader, stripQuotedReply } from '../utils/gmailMessageParser';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import { withRetry } from '../utils/withRetry';
import { loadLeadAssociationInputs } from './leadLifecycle.service';
import { decideLeadIntake } from './leadIntakeDecision';
import { getLeadIntakeMode } from './leadIntakeControl.service';
import { describeWebchatContactPolicy } from './contactRestriction.service';
import { combineInfoForLead } from './leadDuplicateCombine.service';

export type ConversationChannel = 'sms' | 'email' | 'webchat' | 'call' | 'note' | 'inquiry';
export type DeliveryCode = 'sending' | 'sent' | 'delivered' | 'failed' | 'unconfirmed' | 'received';

export interface ConversationItem {
  id: string;
  kind: 'message' | 'call' | 'note' | 'inquiry';
  channel: ConversationChannel;
  direction?: 'inbound' | 'outbound';
  occurredAt: string;
  body: string;
  subject?: string;
  author: { name: string; kind: 'customer' | 'staff' | 'ai' | 'system'; userId?: string | null };
  status?: { code: DeliveryCode; label: string; failureMessage?: string; errorDetail?: string };
  call?: {
    id: string;
    status: string;
    label: string;
    live: boolean;
    durationSec?: number | null;
    answeredBy?: string | null;
    placedBy?: string | null;
    number?: string | null;
    customerNumber?: string | null;
    lineLabel?: string | null;
    selectedOption?: string | null;
    startedAt?: string | null;
    answeredAt?: string | null;
    endedAt?: string | null;
    recording?: { id: string; state: string } | null;
  };
  inquiry?: { isOriginal: boolean; kind: string; source?: string | null; sourceProvider?: string | null; channel?: string | null; vehicle?: Record<string, unknown> | null };
  attachments?: string[];
  messageId?: string;
  note?: { authorType?: string; milestone?: boolean };
}

const DELIVERY_LABELS: Record<DeliveryCode, string> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  unconfirmed: "Couldn't confirm delivery",
  received: 'Received',
};

const deliveryStatus = (code: DeliveryCode, extra: Partial<NonNullable<ConversationItem['status']>> = {}) => ({ code, label: DELIVERY_LABELS[code], ...extra });

export function smsDeliveryStatus(message: { direction?: string; status?: string; errorDetail?: string | null }) {
  if (message.direction === 'inbound') return deliveryStatus('received');
  switch (message.status) {
    case 'queued':
      return deliveryStatus('sending');
    case 'delivered':
      return deliveryStatus('delivered');
    case 'failed': {
      const failure = message.errorDetail ? describeSmsFailure(message.errorDetail) : null;
      return deliveryStatus('failed', {
        failureMessage: failure?.friendlyMessage || 'This message could not be delivered',
        errorDetail: message.errorDetail ? String(message.errorDetail).slice(0, 300) : undefined,
      });
    }
    case 'pending_reconciliation':
      return deliveryStatus('unconfirmed');
    default:
      return deliveryStatus('sent');
  }
}

const CALL_LABELS: Record<string, string> = {
  ivr: 'In the phone menu',
  ringing: 'Ringing',
  answering: 'Connecting',
  'in-progress': 'In progress',
  completed: 'Answered',
  missed: 'Missed',
  failed: 'Failed',
  canceled: 'Ended before answer',
};

const AI_ACTOR = 'ai-agent';
const SYSTEM_ACTORS = ['system', 'system-webchat-ack'];

function authorFor(sentBy: any, customerName: string, inbound: boolean) {
  if (inbound) return { name: customerName, kind: 'customer' as const };
  const userId = sentBy?.userId ? String(sentBy.userId) : null;
  if (userId === AI_ACTOR) return { name: sentBy?.name || 'AI Agent', kind: 'ai' as const, userId };
  if (userId && SYSTEM_ACTORS.includes(userId)) return { name: sentBy?.name || 'Automatic message', kind: 'system' as const, userId };
  return { name: sentBy?.name || 'Team member', kind: 'staff' as const, userId };
}

const toIso = (value: unknown) => {
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

const orgIdsOf = (organizationId: string) => ({ $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] });

interface EmailEntry {
  gmailId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  fromName: string;
  subject: string;
  body: string;
  occurredAt: string;
  attachments: string[];
}

export function parseGmailThreadMessages(messages: any[], ownAddresses: string[]): EmailEntry[] {
  const own = new Set(ownAddresses.map((address) => normalizeIdentityEmail(address)).filter(Boolean) as string[]);
  return (messages || []).map((message: any) => {
    const fromHeader = gmailHeader(message, 'from');
    const fromAddress = normalizeIdentityEmail(fromHeader.match(/<([^<>]+)>/)?.[1] || fromHeader) || '';
    const fromName = fromHeader.replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || fromAddress;
    const outbound = (message.labelIds || []).includes('SENT') || (fromAddress ? own.has(fromAddress) : false);
    const text = extractGmailText(message);
    return {
      gmailId: String(message.id),
      direction: outbound ? 'outbound' : 'inbound',
      from: fromAddress,
      fromName,
      subject: gmailHeader(message, 'subject'),
      body: stripQuotedReply(text),
      occurredAt: toIso(Number(message.internalDate) || Date.now()),
      attachments: gmailAttachmentNames(message),
    };
  });
}

async function loadEmailThread(organizationId: string, leadId: string, threadId: string): Promise<EmailEntry[]> {
  if (isLocalUiAcceptanceMode()) return [];
  const cacheKey = `lead:conversation-email:${leadId}:${threadId}`;
  const cached = await cacheService.get(cacheKey).catch(() => null);
  if (cached) return cached as EmailEntry[];
  const { getCentralOAuth2Client } = await import('../controllers/lead.controller');
  const [config, oauth2Client] = await Promise.all([
    OrgLeadConfig.findOne({ organizationId, isActive: true }).select('gmailAddress').lean(),
    getCentralOAuth2Client(organizationId),
  ]);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const thread: any = await withRetry(() => gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
  const entries = parseGmailThreadMessages(thread.data.messages || [], [config?.gmailAddress || ''].filter(Boolean));
  await cacheService.set(cacheKey, entries, 45).catch(() => undefined);
  return entries;
}

export async function withoutOtherLeadsEmails<T extends { id?: string; messageId?: string }>(
  organizationId: string,
  leadId: string,
  threadId: string,
  messages: T[],
): Promise<T[]> {
  if ((await getLeadIntakeMode(organizationId).catch(() => 'paused')) === 'off') return messages;
  const foreign = await LeadInquiry.find({
    organizationId,
    'sourceIds.gmailThreadId': threadId,
    $or: [{ 'association.leadId': { $ne: new mongoose.Types.ObjectId(leadId) } }, { 'association.state': { $in: ['received', 'pending_review'] } }],
  }).select('sourceIds.gmailMessageId').lean();
  const hidden = new Set(foreign.map((entry: any) => entry.sourceIds?.gmailMessageId).filter(Boolean));
  return hidden.size ? messages.filter((message) => !hidden.has(String(message.id || message.messageId || ''))) : messages;
}

export async function clearLeadConversationEmailCache(leadId: unknown, threadId: unknown): Promise<void> {
  if (!leadId || !threadId) return;
  try {
    await cacheService.del(`lead:conversation-email:${leadId}:${threadId}`);
  } catch {
    return;
  }
}

interface Cursor { occurredAt: string; id: string }

function decodeCursor(value?: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (typeof parsed?.occurredAt === 'string' && typeof parsed?.id === 'string') return parsed;
  } catch {
    return null;
  }
  return null;
}

const encodeCursor = (item: ConversationItem) => Buffer.from(JSON.stringify({ occurredAt: item.occurredAt, id: item.id })).toString('base64url');

const isOlder = (item: ConversationItem, cursor: Cursor | null) =>
  !cursor || item.occurredAt < cursor.occurredAt || (item.occurredAt === cursor.occurredAt && item.id < cursor.id);

const newestFirst = (a: ConversationItem, b: ConversationItem) =>
  a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1;

const LEAD_FIELDS = 'firstName lastName email phone status channel source sourceProvider subject comments parsedContent createdAt notes threadId sourceInquiryId intakeIdentity identityEmailExcluded customerId aiPausedAt aiPausedBy aiAutoPausedUntil vehicle combinedInto';

function leadName(lead: any) {
  return [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim() || lead?.email || lead?.phone || 'Customer';
}

export async function loadConversationItems(organizationId: string, lead: any, options: { before?: string | null; limit?: number } = {}) {
  const limit = Math.min(200, Math.max(1, options.limit || 100));
  const cursor = decodeCursor(options.before);
  const cursorDate = cursor ? new Date(cursor.occurredAt) : null;
  const leadId = String(lead._id);
  const customerName = leadName(lead);
  const orgIds = orgIdsOf(organizationId);
  const unavailableSources: string[] = [];
  const safe = async <T>(name: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch {
      unavailableSources.push(name);
      return fallback;
    }
  };
  const timeFilter = cursorDate ? { $lte: cursorDate } : undefined;
  const fetchLimit = limit + 1;

  const [sms, calls, chats, inquiries, emails, foreignGmail] = await Promise.all([
    safe('sms', () => CommunicationMessage.find({ orgId: orgIds, leadId, ...(timeFilter ? { createdAt: timeFilter } : {}) })
      .sort({ createdAt: -1, _id: -1 }).limit(fetchLimit).lean(), [] as any[]),
    safe('call', () => CallLog.find({ orgId: orgIds, leadId, ...(timeFilter ? { createdAt: timeFilter } : {}) })
      .sort({ createdAt: -1, _id: -1 }).limit(fetchLimit).lean(), [] as any[]),
    safe('webchat', () => WebChatMessage.find({ organizationId, leadId, aiDispatchPending: { $ne: true }, ...(timeFilter ? { createdAt: timeFilter } : {}) })
      .sort({ createdAt: -1, _id: -1 }).limit(fetchLimit).lean(), [] as any[]),
    safe('inquiry', () => LeadInquiry.find({ organizationId, 'association.leadId': leadId, 'association.state': 'associated' })
      .select('kind source sourceProvider channel subject comments vehicle receivedAt sourceIds contact')
      .sort({ receivedAt: -1 }).limit(200).lean(), [] as any[]),
    lead.threadId ? safe('email', () => loadEmailThread(organizationId, leadId, String(lead.threadId)), [] as EmailEntry[]) : Promise.resolve([] as EmailEntry[]),
    lead.threadId
      ? safe('email', () => LeadInquiry.find({
          organizationId,
          'sourceIds.gmailThreadId': lead.threadId,
          $or: [{ 'association.leadId': { $ne: new mongoose.Types.ObjectId(leadId) } }, { 'association.state': { $in: ['received', 'pending_review'] } }],
        }).select('sourceIds.gmailMessageId association').lean(), [] as any[])
      : Promise.resolve([] as any[]),
  ]);

  const recordings: any[] = (calls as any[]).length
    ? await safe('call', () => CallRecording.find({
        organizationId,
        callLogId: { $in: (calls as any[]).map((call) => call._id) },
        startedAt: { $ne: null },
        state: { $nin: ['deleted', 'deleting'] },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }).select('callLogId state').lean(), [] as any[])
    : [];
  const recordingByCall = new Map(recordings.map((recording) => [String(recording.callLogId), recording]));

  const items: ConversationItem[] = [];
  for (const message of sms as any[]) {
    const inbound = message.direction === 'inbound';
    items.push({
      id: `sms:${message._id}`,
      kind: 'message',
      channel: 'sms',
      direction: inbound ? 'inbound' : 'outbound',
      occurredAt: toIso(message.createdAt),
      body: message.body || '',
      author: authorFor(message.sentBy, customerName, inbound),
      status: smsDeliveryStatus(message),
      messageId: String(message._id),
    });
  }
  for (const call of calls as any[]) {
    const recording = recordingByCall.get(String(call._id));
    const live = isLiveCall(call);
    items.push({
      id: `call:${call._id}`,
      kind: 'call',
      channel: 'call',
      direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
      occurredAt: toIso(call.startedAt || call.createdAt),
      body: call.direction === 'outbound' ? 'Outgoing call' : 'Incoming call',
      author: call.direction === 'outbound'
        ? authorFor(call.placedBy, customerName, false)
        : { name: customerName, kind: 'customer' },
      call: {
        id: String(call._id),
        status: call.status,
        label: CALL_LABELS[call.status] || call.status,
        live,
        durationSec: call.durationSec ?? null,
        answeredBy: call.answeredBy?.name || null,
        placedBy: call.placedBy?.name || null,
        number: dealershipNumberOf(call),
        customerNumber: customerNumberOf(call),
        lineLabel: call.lineLabel || null,
        selectedOption: call.routing?.selectedLabel || null,
        startedAt: call.startedAt ? toIso(call.startedAt) : null,
        answeredAt: call.answeredAt ? toIso(call.answeredAt) : null,
        endedAt: call.endedAt ? toIso(call.endedAt) : null,
        recording: recording ? { id: String(recording._id), state: recording.state } : null,
      },
    });
  }
  for (const chat of chats as any[]) {
    const inbound = chat.direction === 'inbound';
    items.push({
      id: `webchat:${chat._id}`,
      kind: 'message',
      channel: 'webchat',
      direction: inbound ? 'inbound' : 'outbound',
      occurredAt: toIso(chat.createdAt),
      body: chat.body || '',
      author: authorFor(chat.sentBy, customerName, inbound),
      status: deliveryStatus(inbound ? 'received' : 'sent'),
      messageId: String(chat._id),
    });
  }

  const foreignIds = new Set((foreignGmail as any[]).map((entry) => entry.sourceIds?.gmailMessageId).filter(Boolean));
  const threadIds = new Set<string>();
  for (const email of emails as EmailEntry[]) {
    threadIds.add(email.gmailId);
    if (foreignIds.has(email.gmailId)) continue;
    if (cursorDate && new Date(email.occurredAt) > cursorDate) continue;
    items.push({
      id: `email:${email.gmailId}`,
      kind: 'message',
      channel: 'email',
      direction: email.direction,
      occurredAt: email.occurredAt,
      body: email.body,
      subject: email.subject || undefined,
      author: email.direction === 'inbound' ? { name: email.fromName || customerName, kind: 'customer' } : { name: email.fromName || 'Your dealership', kind: 'staff' },
      status: deliveryStatus(email.direction === 'inbound' ? 'received' : 'sent'),
      attachments: email.attachments.length ? email.attachments : undefined,
      messageId: email.gmailId,
    });
  }

  let hasOriginal = false;
  for (const inquiry of inquiries as any[]) {
    if (['sms', 'call'].includes(inquiry.kind)) continue;
    const gmailId = inquiry.sourceIds?.gmailMessageId;
    if (inquiry.kind === 'email_reply') {
      if (gmailId && threadIds.has(gmailId)) continue;
      items.push({
        id: `email:inquiry:${inquiry._id}`,
        kind: 'message',
        channel: 'email',
        direction: 'inbound',
        occurredAt: toIso(inquiry.receivedAt),
        body: stripQuotedReply(String(inquiry.comments || '')),
        subject: inquiry.subject || undefined,
        author: { name: customerName, kind: 'customer' },
        status: deliveryStatus('received'),
      });
      continue;
    }
    const isOriginal = String(inquiry._id) === String(lead.sourceInquiryId || '');
    if (isOriginal) hasOriginal = true;
    items.push({
      id: `inquiry:${inquiry._id}`,
      kind: 'inquiry',
      channel: 'inquiry',
      direction: 'inbound',
      occurredAt: toIso(inquiry.receivedAt),
      body: String(inquiry.comments || ''),
      subject: inquiry.subject || undefined,
      author: { name: customerName, kind: 'customer' },
      inquiry: {
        isOriginal,
        kind: inquiry.kind,
        source: inquiry.source || null,
        sourceProvider: inquiry.sourceProvider || null,
        channel: inquiry.channel || null,
        vehicle: inquiry.vehicle || null,
      },
    });
  }
  const leadComments = String(lead.comments || '').trim();
  const leadCreatedAt = new Date(lead.createdAt).getTime();
  const originalAlreadyStored = Boolean(leadComments) && items.some((item) =>
    item.kind === 'message'
    && item.direction === 'inbound'
    && (item.channel === 'sms' || item.channel === 'webchat')
    && item.body.trim() === leadComments
    && Math.abs(new Date(item.occurredAt).getTime() - leadCreatedAt) <= 10 * 60 * 1000);
  if (!hasOriginal && !originalAlreadyStored) {
    items.push({
      id: `inquiry:lead:${leadId}`,
      kind: 'inquiry',
      channel: 'inquiry',
      direction: 'inbound',
      occurredAt: toIso(lead.createdAt),
      body: String(lead.comments || ''),
      subject: lead.subject || undefined,
      author: { name: customerName, kind: 'customer' },
      inquiry: {
        isOriginal: true,
        kind: 'original',
        source: lead.source || null,
        sourceProvider: lead.sourceProvider || null,
        channel: lead.channel || null,
        vehicle: lead.vehicle || null,
      },
    });
  }

  (Array.isArray(lead.notes) ? lead.notes : []).forEach((note: any, index: number) => {
    items.push({
      id: `note:${note._id || `${leadId}-${index}`}`,
      kind: 'note',
      channel: 'note',
      occurredAt: toIso(note.createdAt),
      body: note.text || '',
      author: { name: note.authorName || 'Team member', kind: note.authorType === 'ai' ? 'ai' : 'staff' },
      note: { authorType: note.authorType || 'user', milestone: Boolean(note.milestone) },
    });
  });

  const ordered = items.filter((item) => isOlder(item, cursor)).sort(newestFirst);
  const page = ordered.slice(0, limit);
  const sourceFull = [sms, calls, chats].some((list) => (list as any[]).length > limit);
  const hasMore = ordered.length > limit || sourceFull;
  return {
    items: page.reverse(),
    nextCursor: hasMore && page.length ? encodeCursor(page[0]) : null,
    unavailableSources: [...new Set(unavailableSources)],
  };
}

async function sameCustomerLeadIds(organizationId: string, lead: any) {
  if (lead.intakeIdentity === 'unverified') return { available: false as const, reason: 'unverified' };
  if (!lead.phone && !lead.email) return { available: false as const, reason: 'no_contact' };
  const inputs = await loadLeadAssociationInputs({
    organizationId,
    phone: lead.phone,
    email: lead.email,
    emailExcluded: lead.identityEmailExcluded,
  });
  if (!inputs.lookupComplete) return { available: false as const, reason: 'lookup_incomplete' };
  if (inputs.identity.status === 'ambiguous') return { available: false as const, reason: 'identity_ambiguous' };
  const decision = decideLeadIntake({ ...inputs, policy: 'associate' });
  const same = new Set([...decision.candidateLeadIds, ...decision.previousLeadIds].map(String));
  same.delete(String(lead._id));
  const phoneShared = inputs.candidates.some((candidate) =>
    candidate.leadId !== String(lead._id) && !same.has(candidate.leadId) && candidate.matchedBy.includes('phone'));
  return { available: true as const, leadIds: [...same], phoneSafe: !phoneShared };
}

async function unlinkedPhoneRecords(organizationId: string, phone: string | null | undefined) {
  const normalized = normalizeIdentityPhone(phone);
  if (!normalized) return { messages: [] as any[], calls: [] as any[] };
  const orgIds = orgIdsOf(organizationId);
  const conversations = await Conversation.find({ orgId: orgIds, customerPhone: normalized }).select('_id').lean();
  const conversationIds = conversations.map((conversation: any) => conversation._id);
  const unowned = { $or: [{ leadId: null }, { leadId: { $exists: false } }] };
  const [messages, calls] = await Promise.all([
    conversationIds.length
      ? CommunicationMessage.find({ orgId: orgIds, conversationId: { $in: conversationIds }, ...unowned }).sort({ createdAt: -1 }).limit(200).lean()
      : Promise.resolve([] as any[]),
    CallLog.find({ orgId: orgIds, ...unowned, $and: [{ $or: [{ from: normalized }, { to: normalized }] }] }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  return { messages, calls };
}

export async function listEarlierConversations(organizationId: string, lead: any) {
  const same = await sameCustomerLeadIds(organizationId, lead);
  if (!same.available) return { available: false, reason: same.reason, leads: [], unlinkedCount: 0 };
  const leads = same.leadIds.length
    ? await Lead.find({ _id: { $in: same.leadIds }, organizationId }).select('firstName lastName status source channel createdAt updatedAt combinedInto').sort({ createdAt: -1 }).limit(10).lean()
    : [];
  let unlinkedCount = 0;
  if (same.phoneSafe && lead.phone) {
    const unlinked = await unlinkedPhoneRecords(organizationId, lead.phone);
    unlinkedCount = unlinked.messages.length + unlinked.calls.length;
  }
  return {
    available: true,
    reason: null,
    unlinkedCount,
    leads: leads.map((entry: any) => ({
      _id: String(entry._id),
      name: leadName(entry),
      status: entry.status,
      source: entry.source || null,
      channel: entry.channel || null,
      createdAt: entry.createdAt,
      closed: LIFECYCLE_TERMINAL_STATUSES.includes(entry.status),
      combined: Boolean(entry.combinedInto?.leadId),
      previousStatus: entry.combinedInto?.previousStatus || null,
    })),
  };
}

export async function channelStateFor(organizationId: string, lead: any) {
  const phone = normalizeIdentityPhone(lead.phone);
  const [conversation, optOut, session] = await Promise.all([
    phone ? Conversation.findOne({ orgId: orgIdsOf(organizationId), customerPhone: phone }).select('_id leadId aiPausedAt aiPausedBy aiAutoPausedUntil').lean() : Promise.resolve(null),
    phone ? SmsOptOut.findOne({ organizationId, phone, optedOut: true }).select('_id').lean() : Promise.resolve(null),
    WebChatSession.findOne({ leadId: lead._id, organizationId }).sort({ createdAt: -1 })
      .select('_id organizationId leadId visitorPhone visitorEmail aiPausedAt aiPausedBy aiAutoPausedUntil').lean(),
  ]);
  const ownsConversation = conversation && String((conversation as any).leadId || '') === String(lead._id);
  const contactPolicy = session ? await describeWebchatContactPolicy(session as any).catch(() => null) : null;
  return {
    sms: {
      conversationId: conversation ? String((conversation as any)._id) : null,
      ownsConversation: Boolean(ownsConversation),
      aiPausedAt: ownsConversation ? (conversation as any).aiPausedAt || null : null,
      aiPausedBy: ownsConversation ? (conversation as any).aiPausedBy || null : null,
      aiAutoPausedUntil: ownsConversation ? (conversation as any).aiAutoPausedUntil || null : null,
      optedOut: Boolean(optOut),
    },
    webchat: session
      ? {
          sessionId: String((session as any)._id),
          aiPausedAt: (session as any).aiPausedAt || null,
          aiPausedBy: (session as any).aiPausedBy || null,
          aiAutoPausedUntil: (session as any).aiAutoPausedUntil || null,
          contactPolicy,
        }
      : null,
    email: {
      aiPausedAt: lead.aiPausedAt || null,
      aiPausedBy: lead.aiPausedBy || null,
      aiAutoPausedUntil: lead.aiAutoPausedUntil || null,
    },
  };
}

async function loadLead(organizationId: string, leadId: string) {
  if (!mongoose.isValidObjectId(leadId) || !mongoose.isValidObjectId(organizationId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId }).select(LEAD_FIELDS).lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  return lead;
}

export async function buildLeadConversation(organizationId: string, leadId: string, options: { before?: string | null; limit?: number } = {}) {
  const lead = await loadLead(organizationId, leadId);
  const [page, earlier, channelState, intakeMode, combine] = await Promise.all([
    loadConversationItems(organizationId, lead, options),
    options.before
      ? Promise.resolve(null)
      : listEarlierConversations(organizationId, lead).catch(() => ({ available: false, reason: 'unavailable', leads: [], unlinkedCount: 0 })),
    channelStateFor(organizationId, lead).catch(() => null),
    getLeadIntakeMode(organizationId).catch(() => 'off' as const),
    options.before ? Promise.resolve(null) : combineInfoForLead(organizationId, lead).catch(() => null),
  ]);
  const closed = LIFECYCLE_TERMINAL_STATUSES.includes(lead.status);
  return {
    lead: {
      _id: String(lead._id),
      name: leadName(lead),
      status: lead.status,
      channel: lead.channel || null,
      closed,
      unverified: lead.intakeIdentity === 'unverified',
    },
    composer: {
      closed,
      blocked: closed && intakeMode !== 'off' && lead.status !== 'Do Not Contact',
      intakeMode,
    },
    items: page.items,
    nextCursor: page.nextCursor,
    unavailableSources: page.unavailableSources,
    earlier,
    channelState,
    combine,
  };
}

export async function getEarlierConversation(organizationId: string, leadId: string, earlierId: string) {
  const lead = await loadLead(organizationId, leadId);
  const same = await sameCustomerLeadIds(organizationId, lead);
  if (!same.available) throw new ApiError(404, 'Earlier conversations are not available for this lead');
  if (earlierId === 'unlinked') {
    if (!same.phoneSafe || !lead.phone) throw new ApiError(404, 'No earlier messages for this number');
    const { messages, calls } = await unlinkedPhoneRecords(organizationId, lead.phone);
    const customerName = leadName(lead);
    const items: ConversationItem[] = [
      ...messages.map((message: any) => ({
        id: `sms:${message._id}`,
        kind: 'message' as const,
        channel: 'sms' as const,
        direction: message.direction === 'inbound' ? 'inbound' as const : 'outbound' as const,
        occurredAt: toIso(message.createdAt),
        body: message.body || '',
        author: authorFor(message.sentBy, customerName, message.direction === 'inbound'),
        status: smsDeliveryStatus(message),
      })),
      ...calls.map((call: any) => ({
        id: `call:${call._id}`,
        kind: 'call' as const,
        channel: 'call' as const,
        direction: call.direction === 'outbound' ? 'outbound' as const : 'inbound' as const,
        occurredAt: toIso(call.startedAt || call.createdAt),
        body: call.direction === 'outbound' ? 'Outgoing call' : 'Incoming call',
        author: { name: customerName, kind: 'customer' as const },
        call: { id: String(call._id), status: call.status, label: CALL_LABELS[call.status] || call.status, live: false, durationSec: call.durationSec ?? null, answeredBy: call.answeredBy?.name || null },
      })),
    ].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
    return { lead: null, items };
  }
  if (!same.leadIds.includes(String(earlierId))) throw new ApiError(404, 'Earlier conversation not found');
  const earlierLead = await loadLead(organizationId, earlierId);
  const page = await loadConversationItems(organizationId, earlierLead, { limit: 200 });
  return {
    lead: { _id: String(earlierLead._id), name: leadName(earlierLead), status: earlierLead.status },
    items: page.items,
    unavailableSources: page.unavailableSources,
  };
}
