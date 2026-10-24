import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import LeadInquiry, { ILeadInquiry, LeadInquiryReviewResolution } from '../models/LeadInquiry.model';
import LeadIntakeAudit from '../models/LeadIntakeAudit.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import Appointment from '../models/Appointment.model';
import { CallLog, CommunicationMessage } from '../models/communication.model';
import { LIFECYCLE_TERMINAL_STATUSES } from '../constants/leadStatus';
import { ApiError } from '../utils/ApiError';
import { emitToOrg } from '../utils/socketEmitter';
import logger from '../utils/logger';
import { isOrganizationAdmin } from './contactRestriction.service';
import { loadLeadAssociationInputs } from './leadLifecycle.service';
import { decideLeadIntake } from './leadIntakeDecision';
import { getLeadIntakeMode } from './leadIntakeControl.service';
import {
  LeadIntakeResult,
  appendInquiryToLead,
  createLeadForInquiry,
  runInquirySideEffects,
  submitLeadInquiry,
} from './leadIntake.service';

export type ReviewResolutionInput = 'associate' | 'create_lead' | 'not_customer_inquiry' | 'keep_separate';

export interface ReviewActor {
  userId: string | null;
  name: string | null;
}

const LEAD_SUMMARY_FIELDS = 'firstName lastName status assignedTo source channel createdAt updatedAt intakeIdentity';

const isObjectId = (value: unknown) => Boolean(value) && mongoose.isValidObjectId(String(value));

export async function canResolveLeadReviews(user: any, organizationId: string): Promise<boolean> {
  if (await isOrganizationAdmin(user, organizationId)) return true;
  const userId = String(user?._id || user?.id || '');
  if (!isObjectId(userId) || !isObjectId(organizationId)) return false;
  try {
    const { default: CrmUser } = await import('../models/CrmUser.model');
    const crmUser: any = await CrmUser.findOne({ _id: userId, organizationId }).select('role isActive leadReviewAccess').lean();
    return Boolean(crmUser && crmUser.isActive !== false && crmUser.role === 'manager' && crmUser.leadReviewAccess === true);
  } catch (err) {
    logger.warn({ err, organizationId }, '[LeadReview] Permission check failed; treating the user as view-only');
    return false;
  }
}

function leadSummary(lead: any) {
  if (!lead) return null;
  return {
    _id: String(lead._id),
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Unknown',
    status: lead.status,
    source: lead.source || null,
    channel: lead.channel || null,
    assignedTo: lead.assignedTo ? String(lead.assignedTo) : null,
    unverified: lead.intakeIdentity === 'unverified',
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

function reviewSummary(item: any, leads: Map<string, any>) {
  const candidateIds = [...new Set([...(item.review?.candidateLeadIds || []), ...(item.association?.candidateLeadIds || [])].map(String))];
  return {
    inquiryId: String(item._id),
    kind: item.kind,
    channel: item.channel || null,
    source: item.source || null,
    sourceProvider: item.sourceProvider || null,
    receivedAt: item.receivedAt,
    contact: {
      name: [item.contact?.firstName, item.contact?.lastName].filter(Boolean).join(' ').trim() || null,
      phone: item.contact?.phone || null,
      email: item.contact?.emailExcluded ? null : item.contact?.email || null,
    },
    vehicle: item.vehicle || null,
    subject: item.subject || null,
    message: String(item.comments || '').slice(0, 1000),
    review: {
      state: item.review?.state,
      kind: item.review?.kind,
      reason: item.review?.reason || item.association?.reason || null,
      resolution: item.review?.resolution || null,
      resolvedBy: item.review?.resolvedBy || null,
      resolvedAt: item.review?.resolvedAt || null,
      note: item.review?.note || null,
    },
    lead: leadSummary(item.association?.leadId ? leads.get(String(item.association.leadId)) : null),
    candidates: candidateIds
      .filter((id) => id !== String(item.association?.leadId || ''))
      .map((id) => leadSummary(leads.get(id)))
      .filter(Boolean),
  };
}

export async function listLeadReviews(organizationId: string, options: { state?: string; limit?: number; before?: string } = {}) {
  const state = options.state === 'resolved' ? 'resolved' : 'pending';
  const filter: Record<string, unknown> = { organizationId, 'review.state': state };
  if (options.before && !Number.isNaN(new Date(options.before).getTime())) filter.receivedAt = { $lt: new Date(options.before) };
  const limit = Math.min(100, Math.max(1, options.limit || 50));
  const items = await LeadInquiry.find(filter)
    .sort(state === 'pending' ? { receivedAt: 1, _id: 1 } : { 'review.resolvedAt': -1, _id: -1 })
    .limit(limit)
    .select('-leadDraft -processing -sideEffects')
    .lean();
  const leadIds = new Set<string>();
  for (const item of items as any[]) {
    if (item.association?.leadId) leadIds.add(String(item.association.leadId));
    for (const id of [...(item.review?.candidateLeadIds || []), ...(item.association?.candidateLeadIds || [])]) leadIds.add(String(id));
  }
  const leads = leadIds.size
    ? await Lead.find({ _id: { $in: [...leadIds] }, organizationId }).select(LEAD_SUMMARY_FIELDS).lean()
    : [];
  const byId = new Map(leads.map((lead: any) => [String(lead._id), lead]));
  return items.map((item) => reviewSummary(item, byId));
}

export async function countPendingLeadReviews(organizationId: string): Promise<number> {
  return LeadInquiry.countDocuments({ organizationId, 'review.state': 'pending' });
}

async function requireOpenLead(organizationId: string, leadId: unknown, label = 'the lead you picked') {
  if (!isObjectId(leadId)) throw new ApiError(400, 'Pick the lead to add this to.');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId }).select('status intakeIdentity').lean();
  if (!lead) throw new ApiError(404, 'That lead was not found.');
  if (LIFECYCLE_TERMINAL_STATUSES.includes(lead.status)) throw new ApiError(409, `${label} is closed. Pick an open lead.`);
  if (lead.intakeIdentity === 'unverified') throw new ApiError(409, `${label} is an unverified chat. Pick a verified open lead.`);
  return lead;
}

