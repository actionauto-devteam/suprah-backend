import mongoose from 'mongoose';
import LeadInquiry, {
  ILeadInquiry,
  LeadInquiryAssociationState,
  LeadInquiryContactAssurance,
  LeadInquiryKind,
  LeadInquiryOutcome,
  LeadInquirySideEffect,
  LeadInquirySideEffectState,
} from '../models/LeadInquiry.model';
import Lead from '../models/lead.model';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';

export const INQUIRY_CONTENT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PROCESSING_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_SIDE_EFFECT_LEASE_MS = 120_000;

export interface InquirySourceIds {
  gmailMessageId?: string;
  gmailThreadId?: string;
  providerInquiryKey?: string;
  smsProviderMessageId?: string;
  callControlId?: string;
  webchatSessionId?: unknown;
  appointmentId?: unknown;
  communicationMessageId?: unknown;
}

export interface RecordInquiryInput {
  organizationId: string;
  kind: LeadInquiryKind;
  receivedAt: Date;
  channel?: string;
  source?: string;
  sourceProvider?: string;
  contact?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    emailExcluded?: boolean;
    assurance?: LeadInquiryContactAssurance;
  };
  vehicle?: { year?: string; make?: string; model?: string; trim?: string; vin?: string; stock?: string };
  subject?: string;
  comments?: string;
  sourceIds?: InquirySourceIds;
  fingerprint?: string | null;
  contentKey?: string | null;
  sideEffects?: Partial<Record<LeadInquirySideEffect, LeadInquirySideEffectState>>;
}

const optionalString = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
};

const optionalObjectId = (value: unknown) =>
  value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : undefined;

function sourceIdsFor(input: InquirySourceIds = {}) {
  const ids: Record<string, unknown> = {
    gmailMessageId: optionalString(input.gmailMessageId),
    gmailThreadId: optionalString(input.gmailThreadId),
    providerInquiryKey: optionalString(input.providerInquiryKey),
    smsProviderMessageId: optionalString(input.smsProviderMessageId),
    callControlId: optionalString(input.callControlId),
    webchatSessionId: optionalObjectId(input.webchatSessionId),
    appointmentId: optionalObjectId(input.appointmentId),
    communicationMessageId: optionalObjectId(input.communicationMessageId),
  };
  return Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined));
}

const UNIQUE_SOURCE_FIELDS = [
  'gmailMessageId',
  'providerInquiryKey',
  'smsProviderMessageId',
  'callControlId',
  'webchatSessionId',
] as const;

export async function findDuplicateInquiry(
  organizationId: string,
  sourceIds: InquirySourceIds = {},
  fingerprint?: string | null,
): Promise<ILeadInquiry | null> {
  const ids = sourceIdsFor(sourceIds);
  const conditions: Record<string, unknown>[] = UNIQUE_SOURCE_FIELDS
    .filter((field) => ids[field] !== undefined)
    .map((field) => ({ [`sourceIds.${field}`]: ids[field] }));
  const strongFingerprint = optionalString(fingerprint);
  if (strongFingerprint) conditions.push({ fingerprint: strongFingerprint });
  if (!conditions.length) return null;
  return LeadInquiry.findOne({ organizationId, $or: conditions });
}

export async function findLegacyLeadSourceDuplicate(
  organizationId: string,
  input: { gmailMessageId?: string | null; ingestionFingerprint?: string | null },
): Promise<{ _id: mongoose.Types.ObjectId } | null> {
  const conditions: Record<string, unknown>[] = [];
  const messageId = optionalString(input.gmailMessageId);
  if (messageId) conditions.push({ messageId });
  const fingerprint = optionalString(input.ingestionFingerprint);
  if (fingerprint) conditions.push({ ingestionFingerprint: fingerprint });
  if (!conditions.length) return null;
  return Lead.findOne({ organizationId, $or: conditions }).select('_id').lean<{ _id: mongoose.Types.ObjectId }>();
}

