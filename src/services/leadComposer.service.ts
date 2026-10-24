import crypto from 'crypto';
import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import ComposerSendClaim, { ComposerSendChannel } from '../models/ComposerSendClaim.model';
import { ApiError } from '../utils/ApiError';
import { CLOSED_LEAD_SEND_MESSAGE, isClosedForManualSend } from '../utils/closedLeadGuard';
import { PHONE_EXTENSION_MESSAGE, manualSmsPhoneProblem } from '../utils/manualSmsPhone';
import { resolveSmsDestination } from '../utils/smsDestination';
import { LEAD_SOURCE_EMAILS, NO_CUSTOMER_EMAIL_MESSAGE, resolveLeadReplyRecipient } from '../utils/leadReplyRecipient';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { resolveLeadEmailSubject } from '../utils/leadEmailSubject';
import { contactRestrictionMessage, resolveContactRestriction } from './contactRestriction.service';
import { isSmsOptedOut } from './communication.service';
import * as telnyx from './telnyx.service';

export const COMPOSER_SEND_LEASE_MS = 2 * 60 * 1000;
export const COMPOSER_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SEND_IN_PROGRESS_CODE = 'SEND_IN_PROGRESS';
export const SEND_UNCERTAIN_CODE = 'SEND_UNCERTAIN';
export const SEND_REQUEST_MISMATCH_CODE = 'SEND_REQUEST_MISMATCH';

export const COMPOSER_MESSAGES = {
  inProgress: 'This message is still being sent. Wait a moment, then check the conversation.',
  uncertain: "We couldn't confirm whether this message went out. Check the conversation before sending it again.",
  mismatch: "This message changed after it was sent. Refresh the conversation and send it again if it's still needed.",
  webchatOnly: 'This is a Web Chat lead, so replies go to the chat.',
  noValidPhone: "This lead has no valid phone number, so a text can't be sent. Add a phone number in the contact details.",
  phoneExtension:
    "This lead's phone number includes an extension or other characters, so a text can't be sent. Edit the phone number in the contact details so it only has the phone digits.",
  smsOptedOut: 'This customer replied STOP, so texting is turned off. Texting turns back on only after they reply START.',
  smsNotSetUp: "Texting isn't set up for this dealership yet.",
  emailNotConnected: "Email isn't connected for this dealership yet, so email replies can't be sent. An admin can connect it in CRM settings.",
  unconfirmedEmail:
    "This lead only has the original sender address, which isn't confirmed as the customer's email. Add the customer's email in the contact details before replying.",
  phoneChanged: "This lead's phone number changed. Refresh the conversation and check the number before sending.",
};

export interface ReplyChannelOption {
  available: boolean;
  code: string | null;
  reason: string | null;
  recipient: string | null;
}

export interface LeadReplyOptions {
  leadId: string;
  mode: 'webchat' | 'direct';
  defaultChannel: ComposerSendChannel | null;
  sms: ReplyChannelOption;
  email: ReplyChannelOption & { subject: string; subjectLocked: boolean };
}

const LEAD_FIELDS = '_id status channel phone email senderEmail centralIngestion subject threadId emailThreadSubject customerId';
const UNUSABLE_PHONE_REASONS = new Set(['missing', 'incomplete', 'invalid']);
const EXTENSION_PHONE_REASONS = new Set(['extension', 'unsupported_characters']);

function blocked(code: string, reason: string, recipient: string | null = null): ReplyChannelOption {
  return { available: false, code, reason, recipient };
}

function prefersText(lead: any): boolean {
  const channel = String(lead?.channel || '').toLowerCase();
  if (channel === 'sms' || channel === 'phone') return true;
  return String(lead?.phone || '').replace(/\D/g, '').length >= 7;
}