async function writeAudit(entry: {
  organizationId: string;
  event: 'review_resolved' | 'review_reopened' | 'lead_linked';
  actor: ReviewActor;
  inquiryId?: unknown;
  leadId?: unknown;
  resolution?: string | null;
  reason?: string | null;
}) {
  await LeadIntakeAudit.create({
    organizationId: entry.organizationId,
    event: entry.event,
    actor: { kind: 'staff', userId: entry.actor.userId, name: entry.actor.name },
    inquiryId: isObjectId(entry.inquiryId) ? entry.inquiryId : null,
    leadId: isObjectId(entry.leadId) ? entry.leadId : null,
    resolution: entry.resolution || null,
    reason: entry.reason ? String(entry.reason).slice(0, 1000) : null,
  });
}

async function closeMergedLead(organizationId: string, leadId: unknown, status: string, reason: string, actor: ReviewActor) {
  const lead: any = await Lead.findOne({ _id: leadId, organizationId }).select('status').lean();
  if (!lead || lead.status === status) return;
  await Lead.updateOne(
    { _id: leadId, organizationId },
    {
      $set: { status },
      $push: {
        statusHistory: {
          from: lead.status,
          to: status,
          changedAt: new Date(),
          ...(isObjectId(actor.userId) ? { changedBy: actor.userId } : {}),
          reason,
        },
      },
    },
  );
  emitToOrg(organizationId, 'lead:update', { leadId: String(leadId) });
}

async function moveLeadRecords(organizationId: string, fromLeadId: unknown, toLeadId: unknown) {
  const orgIds = { $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] };
  await Promise.all([
    WebChatSession.updateMany({ organizationId, leadId: fromLeadId }, { $set: { leadId: toLeadId } }),
    WebChatMessage.updateMany({ organizationId, leadId: fromLeadId }, { $set: { leadId: toLeadId } }),
    CommunicationMessage.updateMany({ orgId: orgIds, leadId: fromLeadId }, { $set: { leadId: toLeadId } }),
    CallLog.updateMany({ orgId: orgIds, leadId: fromLeadId }, { $set: { leadId: toLeadId } }),
    Appointment.updateMany({ organizationId, leadId: fromLeadId }, { $set: { leadId: toLeadId } }),
  ]);
}

const RESOLUTION_FOR: Record<ReviewResolutionInput, LeadInquiryReviewResolution> = {
  associate: 'associated',
  create_lead: 'created_lead',
  not_customer_inquiry: 'not_customer_inquiry',
  keep_separate: 'kept_separate',
};

async function rearmSideEffects(inquiryId: unknown) {
  await LeadInquiry.updateOne(
    { _id: inquiryId },
    {
      $set: {
        'sideEffects.conversationRecord.state': 'pending',
        'sideEffects.conversationRecord.attempts': 0,
        'sideEffects.notification.state': 'pending',
        'sideEffects.notification.attempts': 0,
      },
    },
  );
}

