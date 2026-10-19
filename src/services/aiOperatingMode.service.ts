import mongoose from 'mongoose';
import Organization from '../models/Organization.model';
import AiUsageCounter, { AiUsageKind } from '../models/AiUsageCounter.model';
import { isDemoPhone } from '../utils/demoPhone';
import { isGenuineDemoLead } from '../constants/leadSource';
import { CALENDAR_TZ } from '../constants/calendarTimezone';
import { AiReplySuppressedError } from '../utils/aiReplySuppressed';
import logger from '../utils/logger';

export const AI_CHANNELS = ['sms', 'email', 'webchat'] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];

export const AI_MODES = ['off', 'training', 'testing', 'live'] as const;
export type AiMode = (typeof AI_MODES)[number];

export type AiModeSource = 'configured' | 'legacy' | 'disabled';

export type AiWorkflow =
  | 'sms_reply'
  | 'webchat_reply'
  | 'email_reply'
  | 'sms_followup'
  | 'vehicle_reengagement'
  | 'reengagement_send_anyway'
  | 'reschedule_notice';

export interface AiChannelModes {
  sms: AiMode;
  email: AiMode;
  webchat: AiMode;
  source: AiModeSource;
}

export interface AiDeliveryDecision {
  action: 'send' | 'skip';
  mode: AiMode;
  source: AiModeSource;
  simulated?: boolean;
  reason?: string;
}

export const AI_NOT_LIVE_REASON = 'Suprah AI is not live for this channel';

export function isAiMode(value: unknown): value is AiMode {
  return typeof value === 'string' && (AI_MODES as readonly string[]).includes(value);
}

export function isAiMasterSwitchOn(): boolean {
  return process.env.AI_AGENT_ENABLED === 'true';
}

export function hasConfiguredAiModes(metadata: any): boolean {
  const configured = metadata?.aiAgentModes;
  return Boolean(configured) && typeof configured === 'object' && !Array.isArray(configured);
}

export function modesFromMetadata(metadata: any, masterOn: boolean = isAiMasterSwitchOn()): AiChannelModes {
  if (!masterOn) return { sms: 'off', email: 'off', webchat: 'off', source: 'disabled' };
  if (hasConfiguredAiModes(metadata)) {
    const configured = metadata.aiAgentModes;
    return {
      sms: isAiMode(configured.sms) ? configured.sms : 'off',
      email: isAiMode(configured.email) ? configured.email : 'off',
      webchat: isAiMode(configured.webchat) ? configured.webchat : 'off',
      source: 'configured',
    };
  }
  const legacy: AiMode = metadata?.aiAgentEnabled === true ? 'live' : 'off';
  return { sms: legacy, email: legacy, webchat: legacy, source: 'legacy' };
}

export function storedModesFromMetadata(metadata: any): Omit<AiChannelModes, 'source'> & { source: 'configured' | 'legacy' } {
  const resolved = modesFromMetadata(metadata, true);
  return { sms: resolved.sms, email: resolved.email, webchat: resolved.webchat, source: resolved.source === 'configured' ? 'configured' : 'legacy' };
}

export function anyChannelLive(modes: Pick<AiChannelModes, AiChannel>): boolean {
  return AI_CHANNELS.some((channel) => modes[channel] === 'live');
}

export async function resolveAiChannelModes(organizationId: any): Promise<AiChannelModes> {
  if (!isAiMasterSwitchOn()) return modesFromMetadata({}, false);
  try {
    const org = await Organization.findById(organizationId).select('metadata').lean();
    return modesFromMetadata((org as any)?.metadata || {}, true);
  } catch (err) {
    logger.error({ err, organizationId: String(organizationId) }, '[AiOperatingMode] Could not resolve AI modes, failing closed');
    return { sms: 'off', email: 'off', webchat: 'off', source: 'disabled' };
  }
}

export async function resolveAiChannelMode(
  organizationId: any,
  channel: AiChannel,
): Promise<{ mode: AiMode; source: AiModeSource }> {
  const modes = await resolveAiChannelModes(organizationId);
  return { mode: modes[channel], source: modes.source };
}

function lastTenDigits(phone: string): string {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

export function isAttentionScreeningMode(mode: AiMode): boolean {
  return mode !== 'off';
}

async function isSimulatedDemoRecipient(organizationId: any, toPhone?: string, leadId?: any): Promise<boolean> {
  if (process.env.DEMO_LAB_ENABLED !== 'true') return false;
  if (!toPhone || !isDemoPhone(toPhone) || !leadId) return false;
  try {
    const lead: any = await mongoose.model('Lead').findOne({ _id: leadId, organizationId }).select('source phone').lean();
    if (!lead) return false;
    const leadPhone = String(lead.phone || '');
    if (!isGenuineDemoLead(lead.source, leadPhone)) return false;
    return lastTenDigits(leadPhone) === lastTenDigits(toPhone);
  } catch {
    return false;
  }
}

export async function decideAiDelivery(input: {
  organizationId: any;
  channel: AiChannel;
  workflow: AiWorkflow;
  toPhone?: string;
  leadId?: any;
}): Promise<AiDeliveryDecision> {
  const { mode, source } = await resolveAiChannelMode(input.organizationId, input.channel);
  if (mode === 'live') return { action: 'send', mode, source };
  if (
    (mode === 'training' || mode === 'testing') &&
    input.channel === 'sms' &&
    input.workflow !== 'reengagement_send_anyway' &&
    (await isSimulatedDemoRecipient(input.organizationId, input.toPhone, input.leadId))
  ) {
    return { action: 'send', mode, source, simulated: true };
  }
  return { action: 'skip', mode, source, reason: `${AI_NOT_LIVE_REASON} (${input.channel}: ${mode})` };
}

export async function assertAiDispatchAllowed(input: {
  organizationId: any;
  channel: AiChannel;
  workflow: AiWorkflow;
  toPhone?: string;
  leadId?: any;
}): Promise<AiDeliveryDecision> {
  const decision = await decideAiDelivery(input);
  if (decision.action !== 'send') {
    logger.info(
      { organizationId: String(input.organizationId), channel: input.channel, workflow: input.workflow, mode: decision.mode },
      '[AiOperatingMode] AI message suppressed at dispatch',
    );
    throw new AiReplySuppressedError();
  }
  return decision;
}

export function aiUsageDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CALENDAR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export async function recordAiUsage(organizationId: any, kind: AiUsageKind): Promise<void> {
  try {
    await AiUsageCounter.updateOne(
      { organizationId: String(organizationId), day: aiUsageDay(), kind },
      { $inc: { count: 1 }, $setOnInsert: { organizationId: String(organizationId), day: aiUsageDay(), kind } },
      { upsert: true },
    );
  } catch (err) {
    logger.warn({ err, organizationId: String(organizationId), kind }, '[AiOperatingMode] Could not record AI usage');
  }
}

export async function getAiUsageToday(organizationId: any): Promise<Record<string, number>> {
  const rows = await AiUsageCounter.find({ organizationId: String(organizationId), day: aiUsageDay() }).select('kind count').lean();
  const usage: Record<string, number> = {};
  for (const row of rows as any[]) usage[row.kind] = row.count || 0;
  return usage;
}