export async function recordInquiryEvent(input: RecordInquiryInput): Promise<{ event: ILeadInquiry; created: boolean }> {
  if (!input.organizationId || !mongoose.isValidObjectId(input.organizationId)) {
    throw new Error('A valid organization is required to record an inquiry');
  }
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) {
    throw new Error('A valid received time is required to record an inquiry');
  }
  const contact = input.contact || {};
  const sideEffects = Object.fromEntries(
    Object.entries(input.sideEffects || {}).map(([name, state]) => [name, { state }]),
  );
  try {
    const event = await LeadInquiry.create({
      organizationId: input.organizationId,
      kind: input.kind,
      receivedAt: input.receivedAt,
      channel: optionalString(input.channel),
      source: optionalString(input.source),
      sourceProvider: optionalString(input.sourceProvider),
      contact: {
        firstName: optionalString(contact.firstName),
        lastName: optionalString(contact.lastName),
        phone: optionalString(contact.phone),
        email: optionalString(contact.email),
        normalizedPhone: normalizeIdentityPhone(contact.phone),
        normalizedEmail: contact.emailExcluded ? null : normalizeIdentityEmail(contact.email),
        emailExcluded: Boolean(contact.emailExcluded),
        assurance: contact.assurance || 'self_reported',
      },
      vehicle: input.vehicle,
      subject: optionalString(input.subject),
      comments: typeof input.comments === 'string' ? input.comments : undefined,
      sourceIds: sourceIdsFor(input.sourceIds),
      fingerprint: optionalString(input.fingerprint),
      contentKey: optionalString(input.contentKey),
      sideEffects,
    });
    return { event, created: true };
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const existing = await findDuplicateInquiry(input.organizationId, input.sourceIds, input.fingerprint);
    if (!existing) throw err;
    return { event: existing, created: false };
  }
}

export type InquiryIdentityStrength = 'event' | 'transport' | 'none';

const EVENT_IDENTITY_FIELDS = ['providerInquiryKey', 'smsProviderMessageId', 'callControlId', 'webchatSessionId'] as const;

export function resolveInquiryIdentity(sourceIds: InquirySourceIds = {}, fingerprint?: string | null): InquiryIdentityStrength {
  const ids = sourceIdsFor(sourceIds);
  if (optionalString(fingerprint) || EVENT_IDENTITY_FIELDS.some((field) => ids[field] !== undefined)) return 'event';
  if (ids.gmailMessageId !== undefined) return 'transport';
  return 'none';
}

export interface InquiryDuplicateCheckInput {
  organizationId: string;
  eventId?: unknown;
  sourceIds?: InquirySourceIds;
  fingerprint?: string | null;
  contentKey?: string | null;
  legacyIngestionFingerprint?: string | null;
  windowMs?: number;
  now?: Date;
}

export type InquiryDuplicateResult =
  | { duplicate: false; identity: InquiryIdentityStrength }
  | {
      duplicate: true;
      identity: InquiryIdentityStrength;
      kind: 'source_event' | 'legacy_lead' | 'content_window';
      inquiryId?: string;
      leadId?: string;
    };

export async function detectInquiryDuplicate(input: InquiryDuplicateCheckInput): Promise<InquiryDuplicateResult> {
  const identity = resolveInquiryIdentity(input.sourceIds, input.fingerprint);
  const ownId = input.eventId ? String(input.eventId) : '';
  const sameEvent = await findDuplicateInquiry(input.organizationId, input.sourceIds, input.fingerprint);
  if (sameEvent && String(sameEvent._id) !== ownId) {
    return { duplicate: true, identity, kind: 'source_event', inquiryId: String(sameEvent._id) };
  }
  const legacy = await findLegacyLeadSourceDuplicate(input.organizationId, {
    gmailMessageId: input.sourceIds?.gmailMessageId,
    ingestionFingerprint: input.legacyIngestionFingerprint,
  });
  if (legacy) return { duplicate: true, identity, kind: 'legacy_lead', leadId: String(legacy._id) };
  if (identity !== 'event') {
    const recent = await findRecentContentDuplicate(input.organizationId, input.contentKey, {
      excludeId: input.eventId,
      windowMs: input.windowMs,
      now: input.now,
    });
    if (recent) return { duplicate: true, identity, kind: 'content_window', inquiryId: String(recent._id) };
  }
  return { duplicate: false, identity };
}