export async function resolveLeadReview(input: {
  organizationId: string;
  inquiryId: string;
  resolution: ReviewResolutionInput;
  leadId?: string | null;
  note?: string | null;
  actor: ReviewActor;
}) {
  const { organizationId, actor } = input;
  if (!isObjectId(input.inquiryId)) throw new ApiError(404, 'That review item was not found.');
  if (!Object.prototype.hasOwnProperty.call(RESOLUTION_FOR, input.resolution)) {
    throw new ApiError(400, 'Choose how to handle this inquiry.');
  }
  const note = input.note ? String(input.note).trim().slice(0, 1000) : null;
  const current: any = await LeadInquiry.findOne({ _id: input.inquiryId, organizationId }).lean();
  if (!current) throw new ApiError(404, 'That review item was not found.');
  if (current.review?.state !== 'pending') throw new ApiError(409, 'Someone already handled this inquiry.');

  const possibleMatch = current.review?.kind === 'possible_match' && current.association?.state === 'associated';
  if (!possibleMatch && current.association?.state !== 'pending_review') {
    throw new ApiError(409, 'This inquiry is still being processed. Try again in a minute.');
  }
  if (possibleMatch && input.resolution === 'create_lead') input.resolution = 'keep_separate';
  if (!possibleMatch && input.resolution === 'keep_separate') {
    throw new ApiError(400, 'Choose to add this to a lead, create a new lead, or mark it as not a customer inquiry.');
  }
  if (input.resolution === 'associate') {
    await requireOpenLead(organizationId, input.leadId);
    if (possibleMatch && String(input.leadId) === String(current.association.leadId)) {
      throw new ApiError(400, 'Pick a different lead than the one this chat already has.');
    }
  }

  const resolution = RESOLUTION_FOR[input.resolution];
  const now = new Date();
  const claimed = await LeadInquiry.findOneAndUpdate(
    { _id: current._id, organizationId, 'review.state': 'pending', version: current.version },
    {
      $set: {
        'review.state': 'resolved',
        'review.resolution': resolution,
        'review.resolvedBy': { userId: actor.userId || undefined, name: actor.name || undefined },
        'review.resolvedAt': now,
        'review.note': note,
      },
      $inc: { version: 1 },
    },
    { new: true },
  );
  if (!claimed) throw new ApiError(409, 'Someone already handled this inquiry.');

  try {
    await writeAudit({
      organizationId,
      event: 'review_resolved',
      actor,
      inquiryId: current._id,
      leadId: input.resolution === 'associate' ? input.leadId : current.association?.leadId,
      resolution,
      reason: note,
    });
  } catch (err) {
    await LeadInquiry.updateOne(
      { _id: current._id, 'review.resolvedAt': now },
      { $set: { 'review.state': 'pending', 'review.resolution': null, 'review.resolvedBy': null, 'review.resolvedAt': null, 'review.note': null }, $inc: { version: 1 } },
    ).catch(() => undefined);
    logger.error({ err, inquiryId: input.inquiryId }, '[LeadReview] Audit record could not be saved; the review was not changed');
    throw new ApiError(503, "This couldn't be saved right now. Please try again.");
  }

  let finalLeadId: string | null = current.association?.leadId ? String(current.association.leadId) : null;
  try {
    if (possibleMatch) {
      const createdLeadId = current.association.leadId;
      if (input.resolution === 'associate') {
        const appended = await appendInquiryToLead(organizationId, String(input.leadId), claimed as ILeadInquiry);
        if (!appended) throw new ApiError(409, 'The lead you picked just closed. Pick an open lead.');
        await moveLeadRecords(organizationId, createdLeadId, input.leadId);
        await LeadInquiry.updateOne(
          { _id: current._id },
          { $set: { 'association.leadId': input.leadId, 'association.outcome': 'appended', 'association.reason': 'staff_review' } },
        );
        await closeMergedLead(organizationId, createdLeadId, 'Closed', `Linked to another lead after staff review${note ? `: ${note}` : ''}`, actor);
        finalLeadId = String(input.leadId);
        await rearmSideEffects(current._id);
      } else if (input.resolution === 'not_customer_inquiry') {
        await closeMergedLead(organizationId, createdLeadId, 'Bad Lead', `Marked as not a customer inquiry${note ? `: ${note}` : ''}`, actor);
      }
    } else if (input.resolution === 'associate') {
      const appended = await appendInquiryToLead(organizationId, String(input.leadId), claimed as ILeadInquiry);
      if (!appended) throw new ApiError(409, 'The lead you picked just closed. Pick an open lead.');
      await LeadInquiry.updateOne(
        { _id: current._id },
        { $set: { 'association.state': 'associated', 'association.leadId': input.leadId, 'association.outcome': 'appended', 'association.reason': 'staff_review', 'association.decidedAt': now } },
      );
      finalLeadId = String(input.leadId);
      await rearmSideEffects(current._id);
    } else if (input.resolution === 'create_lead') {
      const lead = await createLeadForInquiry(organizationId, claimed as ILeadInquiry, { intakeSlots: undefined });
      await LeadInquiry.updateOne(
        { _id: current._id },
        { $set: { 'association.state': 'associated', 'association.leadId': lead._id, 'association.outcome': 'manual_create', 'association.reason': 'staff_review', 'association.decidedAt': now } },
      );
      finalLeadId = String(lead._id);
      await rearmSideEffects(current._id);
    } else {
      await LeadInquiry.updateOne(
        { _id: current._id },
        { $set: { 'association.state': 'resolved', 'association.outcome': 'dismissed', 'association.reason': 'not_customer_inquiry', 'association.decidedAt': now } },
      );
    }
  } catch (err) {
    await LeadInquiry.updateOne(
      { _id: current._id, 'review.resolvedAt': now },
      { $set: { 'review.state': 'pending', 'review.resolution': null, 'review.resolvedBy': null, 'review.resolvedAt': null, 'review.note': null }, $inc: { version: 1 } },
    ).catch(() => undefined);
    await writeAudit({
      organizationId,
      event: 'review_reopened',
      actor,
      inquiryId: current._id,
      resolution,
      reason: err instanceof Error ? err.message : 'The change could not be completed',
    }).catch(() => undefined);
    throw err;
  }

  await runInquirySideEffects(current._id).catch((err) =>
    logger.warn({ err, inquiryId: input.inquiryId }, '[LeadReview] Follow-up work will be retried by the recovery sweep'));
  emitToOrg(organizationId, 'lead:review', { inquiryId: String(current._id), resolved: true });
  if (finalLeadId) emitToOrg(organizationId, 'lead:update', { leadId: finalLeadId });
  return { inquiryId: String(current._id), resolution, leadId: finalLeadId };
}

