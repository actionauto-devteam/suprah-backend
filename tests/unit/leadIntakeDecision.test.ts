import { decideLeadIntake } from '../../src/services/leadIntakeDecision';
import { LeadAssociationCandidate } from '../../src/services/leadLifecycle.service';

const PHONE = '+18015550101';
const EMAIL = 'pat@example.com';

function lead(id: string, overrides: Partial<LeadAssociationCandidate> = {}): LeadAssociationCandidate {
  return {
    leadId: id,
    status: 'New',
    lifecycle: 'active',
    customerId: null,
    normalizedPhone: PHONE,
    normalizedEmail: EMAIL,
    matchedBy: ['phone', 'email'],
    terminalAt: null,
    terminalMarker: null,
    ...overrides,
  };
}

const closed = (id: string, overrides: Partial<LeadAssociationCandidate> = {}) =>
  lead(id, { status: 'Closed', lifecycle: 'terminal', terminalAt: new Date('2026-10-01T00:00:00Z'), terminalMarker: '1759276800000', ...overrides });

const decide = (candidates: LeadAssociationCandidate[], extra: Partial<Parameters<typeof decideLeadIntake>[0]> = {}) =>
  decideLeadIntake({
    contact: { normalizedPhone: PHONE, normalizedEmail: EMAIL },
    identity: { status: 'none' },
    candidates,
    lookupComplete: true,
    policy: 'associate',
    ...extra,
  });

