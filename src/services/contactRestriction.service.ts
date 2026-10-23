import mongoose from 'mongoose';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import ContactRestrictionAudit, {
  ContactRestrictionAuditEvent,
  IContactRestrictionAuditActor,
} from '../models/ContactRestrictionAudit.model';
import ContactRestrictionIdentifier from '../models/ContactRestrictionIdentifier.model';
import { ApiError } from '../utils/ApiError';
import { CONTACT_RESTRICTED_STATUSES, isContactRestrictedStatus } from '../constants/leadStatus';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import { LEAD_SOURCE_EMAILS } from '../utils/leadReplyRecipient';
import logger from '../utils/logger';

export const CONTACT_RESTRICTED_CODE = 'CONTACT_RESTRICTED';
export const CONTACT_RESTRICTION_UNAVAILABLE_CODE = 'CONTACT_RESTRICTION_UNAVAILABLE';
export const CONTACT_RESTRICTION_ADMIN_ONLY_CODE = 'CONTACT_RESTRICTION_ADMIN_ONLY';
export const CONTACT_RESTRICTION_REASON_REQUIRED_CODE = 'CONTACT_RESTRICTION_REASON_REQUIRED';
export const LEAD_STATUS_CHANGED_CODE = 'LEAD_STATUS_CHANGED';
export const WEBCHAT_RESPONSE_WINDOW_MINUTES = 30;
export const WEBCHAT_RESPONSE_WINDOW_MS = WEBCHAT_RESPONSE_WINDOW_MINUTES * 60 * 1000;

export const CONTACT_RESTRICTION_MESSAGES = {
  restricted: "This customer is marked Do Not Contact, so messages can't be sent. Only an admin can remove Do Not Contact.",
  restrictedElsewhere:
    "This customer is marked Do Not Contact on another lead, so messages can't be sent. Only an admin can remove Do Not Contact.",
  unavailable: "We couldn't confirm this customer can be contacted, so nothing was sent. Please try again in a moment.",
  webchatWindowClosed:
    'This customer is marked Do Not Contact. You can reply in this chat only within 30 minutes of a new message from them.',
  adminOnly: 'Only an organization admin can remove Do Not Contact from a lead.',
  reasonRequired: 'A reason is required to remove Do Not Contact.',
  statusLocked: 'This lead is marked Do Not Contact. Only an admin can change its status, using the status menu with a reason.',
  statusChanged: 'This lead was just changed by someone else. Refresh it and try again.',
  contactEditAdminOnly: 'Only an organization admin can change the phone or email of a lead marked Do Not Contact.',
  contactEditReasonRequired: 'A reason is required to change the phone or email of a lead marked Do Not Contact.',
};

export interface ContactRestrictionTarget {
  organizationId: unknown;
  phone?: unknown;
  email?: unknown;
  leadId?: unknown;
  customerId?: unknown;
}

export type ContactRestrictionCheck =
  | { status: 'allowed' }
  | { status: 'restricted'; leadIds: string[]; onThisLead: boolean }
  | { status: 'unavailable' };

export type ContactRestrictionReasonCode = 'do_not_contact' | 'restriction_lookup_unavailable' | 'webchat_window_closed';

export class ContactRestrictedError extends ApiError {
  readonly restricted: boolean;
  readonly leadIds: string[];
  readonly reasonCode: ContactRestrictionReasonCode;

  constructor(
    check: Exclude<ContactRestrictionCheck, { status: 'allowed' }>,
    options: { message?: string; reasonCode?: ContactRestrictionReasonCode } = {},
  ) {
    const restricted = check.status === 'restricted';
    const leadIds = restricted ? check.leadIds : [];
    const reasonCode = options.reasonCode || (restricted ? 'do_not_contact' : 'restriction_lookup_unavailable');
    const message = options.message
      || (!restricted
        ? CONTACT_RESTRICTION_MESSAGES.unavailable
        : check.onThisLead
          ? CONTACT_RESTRICTION_MESSAGES.restricted
          : CONTACT_RESTRICTION_MESSAGES.restrictedElsewhere);
    super(restricted ? 403 : 503, message, [
      { code: restricted ? CONTACT_RESTRICTED_CODE : CONTACT_RESTRICTION_UNAVAILABLE_CODE, leadIds, reason: reasonCode },
    ]);
    this.name = 'ContactRestrictedError';
    this.restricted = restricted;
    this.leadIds = leadIds;
    this.reasonCode = reasonCode;
  }

