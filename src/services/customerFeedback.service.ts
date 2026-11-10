import crypto from 'crypto';
import mongoose from 'mongoose';
import config from '../config';
import CustomerFeedback, { ICustomerFeedback } from '../models/CustomerFeedback.model';
import Lead from '../models/lead.model';
import Organization from '../models/Organization.model';
import AiAgentTask from '../models/AiAgentTask.model';
import { ApiError } from '../utils/ApiError';
import { notifyOrgAdmins } from '../utils/safeNotification';
import logger from '../utils/logger';

export const FEEDBACK_LINK_DAYS = 60;
export const LOW_RATING_MAX = 2;
const MAX_COMMENT = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedbackRequestInput {
  organizationId: string;
  leadId?: unknown;
  appointmentId?: unknown;
  automationRunId?: string | null;
  channel: 'sms' | 'email';
  source: 'automation' | 'appointment';
  name?: string;
  phone?: string;
  email?: string;
  reviewLink?: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function objectIdOrNull(value: unknown): mongoose.Types.ObjectId | null {
  const id = value ? String(value) : '';
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

export function feedbackPageBase(): string | null {
  const base = String(config.frontendUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : null;
}

export async function createFeedbackRequest(input: FeedbackRequestInput): Promise<{ id: string; url: string } | null> {
  const base = feedbackPageBase();
  if (!base) return null;
  const leadId = objectIdOrNull(input.leadId);
  const lead: any = leadId
    ? await Lead.findOne({ _id: leadId, organizationId: { $in: orgIdVariants(input.organizationId) } }).select('customerId').lean()
    : null;
  const token = crypto.randomBytes(16).toString('base64url');
  const doc = await CustomerFeedback.create({
    organizationId: String(input.organizationId),
    customerId: lead?.customerId || null,
    leadId: lead ? leadId : null,
    appointmentId: objectIdOrNull(input.appointmentId),
    automationRunId: input.automationRunId || null,
    channel: input.channel,
    source: input.source,
    contact: { name: String(input.name || '').slice(0, 160), phone: String(input.phone || ''), email: String(input.email || '') },
    reviewLink: input.reviewLink || null,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + FEEDBACK_LINK_DAYS * DAY_MS),
  });
  return { id: String(doc._id), url: `${base}/feedback/${token}` };
}

export async function discardFeedbackRequest(id: string | null | undefined): Promise<void> {
  if (!id || !mongoose.isValidObjectId(id)) return;
  await CustomerFeedback.deleteOne({ _id: id, status: 'requested' }).catch((err) => logger.warn({ err, id }, '[CustomerFeedback] Unused request was not removed'));
}

async function loadByToken(token: unknown): Promise<ICustomerFeedback> {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) throw new ApiError(404, 'This feedback link is not valid');
  const doc = await CustomerFeedback.findOne({ tokenHash: hashToken(value) });
  if (!doc) throw new ApiError(404, 'This feedback link is not valid');
  return doc;
}

async function dealershipName(orgId: string): Promise<string> {
  if (!mongoose.isValidObjectId(orgId)) return 'the dealership';
  const org: any = await Organization.findById(orgId).select('name').lean().catch(() => null);
  return String(org?.name || '').trim() || 'the dealership';
}

function publicView(doc: ICustomerFeedback, dealership: string) {
  return {
    dealershipName: dealership,
    firstName: String(doc.contact?.name || '').trim().split(/\s+/)[0] || '',
    reviewLink: doc.reviewLink || null,
    rating: doc.rating ?? null,
    comment: doc.comment || '',
    answeredAt: doc.answeredAt || null,
    expired: doc.expiresAt.getTime() <= Date.now(),
  };
}

export async function getPublicFeedback(token: unknown) {
  const doc = await loadByToken(token);
  return publicView(doc, await dealershipName(doc.organizationId));
}

async function raiseLowRating(doc: ICustomerFeedback): Promise<void> {
  const name = String(doc.contact?.name || '').trim() || 'A customer';
  const stars = `${doc.rating} star${doc.rating === 1 ? '' : 's'}`;
  const comment = doc.comment ? ` They wrote: "${doc.comment.slice(0, 240)}"` : ' They left no comment.';
  if (doc.leadId) {
    await AiAgentTask.create({
      organizationId: doc.organizationId,
      leadId: doc.leadId,
      channel: doc.channel,
      question: `Low rating: ${name} gave ${stars}.${comment} Please reach out and make it right.`.slice(0, 500),
      assigneeIds: [],
      status: 'pending',
      waitingSince: new Date(),
    });
  }
  const route = doc.customerId ? `/crm/customers/${doc.customerId}` : doc.leadId ? `/crm/leads?leadId=${doc.leadId}` : '/crm/customers';
  await notifyOrgAdmins(doc.organizationId, 'crm_task_assigned', `Low rating from ${name}`, `${name} gave ${stars}.${comment}`.slice(0, 400), {
    route,
    leadId: doc.leadId ? String(doc.leadId) : undefined,
    customerId: doc.customerId ? String(doc.customerId) : undefined,
  });
}

export async function submitPublicFeedback(token: unknown, body: any) {
  const doc = await loadByToken(token);
  if (doc.expiresAt.getTime() <= Date.now()) throw new ApiError(410, 'This feedback link has expired');
  const rating = Number(body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError(400, 'Pick from 1 to 5 stars');
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > MAX_COMMENT) throw new ApiError(400, `Please keep the comment under ${MAX_COMMENT} characters`);
  const now = new Date();
  const updated = await CustomerFeedback.findOneAndUpdate(
    { _id: doc._id },
    { $set: { rating, comment, status: 'answered', answeredAt: now } },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'This feedback link is not valid');
  if (rating <= LOW_RATING_MAX) {
    const claimed = await CustomerFeedback.findOneAndUpdate({ _id: doc._id, lowRatingTaskAt: null }, { $set: { lowRatingTaskAt: now } }, { new: true });
    if (claimed) {
      await raiseLowRating(claimed).catch((err) => logger.error({ err, feedbackId: String(doc._id) }, '[CustomerFeedback] Low rating task was not created'));
    }
  }
  return publicView(updated, await dealershipName(updated.organizationId));
}

export async function listCustomerFeedback(orgId: string, customerId: string) {
  if (!mongoose.isValidObjectId(customerId)) throw new ApiError(404, 'Customer not found');
  const leads = await Lead.find({ organizationId: { $in: orgIdVariants(orgId) }, customerId }).select('_id').lean();
  const docs = await CustomerFeedback.find({
    organizationId: String(orgId),
    $or: [{ customerId: new mongoose.Types.ObjectId(customerId) }, { leadId: { $in: leads.map((lead: any) => lead._id) } }],
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const answered = docs.filter((doc: any) => doc.status === 'answered' && doc.rating);
  const average = answered.length ? Math.round((answered.reduce((sum: number, doc: any) => sum + doc.rating, 0) / answered.length) * 10) / 10 : null;
  return {
    average,
    answered: answered.length,
    requested: docs.length,
    items: docs.map((doc: any) => ({
      id: String(doc._id),
      status: doc.status,
      rating: doc.rating ?? null,
      comment: doc.comment || '',
      channel: doc.channel,
      source: doc.source,
      leadId: doc.leadId ? String(doc.leadId) : null,
      requestedAt: doc.createdAt,
      answeredAt: doc.answeredAt || null,
      lowRating: Boolean(doc.lowRatingTaskAt),
      expired: new Date(doc.expiresAt).getTime() <= Date.now(),
    })),
  };
}