describe('decideLeadIntake', () => {
  it('adds the inquiry to the one open lead with the same phone and email', () => {
    expect(decide([lead('a')])).toMatchObject({ action: 'append', leadId: 'a', reason: 'single_active_lead' });
  });

  it('treats missing details as no conflict', () => {
    const phoneOnly = decide([lead('a', { normalizedEmail: null, matchedBy: ['phone'] })]);
    expect(phoneOnly).toMatchObject({ action: 'append', leadId: 'a' });
    const contactHasNoEmail = decide([lead('a')], { contact: { normalizedPhone: PHONE, normalizedEmail: null } });
    expect(contactHasNoEmail).toMatchObject({ action: 'append', leadId: 'a' });
  });

  it('joins the open lead when only the phone matches and the email differs', () => {
    const decision = decide([lead('a', { normalizedEmail: 'someone.else@example.com', matchedBy: ['phone'] })]);
    expect(decision).toMatchObject({ action: 'append', leadId: 'a', reason: 'single_active_lead', separateLeadIds: [] });
  });

  it('joins the open lead when only the email matches and the phone differs', () => {
    const decision = decide([lead('a', { normalizedPhone: '+18015550199', matchedBy: ['email'] })]);
    expect(decision).toMatchObject({ action: 'append', leadId: 'a', reason: 'single_active_lead' });
  });

  it('creates a fresh lead once the earlier lead is closed', () => {
    const decision = decide([closed('old')]);
    expect(decision).toMatchObject({ action: 'create', reason: 'previous_lead_finished', previousLeadIds: ['old'] });
    expect(decision.intakeSlots).toEqual([`phone:${PHONE}|after:old@1759276800000`, `email:${EMAIL}|after:old@1759276800000`]);
  });

  it('never attaches to a closed lead and joins the open one that shares a detail', () => {
    const decision = decide([closed('old'), lead('other', { normalizedEmail: 'other@example.com', matchedBy: ['phone'] })]);
    expect(decision).toMatchObject({ action: 'append', leadId: 'other' });
    expect(decide([closed('new-closed', { createdAt: new Date('2026-10-29T00:00:00Z') }), lead('open', { createdAt: new Date('2026-10-01T00:00:00Z') })]))
      .toMatchObject({ action: 'append', leadId: 'open' });
  });

  it('joins the newest open lead when the customer already has several', () => {
    const decision = decide([
      lead('oldest', { createdAt: new Date('2026-10-27T10:00:00Z') }),
      lead('newest', { createdAt: new Date('2026-10-29T10:00:00Z'), matchedBy: ['email'], normalizedPhone: null }),
      lead('middle', { createdAt: new Date('2026-10-28T10:00:00Z') }),
    ]);
    expect(decision).toMatchObject({ action: 'append', leadId: 'newest', reason: 'newest_active_lead' });
    expect([...decision.candidateLeadIds].sort()).toEqual(['middle', 'newest', 'oldest']);
  });

  it('falls back to the lead id time when the created date is missing', () => {
    const older = '65f000000000000000000001';
    const newer = '66f000000000000000000001';
    expect(decide([lead(older), lead(newer)])).toMatchObject({ action: 'append', leadId: newer, reason: 'newest_active_lead' });
  });

  it('still sends cases it cannot read safely to review', () => {
    expect(decide([lead('a')], { lookupComplete: false })).toMatchObject({ action: 'review', reason: 'lookup_incomplete' });
    expect(decide([lead('a', { lifecycle: 'unknown', status: 'Odd' })])).toMatchObject({ action: 'review', reason: 'unknown_lead_status' });
    expect(decide([lead('a'), lead('b', { lifecycle: 'unknown', status: 'Odd' })])).toMatchObject({ action: 'review', reason: 'unknown_lead_status' });
  });

  it('joins the open lead even when the details match more than one customer record', () => {
    expect(decide([lead('a')], { identity: { status: 'ambiguous' } })).toMatchObject({ action: 'append', leadId: 'a' });
    const decision = decide([lead('a', { customerId: 'customer-b' })], { identity: { status: 'linked', customerId: 'customer-a' } });
    expect(decision).toMatchObject({ action: 'append', leadId: 'a', customerId: 'customer-a' });
  });

  it('uses the context lead only while it is open and shares a contact detail', () => {
    const context = lead('ctx');
    expect(decide([context], { contextLead: context })).toMatchObject({ action: 'append', leadId: 'ctx', reason: 'context_lead' });
    const sharesPhone = lead('ctx', { normalizedEmail: 'other@example.com', matchedBy: ['phone'] });
    expect(decide([sharesPhone], { contextLead: sharesPhone })).toMatchObject({ action: 'append', leadId: 'ctx', reason: 'context_lead' });
    const someoneElse = lead('ctx', { normalizedPhone: '+18015550199', normalizedEmail: 'other@example.com', matchedBy: [] });
    expect(decide([], { contextLead: someoneElse })).toMatchObject({ action: 'review', reason: 'context_conflicts_with_contact' });
    const noDetails = lead('ctx', { normalizedPhone: null, normalizedEmail: null, matchedBy: [] });
    expect(decide([], { contextLead: noDetails })).toMatchObject({ action: 'append', leadId: 'ctx', reason: 'context_lead' });
    expect(decide([closed('ctx')], { contextLead: closed('ctx') })).toMatchObject({ action: 'create', reason: 'previous_lead_finished' });
  });

  it('keeps unverified chats separate and offers the open lead as a possible match', () => {
    const decision = decide([lead('a')], { policy: 'isolate' });
    expect(decision).toMatchObject({ action: 'create', reason: 'unverified_contact_kept_separate', possibleMatchLeadIds: ['a'] });
    expect(decision.intakeSlots).toBeUndefined();
  });

  it('still keeps an unverified chat separate when the identity lookup is uncertain', () => {
    expect(decide([lead('a')], { policy: 'isolate', lookupComplete: false }))
      .toMatchObject({ action: 'create', reason: 'unverified_contact_identity_uncertain' });
    expect(decide([], { policy: 'isolate', identity: { status: 'ambiguous' } }))
      .toMatchObject({ action: 'create', reason: 'unverified_contact_identity_uncertain', possibleMatchLeadIds: [] });
  });

  it('never adds a verified inquiry to an unverified chat lead', () => {
    const decision = decide([lead('chat', { unverified: true }), lead('real')]);
    expect(decision).toMatchObject({ action: 'append', leadId: 'real' });
    expect(decide([lead('chat', { unverified: true })])).toMatchObject({ action: 'create' });
  });
});
