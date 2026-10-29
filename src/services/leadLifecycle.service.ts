import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import {
  CONTACT_RESTRICTED_STATUSES,
  LeadLifecycleState,
  classifyLeadLifecycle,
} from '../constants/leadStatus';
import { isPlaceholderEmail, isPlaceholderPhone, matchableIdentityEmail, matchableIdentityPhone } from '../utils/contactIdentity';
import { CustomerLinkStatus, evaluateCustomerIdentity, findIdentityCustomers } from './customerIdentity.service';

const LEAD_MATCH_FIELDS =
  '_id status statusHistory updatedAt createdAt customerId phone email normalizedPhone normalizedEmail identityEmailExcluded intakeIdentity';
export const MAX_MATCHED_LEADS = 200;
export const MAX_RESTRICTION_MATCHES = 100;
const QUERY_TIME_LIMIT_MS = 5000;

export type ContactMatchField = 'phone' | 'email';

export interface LeadAssociationCandidate {
  leadId: string;
  status: string;
  lifecycle: LeadLifecycleState;
  customerId: string | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  matchedBy: ContactMatchField[];
  terminalAt: Date | null;
  terminalMarker?: string | null;
  unverified?: boolean;
  createdAt?: Date | null;
}

export interface LeadAssociationIdentity {
  status: CustomerLinkStatus | 'none';
  customerId?: string;
  reason?: string;
}

export interface LeadAssociationDecisionInput {
  contact: { normalizedPhone: string | null; normalizedEmail: string | null };
  identity: LeadAssociationIdentity;
  candidates: LeadAssociationCandidate[];
  contextLead?: LeadAssociationCandidate | null;
  lookupComplete?: boolean;
}

export interface LeadAssociationDecision {
  action: 'append' | 'create' | 'review';
  reason: string;
  leadId?: string;
  candidateLeadIds: string[];
  previousLeadIds: string[];
  customerId?: string;
  intakeSlots?: string[];
}

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

type TerminalSource = {
  status?: unknown;
  statusHistory?: Array<{ to?: unknown; changedAt?: unknown }> | null;
  updatedAt?: unknown;
  createdAt?: unknown;
};

function terminalSince(lead: TerminalSource): { at: Date | null; fromHistory: boolean } {
  if (classifyLeadLifecycle(lead.status) !== 'terminal') return { at: null, fromHistory: false };
  const history = (Array.isArray(lead.statusHistory) ? lead.statusHistory : [])
    .map((entry) => ({ to: entry?.to, changedAt: toDate(entry?.changedAt) }))
    .filter((entry): entry is { to: unknown; changedAt: Date } => Boolean(entry.changedAt))
    .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  let since: Date | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (classifyLeadLifecycle(history[index].to) !== 'terminal') break;
    since = history[index].changedAt;
  }
  if (since) return { at: since, fromHistory: true };
  return { at: toDate(lead.updatedAt) || toDate(lead.createdAt), fromHistory: false };
}

export function resolveLeadTerminalAt(lead: TerminalSource): Date | null {
  return terminalSince(lead).at;
}

export function effectiveContact(doc: any) {
  const storedPhone = doc.normalizedPhone !== undefined ? doc.normalizedPhone || null : matchableIdentityPhone(doc.phone);
  const normalizedPhone = storedPhone && !isPlaceholderPhone(storedPhone) ? storedPhone : null;
  const storedEmail = doc.identityEmailExcluded
    ? null
    : doc.normalizedEmail !== undefined
      ? doc.normalizedEmail || null
      : matchableIdentityEmail(doc.email);
  const normalizedEmail = storedEmail && !isPlaceholderEmail(storedEmail) ? storedEmail : null;
  return { normalizedPhone, normalizedEmail };
}

