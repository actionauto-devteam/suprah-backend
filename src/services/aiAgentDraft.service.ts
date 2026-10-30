import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { AI_AGENT_NAME_REQUIRED_CODE, AI_AGENT_NAME_REQUIRED_MESSAGE, identityFromMetadata } from '../utils/aiAgentIdentity';
import { hasGeminiApiKey, validateOutboundEmailMessage, validateOutboundMessage } from '../utils/aiOutboundSafety';
import { assertLeadOpenForManualSend } from '../utils/closedLeadGuard';
import {
  AiAgentTranscriptEntry,
  GenerateAlexReplyResult,
  HISTORY_LIMIT,
  classifyAlexEmailReplySafety,
  classifyAlexReplySafety,
  generateAlexEmailReply,
  generateAlexReply,
  selectRelevantAiCoaching,
} from './aiAgent.service';
import { getRelevantAiCoaching } from './aiAgentCoaching.service';
import { resolveCurrentVehicleAndPrice } from './aiReplyContext.service';
import { recordAiUsage } from './aiOperatingMode.service';
import { ContactRestrictedError, resolveContactRestriction } from './contactRestriction.service';
import { ConversationItem, loadConversationItems } from './leadConversation.service';
import { buildVehicleContextNote, resolvePinnedVehicleContext } from './vehicleInquiryContext.service';

export type StaffDraftChannel = 'sms' | 'email' | 'webchat';
export const STAFF_DRAFT_CHANNELS: StaffDraftChannel[] = ['sms', 'email', 'webchat'];

export const STAFF_DRAFT_CODES = {
  failed: 'AI_DRAFT_FAILED',
  inProgress: 'AI_DRAFT_IN_PROGRESS',
  timeout: 'AI_DRAFT_TIMEOUT',
  unavailable: 'AI_DRAFT_UNAVAILABLE',
  wrongChannel: 'AI_DRAFT_WRONG_CHANNEL',
};

export const STAFF_DRAFT_MESSAGES = {
  failed: "Couldn't generate a reply right now. Please try again.",
  inProgress: 'A suggestion is already being written for this conversation.',
  wrongChannel: 'Choose Text or Email for this lead, or reply in the Web Chat.',
};

const DEADLINE_MS = parseInt(process.env.AI_STAFF_DRAFT_DEADLINE_MS || '35000', 10);
const SAFETY_ATTEMPTS = 2;
const SAFETY_REASON_WORDS: Record<string, string> = {
  'currency amount': 'a price',
  'price mention': 'a price',
  'unverified price figure': 'a price we could not confirm',
  'percent-off': 'a percentage',
  'discount/incentive language': 'a discount or promotion',
  'financing/payment language': 'financing or payments',
  'trade-in mention': 'a trade-in',
  'guaranteed-availability language': 'that the vehicle is available or guaranteed',
  'unexpected phone number': 'a phone number',
  'unexpected link': 'a website link',
  'unexpected email address': 'an email address',
};
const SAFETY_WARNINGS = {
  flagged: 'Check this before sending. The safety check flagged something in this suggestion.',
  unchecked: "Check this before sending. The safety check couldn't finish for this suggestion.",
};
const MAX_ENTRY_LENGTH = 1500;
const LEAD_FIELDS = 'firstName lastName email phone status channel source sourceProvider subject comments parsedContent createdAt notes threadId sourceInquiryId intakeIdentity identityEmailExcluded customerId vehicle';

const inFlight = new Set<string>();

export interface StaffDraftResult {
  draft: string;
  channel: StaffDraftChannel;
  agentName: string;
  note: string | null;
  safetyWarning: string | null;
}

function clip(text: string): string {
  const value = String(text || '').replace(/\s+\n/g, '\n').trim();
  return value.length > MAX_ENTRY_LENGTH ? `${value.slice(0, MAX_ENTRY_LENGTH)}…` : value;
}

