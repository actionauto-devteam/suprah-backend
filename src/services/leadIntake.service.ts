import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import Lead from '../models/lead.model';
import LeadInquiry, { ILeadInquiry } from '../models/LeadInquiry.model';
import LeadIntakeControl from '../models/LeadIntakeControl.model';
import LeadIntakeAudit from '../models/LeadIntakeAudit.model';
import { LIFECYCLE_TERMINAL_STATUSES, NOT_A_LEAD_STATUS, isContactRestrictedStatus } from '../constants/leadStatus';
import { CLOSED_LEAD_COPY_WINDOW_MS, SAME_REQUEST_WINDOW_MS, inquiryNamesUnit, inquiryNamesVehicle, isSameRequest, sameInquiryUnit } from '../utils/inquiryKeys';
import {
  RecordInquiryInput,
  claimInquiryProcessing,
  claimInquirySideEffect,
  completeInquiryAssociation,
  detectInquiryDuplicate,
  failInquiryProcessing,
  finishInquirySideEffect,
  recordInquiryEvent,
} from './leadInquiry.service';
import { loadLeadAssociationInputs } from './leadLifecycle.service';
import { LeadIntakeDecision, decideLeadIntake } from './leadIntakeDecision';
import { leadIntakeLockKeys, withLeadIntakeLock } from './leadIntakeLock.service';
import { getLeadIntakeMode, onLeadIntakeResumed } from './leadIntakeControl.service';
import { resolveOrgSystemUserId } from '../utils/orgSystemUser';
import { notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { emitToOrg } from '../utils/socketEmitter';
import { markLeadAwaitingReply } from '../utils/leadActivity';
import logger from '../utils/logger';
import { CONFIRM_KEYWORDS, RESCHEDULE_KEYWORDS, isSmsKeyword, normalizeSmsCommand } from '../utils/smsKeywords';
import { leadDisplayName } from './leadMessageNotice.service';
import { notifyLeadPeople } from './leadNoticeRouting.service';

export const LEAD_INTAKE_MAX_ATTEMPTS = 5;

export interface LeadIntakeRequest extends RecordInquiryInput {
  leadDraft?: Record<string, unknown> | null;
}

export type LeadIntakeResult =
  | { status: 'inactive' }
  | { status: 'held'; inquiryId: string }
  | { status: 'duplicate'; inquiryId: string; leadId: string | null }
  | { status: 'associated'; inquiryId: string; leadId: string; created: boolean; reason: string }
  | { status: 'review'; inquiryId: string; reason: string }
  | { status: 'dismissed'; inquiryId: string; reason: string };

class RetryableIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableIntakeError';
  }
}

const RESERVED_DRAFT_FIELDS = new Set([
  '_id', 'organizationId', 'sourceInquiryId', 'intakeSlots', 'inquiryCount', 'lastInquiryAt', 'intakeIdentity',
  'customerId', 'customerLink', 'normalizedPhone', 'normalizedEmail', 'statusHistory', 'notes', 'announced',
  'customerArea',
]);

const AUTO_REPLY_PATTERNS = [
  /^\s*(auto(matic)?[- ]?reply|out of (the )?office|ooo\b|away from (my|the) (desk|office))/i,
  /\b(delivery status notification|undeliver(able|ed)|mail delivery (failed|subsystem)|returned mail|failure notice)\b/i,
];
const NO_REPLY_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]daemon|postmaster|bounce)/i;

export function isAutomatedEmailReply(input: { subject?: string | null; fromEmail?: string | null; body?: string | null }): boolean {
  const local = String(input.fromEmail || '').split('@')[0] || '';
  if (NO_REPLY_SENDER.test(local)) return true;
  const subject = String(input.subject || '');
  return AUTO_REPLY_PATTERNS.some((pattern) => pattern.test(subject));
}

const asId = (value: unknown) => (value ? String(value) : null);

function resultFromEvent(event: any): LeadIntakeResult {
  const inquiryId = String(event._id);
  const state = event.association?.state;
  if (state === 'associated') {
    return { status: 'duplicate', inquiryId, leadId: asId(event.association.leadId) };
  }
  if (state === 'pending_review') return { status: 'duplicate', inquiryId, leadId: null };
  if (state === 'resolved') return { status: 'duplicate', inquiryId, leadId: asId(event.association.leadId) };
  return { status: 'held', inquiryId };
}

export async function submitLeadInquiry(request: LeadIntakeRequest): Promise<LeadIntakeResult> {
  const mode = await getLeadIntakeMode(request.organizationId);
  if (mode === 'off') return { status: 'inactive' };
  const { event, created } = await recordInquiryEvent(request);
  if (!created) {
    if (event.association?.state === 'received' && mode === 'active') return processLeadInquiry(event._id);
    return resultFromEvent(event);
  }
  if (mode === 'paused') return { status: 'held', inquiryId: String(event._id) };
  return processLeadInquiry(event._id);
}

