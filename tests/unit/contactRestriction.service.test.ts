const mockFindContactRestriction = jest.fn();
const mockLeadFindOne = jest.fn();
const mockLeadFind = jest.fn();
const mockConfigFindOne = jest.fn();
const mockIdentifierFind = jest.fn();
const mockIdentifierUpdateOne = jest.fn();
const mockIdentifierUpdateMany = jest.fn();
const mockAuditCreate = jest.fn();
const mockAuditFindOne = jest.fn();
const mockCrmUserFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockWebChatMessageFindOne = jest.fn();

jest.mock('../../src/services/leadLifecycle.service', () => ({
  findContactRestriction: mockFindContactRestriction,
}));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { findOne: mockLeadFindOne, find: mockLeadFind },
}));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: { findOne: mockConfigFindOne },
}));
jest.mock('../../src/models/ContactRestrictionIdentifier.model', () => ({
  __esModule: true,
  default: { find: mockIdentifierFind, updateOne: mockIdentifierUpdateOne, updateMany: mockIdentifierUpdateMany },
}));
jest.mock('../../src/models/ContactRestrictionAudit.model', () => ({
  __esModule: true,
  default: { create: mockAuditCreate, findOne: mockAuditFindOne },
}));
jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true,
  default: { findOne: mockCrmUserFindOne },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: mockUserFindOne },
}));
jest.mock('../../src/models/WebChatMessage.model', () => ({
  __esModule: true,
  default: { findOne: mockWebChatMessageFindOne },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  assertContactAllowed,
  authorizeWebchatReply,
  checkContactForSend,
  ContactRestrictedError,
  CONTACT_RESTRICTED_CODE,
  CONTACT_RESTRICTION_UNAVAILABLE_CODE,
  CONTACT_RESTRICTION_MESSAGES,
  isDoNotContactError,
  isOrganizationAdmin,
  protectPreviousContact,
  releaseProtectedContacts,
  resolveContactRestriction,
  restrictedSince,
  WEBCHAT_RESPONSE_WINDOW_MS,
} from '../../src/services/contactRestriction.service';

const ORG = '507f1f77bcf86cd799439011';
const LEAD = '507f1f77bcf86cd799439012';
const OLD_LEAD = '507f1f77bcf86cd799439013';
const CUSTOMER = '507f1f77bcf86cd799439014';
const USER = '507f1f77bcf86cd799439015';
const SESSION = '507f1f77bcf86cd799439016';
const MESSAGE = '507f1f77bcf86cd799439017';

const chain = (value: unknown) => {
  const query: any = {};
  for (const method of ['select', 'sort', 'limit', 'maxTimeMS']) query[method] = () => query;
  query.lean = () => Promise.resolve(value);
  return query;
};

describe('resolveContactRestriction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindContactRestriction.mockResolvedValue({ restricted: false, leadIds: [] });
    mockLeadFindOne.mockReturnValue(chain(null));
    mockConfigFindOne.mockReturnValue(chain({ gmailAddress: 'sales@dealer.example', leadSourceEmail: 'leads@dealerscloud.com' }));
    mockIdentifierFind.mockReturnValue(chain([]));
  });

  it('allows a customer with no Do Not Contact lead', async () => {
    await expect(resolveContactRestriction({ organizationId: ORG, phone: '(801) 555-0142' })).resolves.toEqual({ status: 'allowed' });
    expect(mockFindContactRestriction).toHaveBeenCalledWith({ organizationId: ORG, phone: '+18015550142', email: undefined, customerId: undefined });
  });

  it('blocks the lead itself when its own status is Do Not Contact, without trusting only the lookup', async () => {
    mockLeadFindOne.mockReturnValue(chain({ _id: LEAD, status: 'Do Not Contact', phone: '801-555-0142' }));
    const check = await resolveContactRestriction({ organizationId: ORG, leadId: LEAD });
    expect(check).toEqual({ status: 'restricted', leadIds: [LEAD], onThisLead: true });
  });

  it('keeps a fresh New lead restricted when an older lead for the same customer is Do Not Contact', async () => {
    mockLeadFindOne.mockReturnValue(chain({ _id: LEAD, status: 'New', phone: '801-555-0142', email: 'pat@example.com', customerId: CUSTOMER }));
    mockFindContactRestriction.mockResolvedValue({ restricted: true, leadIds: [OLD_LEAD] });
    const check = await resolveContactRestriction({ organizationId: ORG, leadId: LEAD });
    expect(check).toEqual({ status: 'restricted', leadIds: [OLD_LEAD], onThisLead: false });
    expect(mockFindContactRestriction).toHaveBeenCalledWith({
      organizationId: ORG,
      phone: '+18015550142',
      email: 'pat@example.com',
      customerId: CUSTOMER,
    });
  });

  it('keeps a protected previous phone or email restricted after the Do Not Contact lead changed its details', async () => {
    mockIdentifierFind.mockReturnValue(chain([{ leadId: OLD_LEAD }]));
    const check = await resolveContactRestriction({ organizationId: ORG, phone: '801-555-0142', email: 'old@example.com' });
    expect(check).toEqual({ status: 'restricted', leadIds: [OLD_LEAD], onThisLead: false });
    expect(mockIdentifierFind).toHaveBeenCalledWith({
      organizationId: ORG,
      active: true,
      $or: [
        { kind: 'phone', value: { $in: ['+18015550142'] } },
        { kind: 'email', value: { $in: ['old@example.com'] } },
      ],
    });
  });

  it('checks every distinct phone, email, and customer it was given plus the lead record', async () => {
    mockLeadFindOne.mockReturnValue(chain({ _id: LEAD, status: 'New', phone: '801-555-0199', email: 'lead@example.com' }));
    await resolveContactRestriction({ organizationId: ORG, leadId: LEAD, phone: '801-555-0142', email: 'other@example.com', customerId: CUSTOMER });
    const calls = mockFindContactRestriction.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.phone).filter(Boolean).sort()).toEqual(['+18015550142', '+18015550199']);
    expect(calls.map((c) => c.email).filter(Boolean).sort()).toEqual(['lead@example.com', 'other@example.com']);
    expect(calls.map((c) => c.customerId).filter(Boolean)).toEqual([CUSTOMER]);
    expect(calls.every((c) => c.organizationId === ORG)).toBe(true);
  });

  it('never matches on lead-source or dealership addresses, or on an email the lead marked as not the customer', async () => {
    mockLeadFindOne.mockReturnValue(chain({ _id: LEAD, status: 'New', email: 'proxy@example.com', identityEmailExcluded: true }));
    await resolveContactRestriction({ organizationId: ORG, leadId: LEAD, email: 'leads@dealerscloud.com' });
    await resolveContactRestriction({ organizationId: ORG, email: 'SALES@dealer.example' });
    expect(mockFindContactRestriction).not.toHaveBeenCalled();
    expect(mockIdentifierFind).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup throws or is incomplete', async () => {
    mockFindContactRestriction.mockRejectedValue(new Error('The contact restriction lookup was incomplete'));
    await expect(resolveContactRestriction({ organizationId: ORG, phone: '801-555-0142' })).resolves.toEqual({ status: 'unavailable' });
  });

  it('fails closed when the protected-identifier lookup fails', async () => {
    mockIdentifierFind.mockReturnValue({ select: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.reject(new Error('db down')) }) }) }) });
    await expect(resolveContactRestriction({ organizationId: ORG, phone: '801-555-0142' })).resolves.toEqual({ status: 'unavailable' });
  });

  it('fails closed for a missing organization or a malformed lead id', async () => {
    await expect(resolveContactRestriction({ organizationId: '', phone: '801-555-0142' })).resolves.toEqual({ status: 'unavailable' });
    await expect(resolveContactRestriction({ organizationId: ORG, leadId: 'not-an-id' })).resolves.toEqual({ status: 'unavailable' });
    expect(mockFindContactRestriction).not.toHaveBeenCalled();
  });

  it('only looks the lead up inside the same organization', async () => {
    await resolveContactRestriction({ organizationId: ORG, leadId: LEAD });
    expect(mockLeadFindOne).toHaveBeenCalledWith({ _id: LEAD, organizationId: ORG });
  });
});