export function draftTranscriptFromItems(items: ConversationItem[], agentName: string): AiAgentTranscriptEntry[] {
  const transcript: AiAgentTranscriptEntry[] = [];
  for (const item of items) {
    const body = clip(item.body);
    if (!body) continue;
    if (item.kind === 'inquiry') {
      transcript.push({ from: 'customer', body: item.subject ? `${item.subject}\n${body}` : body });
      continue;
    }
    if (item.kind !== 'message') continue;
    if (item.direction === 'inbound') {
      transcript.push({ from: 'customer', body });
    } else if (item.author.kind === 'ai') {
      transcript.push({ from: 'staff', staffName: `${agentName} (AI assistant)`, body });
    } else if (item.author.kind === 'system') {
      transcript.push({ from: 'staff', staffName: 'Automatic message', body });
    } else {
      transcript.push({ from: 'staff', staffName: item.author.name, body });
    }
  }
  return transcript.slice(-HISTORY_LIMIT);
}

function draftError(statusCode: number, message: string, code: string): ApiError {
  return new ApiError(statusCode, message, [{ code }]);
}

function safetyReasonWords(reasons: string[]): string {
  return Array.from(new Set(reasons.map((reason) => SAFETY_REASON_WORDS[reason]).filter(Boolean))).join(', ');
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function buildDraft(input: {
  organizationId: string;
  lead: any;
  channel: StaffDraftChannel;
  agentName: string;
  dealerName: string;
  staffName?: string;
}): Promise<{ draft: string; note: string | null; safetyWarning: string | null }> {
  const { organizationId, lead, channel, agentName, dealerName } = input;
  const { items } = await loadConversationItems(organizationId, lead, { limit: 60 });
  const transcript = draftTranscriptFromItems(items, agentName);
  const customerFirstName = lead.firstName || undefined;
  const leadVehicleInterest = lead.vehicle
    ? [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ') || undefined
    : undefined;
  const pinned = await resolvePinnedVehicleContext({ organizationId, lead, phone: lead.phone, email: lead.email }).catch(() => null);
  const vehicleContextNote = pinned ? buildVehicleContextNote(pinned) : undefined;
  const draftFor = { name: input.staffName };

  let generate: (retryNote?: string) => Promise<GenerateAlexReplyResult>;
  let prices: number[] = [];
  if (channel === 'email') {
    const price = await resolveCurrentVehicleAndPrice(lead).catch(() => null);
    prices = [price?.price, price?.previousPrice].filter((value): value is number => typeof value === 'number');
    generate = (retryNote) => generateAlexEmailReply({
      agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, isFirstReply: false,
      confirmedPrice: price?.price, confirmedPreviousPrice: price?.previousPrice, phone: lead.phone, vehicleContextNote, draftFor, retryNote,
    });
  } else {
    let coachingNotes: string[] = [];
    const coaching = await getRelevantAiCoaching({ organizationId, channel }).catch(() => ({ rules: [] as any[] }));
    if (coaching.rules.length) {
      const selection = await selectRelevantAiCoaching({
        rules: coaching.rules, agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, channel,
      });
      if (selection.status !== 'error') coachingNotes = selection.appliedRules.map((rule) => rule.instruction);
    }
    generate = (retryNote) => generateAlexReply({
      agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, channel, isFirstReply: false,
      coachingNotes, phone: lead.phone, vehicleContextNote, draftFor, retryNote,
    });
  }

  let retryNote: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const generation = await generate(retryNote);
    if (!generation.text) {
      logger.warn({ organizationId, leadId: String(lead._id), channel, reason: generation.error }, '[AiAgentDraft] No draft was generated');
      throw draftError(502, STAFF_DRAFT_MESSAGES.failed, STAFF_DRAFT_CODES.failed);
    }
    const text = generation.text;
    const note = generation.handoffReason ? `${agentName} suggests a team member follows up: ${generation.handoffReason}` : null;
    const deterministic = channel === 'email' ? validateOutboundEmailMessage(text, prices) : validateOutboundMessage(text);
    if (!deterministic.ok) {
      logger.info({ organizationId, leadId: String(lead._id), channel, attempt, reasons: deterministic.reasons }, '[AiAgentDraft] Draft flagged by the safety rules');
      const words = safetyReasonWords(deterministic.reasons);
      if (attempt < SAFETY_ATTEMPTS) {
        retryNote = `Your previous suggestion was flagged${words ? ` because it mentioned ${words}` : ''}. Write a new reply that does not mention this. Say the team will follow up instead.`;
        continue;
      }
      return { draft: text, note, safetyWarning: words ? `Check this before sending. It mentions ${words}.` : SAFETY_WARNINGS.flagged };
    }
    const verdict = channel === 'email'
      ? await classifyAlexEmailReplySafety(text, lead.phone)
      : await classifyAlexReplySafety(text, lead.phone);
    if (verdict === 'SAFE') return { draft: text, note, safetyWarning: null };
    logger.info({ organizationId, leadId: String(lead._id), channel, attempt, verdict }, '[AiAgentDraft] Draft flagged by the safety check');
    if (verdict === 'UNSAFE' && attempt < SAFETY_ATTEMPTS) {
      retryNote = 'Your previous suggestion was flagged by the safety check. Write a simpler reply with no prices, payments, discounts or promises. Say the team will follow up instead.';
      continue;
    }
    return { draft: text, note, safetyWarning: verdict === 'UNSAFE' ? SAFETY_WARNINGS.flagged : SAFETY_WARNINGS.unchecked };
  }
}

export async function generateStaffDraft(input: {
  organizationId: unknown;
  leadId: unknown;
  channel: unknown;
  staff: { userId?: unknown; name?: unknown };
}): Promise<StaffDraftResult> {
  const organizationId = String(input.organizationId || '');
  const leadId = String(input.leadId || '');
  if (!mongoose.isValidObjectId(organizationId) || !mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const channel = String(input.channel || '') as StaffDraftChannel;
  if (!STAFF_DRAFT_CHANNELS.includes(channel)) throw draftError(400, STAFF_DRAFT_MESSAGES.wrongChannel, STAFF_DRAFT_CODES.wrongChannel);

  const org: any = await Organization.findById(organizationId).select('name metadata').lean();
  const identity = identityFromMetadata(org?.metadata);
  if (!identity.configured || !identity.name) {
    throw new ApiError(409, AI_AGENT_NAME_REQUIRED_MESSAGE, [{ code: AI_AGENT_NAME_REQUIRED_CODE }]);
  }

  const lead: any = await Lead.findOne({ _id: leadId, organizationId }).select(LEAD_FIELDS).lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  const webchatLead = String(lead.channel || '').toLowerCase() === 'webchat';
  if (webchatLead !== (channel === 'webchat')) {
    throw draftError(400, STAFF_DRAFT_MESSAGES.wrongChannel, STAFF_DRAFT_CODES.wrongChannel);
  }
  await assertLeadOpenForManualSend(organizationId, lead);
  if (!webchatLead) {
    const restriction = await resolveContactRestriction({
      organizationId, leadId: lead._id, phone: lead.phone, email: lead.email, customerId: lead.customerId,
    });
    if (restriction.status !== 'allowed') throw new ContactRestrictedError(restriction);
  }
  if (!hasGeminiApiKey(lead.phone)) {
    throw draftError(502, STAFF_DRAFT_MESSAGES.failed, STAFF_DRAFT_CODES.unavailable);
  }

  const key = `${organizationId}:${String(input.staff.userId || '')}:${leadId}:${channel}`;
  if (inFlight.has(key)) throw draftError(409, STAFF_DRAFT_MESSAGES.inProgress, STAFF_DRAFT_CODES.inProgress);
  inFlight.add(key);
  try {
    const built = await withDeadline(
      buildDraft({
        organizationId,
        lead,
        channel,
        agentName: identity.name,
        dealerName: org?.name || 'Your Dealership',
        staffName: input.staff.name ? String(input.staff.name) : undefined,
      }),
      DEADLINE_MS,
    );
    if (!built) {
      logger.warn({ organizationId, leadId, channel }, '[AiAgentDraft] Draft generation timed out');
      throw draftError(502, STAFF_DRAFT_MESSAGES.failed, STAFF_DRAFT_CODES.timeout);
    }
    await recordAiUsage(organizationId, 'staff_draft');
    return { draft: built.draft, channel, agentName: identity.name, note: built.note, safetyWarning: built.safetyWarning };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.error({ err, organizationId, leadId, channel }, '[AiAgentDraft] Draft generation failed');
    throw draftError(502, STAFF_DRAFT_MESSAGES.failed, STAFF_DRAFT_CODES.failed);
  } finally {
    inFlight.delete(key);
  }
}