export async function findRecentContentDuplicate(
  organizationId: string,
  contentKey: string | null | undefined,
  options: { excludeId?: unknown; windowMs?: number; now?: Date } = {},
): Promise<ILeadInquiry | null> {
  const key = optionalString(contentKey);
  if (!key) return null;
  const now = options.now || new Date();
  const since = new Date(now.getTime() - (options.windowMs ?? INQUIRY_CONTENT_WINDOW_MS));
  const filter: Record<string, unknown> = { organizationId, contentKey: key, createdAt: { $gte: since, $lte: now } };
  if (options.excludeId) filter._id = { $ne: options.excludeId };
  return LeadInquiry.findOne(filter).sort({ createdAt: 1 });
}

export async function claimInquiryProcessing(
  eventId: unknown,
  owner: string,
  options: { leaseMs?: number; maxAttempts?: number; now?: Date } = {},
): Promise<ILeadInquiry | null> {
  const now = options.now || new Date();
  return LeadInquiry.findOneAndUpdate(
    {
      _id: eventId,
      'association.state': 'received',
      'processing.attempts': { $lt: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS },
      $or: [
        { 'processing.state': 'pending' },
        {
          'processing.state': 'failed',
          $or: [{ 'processing.nextAttemptAt': null }, { 'processing.nextAttemptAt': { $lte: now } }],
        },
        { 'processing.state': 'processing', 'processing.leaseExpiresAt': { $lte: now } },
      ],
    },
    {
      $set: {
        'processing.state': 'processing',
        'processing.leaseOwner': owner,
        'processing.leaseExpiresAt': new Date(now.getTime() + (options.leaseMs ?? DEFAULT_PROCESSING_LEASE_MS)),
        'processing.lastAttemptAt': now,
      },
      $inc: { 'processing.attempts': 1 },
    },
    { new: true },
  );
}

export interface InquiryAssociationResult {
  state: Extract<LeadInquiryAssociationState, 'associated' | 'pending_review' | 'resolved'>;
  leadId?: unknown;
  outcome?: Extract<LeadInquiryOutcome, 'created_lead' | 'appended' | 'dismissed'>;
  reason: string;
  candidateLeadIds?: unknown[];
  contextLeadId?: unknown;
  duplicateOf?: unknown;
}