describe('checkContactForSend, assertContactAllowed, and the permanent record of blocked attempts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigFindOne.mockReturnValue(chain(null));
    mockLeadFindOne.mockReturnValue(chain(null));
    mockIdentifierFind.mockReturnValue(chain([]));
    mockAuditCreate.mockResolvedValue({});
  });

  it('records a blocked attempt with who, which channel, and why', async () => {
    mockFindContactRestriction.mockResolvedValue({ restricted: true, leadIds: [OLD_LEAD] });
    const check = await checkContactForSend(
      { organizationId: ORG, phone: '801-555-0142', leadId: LEAD },
      { channel: 'sms', purpose: 'manual_sms', actor: { kind: 'staff', userId: USER, name: 'Sam' } },
    );
    expect(check.status).toBe('restricted');
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      event: 'outbound_blocked',
      channel: 'sms',
      purpose: 'manual_sms',
      outcome: 'restricted',
      actor: { kind: 'staff', userId: USER, name: 'Sam' },
    }));
    const entry = mockAuditCreate.mock.calls[0][0];
    expect(String(entry.organizationId)).toBe(ORG);
    expect(String(entry.leadId)).toBe(LEAD);
    expect(entry.restrictingLeadIds.map(String)).toEqual([OLD_LEAD]);
  });

  it('writes no audit record when the customer can be contacted', async () => {
    mockFindContactRestriction.mockResolvedValue({ restricted: false, leadIds: [] });
    await checkContactForSend({ organizationId: ORG, phone: '801-555-0142' }, { channel: 'sms' });
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('raises a 403 Do Not Contact error with the restricting lead ids', async () => {
    mockFindContactRestriction.mockResolvedValue({ restricted: true, leadIds: [OLD_LEAD] });
    const error = await assertContactAllowed({ organizationId: ORG, phone: '801-555-0142' }).catch((e) => e);
    expect(error).toBeInstanceOf(ContactRestrictedError);
    expect(isDoNotContactError(error)).toBe(true);
    expect(error).toMatchObject({
      statusCode: 403,
      message: CONTACT_RESTRICTION_MESSAGES.restrictedElsewhere,
      reasonCode: 'do_not_contact',
      errors: [{ code: CONTACT_RESTRICTED_CODE, leadIds: [OLD_LEAD], reason: 'do_not_contact' }],
    });
    expect(error.skipReason).toBe(`${CONTACT_RESTRICTION_MESSAGES.restrictedElsewhere} (do_not_contact)`);
  });

  it('raises a 503 when the restriction cannot be confirmed, which is not a Do Not Contact skip', async () => {
    mockFindContactRestriction.mockRejectedValue(new Error('db down'));
    const error = await assertContactAllowed({ organizationId: ORG, phone: '801-555-0142' }).catch((e) => e);
    expect(error).toMatchObject({
      statusCode: 503,
      restricted: false,
      message: CONTACT_RESTRICTION_MESSAGES.unavailable,
      errors: [{ code: CONTACT_RESTRICTION_UNAVAILABLE_CODE, leadIds: [] }],
    });
    expect(isDoNotContactError(error)).toBe(false);
  });

  it('still blocks the send when the audit record cannot be written', async () => {
    mockFindContactRestriction.mockResolvedValue({ restricted: true, leadIds: [OLD_LEAD] });
    mockAuditCreate.mockRejectedValue(new Error('audit store down'));
    await expect(assertContactAllowed({ organizationId: ORG, phone: '801-555-0142' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('isOrganizationAdmin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts an active CRM admin of this organization', async () => {
    mockCrmUserFindOne.mockReturnValue(chain({ role: 'admin', isActive: true }));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(true);
    expect(mockCrmUserFindOne).toHaveBeenCalledWith({ _id: USER, organizationId: ORG });
  });

  it.each([['manager'], ['employee']])('refuses a CRM %s', async (role) => {
    mockCrmUserFindOne.mockReturnValue(chain({ role, isActive: true }));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(false);
  });

  it('refuses a deactivated CRM admin', async () => {
    mockCrmUserFindOne.mockReturnValue(chain({ role: 'admin', isActive: false }));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(false);
  });

  it('accepts a main-app organization admin of this organization', async () => {
    mockCrmUserFindOne.mockReturnValue(chain(null));
    mockUserFindOne.mockReturnValue(chain({ role: 'employee', organizationRole: 'admin', isActive: true }));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(true);
    expect(mockUserFindOne).toHaveBeenCalledWith({ _id: USER, organizationId: ORG });
  });

  it('refuses a platform super_admin, even one marked as an organization admin', async () => {
    mockCrmUserFindOne.mockReturnValue(chain(null));
    mockUserFindOne.mockReturnValue(chain({ role: 'super_admin', organizationRole: 'admin', isActive: true }));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(false);
  });

  it('refuses someone from another organization, and anyone when the check fails', async () => {
    mockCrmUserFindOne.mockReturnValue(chain(null));
    mockUserFindOne.mockReturnValue(chain(null));
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(false);
    mockCrmUserFindOne.mockImplementation(() => { throw new Error('db down'); });
    await expect(isOrganizationAdmin({ _id: USER }, ORG)).resolves.toBe(false);
    await expect(isOrganizationAdmin({ _id: 'not-an-id' }, ORG)).resolves.toBe(false);
  });
});

describe('protectPreviousContact and releaseProtectedContacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigFindOne.mockReturnValue(chain({ gmailAddress: 'sales@dealer.example' }));
    mockIdentifierUpdateOne.mockResolvedValue({});
    mockIdentifierUpdateMany.mockResolvedValue({});
  });

  it('keeps the old phone and email blocked when they change', async () => {
    const protectedValues = await protectPreviousContact({
      organizationId: ORG,
      leadId: LEAD,
      previous: { phone: '801-555-0142', email: 'old@example.com' },
      next: { phone: '801-555-0199', email: 'new@example.com' },
      actorUserId: USER,
    });
    expect(protectedValues).toEqual({ phone: '+18015550142', email: 'old@example.com' });
    expect(mockIdentifierUpdateOne).toHaveBeenCalledWith(
      { organizationId: ORG, leadId: LEAD, kind: 'phone', value: '+18015550142', active: true },
      { $setOnInsert: expect.objectContaining({ kind: 'phone', value: '+18015550142', active: true, createdBy: USER }) },
      { upsert: true },
    );
  });

  it('blocks the new phone and email right away too', async () => {
    await protectPreviousContact({
      organizationId: ORG,
      leadId: LEAD,
      previous: { phone: '801-555-0142', email: 'old@example.com' },
      next: { phone: '801-555-0199', email: 'new@example.com' },
      actorUserId: USER,
    });
    const values = mockIdentifierUpdateOne.mock.calls.map(([filter]: any[]) => `${filter.kind}:${filter.value}`);
    expect(values.sort()).toEqual(['email:new@example.com', 'email:old@example.com', 'phone:+18015550142', 'phone:+18015550199']);
  });

  it('does not block a new dealership address', async () => {
    await protectPreviousContact({ organizationId: ORG, leadId: LEAD, previous: { email: 'old@example.com' }, next: { email: 'sales@dealer.example' } });
    const values = mockIdentifierUpdateOne.mock.calls.map(([filter]: any[]) => `${filter.kind}:${filter.value}`);
    expect(values).toEqual(['email:old@example.com']);
  });

  it('protects nothing when only the formatting changed, or for excluded and dealership addresses', async () => {
    await protectPreviousContact({ organizationId: ORG, leadId: LEAD, previous: { phone: '(801) 555-0142' }, next: { phone: '801-555-0142' } });
    await protectPreviousContact({ organizationId: ORG, leadId: LEAD, previous: { email: 'proxy@example.com', identityEmailExcluded: true }, next: { email: '' } });
    await protectPreviousContact({ organizationId: ORG, leadId: LEAD, previous: { email: 'sales@dealer.example' }, next: { email: '' } });
    expect(mockIdentifierUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses to run without a valid organization and lead', async () => {
    await expect(protectPreviousContact({ organizationId: '', leadId: LEAD, previous: {}, next: {} })).rejects.toThrow();
  });

  it('releases a lead\'s protected details when Do Not Contact is removed', async () => {
    await releaseProtectedContacts({ organizationId: ORG, leadId: LEAD, actorUserId: USER });
    expect(mockIdentifierUpdateMany).toHaveBeenCalledWith(
      { organizationId: ORG, leadId: LEAD, active: true },
      { $set: expect.objectContaining({ active: false, releasedBy: USER }) },
    );
  });
});

describe('restrictedSince and authorizeWebchatReply', () => {
  const session = { _id: SESSION, organizationId: ORG, leadId: LEAD, visitorPhone: '801-555-0142' };
  const now = new Date('2026-10-23T16:00:00.000Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000);

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigFindOne.mockReturnValue(chain(null));
    mockLeadFindOne.mockReturnValue(chain(null));
    mockIdentifierFind.mockReturnValue(chain([]));
    mockFindContactRestriction.mockResolvedValue({ restricted: true, leadIds: [OLD_LEAD] });
    mockAuditFindOne.mockReturnValue(chain(null));
    mockLeadFind.mockReturnValue(chain([
      { _id: OLD_LEAD, status: 'Do Not Contact', statusHistory: [{ to: 'Contacted', changedAt: minutesAgo(600) }, { to: 'Do Not Contact', changedAt: minutesAgo(120) }] },
    ]));
  });

  it('uses the latest move into Do Not Contact', async () => {
    await expect(restrictedSince(ORG, [OLD_LEAD])).resolves.toEqual(minutesAgo(120));
  });

  it('falls back to the recorded Do Not Contact audit entry for a lead without history', async () => {
    mockLeadFind.mockReturnValue(chain([{ _id: OLD_LEAD, status: 'Do Not Contact', statusHistory: [], updatedAt: minutesAgo(5) }]));
    mockAuditFindOne.mockReturnValue(chain({ createdAt: minutesAgo(300) }));
    await expect(restrictedSince(ORG, [OLD_LEAD])).resolves.toEqual(minutesAgo(300));
  });

  it('gives no answer when a restricting lead is missing or no longer Do Not Contact', async () => {
    mockLeadFind.mockReturnValue(chain([]));
    await expect(restrictedSince(ORG, [OLD_LEAD])).resolves.toBeNull();
    mockLeadFind.mockReturnValue(chain([{ _id: OLD_LEAD, status: 'Contacted', statusHistory: [] }]));
    await expect(restrictedSince(ORG, [OLD_LEAD])).resolves.toBeNull();
  });

  it('allows any reply when the customer is not restricted', async () => {
    mockFindContactRestriction.mockResolvedValue({ restricted: false, leadIds: [] });
    await expect(authorizeWebchatReply(session, now)).resolves.toEqual({ allowed: true, basis: 'not_restricted' });
    expect(mockWebChatMessageFindOne).not.toHaveBeenCalled();
  });

  it('allows a reply within 30 minutes of the customer\'s latest message in this chat', async () => {
    mockWebChatMessageFindOne.mockReturnValue(chain({ _id: MESSAGE, createdAt: minutesAgo(10) }));
    const decision = await authorizeWebchatReply(session, now);
    expect(decision).toEqual({
      allowed: true,
      basis: 'dnc_live_session',
      respondingToMessageId: MESSAGE,
      windowEndsAt: new Date(minutesAgo(10).getTime() + WEBCHAT_RESPONSE_WINDOW_MS),
      restrictingLeadIds: [OLD_LEAD],
    });
    expect(mockWebChatMessageFindOne).toHaveBeenCalledWith({ sessionId: SESSION, organizationId: ORG, direction: 'inbound' });
  });

  it('blocks once 30 minutes have passed since the customer\'s latest message', async () => {
    mockWebChatMessageFindOne.mockReturnValue(chain({ _id: MESSAGE, createdAt: minutesAgo(31) }));
    await expect(authorizeWebchatReply(session, now)).resolves.toMatchObject({ allowed: false, reasonCode: 'webchat_window_closed' });
  });

  it('blocks when Do Not Contact was applied after the customer\'s latest message', async () => {
    mockLeadFind.mockReturnValue(chain([{ _id: OLD_LEAD, status: 'Do Not Contact', statusHistory: [{ to: 'Do Not Contact', changedAt: minutesAgo(5) }] }]));
    mockWebChatMessageFindOne.mockReturnValue(chain({ _id: MESSAGE, createdAt: minutesAgo(10) }));
    await expect(authorizeWebchatReply(session, now)).resolves.toMatchObject({ allowed: false, reasonCode: 'webchat_window_closed' });
  });

  it('blocks when the customer has not written in this chat', async () => {
    mockWebChatMessageFindOne.mockReturnValue(chain(null));
    await expect(authorizeWebchatReply(session, now)).resolves.toMatchObject({ allowed: false, reasonCode: 'webchat_window_closed' });
  });

  it('blocks when the restriction cannot be confirmed', async () => {
    mockFindContactRestriction.mockRejectedValue(new Error('db down'));
    await expect(authorizeWebchatReply(session, now)).resolves.toMatchObject({ allowed: false, reasonCode: 'restriction_lookup_unavailable' });
  });

  it('blocks when the chat history cannot be read', async () => {
    mockWebChatMessageFindOne.mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.reject(new Error('db down')) }) }) });
    await expect(authorizeWebchatReply(session, now)).resolves.toMatchObject({ allowed: false, reasonCode: 'restriction_lookup_unavailable' });
  });
});