  get skipReason(): string {
    return `${this.message} (${this.reasonCode})`;
  }
}

export function isContactRestrictedError(err: unknown): err is ContactRestrictedError {
  return err instanceof ContactRestrictedError;
}

export function isDoNotContactError(err: unknown): err is ContactRestrictedError {
  return isContactRestrictedError(err) && err.restricted;
}

export function contactRestrictionMessage(check: ContactRestrictionCheck): string | null {
  if (check.status === 'allowed') return null;
  return new ContactRestrictedError(check).message;
}

export function contactRestrictionSkipReason(check: ContactRestrictionCheck): string | null {
  if (check.status === 'allowed') return null;
  return new ContactRestrictedError(check).skipReason;
}

export function auditActorFromRef(ref: { userId?: unknown; name?: unknown } | null | undefined): IContactRestrictionAuditActor {
  const userId = ref?.userId ? String(ref.userId) : null;
  const name = ref?.name ? String(ref.name) : null;
  if (userId === 'system') return { kind: 'system', userId, name };
  if (userId === 'ai-agent') return { kind: 'ai', userId, name };
  return { kind: userId ? 'staff' : 'system', userId, name };
}

export interface ContactAuditContext {
  channel?: 'sms' | 'email' | 'webchat';
  purpose?: string;
  actor?: IContactRestrictionAuditActor;
}

export interface ContactRestrictionAuditInput {
  organizationId: unknown;
  event: ContactRestrictionAuditEvent;
  actor: IContactRestrictionAuditActor;
  leadId?: unknown;
  channel?: 'sms' | 'email' | 'webchat';
  purpose?: string;
  outcome?: 'restricted' | 'unavailable';
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  previousContact?: { phone?: string | null; email?: string | null };
  newContact?: { phone?: string | null; email?: string | null };
  restrictingLeadIds?: string[];
  sessionId?: unknown;
  messageId?: unknown;
  respondingToMessageId?: unknown;
}

const objectIdOrNull = (value: unknown) =>
  value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;

export async function recordContactRestrictionAudit(entry: ContactRestrictionAuditInput): Promise<boolean> {
  const organizationId = objectIdOrNull(entry.organizationId);
  if (!organizationId) return false;
  try {
    await ContactRestrictionAudit.create({
      organizationId,
      leadId: objectIdOrNull(entry.leadId),
      event: entry.event,
      actor: entry.actor,
      channel: entry.channel ?? null,
      purpose: entry.purpose ?? null,
      outcome: entry.outcome ?? null,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      reason: entry.reason ?? null,
      previousContact: entry.previousContact ?? null,
      newContact: entry.newContact ?? null,
      restrictingLeadIds: (entry.restrictingLeadIds || []).map(objectIdOrNull).filter(Boolean),
      sessionId: objectIdOrNull(entry.sessionId),
      messageId: objectIdOrNull(entry.messageId),
      respondingToMessageId: objectIdOrNull(entry.respondingToMessageId),
    });
    return true;
  } catch (err) {
    logger.error({ err, organizationId: String(organizationId), event: entry.event }, '[ContactRestriction] Could not write the permanent audit record');
    return false;
  }
}

