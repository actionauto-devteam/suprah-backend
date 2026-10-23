import {
  LeadAssociationCandidate,
  decideLeadAssociation,
  resolveLeadTerminalAt,
} from '../../src/services/leadLifecycle.service';
import { classifyLeadLifecycle } from '../../src/constants/leadStatus';

const PHONE = '+13855035869';
const EMAIL = 'pat@example.com';
const contact = { normalizedPhone: PHONE, normalizedEmail: EMAIL };

function lead(id: string, status: string, overrides: Partial<LeadAssociationCandidate> = {}): LeadAssociationCandidate {
  return {
    leadId: id,
    status,
    lifecycle: classifyLeadLifecycle(status),
    customerId: null,
    normalizedPhone: PHONE,
    normalizedEmail: EMAIL,
    matchedBy: ['phone', 'email'],
    terminalAt: null,
    ...overrides,
  };
}

const unresolved = { status: 'unresolved' as const };

describe('decideLeadAssociation', () => {
  it('A: appends a new inquiry to the single open lead', () => {
    const decision = decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L1', 'Contacted')] });
    expect(decision).toMatchObject({ action: 'append', leadId: 'L1', reason: 'single_active_lead' });
  });

  it('B and D: creates a new lead when the only match is finished', () => {
    const decision = decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L1', 'Closed')] });
    expect(decision).toMatchObject({ action: 'create', reason: 'previous_lead_finished', previousLeadIds: ['L1'] });
    expect(decision.leadId).toBeUndefined();
  });

  it('creates a lead when nothing matches', () => {
    expect(decideLeadAssociation({ contact, identity: unresolved, candidates: [] })).toMatchObject({
      action: 'create',
      reason: 'no_matching_lead',
      previousLeadIds: [],
    });
  });

  it('keeps In Finance and Online Financing leads as the active lead', () => {
    expect(decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L1', 'In Finance')] })).toMatchObject({
      action: 'append',
      leadId: 'L1',
    });
    expect(decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L2', 'Online Financing')] })).toMatchObject({
      action: 'append',
      leadId: 'L2',
    });
  });

  it('appends to the open lead when both open and finished leads exist', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'Closed'), lead('L2', 'New')],
    });
    expect(decision).toMatchObject({ action: 'append', leadId: 'L2', previousLeadIds: ['L1'], candidateLeadIds: ['L2'] });
  });

  it('holds the inquiry for review when several open leads match', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'New'), lead('L2', 'Working')],
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'multiple_active_leads', candidateLeadIds: ['L1', 'L2'] });
  });

  it('uses a reliable context lead among several open leads', () => {
    const candidates = [lead('L1', 'New'), lead('L2', 'Working')];
    const decision = decideLeadAssociation({ contact, identity: unresolved, candidates, contextLead: candidates[1] });
    expect(decision).toMatchObject({ action: 'append', leadId: 'L2', reason: 'context_lead' });
  });

  it('ignores a finished context lead', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'Closed')],
      contextLead: lead('L1', 'Closed'),
    });
    expect(decision.action).toBe('create');
  });

  it('holds for review when the context lead disagrees with the contact details', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [],
      contextLead: lead('L9', 'New', { normalizedEmail: 'someone-else@example.com', matchedBy: [] }),
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'context_conflicts_with_identity' });
  });

  it('holds for review when the context lead is not the identity match', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'New')],
      contextLead: lead('L5', 'New', { matchedBy: [] }),
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'context_differs_from_identity_match' });
  });

  it('appends to a context lead when no contact details were given', () => {
    const decision = decideLeadAssociation({
      contact: { normalizedPhone: null, normalizedEmail: null },
      identity: { status: 'none' },
      candidates: [],
      contextLead: lead('L3', 'New', { matchedBy: [] }),
    });
    expect(decision).toMatchObject({ action: 'append', leadId: 'L3' });
  });

  it.each(['ambiguous', 'conflict'] as const)('never auto-associates a %s customer identity', (status) => {
    const decision = decideLeadAssociation({ contact, identity: { status }, candidates: [lead('L1', 'New')] });
    expect(decision).toMatchObject({ action: 'review', reason: `identity_${status}` });
  });

  it('holds for review when an open lead belongs to a different customer', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: { status: 'linked', customerId: 'C1' },
      candidates: [lead('L1', 'New', { customerId: 'C2' })],
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'lead_belongs_to_other_customer' });
  });

  it('appends when the open lead belongs to the same linked customer', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: { status: 'linked', customerId: 'C1' },
      candidates: [lead('L1', 'New', { customerId: 'C1' })],
    });
    expect(decision).toMatchObject({ action: 'append', leadId: 'L1', customerId: 'C1' });
  });

  it('holds for review when matching open leads belong to different customers', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'New', { customerId: 'C1' }), lead('L2', 'New', { customerId: 'C2' })],
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'leads_belong_to_different_customers' });
  });

  it('holds for review when the phone matches but the email belongs to someone else', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'New', { normalizedEmail: 'spouse@example.com', matchedBy: ['phone'] })],
    });
    expect(decision).toMatchObject({ action: 'review', reason: 'contact_details_disagree' });
  });

  it('does not let a finished lead with different details block a new lead', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: unresolved,
      candidates: [lead('L1', 'Closed', { normalizedEmail: 'old@example.com', matchedBy: ['phone'] })],
    });
    expect(decision.action).toBe('create');
  });

  it('holds for review when a matching lead has an unknown status', () => {
    const decision = decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L1', 'Archived')] });
    expect(decision).toMatchObject({ action: 'review', reason: 'unknown_lead_status' });
  });

  it('never answers from an incomplete lookup', () => {
    const decision = decideLeadAssociation({ contact, identity: unresolved, candidates: [], lookupComplete: false });
    expect(decision).toMatchObject({ action: 'review', reason: 'lookup_incomplete' });
  });

  it('gives a new lead one intake slot per customer key, tied to the latest finished lead for that key', () => {
    const decision = decideLeadAssociation({
      contact,
      identity: { status: 'linked', customerId: 'C1' },
      candidates: [
        lead('L1', 'Closed', { customerId: 'C1', terminalAt: new Date('2026-10-01T00:00:00Z'), terminalMarker: '1' }),
        lead('L2', 'Sold', { customerId: 'C1', matchedBy: ['email'], normalizedPhone: null, terminalAt: new Date('2026-10-05T00:00:00Z'), terminalMarker: '5' }),
      ],
    });
    expect(decision.action).toBe('create');
    expect(decision.intakeSlots).toEqual([
      'customer:C1|after:L2@5',
      `phone:${PHONE}|after:L1@1`,
      `email:${EMAIL}|after:L2@5`,
    ]);
  });

  it('uses a first-lead slot when the customer never had a lead, and no slots when appending', () => {
    expect(decideLeadAssociation({ contact, identity: unresolved, candidates: [] }).intakeSlots).toEqual([
      `phone:${PHONE}|first`,
      `email:${EMAIL}|first`,
    ]);
    expect(decideLeadAssociation({ contact, identity: unresolved, candidates: [lead('L1', 'New')] }).intakeSlots).toBeUndefined();
  });

  it('keeps appending repeated genuine inquiries to the same open lead', () => {
    const candidates = [lead('L1', 'Working')];
    const first = decideLeadAssociation({ contact, identity: unresolved, candidates });
    const second = decideLeadAssociation({ contact, identity: unresolved, candidates });
    expect(first).toEqual(second);
    expect(second).toMatchObject({ action: 'append', leadId: 'L1' });
  });
});