export async function linkUnverifiedLead(input: {
  organizationId: string;
  leadId: string;
  targetLeadId: string;
  note?: string | null;
  actor: ReviewActor;
}) {
  const { organizationId, actor } = input;
  if (!isObjectId(input.leadId)) throw new ApiError(404, 'Lead not found');
  const source: any = await Lead.findOne({ _id: input.leadId, organizationId }).select('status intakeIdentity sourceInquiryId').lean();
  if (!source) throw new ApiError(404, 'Lead not found');
  if (source.intakeIdentity !== 'unverified') throw new ApiError(409, 'Only unverified chat leads can be linked this way.');
  if (String(input.targetLeadId) === String(input.leadId)) throw new ApiError(400, 'Pick a different lead.');
  await requireOpenLead(organizationId, input.targetLeadId);

  const pendingReview: any = source.sourceInquiryId
    ? await LeadInquiry.findOne({ _id: source.sourceInquiryId, organizationId, 'review.state': 'pending', 'review.kind': 'possible_match' }).select('_id').lean()
    : null;
  if (pendingReview) {
    return resolveLeadReview({ organizationId, inquiryId: String(pendingReview._id), resolution: 'associate', leadId: input.targetLeadId, note: input.note, actor });
  }

  const note = input.note ? String(input.note).trim().slice(0, 1000) : null;
  const claimed = await Lead.findOneAndUpdate(
    { _id: input.leadId, organizationId, intakeIdentity: 'unverified' },
    { $unset: { intakeIdentity: 1 } },
    { new: true },
  );
  if (!claimed) throw new ApiError(409, 'This lead was already linked.');
  try {
    await writeAudit({ organizationId, event: 'lead_linked', actor, inquiryId: source.sourceInquiryId, leadId: input.targetLeadId, resolution: 'associated', reason: note || `Linked lead ${input.leadId}` });
  } catch (err) {
    await Lead.updateOne({ _id: input.leadId, organizationId }, { $set: { intakeIdentity: 'unverified' } }).catch(() => undefined);
    throw new ApiError(503, "This couldn't be saved right now. Please try again.");
  }
  await moveLeadRecords(organizationId, input.leadId, input.targetLeadId);
  if (source.sourceInquiryId) {
    await LeadInquiry.updateOne(
      { _id: source.sourceInquiryId, organizationId },
      { $set: { 'association.leadId': input.targetLeadId, 'association.outcome': 'appended', 'association.reason': 'staff_verified_link' } },
    );
  }
  await Lead.updateOne(
    { _id: input.targetLeadId, organizationId },
    { $set: { isRead: false, 'followUp.lastCustomerActivityAt': new Date() } },
  );
  await closeMergedLead(organizationId, input.leadId, 'Closed', `Linked to another lead after staff verification${note ? `: ${note}` : ''}`, actor);
  emitToOrg(organizationId, 'lead:update', { leadId: String(input.targetLeadId) });
  return { leadId: String(input.targetLeadId), resolution: 'associated' };
}

