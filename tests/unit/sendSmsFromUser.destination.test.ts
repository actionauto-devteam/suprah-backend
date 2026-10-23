jest.mock('../../src/services/contactRestriction.service', () => ({
  ...jest.requireActual('../../src/services/contactRestriction.service'),
  resolveContactRestriction: jest.fn(async () => ({ status: 'allowed' })),
  checkContactForSend: jest.fn(async () => ({ status: 'allowed' })),
  assertContactAllowed: jest.fn(async () => undefined),
  authorizeWebchatReply: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  assertWebchatReplyAllowed: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  recordWebchatExceptionReply: jest.fn(async () => undefined),
  recordContactRestrictionAudit: jest.fn(async () => true),
  describeWebchatContactPolicy: jest.fn(async () => ({ restricted: false, lookupUnavailable: false, restrictedSince: null, windowMinutes: 30 })),
  isOrganizationAdmin: jest.fn(async () => false),
  protectPreviousContact: jest.fn(async () => ({})),
  releaseProtectedContacts: jest.fn(async () => undefined),
}));
const mockConvFindOneAndUpdate = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageFindOneAndUpdate = jest.fn().mockResolvedValue(null);
const mockMessageDeleteOne = jest.fn().mockResolvedValue({});
const mockSendSms = jest.fn();
const mockOptOutLean = jest.fn().mockResolvedValue(null);
const mockGetSocketIO = jest.fn().mockReturnValue(null);
const mockFindUniqueCustomerByPhone = jest.fn().mockResolvedValue(null);

function makeMessageDoc(overrides: Partial<{ _id: any; status: string }> = {}) {
  const doc: any = {
    _id: overrides._id ?? 'msg-1',
    status: overrides.status ?? 'queued',
    providerMessageId: undefined,
    sentAt: undefined,
    errorDetail: undefined,
    toObject() {
      return { ...this };
    },
    save: jest.fn().mockImplementation(async function (this: any) {
      return this;
    }),
  };
  return doc;
}

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: {
    findOneAndUpdate: mockConvFindOneAndUpdate,
    updateOne: mockConvUpdateOne,
  },
  CommunicationMessage: {
    create: mockMessageCreate,
    updateOne: mockMessageUpdateOne,
    findOneAndUpdate: mockMessageFindOneAndUpdate,
    deleteOne: mockMessageDeleteOne,
  },
  CallLog: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() },
  TelephonyCredential: {},
}));
jest.mock('../../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550000',
  sendSms: mockSendSms,
}));
jest.mock('../../src/services/customerIdentity.service', () => ({
  findUniqueCustomerByPhone: mockFindUniqueCustomerByPhone,
}));
jest.mock('../../src/services/callRoutingConfig.service', () => ({
  getInboundRoutingConfig: jest.fn().mockResolvedValue(null),
  getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: mockGetSocketIO }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: jest.fn() }));
jest.mock('../../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn(), shouldSuppressHandoffNoteNotification: jest.fn() }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({ notificationTemplates: {} }));
jest.mock('../../src/models/SmsOptOut.model', () => ({ __esModule: true, default: { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: mockOptOutLean }) }) } }));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: jest.fn(),
  processAlexTurn: jest.fn(),
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: jest.fn() }));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(),
  finishAiAttentionCheck: jest.fn(),
  screenAiHumanAttention: jest.fn(),
  canSendAiReply: jest.fn(),
  assertAiReplyAllowed: jest.fn(),
  AiReplySuppressedError: class AiReplySuppressedError extends Error {},
  claimAiGeneration: jest.fn(),
  claimAiReplyDispatch: jest.fn(),
  attentionOrgIds: (id: string) => [id],
  recoverAiHumanAttention: jest.fn(),
}));
jest.mock('../../src/services/ivr.service', () => ({
  initializeIvr: jest.fn(),
  handleIvrGather: jest.fn(),
  emitIvrCall: jest.fn(),
  clearIvrTimer: jest.fn(),
  canReceiveIvrCall: jest.fn(),
  ivrAgentFailed: jest.fn(),
  recoverIvrCalls: jest.fn(),
}));


