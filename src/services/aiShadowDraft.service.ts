import { randomUUID } from 'crypto';
import { AI_AGENT_NAME_REQUIRED_REASON, configuredAiAgentName } from '../utils/aiAgentIdentity';
import Organization from '../models/Organization.model';
import AiAgentDraft, {
  AI_DRAFT_RETENTION_DAYS,
  AiDraftChannel,
  AiDraftSourceModel,
  AiDraftStatus,
} from '../models/AiAgentDraft.model';
import AiUsageCounter from '../models/AiUsageCounter.model';
import { CALENDAR_TZ } from '../constants/calendarTimezone';
import { isAiMasterSwitchOn, modesFromMetadata, AiMode, AiModeSource } from './aiOperatingMode.service';
import logger from '../utils/logger';
import mongoose from 'mongoose';
import { CommunicationMessage, Conversation } from '../models/communication.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { attentionKindOf } from '../models/aiHumanAttention';
import {
  AiAgentTranscriptEntry,
  AppliedAiCoachingRule,
  generateAlexReply,
  generateAlexEmailReply,
  classifyAlexReplySafety,
  classifyAlexEmailReplySafety,
  selectRelevantAiCoaching,
  checkAiCoachingCompliance,
  checkReplyCaps,
} from './aiAgent.service';
import { getRelevantAiCoaching } from './aiAgentCoaching.service';
import {
  VehicleContextResult,
  resolveVehicleContextForReply,
  resolvePinnedVehicleContext,
  buildVehicleContextNote,
  buildClarifyingQuestion,
  lastAiMessageWasClarifyingQuestion,
} from './vehicleInquiryContext.service';
import { buildSmsTranscriptUntil, buildWebchatTranscriptUntil, resolveCurrentVehicleAndPrice } from './aiReplyContext.service';
import {
  AiCallObserver,
  AiCallBudgetExceededError,
  runWithAiCallObserver,
  validateOutboundMessage,
  validateOutboundEmailMessage,
} from '../utils/aiOutboundSafety';

export const SHADOW_DRAFT_DAILY_LIMIT = 100;
export const SHADOW_DRAFT_LEASE_MS = 10 * 60 * 1000;
export const SHADOW_DRAFT_FALLBACK_TIMEZONE = CALENDAR_TZ;
export const SHADOW_DRAFT_VIEW_ROLES = new Set(['manager', 'admin', 'super_admin']);

export type ShadowIneligibleReason =
  | 'global_flag_off'
  | 'ai_master_off'
  | 'org_not_found'
  | 'org_flag_off'
  | 'mode_not_training'
  | 'agent_name_missing';

export interface ShadowEligibility {
  eligible: boolean;
  reason?: ShadowIneligibleReason;
  mode: AiMode;
  source: AiModeSource;
  timezone: string;
}

export interface ShadowDraftSource {
  organizationId: any;
  channel: AiDraftChannel;
  sourceMessageId: string;
  sourceMessageModel: AiDraftSourceModel;
  leadId?: any;
  conversationId?: any;
  sessionId?: any;
  inquiryReceivedAt?: Date;
}

export type ShadowClaimResult =
  | { outcome: 'claimed'; draftId: string; leaseId: string; timezone: string }
  | { outcome: 'duplicate'; draftId?: string }
  | { outcome: 'ineligible'; reason: ShadowIneligibleReason };

export type ShadowStartResult =
  | { started: true; usageDay: string; reservedCount: number }
  | { started: false; status: AiDraftStatus | 'lost_lease'; reason: string };

export interface ShadowDraftResult {
  status: 'ready' | 'blocked_safety' | 'needs_human';
  draftText?: string;
  kind?: 'reply' | 'vehicle_clarification';
  handoffReason?: string;
  deterministicOk?: boolean;
  deterministicReasons?: string[];
  classifierVerdict?: 'SAFE' | 'UNSAFE' | 'ERROR';
  vehicleResolution?: string;
  coachingRuleIds?: string[];
  coachingVerdict?: 'compliant' | 'violates' | 'not_applicable' | 'error' | 'not_checked';
  wouldHaveBeenCapped?: boolean;
  aiModel?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  aiCallCount?: number;
}

export function isShadowDraftsGloballyEnabled(): boolean {
  return process.env.AI_SHADOW_DRAFTS_ENABLED === 'true';
}