export type ActiveLeadLookup =
  | { leadClosed: false }
  | { leadClosed: true; status: 'single'; lead: ReturnType<typeof leadSummary> }
  | { leadClosed: true; status: 'multiple'; candidates: ReturnType<typeof leadSummary>[] }
  | { leadClosed: true; status: 'none' | 'uncertain' };

export async function findActiveLeadForClosedLead(organizationId: string, leadId: string): Promise<ActiveLeadLookup> {
  if (!isObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: leadId, organizationId })
    .select('status phone email identityEmailExcluded intakeIdentity')
    .lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!LIFECYCLE_TERMINAL_STATUSES.includes(lead.status)) return { leadClosed: false };
  if (lead.intakeIdentity === 'unverified') return { leadClosed: true, status: 'uncertain' };
  const inputs = await loadLeadAssociationInputs({
    organizationId,
    phone: lead.phone,
    email: lead.email,
    emailExcluded: lead.identityEmailExcluded,
  });
  const decision = decideLeadIntake({ ...inputs, policy: 'associate' });
  if (decision.action === 'append' && decision.leadId) {
    const active = await Lead.findOne({ _id: decision.leadId, organizationId }).select(LEAD_SUMMARY_FIELDS).lean();
    return active ? { leadClosed: true, status: 'single', lead: leadSummary(active) } : { leadClosed: true, status: 'uncertain' };
  }
  if (decision.action === 'review' && decision.reason === 'multiple_active_leads') {
    const candidates = await Lead.find({ _id: { $in: decision.candidateLeadIds }, organizationId }).select(LEAD_SUMMARY_FIELDS).lean();
    return { leadClosed: true, status: 'multiple', candidates: candidates.map(leadSummary) };
  }
  if (decision.action === 'review') return { leadClosed: true, status: 'uncertain' };
  return { leadClosed: true, status: 'none' };
}

export async function startFreshLeadFromClosedLead(input: {
  organizationId: string;
  leadId: string;
  note?: string | null;
  actor: ReviewActor;
}): Promise<LeadIntakeResult> {
  const { organizationId } = input;
  if (!isObjectId(input.leadId)) throw new ApiError(404, 'Lead not found');
  const lead: any = await Lead.findOne({ _id: input.leadId, organizationId }).lean();
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (!LIFECYCLE_TERMINAL_STATUSES.includes(lead.status)) throw new ApiError(409, 'This lead is still open. Reply from it directly.');
  if (lead.status === 'Do Not Contact') throw new ApiError(409, 'This customer asked not to be contacted.');
  if (lead.intakeIdentity === 'unverified') throw new ApiError(409, 'This chat was never verified. Ask an admin to review it before starting a new lead.');
  if ((await getLeadIntakeMode(organizationId)) !== 'active') {
    throw new ApiError(409, 'New leads from closed leads are not available right now.');
  }
  const result = await submitLeadInquiry({
    organizationId,
    kind: 'manual',
    receivedAt: new Date(),
    channel: lead.channel,
    source: lead.source,
    sourceProvider: lead.sourceProvider,
    contact: {
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      email: lead.email,
      emailExcluded: lead.identityEmailExcluded,
      assurance: 'staff_entered',
    },
    vehicle: lead.vehicle
      ? { year: lead.vehicle.year, make: lead.vehicle.make, model: lead.vehicle.model, trim: lead.vehicle.trim, vin: lead.vehicle.vin, stock: lead.vehicle.stock }
      : undefined,
    comments: input.note ? String(input.note).slice(0, 5000) : `Started from closed lead ${input.leadId} by ${input.actor.name || 'a team member'}.`,
    sourceIds: { providerInquiryKey: `fresh:${input.leadId}:${Date.now()}` },
    leadDraft: {
      ...(isObjectId(input.actor.userId) ? { createdBy: input.actor.userId } : {}),
      vehicle: lead.vehicle,
      vehicleId: lead.vehicleId,
      location: lead.location,
      identityEmailExcluded: lead.identityEmailExcluded,
    },
  });
  return result;
}