import { sendSmsFromUser, sendAutomatedSms, sendStaffAttributedSms } from '../../src/services/communication.service';
import { SmsDestinationError } from '../../src/utils/smsDestination';

describe('sendSmsFromUser — destination validation at the central SMS boundary', () => {
  const actor = { userId: 'staff-1', name: 'Jamie' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutLean.mockResolvedValue(null);
    mockFindUniqueCustomerByPhone.mockResolvedValue(null);
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', toObject() { return { _id: 'conv-1' }; } });
    mockMessageCreate.mockImplementation(async (doc: any) => ({ ...makeMessageDoc(), ...doc }));
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-1' });
  });

  function expectNothingWritten() {
    expect(mockFindUniqueCustomerByPhone).not.toHaveBeenCalled();
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConvUpdateOne).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  }

  it.each([
    ['385-503-5869 x12', 'extension'],
    ['385-503-5869;ext=12', 'extension'],
    ['503-5869', 'incomplete'],
    ['+999123456789', 'invalid'],
    ['+385503586912', 'invalid'],
    ['+180170268', 'invalid'],
    ['+44 (0) 20 7946 0958', 'ambiguous'],
    ['+19005551234', 'unsupported_number_type'],
  ])('rejects %p for a manual send before any lookup, record or Telnyx call', async (toPhone, reason) => {
    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone, body: 'hello', destinationPolicy: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 400, reason, errors: [{ code: 'SMS_INVALID_DESTINATION', reason, policy: 'manual' }] });
    expectNothingWritten();
  });

  it('uses the strict automated policy when the caller does not say otherwise', async () => {
    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+639171234567', body: 'hello' }),
    ).rejects.toBeInstanceOf(SmsDestinationError);
    expectNothingWritten();
  });

  it('sends a valid international number when the server marks the send as manual', async () => {
    const result = await sendSmsFromUser({
      orgId: 'org-1',
      user: actor,
      toPhone: '+63 917 123 4567',
      body: 'hello',
      destinationPolicy: 'manual',
    });

    expect(mockSendSms).toHaveBeenCalledWith('+639171234567', 'hello');
    expect(mockMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ to: '+639171234567', status: 'queued' }));
    expect(result.message.status).toBe('sent');
  });

  it('keeps a normal US send unchanged, using the same conversation key as before', async () => {
    const result = await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '(385) 503-5869', body: 'hello' });

    expect(mockConvFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', customerPhone: '+13855035869' }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockSendSms).toHaveBeenCalledWith('+13855035869', 'hello');
    expect(result.message.status).toBe('sent');
  });

  it('still sends to a Demo Lab number through the automated policy', async () => {
    await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550142', body: 'hello' });
    expect(mockSendSms).toHaveBeenCalledWith('+18015550142', 'hello');
  });

  it('still marks a provider-rejected destination as failed instead of sent', async () => {
    const doc = makeMessageDoc();
    mockMessageCreate.mockResolvedValue(doc);
    mockSendSms.mockRejectedValue(new Error('Telnyx: destination not supported'));

    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+44 20 7946 0958', body: 'hello', destinationPolicy: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(doc.status).toBe('failed');
  });
});