describe('resolveLeadTerminalAt', () => {
  const t = (iso: string) => new Date(iso);

  it('returns null for an active lead', () => {
    expect(resolveLeadTerminalAt({ status: 'New', updatedAt: t('2026-10-02T00:00:00Z') })).toBeNull();
  });

  it('uses the start of the final run of finished statuses', () => {
    const terminalAt = resolveLeadTerminalAt({
      status: 'Bad Lead',
      statusHistory: [
        { to: 'Contacted', changedAt: t('2026-10-01T10:00:00Z') },
        { to: 'Closed', changedAt: t('2026-10-02T10:00:00Z') },
        { to: 'Bad Lead', changedAt: t('2026-10-03T10:00:00Z') },
      ],
      updatedAt: t('2026-10-05T10:00:00Z'),
    });
    expect(terminalAt).toEqual(t('2026-10-02T10:00:00Z'));
  });

  it('ignores an earlier closure that was reopened', () => {
    const terminalAt = resolveLeadTerminalAt({
      status: 'Closed',
      statusHistory: [
        { to: 'Closed', changedAt: t('2026-10-01T10:00:00Z') },
        { to: 'Contacted', changedAt: t('2026-10-02T10:00:00Z') },
        { to: 'Closed', changedAt: t('2026-10-04T10:00:00Z') },
      ],
    });
    expect(terminalAt).toEqual(t('2026-10-04T10:00:00Z'));
  });

  it('falls back to the last update for older leads without history', () => {
    expect(resolveLeadTerminalAt({ status: 'Sold', updatedAt: t('2026-09-30T10:00:00Z') })).toEqual(t('2026-09-30T10:00:00Z'));
  });
});