export async function completeInquiryAssociation(
  eventId: unknown,
  owner: string,
  result: InquiryAssociationResult,
  options: { now?: Date } = {},
): Promise<ILeadInquiry | null> {
  if (result.state === 'associated' && (!result.leadId || !['created_lead', 'appended'].includes(String(result.outcome)))) {
    throw new Error('An associated inquiry needs a lead and an outcome');
  }
  if (result.state === 'resolved' && result.outcome !== 'dismissed') {
    throw new Error('Automatic resolution only dismisses duplicates');
  }
  const now = options.now || new Date();
  return LeadInquiry.findOneAndUpdate(
    {
      _id: eventId,
      'association.state': 'received',
      'processing.state': 'processing',
      'processing.leaseOwner': owner,
      'processing.leaseExpiresAt': { $gt: now },
    },
    {
      $set: {
        'association.state': result.state,
        'association.leadId': result.state === 'associated' ? optionalObjectId(result.leadId) : null,
        'association.outcome': result.state === 'pending_review' ? null : result.outcome,
        'association.reason': result.reason,
        'association.candidateLeadIds': (result.candidateLeadIds || []).map(optionalObjectId).filter(Boolean),
        'association.contextLeadId': optionalObjectId(result.contextLeadId) || null,
        'association.duplicateOf': optionalObjectId(result.duplicateOf) || null,
        'association.decidedAt': now,
        'processing.state': 'completed',
        'processing.leaseOwner': null,
        'processing.leaseExpiresAt': null,
        'processing.lastError': null,
        'processing.nextAttemptAt': null,
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
}

export async function failInquiryProcessing(
  eventId: unknown,
  owner: string,
  error: unknown,
  options: { retryBaseMs?: number; now?: Date } = {},
): Promise<ILeadInquiry | null> {
  const now = options.now || new Date();
  const current = await LeadInquiry.findOne({ _id: eventId, 'processing.leaseOwner': owner })
    .select('processing.attempts')
    .lean<{ processing?: { attempts?: number } }>();
  if (!current) return null;
  const attempts = Math.max(1, current.processing?.attempts || 1);
  return LeadInquiry.findOneAndUpdate(
    { _id: eventId, 'processing.state': 'processing', 'processing.leaseOwner': owner },
    {
      $set: {
        'processing.state': 'failed',
        'processing.leaseOwner': null,
        'processing.leaseExpiresAt': null,
        'processing.lastError': String((error as any)?.message || error).slice(0, 500),
        'processing.nextAttemptAt': new Date(now.getTime() + (options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * attempts),
      },
    },
    { new: true },
  );
}

export async function findLeadCreatedForInquiry(organizationId: string, eventId: unknown) {
  if (!mongoose.isValidObjectId(eventId)) return null;
  return Lead.findOne({ organizationId, sourceInquiryId: eventId }).select('_id status').lean();
}

export const INTERNAL_IDEMPOTENT_SIDE_EFFECTS: LeadInquirySideEffect[] = ['conversationRecord', 'notification'];

export async function claimInquirySideEffect(
  eventId: unknown,
  name: LeadInquirySideEffect,
  owner: string,
  options: { leaseMs?: number; maxAttempts?: number; now?: Date } = {},
): Promise<ILeadInquiry | null> {
  const now = options.now || new Date();
  const path = `sideEffects.${name}`;
  const claimable: Record<string, unknown>[] = [{ [`${path}.state`]: 'pending' }, { [`${path}.state`]: 'failed' }];
  if (INTERNAL_IDEMPOTENT_SIDE_EFFECTS.includes(name)) {
    claimable.push({ [`${path}.state`]: 'claimed', [`${path}.claimExpiresAt`]: { $lte: now } });
  }
  return LeadInquiry.findOneAndUpdate(
    {
      _id: eventId,
      'association.state': { $in: ['associated', 'resolved'] },
      [`${path}.attempts`]: { $lt: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS },
      $or: claimable,
    },
    {
      $set: {
        [`${path}.state`]: 'claimed',
        [`${path}.claimOwner`]: owner,
        [`${path}.claimedAt`]: now,
        [`${path}.claimExpiresAt`]: new Date(now.getTime() + (options.leaseMs ?? DEFAULT_SIDE_EFFECT_LEASE_MS)),
      },
      $inc: { [`${path}.attempts`]: 1 },
    },
    { new: true },
  );
}

export async function finishInquirySideEffect(
  eventId: unknown,
  name: LeadInquirySideEffect,
  owner: string,
  outcome: {
    state: Extract<LeadInquirySideEffectState, 'done' | 'skipped' | 'failed' | 'unknown'>;
    externalRef?: string;
    error?: unknown;
  },
  options: { now?: Date } = {},
): Promise<ILeadInquiry | null> {
  if (outcome.state === 'unknown' && INTERNAL_IDEMPOTENT_SIDE_EFFECTS.includes(name)) {
    throw new Error('Internal side effects are retried instead of being marked unknown');
  }
  const now = options.now || new Date();
  const path = `sideEffects.${name}`;
  return LeadInquiry.findOneAndUpdate(
    { _id: eventId, [`${path}.state`]: 'claimed', [`${path}.claimOwner`]: owner },
    {
      $set: {
        [`${path}.state`]: outcome.state,
        [`${path}.claimOwner`]: null,
        [`${path}.claimExpiresAt`]: null,
        [`${path}.doneAt`]: outcome.state === 'done' || outcome.state === 'skipped' ? now : null,
        [`${path}.externalRef`]: outcome.externalRef ? String(outcome.externalRef).slice(0, 200) : null,
        [`${path}.lastError`]: outcome.error ? String((outcome.error as any)?.message || outcome.error).slice(0, 500) : null,
      },
    },
    { new: true },
  );
}

export async function markExpiredExternalSideEffectsUnknown(
  eventId: unknown,
  name: LeadInquirySideEffect,
  options: { now?: Date } = {},
): Promise<ILeadInquiry | null> {
  if (INTERNAL_IDEMPOTENT_SIDE_EFFECTS.includes(name)) return null;
  const now = options.now || new Date();
  const path = `sideEffects.${name}`;
  return LeadInquiry.findOneAndUpdate(
    { _id: eventId, [`${path}.state`]: 'claimed', [`${path}.claimExpiresAt`]: { $lte: now } },
    {
      $set: {
        [`${path}.state`]: 'unknown',
        [`${path}.claimOwner`]: null,
        [`${path}.claimExpiresAt`]: null,
        [`${path}.lastError`]: 'Claim expired before the result was recorded; delivery may or may not have happened',
      },
    },
    { new: true },
  );
}