export const CONVERSATION_ONLY_KINDS = ['email_reply', 'sms', 'call'];
const REPLY_KINDS = ['email_reply', 'sms'];
export const SAME_REQUEST_KINDS = ['provider_inquiry', 'website_inquiry'];

const objectIdsOf = (leadIds: unknown[]) => [...new Set(leadIds.map((id) => String(id || '')).filter((id) => mongoose.isValidObjectId(id)))]
  .map((id) => new mongoose.Types.ObjectId(id));

async function findSameRequestInquiry(organizationId: string, event: any, openLeadIds: unknown[], closedLeadIds: unknown[]) {
  if (!SAME_REQUEST_KINDS.includes(event.kind) || event.intakePolicy === 'isolate') return null;
  const open = objectIdsOf(openLeadIds);
  const closed = objectIdsOf(closedLeadIds);
  if (!open.length && !closed.length) return null;
  const at = new Date(event.receivedAt).getTime();
  const near = (windowMs: number) => ({ $gte: new Date(at - windowMs), $lte: new Date(at + windowMs) });
  const earlier = await LeadInquiry.find({
    organizationId,
    _id: { $ne: event._id },
    kind: { $in: SAME_REQUEST_KINDS },
    'association.state': 'associated',
    $or: [
      ...(open.length ? [{ 'association.leadId': { $in: open }, receivedAt: near(SAME_REQUEST_WINDOW_MS) }] : []),
      ...(closed.length ? [{ 'association.leadId': { $in: closed }, receivedAt: near(CLOSED_LEAD_COPY_WINDOW_MS) }] : []),
    ],
  }).select('_id association.leadId vehicle comments source sourceProvider sourceIds.mailbox receivedAt').sort({ receivedAt: 1 }).limit(25).lean();
  return earlier.find((candidate) => isSameRequest(candidate, event)) || null;
}

const PLACEHOLDER_NAME_WORDS = new Set([
  'unknown', 'customer', 'guest', 'user', 'buyer', 'shopper', 'test', 'lead', 'none', 'na', 'noname', 'anonymous',
  'visitor', 'client', 'prospect', 'facebook', 'marketplace', 'web', 'website', 'internet', 'online', 'cargurus', 'autotrader', 'carscom',
]);