export function canViewShadowDrafts(role: unknown): boolean {
  return SHADOW_DRAFT_VIEW_ROLES.has(String(role || ''));
}

export function resolveOrgTimezone(metadata: any): string {
  const candidate = String(metadata?.timezone || '').trim();
  if (!candidate) return SHADOW_DRAFT_FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return SHADOW_DRAFT_FALLBACK_TIMEZONE;
  }
}

export function shadowDraftUsageDay(timezone: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function eligibilityFromMetadata(metadata: any, channel: AiDraftChannel, found = true): ShadowEligibility {
  const timezone = resolveOrgTimezone(metadata);
  const modes = modesFromMetadata(metadata || {}, isAiMasterSwitchOn());
  const base = { mode: modes[channel], source: modes.source, timezone };
  if (!isShadowDraftsGloballyEnabled()) return { eligible: false, reason: 'global_flag_off', ...base };
  if (!isAiMasterSwitchOn()) return { eligible: false, reason: 'ai_master_off', ...base };
  if (!found) return { eligible: false, reason: 'org_not_found', ...base };
  if (metadata?.aiShadowDraftsEnabled !== true) return { eligible: false, reason: 'org_flag_off', ...base };
  if (modes.source !== 'configured' || modes[channel] !== 'training') return { eligible: false, reason: 'mode_not_training', ...base };
  if (!configuredAiAgentName(metadata)) return { eligible: false, reason: 'agent_name_missing', ...base };
  return { eligible: true, ...base };
}

export async function resolveShadowDraftEligibility(organizationId: any, channel: AiDraftChannel): Promise<ShadowEligibility> {
  if (!isShadowDraftsGloballyEnabled()) return eligibilityFromMetadata({}, channel);
  if (!isAiMasterSwitchOn()) return eligibilityFromMetadata({}, channel);
  try {
    const org: any = await Organization.findById(organizationId).select('metadata').lean();
    return eligibilityFromMetadata(org?.metadata || {}, channel, Boolean(org));
  } catch (err) {
    logger.error({ err, organizationId: String(organizationId) }, '[AiShadowDraft] Could not resolve eligibility, failing closed');
    return { eligible: false, reason: 'org_not_found', mode: 'off', source: 'disabled', timezone: SHADOW_DRAFT_FALLBACK_TIMEZONE };
  }
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || err?.code === 11001 || /E11000/.test(String(err?.message || ''));
}

function draftBase(source: ShadowDraftSource) {
  return {
    organizationId: String(source.organizationId),
    channel: source.channel,
    sourceMessageId: String(source.sourceMessageId),
    sourceMessageModel: source.sourceMessageModel,
    leadId: source.leadId || undefined,
    conversationId: source.conversationId || undefined,
    sessionId: source.sessionId || undefined,
    inquiryReceivedAt: source.inquiryReceivedAt || undefined,
    expiresAt: new Date(Date.now() + AI_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };
}

async function existingDraftId(source: ShadowDraftSource): Promise<string | undefined> {
  const existing: any = await AiAgentDraft.findOne({
    organizationId: String(source.organizationId),
    channel: source.channel,
    sourceMessageId: String(source.sourceMessageId),
  }).select('_id').lean();
  return existing ? String(existing._id) : undefined;
}

export async function claimShadowDraft(source: ShadowDraftSource): Promise<ShadowClaimResult> {
  if (!source.sourceMessageId) throw new Error('A source message id is required to claim a shadow draft');
  const eligibility = await resolveShadowDraftEligibility(source.organizationId, source.channel);
  if (!eligibility.eligible) return { outcome: 'ineligible', reason: eligibility.reason! };

  const leaseId = randomUUID();
  try {
    const draft = await AiAgentDraft.create({
      ...draftBase(source),
      status: 'claimed',
      modeAtClaim: eligibility.mode,
      leaseId,
      leaseExpiresAt: new Date(Date.now() + SHADOW_DRAFT_LEASE_MS),
    });
    return { outcome: 'claimed', draftId: String(draft._id), leaseId, timezone: eligibility.timezone };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { outcome: 'duplicate', draftId: await existingDraftId(source) };
    throw err;
  }
}

export async function recordShadowAttentionSkip(
  source: ShadowDraftSource,
  reason: string,
  status: 'skipped_attention' | 'skipped_technical' = 'skipped_attention',
): Promise<ShadowClaimResult | { outcome: 'recorded'; draftId: string }> {
  if (!source.sourceMessageId) throw new Error('A source message id is required to record a shadow skip');
  const eligibility = await resolveShadowDraftEligibility(source.organizationId, source.channel);
  if (!eligibility.eligible) return { outcome: 'ineligible', reason: eligibility.reason! };
  try {
    const draft = await AiAgentDraft.create({
      ...draftBase(source),
      status,
      statusReason: String(reason || 'Customer needs a person').slice(0, 500),
      modeAtClaim: eligibility.mode,
      completedAt: new Date(),
    });
    return { outcome: 'recorded', draftId: String(draft._id) };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { outcome: 'duplicate', draftId: await existingDraftId(source) };
    throw err;
  }
}

export async function reserveShadowGenerationSlot(
  organizationId: any,
  timezone: string = SHADOW_DRAFT_FALLBACK_TIMEZONE,
  limit: number = SHADOW_DRAFT_DAILY_LIMIT,
  now: Date = new Date(),
): Promise<{ reserved: boolean; count: number; day: string }> {
  const day = shadowDraftUsageDay(timezone, now);
  const filter = { organizationId: String(organizationId), day, kind: 'shadow_draft' as const };
  const increment = async () => AiUsageCounter.findOneAndUpdate(
    { ...filter, count: { $lt: limit } },
    { $inc: { count: 1 } },
    { new: true },
  ).lean();

  const first: any = await increment();
  if (first) return { reserved: true, count: first.count, day };

  try {
    await AiUsageCounter.create({ ...filter, count: 1 });
    return { reserved: true, count: 1, day };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  const retried: any = await increment();
  if (retried) return { reserved: true, count: retried.count, day };
  const current: any = await AiUsageCounter.findOne(filter).select('count').lean();
  return { reserved: false, count: current?.count ?? limit, day };
}

export async function getShadowDraftUsageToday(organizationId: any, timezone: string = SHADOW_DRAFT_FALLBACK_TIMEZONE): Promise<number> {
  const row: any = await AiUsageCounter.findOne({
    organizationId: String(organizationId),
    day: shadowDraftUsageDay(timezone),
    kind: 'shadow_draft',
  }).select('count').lean();
  return row?.count || 0;
}

async function finishDraft(
  organizationId: any,
  draftId: string,
  leaseId: string,
  fromStatus: AiDraftStatus,
  set: Record<string, unknown>,
): Promise<boolean> {
  const result = await AiAgentDraft.updateOne(
    { _id: draftId, organizationId: String(organizationId), leaseId, status: fromStatus },
    { $set: { ...set, completedAt: new Date() }, $unset: { leaseId: '', leaseExpiresAt: '' } },
  );
  return result.modifiedCount === 1;
}

export async function beginShadowGeneration(input: {
  organizationId: any;
  draftId: string;
  leaseId: string;
  channel: AiDraftChannel;
}): Promise<ShadowStartResult> {
  const eligibility = await resolveShadowDraftEligibility(input.organizationId, input.channel);
  if (!eligibility.eligible) {
    await finishDraft(input.organizationId, input.draftId, input.leaseId, 'claimed', {
      status: 'failed',
      failureReason: `No longer eligible before generation: ${eligibility.reason}`,
    });
    return { started: false, status: 'failed', reason: eligibility.reason! };
  }

  const now = new Date();
  const moved = await AiAgentDraft.findOneAndUpdate(
    { _id: input.draftId, organizationId: String(input.organizationId), leaseId: input.leaseId, status: 'claimed' },
    {
      $set: { status: 'generating', generationStartedAt: now, leaseExpiresAt: new Date(now.getTime() + SHADOW_DRAFT_LEASE_MS) },
      $inc: { attemptCount: 1 },
    },
    { new: true },
  ).lean();
  if (!moved) return { started: false, status: 'lost_lease', reason: 'Draft is no longer claimed by this worker' };

  const slot = await reserveShadowGenerationSlot(input.organizationId, eligibility.timezone);
  if (!slot.reserved) {
    await finishDraft(input.organizationId, input.draftId, input.leaseId, 'generating', {
      status: 'skipped_cap',
      statusReason: `Daily limit of ${SHADOW_DRAFT_DAILY_LIMIT} shadow drafts reached`,
      usageDay: slot.day,
    });
    return { started: false, status: 'skipped_cap', reason: 'daily_limit_reached' };
  }

  await AiAgentDraft.updateOne(
    { _id: input.draftId, organizationId: String(input.organizationId), leaseId: input.leaseId, status: 'generating' },
    { $set: { usageDay: slot.day } },
  );
  return { started: true, usageDay: slot.day, reservedCount: slot.count };
}

export async function completeShadowDraft(input: {
  organizationId: any;
  draftId: string;
  leaseId: string;
  channel: AiDraftChannel;
  result: ShadowDraftResult;
}): Promise<{ saved: boolean; status: AiDraftStatus | 'lost_lease' }> {
  const eligibility = await resolveShadowDraftEligibility(input.organizationId, input.channel);
  if (!eligibility.eligible) {
    const saved = await finishDraft(input.organizationId, input.draftId, input.leaseId, 'generating', {
      status: 'failed',
      failureReason: `Discarded: no longer eligible after generation (${eligibility.reason})`,
    });
    return { saved, status: saved ? 'failed' : 'lost_lease' };
  }
  const { status, ...fields } = input.result;
  const saved = await finishDraft(input.organizationId, input.draftId, input.leaseId, 'generating', { status, ...fields });
  return { saved, status: saved ? status : 'lost_lease' };
}

export async function failShadowDraft(input: {
  organizationId: any;
  draftId: string;
  leaseId: string;
  reason: string;
}): Promise<boolean> {
  const reason = String(input.reason || 'Generation failed').slice(0, 500);
  for (const fromStatus of ['generating', 'claimed'] as const) {
    if (await finishDraft(input.organizationId, input.draftId, input.leaseId, fromStatus, { status: 'failed', failureReason: reason })) {
      return true;
    }
  }
  return false;
}

export async function recoverStaleShadowDrafts(organizationId: any, now: Date = new Date()): Promise<{ abandonedClaims: number; abandonedGenerations: number }> {
  const orgId = String(organizationId);
  const [claims, generations] = await Promise.all([
    AiAgentDraft.updateMany(
      { organizationId: orgId, status: 'claimed', leaseExpiresAt: { $lt: now } },
      { $set: { status: 'failed', failureReason: 'Abandoned before generation started', completedAt: now }, $unset: { leaseId: '', leaseExpiresAt: '' } },
    ),
    AiAgentDraft.updateMany(
      { organizationId: orgId, status: 'generating', leaseExpiresAt: { $lt: now } },
      { $set: { status: 'failed', failureReason: 'Abandoned during generation (worker stopped or timed out)', completedAt: now }, $unset: { leaseId: '', leaseExpiresAt: '' } },
    ),
  ]);
  return { abandonedClaims: claims.modifiedCount || 0, abandonedGenerations: generations.modifiedCount || 0 };
}

export const SHADOW_MAX_AI_CALLS = 6;
export const SHADOW_PER_CALL_TIMEOUT_MS = 12_000;
export const SHADOW_DEADLINE_MS = 45_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface ShadowGenerationInput extends ShadowDraftSource {
  lead?: any;
  phone?: string;
  customerFirstName?: string;
  isNewInquiry?: boolean;
  inquiryText?: string;
}

export type ShadowGenerationOutcome =
  | { outcome: 'completed'; draftId: string; status: AiDraftStatus | 'lost_lease' }
  | { outcome: 'not_started'; draftId: string; status: AiDraftStatus | 'lost_lease'; reason: string }
  | { outcome: 'failed'; draftId: string; status: 'failed' | 'lost_lease'; reason: string }
  | { outcome: 'duplicate'; draftId?: string }
  | { outcome: 'ineligible'; reason: ShadowIneligibleReason };

class ShadowGenerationError extends Error {}

function summarizeAiCalls(observer: AiCallObserver, latencyMs: number) {
  const generation = [...observer.calls].reverse().find((call) => call.phase === 'generation' && call.ok);
  const withUsage = observer.calls.filter((call) => typeof call.totalTokens === 'number' || typeof call.promptTokens === 'number');
  const sum = (key: 'promptTokens' | 'completionTokens' | 'totalTokens') =>
    withUsage.length ? withUsage.reduce((total, call) => total + (call[key] || 0), 0) : undefined;
  return {
    aiModel: generation?.model || undefined,
    latencyMs,
    aiCallCount: observer.calls.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    totalTokens: sum('totalTokens'),
  };
}

async function countAiRepliesToday(input: ShadowGenerationInput): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (input.channel === 'sms' && input.conversationId) {
    return CommunicationMessage.countDocuments({ conversationId: input.conversationId, direction: 'outbound', 'sentBy.userId': 'ai-agent', createdAt: { $gte: since } });
  }
  if (input.channel === 'webchat' && input.sessionId) {
    return WebChatMessage.countDocuments({ sessionId: input.sessionId, 'sentBy.userId': 'ai-agent', aiDispatchPending: { $ne: true }, createdAt: { $gte: since } });
  }
  return 0;
}

async function loadShadowLead(input: ShadowGenerationInput): Promise<any | null> {
  if (!input.leadId) return null;
  return mongoose.model('Lead')
    .findOne({ _id: input.leadId, organizationId: input.organizationId })
    .select('organizationId firstName lastName phone email vehicle status assignedTo')
    .lean();
}

async function buildShadowResult(input: ShadowGenerationInput, observer: AiCallObserver): Promise<ShadowDraftResult> {
  const org: any = await Organization.findById(input.organizationId).select('name metadata').lean();
  const agentName = configuredAiAgentName(org?.metadata);
  if (!agentName) throw new ShadowGenerationError(AI_AGENT_NAME_REQUIRED_REASON);
  const dealerName = org?.name || 'Your Dealership';
  const lead = input.lead || (await loadShadowLead(input)) || {};

  let transcript: AiAgentTranscriptEntry[];
  let vehicleContext: VehicleContextResult | null = null;
  let priceContext: Awaited<ReturnType<typeof resolveCurrentVehicleAndPrice>> = null;
  if (input.channel === 'sms') {
    transcript = input.conversationId ? await buildSmsTranscriptUntil(input.conversationId, input.sourceMessageId) : [];
    vehicleContext = await resolveVehicleContextForReply({
      organizationId: input.organizationId,
      phone: input.phone || lead.phone || '',
      triggerLead: lead,
      isNewInquiry: input.isNewInquiry,
      transcript,
    });
  } else if (input.channel === 'webchat') {
    transcript = input.sessionId ? await buildWebchatTranscriptUntil(input.sessionId, input.sourceMessageId) : [];
  } else {
    const inquiry = String(input.inquiryText || '').trim();
    if (!inquiry) throw new ShadowGenerationError('No inquiry text was provided for the email draft');
    transcript = [{ from: 'customer', body: inquiry }];
    [priceContext, vehicleContext] = await Promise.all([
      resolveCurrentVehicleAndPrice(lead),
      resolvePinnedVehicleContext({ organizationId: input.organizationId, lead, email: lead.email }),
    ]);
  }

  const replyLead = vehicleContext?.lead || lead;
  const customerFirstName = input.customerFirstName || replyLead.firstName || lead.firstName || undefined;
  const leadVehicleInterest = replyLead.vehicle
    ? [replyLead.vehicle.year, replyLead.vehicle.make, replyLead.vehicle.model].filter(Boolean).join(' ') || undefined
    : undefined;
  const isFirstReply = !transcript.some((entry) => entry.from === 'ai');
  const vehicleResolution = vehicleContext?.resolution;
  const caps = input.channel === 'email'
    ? { capped: false }
    : checkReplyCaps({ transcript, repliesSentToday: await countAiRepliesToday(input) });
  const base: Partial<ShadowDraftResult> = { vehicleResolution, wouldHaveBeenCapped: caps.capped };

  if (input.channel === 'sms' && vehicleContext?.resolution === 'ambiguous') {
    if (lastAiMessageWasClarifyingQuestion(transcript)) {
      return { ...base, status: 'needs_human', kind: 'vehicle_clarification', handoffReason: 'Customer has more than one vehicle inquiry and it is still unclear which vehicle they mean' };
    }
    const question = buildClarifyingQuestion({ candidates: vehicleContext.ambiguousCandidates, customerFirstName, agentName, dealerName, isFirstReply });
    if (!question) {
      return { ...base, status: 'needs_human', kind: 'vehicle_clarification', handoffReason: 'Customer has more than one vehicle inquiry and the vehicle could not be confirmed' };
    }
    const deterministic = validateOutboundMessage(question);
    return {
      ...base,
      status: deterministic.ok ? 'ready' : 'blocked_safety',
      kind: 'vehicle_clarification',
      draftText: question,
      deterministicOk: deterministic.ok,
      deterministicReasons: deterministic.reasons,
    };
  }

  let appliedRules: AppliedAiCoachingRule[] = [];
  let coachingVerdict: ShadowDraftResult['coachingVerdict'] = 'not_applicable';
  if (input.channel !== 'email') {
    const coaching = await getRelevantAiCoaching({ organizationId: String(input.organizationId), channel: input.channel });
    if (coaching.rules.length) {
      observer.phase = 'coaching_selection';
      const selection = await selectRelevantAiCoaching({
        rules: coaching.rules, agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, channel: input.channel,
      });
      if (selection.status === 'error') {
        return {
          ...base,
          status: 'needs_human',
          coachingVerdict: 'error',
          handoffReason: `Coaching rules could not be checked, so live ${agentName} would have sent a safe fallback instead`,
        };
      }
      appliedRules = selection.appliedRules;
      coachingVerdict = appliedRules.length ? 'not_checked' : 'not_applicable';
    }
  }

  observer.phase = 'generation';
  const vehicleContextNote = vehicleContext ? buildVehicleContextNote(vehicleContext) : undefined;
  const generation = input.channel === 'email'
    ? await generateAlexEmailReply({
        agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, isFirstReply,
        confirmedPrice: priceContext?.price, confirmedPreviousPrice: priceContext?.previousPrice,
        phone: input.phone || lead.phone, vehicleContextNote,
      })
    : await generateAlexReply({
        agentName, dealerName, customerFirstName, leadVehicleInterest, transcript, channel: input.channel, isFirstReply,
        coachingNotes: appliedRules.map((rule) => rule.instruction), phone: input.phone || lead.phone, vehicleContextNote,
      });

  const coachingRuleIds = appliedRules.map((rule) => rule.id);
  if (!generation.text) {
    if (generation.handoffReason) {
      return { ...base, status: 'needs_human', kind: 'reply', handoffReason: generation.handoffReason, coachingRuleIds, coachingVerdict };
    }
    throw new ShadowGenerationError(generation.error || 'The draft could not be generated');
  }
  const draftText = generation.text;

  if (appliedRules.length) {
    observer.phase = 'coaching_compliance';
    const compliance = await checkAiCoachingCompliance({ appliedRules, agentName, customerFirstName, transcript, candidateReply: draftText });
    coachingVerdict = compliance.verdict;
  }

  const deterministic = input.channel === 'email'
    ? validateOutboundEmailMessage(draftText, [priceContext?.price, priceContext?.previousPrice].filter((value): value is number => typeof value === 'number'))
    : validateOutboundMessage(draftText);

  let classifierVerdict: ShadowDraftResult['classifierVerdict'];
  if (deterministic.ok) {
    observer.phase = 'safety_classifier';
    classifierVerdict = input.channel === 'email'
      ? await classifyAlexEmailReplySafety(draftText, input.phone || lead.phone)
      : await classifyAlexReplySafety(draftText, input.phone || lead.phone, observer.perCallTimeoutMs);
  }

  const safe = deterministic.ok && classifierVerdict === 'SAFE';
  return {
    ...base,
    status: !safe ? 'blocked_safety' : generation.handoffReason ? 'needs_human' : 'ready',
    kind: 'reply',
    draftText,
    handoffReason: generation.handoffReason,
    deterministicOk: deterministic.ok,
    deterministicReasons: deterministic.reasons,
    classifierVerdict,
    coachingRuleIds,
    coachingVerdict,
  };
}

export async function generateShadowDraft(input: ShadowGenerationInput): Promise<ShadowGenerationOutcome> {
  await recoverStaleShadowDrafts(input.organizationId).catch((err) => {
    logger.warn({ err, organizationId: String(input.organizationId) }, '[AiShadowDraft] Stale draft recovery failed');
  });

  const claim = await claimShadowDraft(input);
  if (claim.outcome === 'ineligible') return claim;
  if (claim.outcome === 'duplicate') return claim;
  const { draftId, leaseId } = claim;

  const start = await beginShadowGeneration({ organizationId: input.organizationId, draftId, leaseId, channel: input.channel });
  if (!start.started) return { outcome: 'not_started', draftId, status: start.status, reason: start.reason };

  const controller = new AbortController();
  const deadlineMs = positiveIntFromEnv('AI_SHADOW_DRAFT_DEADLINE_MS', SHADOW_DEADLINE_MS);
  const deadline = setTimeout(() => controller.abort(new Error('Shadow draft generation exceeded its time limit')), deadlineMs);
  const observer: AiCallObserver = {
    signal: controller.signal,
    perCallTimeoutMs: positiveIntFromEnv('AI_SHADOW_DRAFT_CALL_TIMEOUT_MS', SHADOW_PER_CALL_TIMEOUT_MS),
    maxCalls: positiveIntFromEnv('AI_SHADOW_DRAFT_MAX_AI_CALLS', SHADOW_MAX_AI_CALLS),
    phase: 'setup',
    calls: [],
  };
  const startedAt = Date.now();
  const logContext = { organizationId: String(input.organizationId), draftId, channel: input.channel };

  try {
    const result = await runWithAiCallObserver(observer, () => buildShadowResult(input, observer));
    if (controller.signal.aborted) throw new ShadowGenerationError('Generation timed out and was cancelled');
    if (observer.budgetExhausted) throw new AiCallBudgetExceededError();
    const saved = await completeShadowDraft({
      organizationId: input.organizationId,
      draftId,
      leaseId,
      channel: input.channel,
      result: { ...result, ...summarizeAiCalls(observer, Date.now() - startedAt) },
    });
    logger.info({ ...logContext, status: saved.status, aiCallCount: observer.calls.length }, '[AiShadowDraft] Shadow draft finished');
    return { outcome: 'completed', draftId, status: saved.status };
  } catch (err) {
    const reason = controller.signal.aborted
      ? 'Generation timed out and was cancelled'
      : observer.budgetExhausted || err instanceof AiCallBudgetExceededError
        ? 'AI call budget for this draft was exceeded'
        : err instanceof ShadowGenerationError
          ? err.message
          : 'Generation failed unexpectedly';
    const failed = await failShadowDraft({ organizationId: input.organizationId, draftId, leaseId, reason }).catch(() => false);
    logger.warn({ ...logContext, reason, errorName: (err as any)?.name }, '[AiShadowDraft] Shadow draft failed');
    return { outcome: 'failed', draftId, status: failed ? 'failed' : 'lost_lease', reason };
  } finally {
    clearTimeout(deadline);
    if (!controller.signal.aborted) controller.abort(new Error('Shadow draft generation finished'));
  }
}

function logQueueFailure(source: ShadowDraftSource, err: any): void {
  logger.warn(
    { organizationId: String(source.organizationId), channel: source.channel, errorName: err?.name },
    '[AiShadowDraft] Shadow draft could not run',
  );
}

export function queueShadowDraft(input: ShadowGenerationInput): Promise<void> {
  if (!isShadowDraftsGloballyEnabled()) return Promise.resolve();
  return Promise.resolve()
    .then(() => generateShadowDraft(input))
    .then(() => undefined, (err) => logQueueFailure(input, err));
}

async function activeHumanAttention(source: ShadowDraftSource): Promise<{ reason?: string; kind?: string } | null> {
  const orgId = String(source.organizationId);
  let state: any = null;
  if (source.channel === 'sms' && source.conversationId) {
    const orgIds = mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
    state = await Conversation.findOne({ _id: source.conversationId, orgId: { $in: orgIds } }).select('aiHumanAttention').lean();
  } else if (source.channel === 'webchat' && source.sessionId) {
    state = await WebChatSession.findOne({ _id: source.sessionId, organizationId: orgId }).select('aiHumanAttention').lean();
  } else if (source.channel === 'email' && source.leadId) {
    state = await mongoose.model('Lead').findOne({ _id: source.leadId, organizationId: source.organizationId }).select('aiHumanAttention').lean();
  }
  return state?.aiHumanAttention || null;
}

export function queueShadowAttentionSkip(source: ShadowDraftSource): Promise<void> {
  if (!isShadowDraftsGloballyEnabled()) return Promise.resolve();
  return Promise.resolve()
    .then(async () => {
      const attention = await activeHumanAttention(source);
      if (!attention) return;
      const technical = attentionKindOf(attention) === 'technical';
      await recordShadowAttentionSkip(
        source,
        attention.reason || (technical ? 'Safety check unavailable' : 'Customer needs a person'),
        technical ? 'skipped_technical' : 'skipped_attention',
      );
    })
    .then(() => undefined, (err) => logQueueFailure(source, err));
}