describe('automated SMS wrappers', () => {
  const actor = { userId: 'staff-1', name: 'Jamie' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutLean.mockResolvedValue(null);
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', toObject() { return { _id: 'conv-1' }; } });
    mockMessageCreate.mockImplementation(async (doc: any) => ({ ...makeMessageDoc(), ...doc }));
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-1' });
  });

  it('still returns false for a STOP opt-out without any record or Telnyx call', async () => {
    mockOptOutLean.mockResolvedValue({ optedOut: true });

    await expect(sendAutomatedSms({ orgId: 'org-1', toPhone: '+13855035869', body: 'hello' })).resolves.toBe(false);
    await expect(sendStaffAttributedSms({ orgId: 'org-1', toPhone: '+13855035869', body: 'hello', actor })).resolves.toBe(false);
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('throws the structured destination error for automated and campaign sends to a non-US/Canada number', async () => {
    await expect(sendAutomatedSms({ orgId: 'org-1', toPhone: '+639171234567', body: 'hello' })).rejects.toMatchObject({
      reason: 'country_not_allowed',
    });
    await expect(
      sendStaffAttributedSms({ orgId: 'org-1', toPhone: '+639171234567', body: 'hello', actor }),
    ).rejects.toMatchObject({ reason: 'country_not_allowed', policy: 'automated' });
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('sends a valid US automated text normally', async () => {
    await expect(sendAutomatedSms({ orgId: 'org-1', toPhone: '385-503-5869', body: 'hello' })).resolves.toBe(true);
    expect(mockSendSms).toHaveBeenCalledWith('+13855035869', 'hello');
  });
});

describe('Do Not Contact at the central SMS boundary', () => {
  const actor = { userId: 'staff-1', name: 'Jamie' };
  const restriction = jest.requireMock('../../src/services/contactRestriction.service');
  const { ContactRestrictedError } = jest.requireActual('../../src/services/contactRestriction.service');
  const blocked = () => new ContactRestrictedError({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false });

  beforeEach(() => {
    jest.clearAllMocks();
    mockOptOutLean.mockResolvedValue(null);
    mockFindUniqueCustomerByPhone.mockResolvedValue(null);
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', toObject() { return { _id: 'conv-1' }; } });
    mockMessageCreate.mockImplementation(async (doc: any) => ({ ...makeMessageDoc(), ...doc }));
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-1' });
  });

  afterEach(() => {
    restriction.assertContactAllowed.mockImplementation(async () => undefined);
  });

  it('blocks a manual send with an actionable 403 before any conversation, record, or Telnyx call', async () => {
    restriction.assertContactAllowed.mockImplementation(async () => { throw blocked(); });

    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '(385) 503-5869', body: 'hello', leadId: 'lead-new', customerId: 'cust-1', destinationPolicy: 'manual' }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Do Not Contact'),
      errors: [{ code: 'CONTACT_RESTRICTED', leadIds: ['lead-old'] }],
    });
    expect(restriction.assertContactAllowed).toHaveBeenCalledWith({
      organizationId: 'org-1',
      phone: '+13855035869',
      leadId: 'lead-new',
      customerId: 'cust-1',
    }, expect.objectContaining({ channel: 'sms', purpose: 'manual_sms', actor: expect.objectContaining({ kind: 'staff', userId: 'staff-1' }) }));
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('blocks automated, campaign, and Alex-attributed wrappers instead of reporting a STOP opt-out', async () => {
    restriction.assertContactAllowed.mockImplementation(async () => { throw blocked(); });

    await expect(sendAutomatedSms({ orgId: 'org-1', toPhone: '385-503-5869', body: 'hello' })).rejects.toMatchObject({ statusCode: 403, restricted: true });
    await expect(sendStaffAttributedSms({ orgId: 'org-1', toPhone: '385-503-5869', body: 'hello', actor: { userId: 'ai-agent', name: 'Alex' } }))
      .rejects.toMatchObject({ statusCode: 403, restricted: true });
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('rechecks right before Telnyx and removes the queued record when the customer became Do Not Contact meanwhile', async () => {
    restriction.assertContactAllowed
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => { throw blocked(); });

    await expect(sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '385-503-5869', body: 'hello' })).rejects.toMatchObject({ statusCode: 403 });
    expect(restriction.assertContactAllowed).toHaveBeenCalledTimes(2);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageDeleteOne).toHaveBeenCalledWith({ _id: 'msg-1', orgId: 'org-1', status: 'queued' });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('fails closed with a 503 when the restriction cannot be confirmed', async () => {
    restriction.assertContactAllowed.mockImplementation(async () => {
      throw new ContactRestrictedError({ status: 'unavailable' });
    });

    await expect(sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '385-503-5869', body: 'hello', destinationPolicy: 'manual' }))
      .rejects.toMatchObject({ statusCode: 503, errors: [{ code: 'CONTACT_RESTRICTION_UNAVAILABLE', leadIds: [] }] });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('keeps the STOP check first for automated sends', async () => {
    mockOptOutLean.mockResolvedValue({ optedOut: true });
    restriction.assertContactAllowed.mockImplementation(async () => { throw blocked(); });

    await expect(sendAutomatedSms({ orgId: 'org-1', toPhone: '385-503-5869', body: 'hello' })).resolves.toBe(false);
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