export function toAssociationCandidate(
  doc: any,
  contact: { normalizedPhone: string | null; normalizedEmail: string | null },
): LeadAssociationCandidate {
  const own = effectiveContact(doc);
  const matchedBy: ContactMatchField[] = [];
  if (contact.normalizedPhone && own.normalizedPhone === contact.normalizedPhone) matchedBy.push('phone');
  if (contact.normalizedEmail && own.normalizedEmail === contact.normalizedEmail) matchedBy.push('email');
  const terminal = terminalSince(doc);
  return {
    leadId: String(doc._id),
    status: String(doc.status || ''),
    lifecycle: classifyLeadLifecycle(doc.status),
    customerId: doc.customerId ? String(doc.customerId) : null,
    normalizedPhone: own.normalizedPhone,
    normalizedEmail: own.normalizedEmail,
    matchedBy,
    terminalAt: terminal.at,
    terminalMarker: terminal.at ? (terminal.fromHistory ? String(terminal.at.getTime()) : 'legacy') : null,
    unverified: doc.intakeIdentity === 'unverified',
    createdAt: toDate(doc.createdAt),
  };
}

export function contactDisagrees(
  candidate: LeadAssociationCandidate,
  contact: { normalizedPhone: string | null; normalizedEmail: string | null },
): boolean {
  if (contact.normalizedEmail && candidate.normalizedEmail && candidate.normalizedEmail !== contact.normalizedEmail) return true;
  if (contact.normalizedPhone && candidate.normalizedPhone && candidate.normalizedPhone !== contact.normalizedPhone) return true;
  return false;
}

function latestTerminal(candidates: LeadAssociationCandidate[]): LeadAssociationCandidate | null {
  const terminal = candidates.filter((c) => c.lifecycle === 'terminal');
  if (!terminal.length) return null;
  return [...terminal].sort(
    (a, b) => (b.terminalAt?.getTime() ?? 0) - (a.terminalAt?.getTime() ?? 0) || b.leadId.localeCompare(a.leadId),
  )[0];
}

export function buildIntakeSlots(
  identity: { customerId?: string | null; normalizedPhone: string | null; normalizedEmail: string | null },
  candidates: LeadAssociationCandidate[],
): string[] {
  const slots: string[] = [];
  const add = (key: string, related: LeadAssociationCandidate[]) => {
    const previous = latestTerminal(related);
    slots.push(previous ? `${key}|after:${previous.leadId}@${previous.terminalMarker || 'legacy'}` : `${key}|first`);
  };
  if (identity.customerId) add(`customer:${identity.customerId}`, candidates.filter((c) => c.customerId === identity.customerId));
  if (identity.normalizedPhone) add(`phone:${identity.normalizedPhone}`, candidates.filter((c) => c.matchedBy.includes('phone')));
  if (identity.normalizedEmail) add(`email:${identity.normalizedEmail}`, candidates.filter((c) => c.matchedBy.includes('email')));
  return slots;
}

