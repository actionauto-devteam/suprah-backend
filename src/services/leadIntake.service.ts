import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import Lead from '../models/lead.model';
import LeadInquiry, { ILeadInquiry } from '../models/LeadInquiry.model';
import LeadIntakeControl from '../models/LeadIntakeControl.model';
import LeadIntakeAudit from '../models/LeadIntakeAudit.model';
import { LIFECYCLE_TERMINAL_STATUSES } from '../constants/leadStatus';
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
import { notifyOrgAdmins, notifyUsers } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { emitToOrg } from '../utils/socketEmitter';
import logger from '../utils/logger';
import { isSmsKeyword } from '../utils/smsKeywords';

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

export async function findOpenLeadForContact(organizationId: string, contact: { phone?: string | null; email?: string | null }) {
  const inputs = await loadLeadAssociationInputs({ organizationId, phone: contact.phone, email: contact.email });
  const decision = decideLeadIntake({ ...inputs, policy: 'associate' });
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

export async function appendInquiryToLead(organizationId: string, leadId: string, event: ILeadInquiry) {
  const countsAsInquiry = !CONVERSATION_ONLY_KINDS.includes(event.kind);
  return Lead.findOneAndUpdate(
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
}

export async function createLeadForInquiry(organizationId: string, event: ILeadInquiry, decision: Pick<LeadIntakeDecision, 'intakeSlots'>) {
  const adopted = await Lead.findOne({ organizationId, sourceInquiryId: event._id });
  if (adopted) return adopted;
  const draft = (event.leadDraft || {}) as Record<string, unknown>;
  const createdBy = draft.createdBy || (await resolveOrgSystemUserId(organizationId));
  if (!createdBy) throw new RetryableIntakeError('This organization has no staff account to own new leads');
  const fromDraft = Object.fromEntries(Object.entries(draft).filter(([key]) => !RESERVED_DRAFT_FIELDS.has(key)));
  const draftStatus = typeof fromDraft.status === 'string' ? fromDraft.status : 'New';
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
    status: LIFECYCLE_TERMINAL_STATUSES.includes(draftStatus) ? 'New' : draftStatus,
    createdBy,
    sourceInquiryId: event._id,
    lastInquiryAt: event.receivedAt,
    inquiryCount: 1,
    ...(event.intakePolicy === 'isolate' ? { intakeIdentity: 'unverified' } : {}),
    ...(decision.intakeSlots?.length ? { intakeSlots: decision.intakeSlots } : {}),
  };
  try {
    return await Lead.create(document);
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

    if (event.kind === 'sms' && isSmsKeyword(event.comments)) {
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
      const decided = decideLeadIntake({ ...inputs, policy: event.intakePolicy === 'isolate' ? 'isolate' : 'associate' });
      const decision = event.kind === 'email_reply' && decided.action === 'create'
        ? { ...decided, action: 'review' as const, reason: 'reply_without_open_lead' }
        : event.intentAssurance === 'unconfirmed' && decided.action === 'create' && decided.previousLeadIds.length
          ? { ...decided, action: 'review' as const, reason: 'email_after_lead_closed' }
          : decided;

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

    await runInquirySideEffects(event._id).catch((err) =>
      logger.warn({ err, inquiryId }, '[LeadIntake] Side effects will be retried by the recovery sweep'));
    return result;
  } catch (err) {
    await failInquiryProcessing(event._id, owner, err).catch(() => undefined);
    logger.warn({ err, inquiryId, organizationId }, '[LeadIntake] Inquiry kept for retry');
    return { status: 'held', inquiryId };
  }
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
  return [event.contact?.firstName, event.contact?.lastName].filter(Boolean).join(' ').trim() || event.contact?.email || event.contact?.phone || 'A customer';
}

function vehicleLabelOf(event: any): string {
  return [event.vehicle?.year, event.vehicle?.make, event.vehicle?.model].filter(Boolean).join(' ');
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
  const lead: any = await Lead.findOne({ _id: association.leadId, organizationId }).select('assignedTo firstName lastName source').lean();
  if (!lead) return;
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
    await notifyOrgAdmins(organizationId, 'new_lead', template.title, template.message, metadata);
    emitToOrg(organizationId, 'lead:new', { _id: String(lead._id), leadId: String(lead._id) });
    return;
  }
  const template = CONVERSATION_ONLY_KINDS.includes(event.kind)
    ? notificationTemplates.lead_customer_replied({ customerName: customerNameOf(event), channel: event.kind })
    : notificationTemplates.lead_new_inquiry({
        customerName: customerNameOf(event),
        source: event.source || undefined,
        vehicleInterest: vehicleLabelOf(event) || undefined,
      });
  if (lead.assignedTo) {
    await notifyUsers([String(lead.assignedTo)], organizationId, 'lead_new_inquiry', template.title, template.message, metadata);
  } else {
    await notifyOrgAdmins(organizationId, 'lead_new_inquiry', template.title, template.message, metadata);
  }
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