export async function isOrganizationAdmin(
  user: { _id?: unknown; id?: unknown } | null | undefined,
  organizationId: unknown,
): Promise<boolean> {
  const userId = String(user?._id || user?.id || '');
  const orgId = String(organizationId || '');
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(orgId)) return false;
  try {
    const { default: CrmUser } = await import('../models/CrmUser.model');
    const crmUser: any = await CrmUser.findOne({ _id: userId, organizationId: orgId }).select('role isActive').lean();
    if (crmUser) return crmUser.role === 'admin' && crmUser.isActive !== false;
    const { default: User } = await import('../models/User.model');
    const mainUser: any = await User.findOne({ _id: userId, organizationId: orgId }).select('role organizationRole isActive').lean();
    if (!mainUser || mainUser.isActive === false || mainUser.role === 'super_admin') return false;
    return mainUser.organizationRole === 'admin' || mainUser.role === 'admin';
  } catch (err) {
    logger.warn({ err, organizationId: orgId }, '[ContactRestriction] Admin check failed; treating the user as not authorized');
    return false;
  }
}

async function dealershipAddresses(organizationId: string): Promise<Set<string>> {
  const config: any = await OrgLeadConfig.findOne({ organizationId, isActive: true })
    .select('gmailAddress leadSourceEmail')
    .lean();
  return new Set(
    [...LEAD_SOURCE_EMAILS, config?.gmailAddress, config?.leadSourceEmail]
      .map((address) => normalizeIdentityEmail(address))
      .filter((address): address is string => Boolean(address)),
  );
}

export async function resolveContactRestriction(target: ContactRestrictionTarget): Promise<ContactRestrictionCheck> {
  const organizationId = String(target.organizationId || '');
  try {
    if (!mongoose.isValidObjectId(organizationId)) return { status: 'unavailable' };
    const { findContactRestriction } = await import('./leadLifecycle.service');
    const { default: Lead } = await import('../models/lead.model');
    const phones = new Set<string>();
    const emails = new Set<string>();
    const customerIds = new Set<string>();
    const restrictedLeadIds = new Set<string>();
    const addPhone = (value: unknown) => {
      const phone = normalizeIdentityPhone(value);
      if (phone) phones.add(phone);
    };
    const addEmail = (value: unknown) => {
      const email = normalizeIdentityEmail(value);
      if (email) emails.add(email);
    };
    const addCustomer = (value: unknown) => {
      if (value && mongoose.isValidObjectId(value)) customerIds.add(String(value));
    };

    addPhone(target.phone);
    addEmail(target.email);
    addCustomer(target.customerId);

    const leadId = target.leadId ? String(target.leadId) : '';
    if (leadId) {
      if (!mongoose.isValidObjectId(leadId)) return { status: 'unavailable' };
      const lead: any = await Lead.findOne({ _id: leadId, organizationId })
        .select('_id status phone email identityEmailExcluded customerId')
        .lean();
      if (lead) {
        if (isContactRestrictedStatus(lead.status)) restrictedLeadIds.add(String(lead._id));
        addPhone(lead.phone);
        if (!lead.identityEmailExcluded) addEmail(lead.email);
        addCustomer(lead.customerId);
      }
    }

    if (emails.size) {
      const blocked = await dealershipAddresses(organizationId);
      for (const email of [...emails]) if (blocked.has(email)) emails.delete(email);
    }

    const phoneList = [...phones];
    const emailList = [...emails];
    const customerList = [...customerIds];
    const lookups = Array.from({ length: Math.max(phoneList.length, emailList.length, customerList.length) }, (_, index) =>
      findContactRestriction({
        organizationId,
        phone: phoneList[index],
        email: emailList[index],
        customerId: customerList[index],
      }),
    );
    for (const result of await Promise.all(lookups)) result.leadIds.forEach((id) => restrictedLeadIds.add(id));

    const identifierConditions: Record<string, unknown>[] = [];
    if (phoneList.length) identifierConditions.push({ kind: 'phone', value: { $in: phoneList } });
    if (emailList.length) identifierConditions.push({ kind: 'email', value: { $in: emailList } });
    if (identifierConditions.length) {
      const protectedIdentifiers = await ContactRestrictionIdentifier.find({
        organizationId,
        active: true,
        $or: identifierConditions,
      })
        .select('leadId')
        .limit(200)
        .maxTimeMS(5000)
        .lean();
      for (const identifier of protectedIdentifiers) restrictedLeadIds.add(String(identifier.leadId));
    }

    if (!restrictedLeadIds.size) return { status: 'allowed' };
    return { status: 'restricted', leadIds: [...restrictedLeadIds], onThisLead: Boolean(leadId && restrictedLeadIds.has(leadId)) };
  } catch (err) {
    logger.warn({ err, organizationId }, '[ContactRestriction] Do Not Contact lookup failed; treating the customer as not contactable');
    return { status: 'unavailable' };
  }
}