async function smsOption(organizationId: string, lead: any): Promise<ReplyChannelOption> {
  const raw = String(lead.phone || '').trim();
  if (!raw) return blocked('NO_PHONE', COMPOSER_MESSAGES.noValidPhone);
  const phoneProblem = manualSmsPhoneProblem(raw);
  if (phoneProblem) {
    return blocked(
      'SMS_INVALID_DESTINATION',
      phoneProblem === PHONE_EXTENSION_MESSAGE ? COMPOSER_MESSAGES.phoneExtension : COMPOSER_MESSAGES.noValidPhone,
    );
  }
  const destination = resolveSmsDestination(raw, 'manual');
  if (!destination.ok) {
    const reason = UNUSABLE_PHONE_REASONS.has(destination.reason)
      ? COMPOSER_MESSAGES.noValidPhone
      : EXTENSION_PHONE_REASONS.has(destination.reason)
        ? COMPOSER_MESSAGES.phoneExtension
        : destination.message;
    return blocked('SMS_INVALID_DESTINATION', reason);
  }
  if (!telnyx.COMPANY_NUMBER) return blocked('SMS_NOT_SET_UP', COMPOSER_MESSAGES.smsNotSetUp, destination.e164);
  if (await isSmsOptedOut(organizationId, destination.e164)) {
    return blocked('SMS_OPTED_OUT', COMPOSER_MESSAGES.smsOptedOut, destination.e164);
  }
  return { available: true, code: null, reason: null, recipient: destination.e164 };
}

function hasUnconfirmedAddress(lead: any, dealershipAddresses: unknown[]): boolean {
  if (normalizeIdentityEmail(lead.email)) return true;
  const sender = normalizeIdentityEmail(lead.senderEmail);
  if (!sender) return false;
  if (String(lead.channel || '').toLowerCase() === 'adf' || lead.centralIngestion === true) return false;
  const internal = [...LEAD_SOURCE_EMAILS, ...dealershipAddresses].map((address) => normalizeIdentityEmail(address));
  return !internal.includes(sender);
}

function emailOption(lead: any, config: any, emailConnected: boolean): ReplyChannelOption {
  const dealershipAddresses = [config?.gmailAddress, config?.leadSourceEmail];
  const recipient = resolveLeadReplyRecipient(lead, dealershipAddresses);
  if (!recipient) {
    return hasUnconfirmedAddress(lead, dealershipAddresses)
      ? blocked('NO_CUSTOMER_EMAIL', COMPOSER_MESSAGES.unconfirmedEmail)
      : blocked('NO_CUSTOMER_EMAIL', NO_CUSTOMER_EMAIL_MESSAGE);
  }
  if (!emailConnected) {
    return blocked('EMAIL_NOT_CONNECTED', COMPOSER_MESSAGES.emailNotConnected, recipient);
  }
  return { available: true, code: null, reason: null, recipient };
}

export async function getLeadReplyOptions(organizationId: unknown, leadId: unknown): Promise<LeadReplyOptions> {
  const orgId = String(organizationId || '');
  if (!mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(String(leadId || ''))) {
    throw new ApiError(404, 'Lead not found');
  }
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgId }).select(LEAD_FIELDS).lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const { subject, locked } = resolveLeadEmailSubject(lead);
  if (String(lead.channel || '').toLowerCase() === 'webchat') {
    const webchatOnly = blocked('WEBCHAT_ONLY', COMPOSER_MESSAGES.webchatOnly);
    return {
      leadId: String(lead._id),
      mode: 'webchat',
      defaultChannel: null,
      sms: webchatOnly,
      email: { ...webchatOnly, subject, subjectLocked: locked },
    };
  }

  const [config, emailConnected] = await Promise.all([
    OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).select('gmailAddress leadSourceEmail').lean(),
    OrgLeadConfig.exists({ organizationId: orgId, isActive: true, gmailConnected: true, refreshToken: { $nin: [null, ''] } }),
  ]);
  let sms = await smsOption(orgId, lead);
  let email = emailOption(lead, config, Boolean(emailConnected));

  const restriction = await resolveContactRestriction({
    organizationId: orgId,
    leadId: lead._id,
    phone: lead.phone,
    email: email.recipient || undefined,
    customerId: lead.customerId,
  });
  const restrictionReason = contactRestrictionMessage(restriction);
  if (restrictionReason) {
    const code = restriction.status === 'restricted' ? 'CONTACT_RESTRICTED' : 'CONTACT_RESTRICTION_UNAVAILABLE';
    sms = blocked(code, restrictionReason, sms.recipient);
    email = blocked(code, restrictionReason, email.recipient);
  }
  if (await isClosedForManualSend(orgId, lead)) {
    sms = blocked('lead_closed', CLOSED_LEAD_SEND_MESSAGE, sms.recipient);
    email = blocked('lead_closed', CLOSED_LEAD_SEND_MESSAGE, email.recipient);
  }

  return {
    leadId: String(lead._id),
    mode: 'direct',
    defaultChannel: prefersText(lead) ? 'sms' : 'email',
    sms,
    email: { ...email, subject, subjectLocked: locked },
  };
}

