import {
  LeadAssociationCandidate,
  LeadAssociationIdentity,
  buildIntakeSlots,
  contactDisagrees,
} from './leadLifecycle.service';

export type LeadIntakePolicy = 'associate' | 'isolate';

export interface LeadIntakeDecisionInput {
  contact: { normalizedPhone: string | null; normalizedEmail: string | null };
  identity: LeadAssociationIdentity;
  candidates: LeadAssociationCandidate[];
  contextLead?: LeadAssociationCandidate | null;
  lookupComplete: boolean;
  policy: LeadIntakePolicy;
}

export interface LeadIntakeDecision {
  action: 'append' | 'create' | 'review';
  reason: string;
  leadId?: string;
  candidateLeadIds: string[];
  previousLeadIds: string[];
  separateLeadIds: string[];
  possibleMatchLeadIds: string[];
  customerId?: string;
  intakeSlots?: string[];
}

const createdTime = (candidate: Pick<LeadAssociationCandidate, 'leadId' | 'createdAt'>) => {
  if (candidate.createdAt) return candidate.createdAt.getTime();
  return /^[a-f0-9]{24}$/i.test(candidate.leadId) ? parseInt(candidate.leadId.slice(0, 8), 16) * 1000 : 0;
};

export const newestFirst = (a: Pick<LeadAssociationCandidate, 'leadId' | 'createdAt'>, b: Pick<LeadAssociationCandidate, 'leadId' | 'createdAt'>) =>
  createdTime(b) - createdTime(a) || b.leadId.localeCompare(a.leadId);

export function decideLeadIntake(input: LeadIntakeDecisionInput): LeadIntakeDecision {
  const { contact, identity } = input;
  const linkedCustomerId = identity.status === 'linked' ? identity.customerId : undefined;
  const sameCustomer = (candidate: LeadAssociationCandidate) => !candidate.unverified;
  const contextBelongs = (candidate: LeadAssociationCandidate) =>
    !candidate.unverified &&
    (candidate.matchedBy.length > 0 ||
      (!contactDisagrees(candidate, contact) &&
        !(linkedCustomerId && candidate.customerId && candidate.customerId !== linkedCustomerId)));

  const matching = input.candidates.filter(sameCustomer);
  const separate = input.candidates.filter((candidate) => !sameCustomer(candidate));
  const open = matching.filter((candidate) => candidate.lifecycle !== 'terminal');
  const previous = matching.filter((candidate) => candidate.lifecycle === 'terminal');
  const base = {
    candidateLeadIds: open.map((candidate) => candidate.leadId),
    previousLeadIds: previous.map((candidate) => candidate.leadId),
    separateLeadIds: separate.filter((candidate) => candidate.lifecycle !== 'terminal').map((candidate) => candidate.leadId),
    possibleMatchLeadIds: [] as string[],
    customerId: linkedCustomerId,
  };
  const review = (reason: string): LeadIntakeDecision => ({ action: 'review', reason, ...base });
  const append = (leadId: string, reason: string): LeadIntakeDecision => ({ action: 'append', leadId, reason, ...base });
  const create = (reason: string, extra: Partial<LeadIntakeDecision> = {}): LeadIntakeDecision => {
    const phoneShared = separate.some((candidate) => candidate.matchedBy.includes('phone'));
    const emailShared = separate.some((candidate) => candidate.matchedBy.includes('email'));
    const intakeSlots = buildIntakeSlots(
      {
        customerId: linkedCustomerId,
        normalizedPhone: phoneShared ? null : contact.normalizedPhone,
        normalizedEmail: emailShared ? null : contact.normalizedEmail,
      },
      matching,
    );
    return { action: 'create', reason, ...base, intakeSlots, ...extra };
  };

  if (input.policy === 'isolate') {
    const uncertain = !input.lookupComplete || identity.status === 'ambiguous';
    const possibleMatchLeadIds = open.filter((candidate) => candidate.lifecycle === 'active').map((candidate) => candidate.leadId);
    return {
      action: 'create',
      reason: uncertain
        ? 'unverified_contact_identity_uncertain'
        : possibleMatchLeadIds.length ? 'unverified_contact_kept_separate' : previous.length ? 'previous_lead_finished' : 'no_matching_lead',
      ...base,
      possibleMatchLeadIds,
      intakeSlots: undefined,
    };
  }

  if (!input.lookupComplete) return review('lookup_incomplete');

  if (open.some((candidate) => candidate.lifecycle === 'unknown')) return review('unknown_lead_status');

  const context = input.contextLead;
  if (context && context.lifecycle === 'unknown') return review('unknown_lead_status');
  if (context && context.lifecycle === 'active') {
    if (!contextBelongs(context)) return review('context_conflicts_with_contact');
    if (!open.length || open.some((candidate) => candidate.leadId === context.leadId)) return append(context.leadId, 'context_lead');
    return review('context_differs_from_contact_match');
  }

  if (open.length === 1) return append(open[0].leadId, 'single_active_lead');
  if (open.length > 1) return append([...open].sort(newestFirst)[0].leadId, 'newest_active_lead');
  if (previous.length) return create('previous_lead_finished');
  if (separate.length) return create('contact_conflict_separate_lead');
  return create('no_matching_lead');
}