export async function checkContactForSend(
  target: ContactRestrictionTarget,
  context: ContactAuditContext = {},
): Promise<ContactRestrictionCheck> {
  const check = await resolveContactRestriction(target);
  if (check.status !== 'allowed') {
    await recordContactRestrictionAudit({
      organizationId: target.organizationId,
      leadId: target.leadId,
      event: 'outbound_blocked',
      actor: context.actor || { kind: 'system' },
      channel: context.channel,
      purpose: context.purpose,
      outcome: check.status,
      restrictingLeadIds: check.status === 'restricted' ? check.leadIds : [],
    });
  }
  return check;
}

export async function assertContactAllowed(target: ContactRestrictionTarget, context: ContactAuditContext = {}): Promise<void> {
  const check = await checkContactForSend(target, context);
  if (check.status !== 'allowed') throw new ContactRestrictedError(check);
}

export async function protectPreviousContact(input: {
  organizationId: unknown;
  leadId: unknown;
  previous: { phone?: unknown; email?: unknown; identityEmailExcluded?: boolean };
  next: { phone?: unknown; email?: unknown };
  actorUserId?: unknown;
}): Promise<{ phone?: string; email?: string }> {
  const organizationId = String(input.organizationId || '');
  const leadId = String(input.leadId || '');
  if (!mongoose.isValidObjectId(organizationId) || !mongoose.isValidObjectId(leadId)) {
    throw new Error('A valid organization and lead are required to protect previous contact details');
  }
  const protectedValues: { phone?: string; email?: string } = {};
  let blocked: Set<string> | null = null;
  const isDealershipAddress = async (email: string) => {
    blocked = blocked || await dealershipAddresses(organizationId);
    return blocked.has(email);
  };
  const previousPhone = normalizeIdentityPhone(input.previous.phone);
  const nextPhone = normalizeIdentityPhone(input.next.phone);
  if (previousPhone && previousPhone !== nextPhone) protectedValues.phone = previousPhone;
  const previousEmail = input.previous.identityEmailExcluded ? null : normalizeIdentityEmail(input.previous.email);
  const nextEmail = normalizeIdentityEmail(input.next.email);
  if (previousEmail && previousEmail !== nextEmail && !(await isDealershipAddress(previousEmail))) {
    protectedValues.email = previousEmail;
  }
  const identifiers: Array<[string, string]> = Object.entries(protectedValues) as Array<[string, string]>;
  if (nextPhone && nextPhone !== previousPhone) identifiers.push(['phone', nextPhone]);
  if (nextEmail && nextEmail !== previousEmail && !(await isDealershipAddress(nextEmail))) identifiers.push(['email', nextEmail]);
  for (const [kind, value] of identifiers) {
    await ContactRestrictionIdentifier.updateOne(
      { organizationId, leadId, kind, value, active: true },
      { $setOnInsert: { organizationId, leadId, kind, value, active: true, createdBy: input.actorUserId ? String(input.actorUserId) : null } },
      { upsert: true },
    );
  }
  return protectedValues;
}