export function normalizeClientRequestId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : null;
}

export function composerRequestHash(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export type ComposerSendStart =
  | { kind: 'proceed'; claimId: mongoose.Types.ObjectId }
  | { kind: 'duplicate'; result: Record<string, unknown> };

function composerError(statusCode: number, message: string, code: string) {
  return new ApiError(statusCode, message, [{ code }]);
}

export async function beginComposerSend(input: {
  organizationId: unknown;
  leadId: unknown;
  channel: ComposerSendChannel;
  clientRequestId: string;
  requestHash: string;
  userId?: unknown;
}): Promise<ComposerSendStart> {
  const now = new Date();
  const key = { organizationId: input.organizationId, channel: input.channel, clientRequestId: input.clientRequestId };
  try {
    const created = await ComposerSendClaim.create({
      ...key,
      leadId: input.leadId,
      requestHash: input.requestHash,
      userId: input.userId ? String(input.userId) : null,
      state: 'sending',
      attempts: 1,
      leaseExpiresAt: new Date(now.getTime() + COMPOSER_SEND_LEASE_MS),
      expiresAt: new Date(now.getTime() + COMPOSER_CLAIM_TTL_MS),
    });
    return { kind: 'proceed', claimId: created._id as mongoose.Types.ObjectId };
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }

  const existing: any = await ComposerSendClaim.findOne(key).lean();
  if (!existing) throw composerError(409, COMPOSER_MESSAGES.inProgress, SEND_IN_PROGRESS_CODE);
  if (String(existing.leadId) !== String(input.leadId) || existing.requestHash !== input.requestHash) {
    throw composerError(409, COMPOSER_MESSAGES.mismatch, SEND_REQUEST_MISMATCH_CODE);
  }
  if (existing.state === 'sent') return { kind: 'duplicate', result: existing.result || {} };
  if (existing.state === 'uncertain') throw composerError(409, COMPOSER_MESSAGES.uncertain, SEND_UNCERTAIN_CODE);
  if (existing.state === 'sending') {
    if (existing.leaseExpiresAt && new Date(existing.leaseExpiresAt) > now) {
      throw composerError(409, COMPOSER_MESSAGES.inProgress, SEND_IN_PROGRESS_CODE);
    }
    await ComposerSendClaim.updateOne(
      { _id: existing._id, state: 'sending', leaseExpiresAt: existing.leaseExpiresAt },
      { $set: { state: 'uncertain', leaseExpiresAt: null, lastError: 'The earlier send attempt stopped before it finished' } },
    );
    throw composerError(409, COMPOSER_MESSAGES.uncertain, SEND_UNCERTAIN_CODE);
  }
  const retried = await ComposerSendClaim.findOneAndUpdate(
    { _id: existing._id, state: 'failed', requestHash: input.requestHash },
    {
      $set: { state: 'sending', leaseExpiresAt: new Date(now.getTime() + COMPOSER_SEND_LEASE_MS), lastError: null },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
  if (!retried) throw composerError(409, COMPOSER_MESSAGES.inProgress, SEND_IN_PROGRESS_CODE);
  return { kind: 'proceed', claimId: retried._id as mongoose.Types.ObjectId };
}

export async function finishComposerSend(
  claimId: mongoose.Types.ObjectId,
  outcome: { state: 'sent'; result: Record<string, unknown> } | { state: 'failed' | 'uncertain'; error?: unknown },
): Promise<void> {
  const update: Record<string, unknown> = { state: outcome.state, leaseExpiresAt: null };
  if (outcome.state === 'sent') update.result = outcome.result;
  else update.lastError = String((outcome.error as any)?.message || outcome.error || '').slice(0, 500) || null;
  await ComposerSendClaim.updateOne({ _id: claimId, state: 'sending' }, { $set: update }).catch(() => undefined);
}
