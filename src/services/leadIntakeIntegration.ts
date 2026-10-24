import { randomUUID } from 'crypto';
import Lead from '../models/lead.model';
import { ParsedADFLead } from '../utils/adfParser';
import { buildInquiryContentKey, buildInquiryFingerprint, buildProviderInquiryKey } from '../utils/inquiryKeys';
import { InquirySourceIds, claimInquirySideEffect, finishInquirySideEffect } from './leadInquiry.service';
import { LeadIntakeRequest, LeadIntakeResult } from './leadIntake.service';
import logger from '../utils/logger';

export function vehicleFromAdf(vehicle: ParsedADFLead['vehicle'] | null | undefined) {
  if (!vehicle) return undefined;
  const pick = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  return {
    year: pick(vehicle.year),
    make: pick(vehicle.make),
    model: pick(vehicle.model),
    trim: pick(vehicle.trim),
    vin: pick(vehicle.vin),
    stock: pick(vehicle.stock),
  };
}

export function adfInquiryRequest(input: {
  organizationId: string;
  adf: ParsedADFLead;
  receivedAt: Date;
  channel: string;
  source: string;
  sourceIds?: InquirySourceIds;
  leadDraft: Record<string, unknown>;
  contextLeadId?: unknown;
}): LeadIntakeRequest {
  const adf = input.adf;
  const provider = adf.provider || adf.vendor || '';
  const vehicle = vehicleFromAdf(adf.vehicle);
  const keyInput = { provider, email: adf.email, phone: adf.phone, vehicle, comments: adf.comments };
  return {
    organizationId: input.organizationId,
    kind: 'provider_inquiry',
    receivedAt: input.receivedAt,
    channel: input.channel,
    source: input.source,
    sourceProvider: provider || undefined,
    contact: { firstName: adf.firstName, lastName: adf.lastName, phone: adf.phone, email: adf.email, assurance: 'self_reported' },
    vehicle,
    comments: adf.comments,
    sourceIds: {
      ...(input.sourceIds || {}),
      providerInquiryKey: buildProviderInquiryKey(adf.providerInquiryIdSource || provider, adf.providerInquiryId) || undefined,
    },
    fingerprint: adf.requestDateProvided ? buildInquiryFingerprint({ ...keyInput, requestDate: adf.requestDate }) : null,
    contentKey: buildInquiryContentKey(keyInput),
    leadDraft: input.leadDraft,
    contextLeadId: input.contextLeadId,
  };
}

export function intakeHandled(result: LeadIntakeResult): boolean {
  return result.status !== 'inactive';
}

export async function startNewLeadAutomations(
  organizationId: string,
  result: LeadIntakeResult,
  options: { email?: boolean } = {},
): Promise<void> {
  if (result.status !== 'associated' || !result.created) return;
  const owner = randomUUID();
  const claim = await claimInquirySideEffect(result.inquiryId, 'alexReply', owner);
  if (!claim) return;
  try {
    const lead: any = await Lead.findOne({ _id: result.leadId, organizationId }).lean();
    if (!lead || lead.intakeIdentity === 'unverified') {
      await finishInquirySideEffect(result.inquiryId, 'alexReply', owner, { state: 'skipped' });
      return;
    }
    const [{ triggerAiReplyForNewInquiry }, { triggerAiEmailReplyForNewInquiry }] = await Promise.all([
      import('./communication.service'),
      import('./aiEmailReply.service'),
    ]);
    triggerAiReplyForNewInquiry(organizationId, lead, lead.phone, lead.comments).catch((err) =>
      logger.warn({ err, leadId: result.leadId }, '[LeadIntake] New-lead text reply failed'));
    if (options.email !== false) {
      triggerAiEmailReplyForNewInquiry(organizationId, lead, lead.comments).catch((err) =>
        logger.warn({ err, leadId: result.leadId }, '[LeadIntake] New-lead email reply failed'));
    }
    await finishInquirySideEffect(result.inquiryId, 'alexReply', owner, { state: 'done' });
  } catch (err) {
    await finishInquirySideEffect(result.inquiryId, 'alexReply', owner, { state: 'failed', error: err }).catch(() => undefined);
    throw err;
  }
}