export async function releaseProtectedContacts(input: { organizationId: unknown; leadId: unknown; actorUserId?: unknown }): Promise<void> {
  const organizationId = String(input.organizationId || '');
  const leadId = String(input.leadId || '');
  if (!mongoose.isValidObjectId(organizationId) || !mongoose.isValidObjectId(leadId)) return;
  await ContactRestrictionIdentifier.updateMany(
    { organizationId, leadId, active: true },
    { $set: { active: false, releasedAt: new Date(), releasedBy: input.actorUserId ? String(input.actorUserId) : null } },
  );
}

function restrictionStartFromHistory(lead: any): Date | null {
  const entries = (Array.isArray(lead?.statusHistory) ? lead.statusHistory : [])
    .filter((entry: any) => isContactRestrictedStatus(entry?.to) && entry?.changedAt)
    .map((entry: any) => new Date(entry.changedAt))
    .filter((date: Date) => !Number.isNaN(date.getTime()));
  if (!entries.length) return null;
  return new Date(Math.max(...entries.map((date: Date) => date.getTime())));
}

export async function restrictedSince(organizationId: unknown, leadIds: string[]): Promise<Date | null> {
  const orgId = String(organizationId || '');
  const ids = leadIds.filter((id) => mongoose.isValidObjectId(id));
  if (!mongoose.isValidObjectId(orgId) || !ids.length || ids.length !== leadIds.length) return null;
  const { default: Lead } = await import('../models/lead.model');
  const leads: any[] = await Lead.find({ _id: { $in: ids }, organizationId: orgId })
    .select('_id status statusHistory updatedAt')
    .limit(ids.length)
    .lean();
  if (leads.length !== ids.length) return null;
  let latest = 0;
  for (const lead of leads) {
    if (!CONTACT_RESTRICTED_STATUSES.includes(String(lead.status || '').trim())) return null;
    let since = restrictionStartFromHistory(lead);
    if (!since) {
      const applied: any = await ContactRestrictionAudit.findOne({ organizationId: orgId, leadId: lead._id, event: 'dnc_applied' })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();
      since = applied?.createdAt ? new Date(applied.createdAt) : lead.updatedAt ? new Date(lead.updatedAt) : null;
    }
    if (!since) return null;
    latest = Math.max(latest, since.getTime());
  }
  return new Date(latest);
}

export interface WebchatSessionLike {
  _id: unknown;
  organizationId: unknown;
  leadId: unknown;
  visitorPhone?: unknown;
  visitorEmail?: unknown;
}

export function webchatRestrictionTarget(session: WebchatSessionLike): ContactRestrictionTarget {
  return {
    organizationId: session.organizationId,
    leadId: session.leadId,
    phone: session.visitorPhone,
    email: session.visitorEmail,
  };
}

export type WebchatReplyDecision =
  | { allowed: true; basis: 'not_restricted' }
  | {
      allowed: true;
      basis: 'dnc_live_session';
      respondingToMessageId: string;
      windowEndsAt: Date;
      restrictingLeadIds: string[];
    }
  | {
      allowed: false;
      check: Exclude<ContactRestrictionCheck, { status: 'allowed' }>;
      reasonCode: ContactRestrictionReasonCode;
    };

async function latestInboundWebchatMessage(session: WebchatSessionLike): Promise<{ _id: unknown; createdAt: Date } | null> {
  const { default: WebChatMessage } = await import('../models/WebChatMessage.model');
  const latest: any = await WebChatMessage.findOne({
    sessionId: session._id,
    organizationId: String(session.organizationId),
    direction: 'inbound',
  })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean();
  return latest?.createdAt ? { _id: latest._id, createdAt: new Date(latest.createdAt) } : null;
}