export function decideLeadAssociation(input: LeadAssociationDecisionInput): LeadAssociationDecision {
  const { contact, identity } = input;
  const previousLeadIds = input.candidates.filter((c) => c.lifecycle === 'terminal').map((c) => c.leadId);
  const open = input.candidates.filter((c) => c.lifecycle !== 'terminal');
  const candidateLeadIds = open.map((c) => c.leadId);
  const linkedCustomerId = identity.status === 'linked' ? identity.customerId : undefined;
  const base = { candidateLeadIds, previousLeadIds, customerId: linkedCustomerId };
  const review = (reason: string): LeadAssociationDecision => ({ action: 'review', reason, ...base });
  const append = (leadId: string, reason: string): LeadAssociationDecision => ({ action: 'append', leadId, reason, ...base });

  if (input.lookupComplete === false) return review('lookup_incomplete');
  if (identity.status === 'ambiguous' || identity.status === 'conflict') return review(`identity_${identity.status}`);
  if (linkedCustomerId && open.some((c) => c.customerId && c.customerId !== linkedCustomerId)) {
    return review('lead_belongs_to_other_customer');
  }
  if (!linkedCustomerId && new Set(open.map((c) => c.customerId).filter(Boolean)).size > 1) {
    return review('leads_belong_to_different_customers');
  }
  if (open.some((c) => contactDisagrees(c, contact))) return review('contact_details_disagree');
  if (open.some((c) => c.lifecycle === 'unknown')) return review('unknown_lead_status');

  const context = input.contextLead;
  if (context && context.lifecycle === 'unknown') return review('unknown_lead_status');
  if (context && context.lifecycle === 'active') {
    const contextConflicts =
      contactDisagrees(context, contact) ||
      Boolean(linkedCustomerId && context.customerId && context.customerId !== linkedCustomerId);
    if (contextConflicts) return review('context_conflicts_with_identity');
    if (!open.length || open.some((c) => c.leadId === context.leadId)) return append(context.leadId, 'context_lead');
    return review('context_differs_from_identity_match');
  }

  if (!open.length) {
    return {
      action: 'create',
      reason: previousLeadIds.length ? 'previous_lead_finished' : 'no_matching_lead',
      ...base,
      intakeSlots: buildIntakeSlots({ customerId: linkedCustomerId, ...contact }, input.candidates),
    };
  }
  if (open.length === 1) return append(open[0].leadId, 'single_active_lead');
  return review('multiple_active_leads');
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contactConditions(contact: { normalizedPhone: string | null; normalizedEmail: string | null }) {
  const indexed: Record<string, unknown>[] = [];
  const legacy: Record<string, unknown>[] = [];
  if (contact.normalizedPhone) {
    const digits = contact.normalizedPhone.replace(/\D/g, '').slice(-10);
    indexed.push({ normalizedPhone: contact.normalizedPhone });
    legacy.push({ normalizedPhone: { $exists: false }, phone: { $regex: digits.split('').join('\\D*') } });
  }
  if (contact.normalizedEmail) {
    indexed.push({ normalizedEmail: contact.normalizedEmail });
    legacy.push({
      normalizedEmail: { $exists: false },
      email: { $regex: `^\\s*${escapeRegex(contact.normalizedEmail)}\\s*$`, $options: 'i' },
    });
  }
  return { indexed, legacy };
}

const isTimeLimitError = (err: any) =>
  err?.code === 50 || /MaxTimeMSExpired|exceeded time limit/i.test(String(err?.message || ''));

async function boundedLeadQuery(filter: Record<string, unknown>): Promise<{ docs: any[]; complete: boolean }> {
  try {
    const docs = await Lead.find(filter)
      .select(LEAD_MATCH_FIELDS)
      .limit(MAX_MATCHED_LEADS + 1)
      .maxTimeMS(QUERY_TIME_LIMIT_MS)
      .lean();
    if (docs.length > MAX_MATCHED_LEADS) return { docs: docs.slice(0, MAX_MATCHED_LEADS), complete: false };
    return { docs, complete: true };
  } catch (err) {
    if (isTimeLimitError(err)) return { docs: [], complete: false };
    throw err;
  }
}

async function loadContactLeads(
  organizationId: string,
  contact: { normalizedPhone: string | null; normalizedEmail: string | null },
): Promise<{ candidates: LeadAssociationCandidate[]; complete: boolean }> {
  const { indexed, legacy } = contactConditions(contact);
  if (!indexed.length) return { candidates: [], complete: true };
  const [current, older] = await Promise.all([
    boundedLeadQuery({ organizationId, $or: indexed }),
    boundedLeadQuery({ organizationId, $or: legacy }),
  ]);
  const byId = new Map<string, LeadAssociationCandidate>();
  for (const doc of [...current.docs, ...older.docs]) {
    const candidate = toAssociationCandidate(doc, contact);
    if (candidate.matchedBy.length) byId.set(candidate.leadId, candidate);
  }
  return { candidates: [...byId.values()], complete: current.complete && older.complete };
}

export interface LeadAssociationInputs {
  contact: { normalizedPhone: string | null; normalizedEmail: string | null };
  identity: LeadAssociationIdentity;
  candidates: LeadAssociationCandidate[];
  contextLead: LeadAssociationCandidate | null;
  lookupComplete: boolean;
}

export async function loadLeadAssociationInputs(input: {
  organizationId: string;
  phone?: unknown;
  email?: unknown;
  emailExcluded?: boolean;
  contextLeadId?: unknown;
}): Promise<LeadAssociationInputs> {
  if (!input.organizationId || !mongoose.isValidObjectId(input.organizationId)) {
    throw new Error('A valid organization is required for lead matching');
  }
  const contact = {
    normalizedPhone: matchableIdentityPhone(input.phone),
    normalizedEmail: input.emailExcluded ? null : matchableIdentityEmail(input.email),
  };
  let identity: LeadAssociationIdentity = { status: 'none' };
  if (contact.normalizedPhone || contact.normalizedEmail) {
    const lookup = { phone: contact.normalizedPhone || undefined, email: contact.normalizedEmail || undefined };
    const customers = await findIdentityCustomers(String(input.organizationId), lookup);
    const result = evaluateCustomerIdentity(lookup, customers);
    identity = { status: result.status, customerId: result.customerId, reason: result.reason };
  }
  const { candidates, complete } = await loadContactLeads(String(input.organizationId), contact);
  let contextLead: LeadAssociationCandidate | null = null;
  if (input.contextLeadId && mongoose.isValidObjectId(input.contextLeadId)) {
    const doc = await Lead.findOne({ _id: input.contextLeadId, organizationId: input.organizationId })
      .select(LEAD_MATCH_FIELDS)
      .lean();
    contextLead = doc ? toAssociationCandidate(doc, contact) : null;
  }
  return { contact, identity, candidates, contextLead, lookupComplete: complete };
}

export async function findLeadAssociation(input: {
  organizationId: string;
  phone?: unknown;
  email?: unknown;
  emailExcluded?: boolean;
  contextLeadId?: unknown;
}): Promise<
  LeadAssociationDecision & { identity: LeadAssociationIdentity; candidates: LeadAssociationCandidate[]; lookupComplete: boolean }
> {
  const { contact, identity, candidates, contextLead, lookupComplete } = await loadLeadAssociationInputs(input);
  const decision = decideLeadAssociation({ contact, identity, candidates, contextLead, lookupComplete });
  return { ...decision, identity, candidates, lookupComplete };
}

export async function findContactRestriction(input: {
  organizationId: string;
  phone?: unknown;
  email?: unknown;
  emailExcluded?: boolean;
  customerId?: unknown;
}): Promise<{ restricted: boolean; leadIds: string[] }> {
  if (!input.organizationId || !mongoose.isValidObjectId(input.organizationId)) {
    throw new Error('A valid organization is required for the contact restriction lookup');
  }
  const phone = matchableIdentityPhone(input.phone);
  const email = input.emailExcluded ? null : matchableIdentityEmail(input.email);
  const customerId = input.customerId && mongoose.isValidObjectId(input.customerId) ? String(input.customerId) : '';
  const { indexed, legacy } = contactConditions({ normalizedPhone: phone, normalizedEmail: email });
  const conditions: Record<string, unknown>[] = [...indexed, ...legacy];
  if (customerId) conditions.push({ customerId: new mongoose.Types.ObjectId(customerId) });
  if (!conditions.length) return { restricted: false, leadIds: [] };
  const docs: any[] = await Lead.find({
    organizationId: input.organizationId,
    status: { $in: CONTACT_RESTRICTED_STATUSES },
    $or: conditions,
  })
    .select(LEAD_MATCH_FIELDS)
    .limit(MAX_RESTRICTION_MATCHES + 1)
    .maxTimeMS(QUERY_TIME_LIMIT_MS)
    .lean();
  const leadIds = docs
    .filter((doc) => {
      const own = effectiveContact(doc);
      return (
        (customerId && doc.customerId && String(doc.customerId) === customerId) ||
        (phone && own.normalizedPhone === phone) ||
        (email && own.normalizedEmail === email)
      );
    })
    .map((doc) => String(doc._id));
  if (!leadIds.length && docs.length > MAX_RESTRICTION_MATCHES) {
    throw new Error('The contact restriction lookup was incomplete');
  }
  return { restricted: leadIds.length > 0, leadIds };
}