const fullNameKey = (contact: any) => {
  const first = String(contact?.firstName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const last = String(contact?.lastName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (first.length < 2 || last.length < 2 || PLACEHOLDER_NAME_WORDS.has(first) || PLACEHOLDER_NAME_WORDS.has(last)) return '';
  return `${first}|${last}`;
};

async function findSameNameRequest(organizationId: string, event: any) {
  if (!SAME_REQUEST_KINDS.includes(event.kind) || event.intakePolicy === 'isolate') return null;
  const nameKey = fullNameKey(event.contact);
  if (!nameKey || !inquiryNamesUnit(event.vehicle)) return null;
  const at = new Date(event.receivedAt).getTime();
  const nearby = await LeadInquiry.find({
    organizationId,
    _id: { $ne: event._id },
    kind: { $in: SAME_REQUEST_KINDS },
    'association.state': 'associated',
    receivedAt: { $gte: new Date(at - SAME_REQUEST_WINDOW_MS), $lte: new Date(at + SAME_REQUEST_WINDOW_MS) },
  }).select('_id association.leadId vehicle comments contact.firstName contact.lastName contact.normalizedPhone receivedAt').sort({ receivedAt: 1 }).limit(200).lean();
  const eventPhone = event.contact?.normalizedPhone || null;
  const matches = nearby.filter((candidate: any) => fullNameKey(candidate.contact) === nameKey
    && sameInquiryUnit(candidate.vehicle, event.vehicle)
    && !(eventPhone && candidate.contact?.normalizedPhone && candidate.contact.normalizedPhone !== eventPhone)
    && isSameRequest(candidate, event));
  if (!matches.length) return null;
  const leads: any[] = await Lead.find({ _id: { $in: matches.map((candidate: any) => candidate.association?.leadId) }, organizationId })
    .select('status combinedInto.leadId')
    .lean();
  const leadById = new Map(leads.map((lead) => [String(lead._id), lead]));
  return matches.find((candidate: any) => {
    const lead = leadById.get(String(candidate.association?.leadId));
    if (!lead || lead.combinedInto?.leadId) return false;
    if (!LIFECYCLE_TERMINAL_STATUSES.includes(lead.status)) return true;
    return Math.abs(new Date(candidate.receivedAt).getTime() - at) <= CLOSED_LEAD_COPY_WINDOW_MS;
  }) || null;
}

const blankText = (value: unknown) => !String(value ?? '').trim();

export async function fillEmptyLeadFields(organizationId: string, leadId: unknown, event: any): Promise<void> {
  const lead: any = await Lead.findOne({ _id: leadId, organizationId })
    .select('firstName lastName phone email identityEmailExcluded vehicle comments address status')
    .lean();
  if (!lead || isContactRestrictedStatus(lead.status)) return;
  const contact = event?.contact || {};
  const set: Record<string, unknown> = {};
  if ((blankText(lead.firstName) || lead.firstName === 'Unknown') && !blankText(contact.firstName)) {
    set.firstName = String(contact.firstName).trim();
    if (blankText(lead.lastName) && !blankText(contact.lastName)) set.lastName = String(contact.lastName).trim();
  }
  if (blankText(lead.phone) && !blankText(contact.phone)) set.phone = String(contact.phone).trim();
  if (blankText(lead.email) && !lead.identityEmailExcluded && !contact.emailExcluded && !blankText(contact.email)) {
    set.email = String(contact.email).trim();
  }
  const vehicle = event?.vehicle || {};
  const current = lead.vehicle || {};
  if (!inquiryNamesVehicle(current) && inquiryNamesVehicle(vehicle)) {
    const filled = Object.fromEntries(
      ['year', 'make', 'model', 'trim', 'vin', 'stock']
        .filter((key) => !blankText(vehicle[key]))
        .map((key) => [`vehicle.${key}`, String(vehicle[key]).trim()]),
    );
    Object.assign(set, filled);
  }
  if (blankText(lead.comments) && !blankText(event?.comments)) set.comments = String(event.comments).trim().slice(0, 10000);
  const draftAddress = (event?.leadDraft as Record<string, unknown> | null | undefined)?.address;
  if (blankText(lead.address) && typeof draftAddress === 'string' && draftAddress.trim()) set.address = draftAddress.trim();
  if (!Object.keys(set).length) return;
  await Lead.findOneAndUpdate({ _id: leadId, organizationId }, { $set: set }, { timestamps: false }).catch((err) =>
    logger.warn({ err, leadId: String(leadId) }, '[LeadIntake] Could not fill empty details from a repeated inquiry'));
}

export async function findOpenLeadForContact(
  organizationId: string,
  contact: { phone?: string | null; email?: string | null },
  options: { phoneVerified?: boolean } = {},
) {
  const inputs = await loadLeadAssociationInputs({ organizationId, phone: contact.phone, email: contact.email });
  const decision = decideLeadIntake({ ...inputs, policy: 'associate', phoneVerified: Boolean(options.phoneVerified) });
  if (decision.action !== 'append' || !decision.leadId) return null;
  return Lead.findOne({ _id: decision.leadId, organizationId, status: { $nin: LIFECYCLE_TERMINAL_STATUSES } });
}

export async function dismissLeadInquiry(eventId: unknown, reason: string): Promise<boolean> {
  const owner = randomUUID();
  const event = await claimInquiryProcessing(eventId, owner, { maxAttempts: LEAD_INTAKE_MAX_ATTEMPTS });
  if (!event) return false;
  const done = await completeInquiryAssociation(event._id, owner, {
    state: 'resolved',
    outcome: 'dismissed',
    reason,
    contextLeadId: event.association?.contextLeadId,
  });
  return Boolean(done);
}

export async function skipLeadInquiryNotification(eventId: unknown): Promise<void> {
  await LeadInquiry.updateOne(
    { _id: eventId, 'sideEffects.notification.state': 'pending' },
    { $set: { 'sideEffects.notification.state': 'skipped' } },
  );
}

export async function fillEmptyLeadAddress(organizationId: string, lead: any, event: ILeadInquiry) {
  const draftAddress = (event.leadDraft as Record<string, unknown> | null | undefined)?.address;
  const address = typeof draftAddress === 'string' ? draftAddress.trim() : '';
  if (!lead || !address || String(lead.address || '').trim()) return lead;
  const filled = await Lead.findOneAndUpdate(
    { _id: lead._id, organizationId, address: { $in: [null, ''] } },
    { $set: { address } },
    { new: true, timestamps: false },
  ).catch(() => null);
  return filled || lead;
}

export async function appendInquiryToLead(organizationId: string, leadId: string, event: ILeadInquiry, options: { fillAddress?: boolean } = {}) {
  const countsAsInquiry = !CONVERSATION_ONLY_KINDS.includes(event.kind);
  const appended = await Lead.findOneAndUpdate(
    { _id: leadId, organizationId, status: { $nin: LIFECYCLE_TERMINAL_STATUSES } },
    [
      {
        $set: {
          ...(countsAsInquiry
            ? {
                inquiryCount: { $add: [{ $ifNull: ['$inquiryCount', 1] }, 1] },
                lastInquiryAt: { $max: [{ $ifNull: ['$lastInquiryAt', event.receivedAt] }, event.receivedAt] },
              }
            : {}),
          isRead: false,
          followUp: { $mergeObjects: [{ $ifNull: ['$followUp', {}] }, { lastCustomerActivityAt: event.receivedAt }] },
        },
      },
    ],
    { new: true },
  );
  if (appended && REPLY_KINDS.includes(event.kind)) await markLeadAwaitingReply(appended._id, event.receivedAt, organizationId);
  return options.fillAddress === false ? appended : fillEmptyLeadAddress(organizationId, appended, event);
}

export async function createLeadForInquiry(organizationId: string, event: ILeadInquiry, decision: Pick<LeadIntakeDecision, 'intakeSlots'>) {
  const adopted = await Lead.findOne({ organizationId, sourceInquiryId: event._id });
  if (adopted) return adopted;
  const draft = (event.leadDraft || {}) as Record<string, unknown>;
  const createdBy = draft.createdBy || (await resolveOrgSystemUserId(organizationId));
  if (!createdBy) throw new RetryableIntakeError('This organization has no staff account to own new leads');
  const fromDraft = Object.fromEntries(Object.entries(draft).filter(([key]) => !RESERVED_DRAFT_FIELDS.has(key) && key !== 'othersReason'));
  const draftStatus = typeof fromDraft.status === 'string' ? fromDraft.status : 'New';
  const notALead = draftStatus === NOT_A_LEAD_STATUS;
  const othersReason = typeof draft.othersReason === 'string' && draft.othersReason.trim() ? draft.othersReason.trim() : 'Not a lead';
  const document: Record<string, unknown> = {
    organizationId,
    firstName: event.contact?.firstName || 'Unknown',
    lastName: event.contact?.lastName || '',
    email: event.contact?.email || undefined,
    phone: event.contact?.phone || undefined,
    identityEmailExcluded: event.contact?.emailExcluded || undefined,
    vehicle: event.vehicle,
    comments: event.comments,
    subject: event.subject,
    source: event.source,
    sourceProvider: event.sourceProvider,
    channel: event.channel,
    isRead: false,
    ...fromDraft,
    status: notALead ? NOT_A_LEAD_STATUS : LIFECYCLE_TERMINAL_STATUSES.includes(draftStatus) ? 'New' : draftStatus,
    ...(notALead ? { statusHistory: [{ from: 'New', to: NOT_A_LEAD_STATUS, changedAt: event.receivedAt, reason: othersReason }] } : {}),
    createdBy,
    sourceInquiryId: event._id,
    lastInquiryAt: event.receivedAt,
    inquiryCount: 1,
    ...(event.intakePolicy === 'isolate' ? { intakeIdentity: 'unverified' } : {}),
    ...(decision.intakeSlots?.length ? { intakeSlots: decision.intakeSlots } : {}),
  };
  try {
    const created = await Lead.create(document);
    if (REPLY_KINDS.includes(event.kind)) await markLeadAwaitingReply(created._id, event.receivedAt, organizationId);
    return created;
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const existing = await Lead.findOne({ organizationId, sourceInquiryId: event._id });
    if (existing) return existing;
    throw new RetryableIntakeError('Another intake created a lead for this customer at the same moment');
  }
}

export async function processLeadInquiry(eventId: unknown): Promise<LeadIntakeResult> {
  const owner = randomUUID();
  const event = await claimInquiryProcessing(eventId, owner, { maxAttempts: LEAD_INTAKE_MAX_ATTEMPTS });
  if (!event) {
    const current = await LeadInquiry.findById(eventId).lean();
    return current ? resultFromEvent(current) : { status: 'held', inquiryId: String(eventId) };
  }
  const organizationId = String(event.organizationId);
  const inquiryId = String(event._id);
  try {
    const duplicate = await detectInquiryDuplicate({
      organizationId,
      eventId: event._id,
      sourceIds: event.sourceIds as any,
      fingerprint: event.fingerprint,
      contentKey: event.contentKey,
      legacyIngestionFingerprint: (event.leadDraft as any)?.ingestionFingerprint || null,
    });
    if (duplicate.duplicate) {
      const original = duplicate.inquiryId ? await LeadInquiry.findById(duplicate.inquiryId).select('association').lean() : null;
      await completeInquiryAssociation(event._id, owner, {
        state: 'resolved',
        outcome: 'dismissed',
        reason: `duplicate_${duplicate.kind}`,
        duplicateOf: duplicate.inquiryId,
        contextLeadId: event.association?.contextLeadId,
      });
      return { status: 'duplicate', inquiryId, leadId: duplicate.leadId || asId(original?.association?.leadId) };
    }

    if (event.evidence?.automated || ((event.kind === 'email_reply' || event.intentAssurance === 'unconfirmed') && isAutomatedEmailReply({
      subject: event.subject,
      fromEmail: event.contact?.email,
      body: event.comments,
    }))) {
      await completeInquiryAssociation(event._id, owner, {
        state: 'resolved',
        outcome: 'dismissed',
        reason: 'automated_email',
        contextLeadId: event.association?.contextLeadId,
      });
      return { status: 'dismissed', inquiryId, reason: 'automated_email' };
    }

    const command = normalizeSmsCommand(String(event.comments || ''));
    const shortReply = event.kind === 'sms' && (CONFIRM_KEYWORDS.has(command) || RESCHEDULE_KEYWORDS.has(command));
    if (event.kind === 'sms' && isSmsKeyword(event.comments) && !shortReply) {
      await completeInquiryAssociation(event._id, owner, {
        state: 'resolved',
        outcome: 'dismissed',
        reason: 'sms_keyword',
        contextLeadId: event.association?.contextLeadId,
      });
      return { status: 'dismissed', inquiryId, reason: 'sms_keyword' };
    }

    const keys = leadIntakeLockKeys({ phone: event.contact?.phone, email: event.contact?.emailExcluded ? undefined : event.contact?.email });
    const lockKeys = keys.length ? keys : [`inquiry:${inquiryId}`];
    const result = await withLeadIntakeLock(organizationId, lockKeys, async ({ confirmHeld }) => {
      const inputs = await loadLeadAssociationInputs({
        organizationId,
        phone: event.contact?.phone,
        email: event.contact?.email,
        emailExcluded: event.contact?.emailExcluded,
        contextLeadId: event.association?.contextLeadId,
      });
      if (event.kind === 'email_reply' && inputs.contextLead?.lifecycle === 'terminal') {
        await confirmHeld();
        const done = await completeInquiryAssociation(event._id, owner, {
          state: 'pending_review',
          reason: 'reply_after_lead_closed',
          candidateLeadIds: [inputs.contextLead.leadId],
          contextLeadId: event.association?.contextLeadId,
        });
        if (!done) throw new RetryableIntakeError('The intake lease expired before the review was saved');
        return { status: 'review', inquiryId, reason: 'reply_after_lead_closed' } as LeadIntakeResult;
      }
      const decided = decideLeadIntake({
        ...inputs,
        policy: event.intakePolicy === 'isolate' ? 'isolate' : 'associate',
        phoneVerified: event.contact?.assurance === 'carrier_verified',
      });
      const decision = event.kind === 'email_reply' && decided.action === 'create'
        ? { ...decided, action: 'review' as const, reason: 'reply_without_open_lead' }
        : event.intentAssurance === 'unconfirmed' && decided.action === 'create' && decided.previousLeadIds.length
          ? { ...decided, action: 'review' as const, reason: 'email_after_lead_closed' }
          : decided;

      const sameRequest = await findSameRequestInquiry(
        organizationId,
        event,
        [decided.leadId, ...decided.candidateLeadIds, ...decided.possibleMatchLeadIds],
        decided.previousLeadIds,
      ) || (decided.action === 'create' ? await findSameNameRequest(organizationId, event) : null);
      if (sameRequest) {
        await confirmHeld();
        const done = await completeInquiryAssociation(event._id, owner, {
          state: 'resolved',
          outcome: 'dismissed',
          reason: 'duplicate_same_request',
          duplicateOf: sameRequest._id,
          contextLeadId: event.association?.contextLeadId,
        });
        if (!done) throw new RetryableIntakeError('The intake lease expired before the repeated inquiry was saved');
        const originalLeadId = asId((sameRequest as any).association?.leadId);
        if (originalLeadId) await fillEmptyLeadFields(organizationId, originalLeadId, event);
        return { status: 'duplicate', inquiryId, leadId: originalLeadId } as LeadIntakeResult;
      }

      if (shortReply && decision.action !== 'append') {
        await confirmHeld();
        const done = await completeInquiryAssociation(event._id, owner, {
          state: 'resolved',
          outcome: 'dismissed',
          reason: 'sms_keyword',
          contextLeadId: event.association?.contextLeadId,
        });
        if (!done) throw new RetryableIntakeError('The intake lease expired before the dismissal was saved');
        return { status: 'dismissed', inquiryId, reason: 'sms_keyword' } as LeadIntakeResult;
      }

      if (decision.action === 'review') {
        await confirmHeld();
        const done = await completeInquiryAssociation(event._id, owner, {
          state: 'pending_review',
          reason: decision.reason,
          candidateLeadIds: [...decision.candidateLeadIds, ...decision.previousLeadIds],
          contextLeadId: event.association?.contextLeadId,
        });
        if (!done) throw new RetryableIntakeError('The intake lease expired before the review was saved');
        return { status: 'review', inquiryId, reason: decision.reason } as LeadIntakeResult;
      }

      if (decision.action === 'append' && decision.leadId) {
        await confirmHeld();
        const lead = await appendInquiryToLead(organizationId, decision.leadId, event);
        if (!lead) throw new RetryableIntakeError('The matched lead closed while this inquiry was being added');
        const done = await completeInquiryAssociation(event._id, owner, {
          state: 'associated',
          outcome: 'appended',
          leadId: lead._id,
          reason: decision.reason,
          candidateLeadIds: decision.candidateLeadIds,
          contextLeadId: event.association?.contextLeadId,
        });
        if (!done) throw new RetryableIntakeError('The intake lease expired before the association was saved');
        if (decision.reason === 'phone_confirmed_chat') {
          await Lead.updateOne({ _id: lead._id, organizationId, intakeIdentity: 'unverified' }, {
            $unset: { intakeIdentity: 1 },
            $set: { 'customerLink.status': 'pending', 'customerLink.nextRetryAt': new Date() },
          });
        }
        return { status: 'associated', inquiryId, leadId: String(lead._id), created: false, reason: decision.reason } as LeadIntakeResult;
      }

      await confirmHeld();
      const lead = await createLeadForInquiry(organizationId, event, decision);
      const done = await completeInquiryAssociation(event._id, owner, {
        state: 'associated',
        outcome: 'created_lead',
        leadId: lead._id,
        reason: decision.reason,
        candidateLeadIds: decision.candidateLeadIds,
        contextLeadId: event.association?.contextLeadId,
        review: decision.possibleMatchLeadIds.length
          ? { kind: 'possible_match', reason: decision.reason, candidateLeadIds: decision.possibleMatchLeadIds }
          : null,
      });
      if (!done) throw new RetryableIntakeError('The intake lease expired before the association was saved');
      return { status: 'associated', inquiryId, leadId: String(lead._id), created: true, reason: decision.reason } as LeadIntakeResult;
    });

    if (result.status === 'associated' && result.reason === 'phone_confirmed_chat') {
      await linkConfirmedChatCustomer(organizationId, result.leadId);
    }
    if (result.status !== 'dismissed' && result.status !== 'duplicate') {
      await runInquirySideEffects(event._id).catch((err) =>
        logger.warn({ err, inquiryId }, '[LeadIntake] Side effects will be retried by the recovery sweep'));
    }
    return result;
  } catch (err) {
    await failInquiryProcessing(event._id, owner, err).catch(() => undefined);
    logger.warn({ err, inquiryId, organizationId }, '[LeadIntake] Inquiry kept for retry');
    return { status: 'held', inquiryId };
  }
}

async function linkConfirmedChatCustomer(organizationId: string, leadId: string): Promise<void> {
  try {
    const { syncLeadCustomerSafely } = await import('./customerIdentity.service');
    await syncLeadCustomerSafely(organizationId, leadId);
  } catch (err) {
    logger.warn({ err, leadId }, '[LeadIntake] Could not link the customer record for a chat confirmed by text or call');
  }
  emitToOrg(organizationId, 'lead:update', { leadId });
}

async function linkInquirySources(event: any): Promise<void> {
  const leadId = event.association?.leadId;
  if (!leadId) return;
  const organizationId = String(event.organizationId);
  const ids = event.sourceIds || {};
  const unowned = { $or: [{ leadId: null }, { leadId: { $exists: false } }] };
  const updates: Promise<unknown>[] = [];
  const orgIds = { $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] };
  const conversationIds: unknown[] = [];
  if (ids.communicationMessageId) {
    const { CommunicationMessage } = await import('../models/communication.model');
    updates.push(CommunicationMessage.updateOne({ _id: ids.communicationMessageId, orgId: orgIds, ...unowned }, { $set: { leadId } }));
    const message: any = await CommunicationMessage.findOne({ _id: ids.communicationMessageId, orgId: orgIds }).select('conversationId').lean();
    if (message?.conversationId) conversationIds.push(message.conversationId);
  }
  if (ids.callControlId) {
    const { CallLog } = await import('../models/communication.model');
    updates.push(CallLog.updateOne({ providerCallControlId: ids.callControlId, orgId: orgIds, ...unowned }, { $set: { leadId } }));
    const call: any = await CallLog.findOne({ providerCallControlId: ids.callControlId, orgId: orgIds }).select('conversationId').lean();
    if (call?.conversationId) conversationIds.push(call.conversationId);
  }
  if (conversationIds.length) {
    const { moveConversationToLead } = await import('../utils/conversationOwnership');
    for (const conversationId of conversationIds) {
      updates.push(moveConversationToLead({ organizationId, conversationId, leadId }));
    }
  }
  if (ids.appointmentId) {
    const { default: Appointment } = await import('../models/Appointment.model');
    updates.push(Appointment.updateOne({ _id: ids.appointmentId, organizationId, ...unowned }, { $set: { leadId } }));
  }
  await Promise.all(updates);
}

function customerNameOf(event: any): string {
  return leadDisplayName(event.contact || {});
}

function vehicleLabelOf(event: any): string {
  return [event.vehicle?.year, event.vehicle?.make, event.vehicle?.model].filter(Boolean).join(' ');
}

function inquiryTextOf(event: any): string {
  return [event.subject, event.comments].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

async function sendIntakeNotification(event: any): Promise<void> {
  const organizationId = String(event.organizationId);
  const association = event.association || {};
  const metadata = { leadId: asId(association.leadId), inquiryId: String(event._id), source: event.source || null };
  if (association.state === 'pending_review' || event.review?.state === 'pending') {
    const template = notificationTemplates.lead_inquiry_review({ customerName: customerNameOf(event) });
    await notifyOrgAdmins(organizationId, 'lead_inquiry_review', template.title, template.message, { ...metadata, route: '/crm/leads?review=1' });
    emitToOrg(organizationId, 'lead:review', { inquiryId: String(event._id) });
    if (association.state === 'pending_review') return;
  }
  if (association.state !== 'associated' || !association.leadId) return;
  const lead: any = await Lead.findOne({ _id: association.leadId, organizationId }).select('assignedTo firstName lastName source status').lean();
  if (!lead) return;
  if (lead.status === NOT_A_LEAD_STATUS) {
    emitToOrg(organizationId, 'lead:update', { _id: String(lead._id), leadId: String(lead._id) });
    return;
  }
  if (association.outcome === 'created_lead' || association.outcome === 'manual_create') {
    if ((event.leadDraft as any)?.announced) {
      emitToOrg(organizationId, 'lead:update', { _id: String(lead._id), leadId: String(lead._id) });
      return;
    }
    const template = notificationTemplates.new_lead({
      customerName: customerNameOf(event),
      source: event.source,
      vehicleInterest: vehicleLabelOf(event) || undefined,
    } as any);
    await notifyLeadPeople({
      organizationId,
      leadId: lead._id,
      type: 'new_lead',
      title: template.title,
      message: template.message,
      metadata,
      topicText: inquiryTextOf(event),
    });
    emitToOrg(organizationId, 'lead:new', { _id: String(lead._id), leadId: String(lead._id) });
    return;
  }
  const conversationReply = CONVERSATION_ONLY_KINDS.includes(event.kind);
  const template = conversationReply
    ? notificationTemplates.lead_customer_replied({ customerName: customerNameOf(event), channel: event.kind })
    : notificationTemplates.lead_new_inquiry({
        customerName: customerNameOf(event),
        source: event.source || undefined,
        vehicleInterest: vehicleLabelOf(event) || undefined,
      });
  await notifyLeadPeople({
    organizationId,
    leadId: lead._id,
    type: 'lead_new_inquiry',
    assignedOwnerOnly: conversationReply,
    title: template.title,
    message: template.message,
    metadata,
    topicText: inquiryTextOf(event),
  });
  emitToOrg(organizationId, 'lead:update', { _id: String(lead._id), leadId: String(lead._id) });
}

export async function runInquirySideEffects(eventId: unknown): Promise<void> {
  const owner = randomUUID();
  const linkClaim = await claimInquirySideEffect(eventId, 'conversationRecord', owner);
  if (linkClaim) {
    try {
      await linkInquirySources(linkClaim);
      await finishInquirySideEffect(eventId, 'conversationRecord', owner, { state: linkClaim.association?.leadId ? 'done' : 'skipped' });
    } catch (err) {
      await finishInquirySideEffect(eventId, 'conversationRecord', owner, { state: 'failed', error: err }).catch(() => undefined);
      throw err;
    }
  }
  const notifyClaim = await claimInquirySideEffect(eventId, 'notification', owner, { allowPendingReview: true });
  if (notifyClaim) {
    try {
      await sendIntakeNotification(notifyClaim);
      await finishInquirySideEffect(eventId, 'notification', owner, { state: 'done' });
    } catch (err) {
      await finishInquirySideEffect(eventId, 'notification', owner, { state: 'failed', error: err }).catch(() => undefined);
      throw err;
    }
  }
}

async function moveExhaustedInquiriesToReview(organizationIds: string[]): Promise<number> {
  const exhausted = await LeadInquiry.find({
    organizationId: { $in: organizationIds },
    'association.state': 'received',
    'processing.state': 'failed',
    'processing.attempts': { $gte: LEAD_INTAKE_MAX_ATTEMPTS },
  }).select('_id organizationId processing.lastError').limit(50).lean();
  let moved = 0;
  for (const item of exhausted) {
    const updated = await LeadInquiry.findOneAndUpdate(
      { _id: item._id, 'association.state': 'received', 'processing.state': 'failed' },
      {
        $set: {
          'association.state': 'pending_review',
          'association.reason': 'processing_failed',
          'association.decidedAt': new Date(),
          'review.state': 'pending',
          'review.kind': 'unassigned',
          'review.reason': 'processing_failed',
          'processing.state': 'completed',
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) continue;
    moved += 1;
    await LeadIntakeAudit.create({
      organizationId: item.organizationId,
      event: 'inquiry_moved_to_review',
      actor: { kind: 'system', userId: null, name: 'Lead intake' },
      inquiryId: item._id,
      reason: String(item.processing?.lastError || 'Processing kept failing').slice(0, 1000),
    }).catch(() => undefined);
    await runInquirySideEffects(item._id).catch(() => undefined);
  }
  return moved;
}

const SMS_RESTORE_AGE_MS = 2 * 60 * 1000;

export async function recoverLeadIntake(options: { organizationId?: string; limit?: number; minAgeMs?: number } = {}) {
  const limit = Math.min(200, Math.max(1, options.limit || 50));
  const now = new Date();
  const controls = await LeadIntakeControl.find(
    options.organizationId ? { organizationId: options.organizationId, mode: 'active' } : { mode: 'active' },
  ).select('organizationId').lean();
  const organizationIds = controls.map((control) => String(control.organizationId));
  const stats = { processed: 0, sideEffects: 0, movedToReview: 0 };
  if (!organizationIds.length) return stats;

  const due = await LeadInquiry.find({
    organizationId: { $in: organizationIds },
    'association.state': 'received',
    'processing.attempts': { $lt: LEAD_INTAKE_MAX_ATTEMPTS },
    $or: [
      options.minAgeMs
        ? { 'processing.state': 'pending', receivedAt: { $lte: new Date(now.getTime() - options.minAgeMs) } }
        : { 'processing.state': 'pending' },
      { 'processing.state': 'failed', $or: [{ 'processing.nextAttemptAt': null }, { 'processing.nextAttemptAt': { $lte: now } }] },
      { 'processing.state': 'processing', 'processing.leaseExpiresAt': { $lte: now } },
    ],
  }).sort({ receivedAt: 1, _id: 1 }).select('_id kind receivedAt organizationId contact comments sourceIds association').limit(limit).lean();
  for (const item of due) {
    if (item.kind === 'sms' && item.sourceIds?.communicationMessageId && new Date(item.receivedAt).getTime() <= now.getTime() - SMS_RESTORE_AGE_MS) {
      const { restoreInboundSmsFromInquiry } = await import('./communication.service');
      await restoreInboundSmsFromInquiry(item).catch((err) =>
        logger.warn({ err, inquiryId: String(item._id) }, '[LeadIntake] Could not restore a stored text message'));
    }
    await processLeadInquiry(item._id);
    stats.processed += 1;
  }

  const pendingEffects = await LeadInquiry.find({
    organizationId: { $in: organizationIds },
    'association.state': { $in: ['associated', 'pending_review'] },
    $or: [
      { 'sideEffects.notification.state': { $in: ['pending', 'failed'] } },
      { 'sideEffects.conversationRecord.state': { $in: ['pending', 'failed'] }, 'association.state': 'associated' },
      { 'sideEffects.notification.state': 'claimed', 'sideEffects.notification.claimExpiresAt': { $lte: now } },
    ],
    'processing.state': 'completed',
  }).select('_id').limit(limit).lean();
  for (const item of pendingEffects) {
    await runInquirySideEffects(item._id).catch(() => undefined);
    stats.sideEffects += 1;
  }

  stats.movedToReview = await moveExhaustedInquiriesToReview(organizationIds);
  return stats;
}

onLeadIntakeResumed((organizationId) => {
  recoverLeadIntake({ organizationId, limit: 200 }).catch((err) =>
    logger.warn({ err, organizationId }, '[LeadIntake] Replay after resume failed; the recovery sweep will retry'));
});