export async function authorizeWebchatReply(session: WebchatSessionLike, now: Date = new Date()): Promise<WebchatReplyDecision> {
  const check = await resolveContactRestriction(webchatRestrictionTarget(session));
  if (check.status === 'allowed') return { allowed: true, basis: 'not_restricted' };
  if (check.status === 'unavailable') return { allowed: false, check, reasonCode: 'restriction_lookup_unavailable' };
  try {
    const [latest, since] = await Promise.all([
      latestInboundWebchatMessage(session),
      restrictedSince(session.organizationId, check.leadIds),
    ]);
    if (latest && since && latest.createdAt.getTime() > since.getTime()) {
      const windowEndsAt = new Date(latest.createdAt.getTime() + WEBCHAT_RESPONSE_WINDOW_MS);
      if (windowEndsAt.getTime() > now.getTime()) {
        return {
          allowed: true,
          basis: 'dnc_live_session',
          respondingToMessageId: String(latest._id),
          windowEndsAt,
          restrictingLeadIds: check.leadIds,
        };
      }
    }
    return { allowed: false, check, reasonCode: 'webchat_window_closed' };
  } catch (err) {
    logger.warn({ err, sessionId: String(session._id) }, '[ContactRestriction] Web Chat reply check failed; blocking the reply');
    return { allowed: false, check: { status: 'unavailable' }, reasonCode: 'restriction_lookup_unavailable' };
  }
}

export function webchatReplyError(decision: Extract<WebchatReplyDecision, { allowed: false }>): ContactRestrictedError {
  return new ContactRestrictedError(decision.check, {
    reasonCode: decision.reasonCode,
    ...(decision.reasonCode === 'webchat_window_closed' ? { message: CONTACT_RESTRICTION_MESSAGES.webchatWindowClosed } : {}),
  });
}

export async function assertWebchatReplyAllowed(
  session: WebchatSessionLike,
  context: { purpose: string; actor: IContactRestrictionAuditActor },
): Promise<WebchatReplyDecision> {
  const decision = await authorizeWebchatReply(session);
  if (decision.allowed) return decision;
  await recordContactRestrictionAudit({
    organizationId: session.organizationId,
    leadId: session.leadId,
    event: 'outbound_blocked',
    actor: context.actor,
    channel: 'webchat',
    purpose: context.purpose,
    outcome: decision.check.status,
    restrictingLeadIds: decision.check.status === 'restricted' ? decision.check.leadIds : [],
    sessionId: session._id,
  });
  throw webchatReplyError(decision);
}

export async function recordWebchatExceptionReply(
  session: WebchatSessionLike,
  decision: WebchatReplyDecision,
  details: { actor: IContactRestrictionAuditActor; purpose: string; messageId: unknown },
): Promise<void> {
  if (!decision.allowed || decision.basis !== 'dnc_live_session') return;
  await recordContactRestrictionAudit({
    organizationId: session.organizationId,
    leadId: session.leadId,
    event: 'webchat_exception_reply',
    actor: details.actor,
    channel: 'webchat',
    purpose: details.purpose,
    restrictingLeadIds: decision.restrictingLeadIds,
    sessionId: session._id,
    messageId: details.messageId,
    respondingToMessageId: decision.respondingToMessageId,
  });
}

export async function describeWebchatContactPolicy(session: WebchatSessionLike): Promise<{
  restricted: boolean;
  lookupUnavailable: boolean;
  restrictedSince: string | null;
  windowMinutes: number;
}> {
  const check = await resolveContactRestriction(webchatRestrictionTarget(session));
  if (check.status === 'allowed') return { restricted: false, lookupUnavailable: false, restrictedSince: null, windowMinutes: WEBCHAT_RESPONSE_WINDOW_MINUTES };
  if (check.status === 'unavailable') return { restricted: true, lookupUnavailable: true, restrictedSince: null, windowMinutes: WEBCHAT_RESPONSE_WINDOW_MINUTES };
  const since = await restrictedSince(session.organizationId, check.leadIds).catch(() => null);
  return {
    restricted: true,
    lookupUnavailable: false,
    restrictedSince: since ? since.toISOString() : null,
    windowMinutes: WEBCHAT_RESPONSE_WINDOW_MINUTES,
  };
}
