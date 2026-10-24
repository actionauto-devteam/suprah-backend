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
const mockConvFindById = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageFindOne = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockAppointmentFindOne = jest.fn();
const mockAppointmentUpdateOne = jest.fn().mockResolvedValue({});
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);
const mockResolveAiAgentSettings = jest.fn();
const mockSendSms = jest.fn();
const mockClaimAiGeneration = jest.fn().mockResolvedValue(null);
const mockFinishAiAttentionCheck = jest.fn().mockResolvedValue(undefined);
const mockProcessAlexTurn = jest.fn();
const mockAiAgentLogCreate = jest.fn().mockResolvedValue({});

jest.mock('../../src/models/IntakeClaim.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn().mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: null }),
    findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  },
}));
jest.mock('../../src/models/communication.model', () => {
  const { Schema } = require('mongoose');
  return {
    __esModule: true,
    Conversation: { findOneAndUpdate: mockConvFindOneAndUpdate, findById: mockConvFindById, updateOne: mockConvUpdateOne },
    CommunicationMessage: {
      findOne: mockMessageFindOne,
      create: mockMessageCreate,
      updateOne: mockMessageUpdateOne,
      countDocuments: jest.fn().mockResolvedValue(0),
    },
    CallLog: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() },
    TelephonyCredential: {},
    ActorRefSchema: new Schema({ userId: Schema.Types.Mixed, name: String, email: String }, { _id: false }),
  };
});
jest.mock('../../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550000', sendSms: mockSendSms }));
jest.mock('../../src/services/customerIdentity.service', () => ({ findUniqueCustomerByPhone: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ getInboundRoutingConfig: jest.fn().mockResolvedValue(null), getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn().mockReturnValue(null) }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { findOne: mockAppointmentFindOne, updateOne: mockAppointmentUpdateOne },
}));
jest.mock('../../src/models/AiAgentLog.model', () => ({ __esModule: true, default: { create: mockAiAgentLogCreate } }));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: mockNotifyOrgAdmins }));
jest.mock('../../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn() }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({
  notificationTemplates: {
    new_lead: jest.fn().mockReturnValue({ title: 'New Lead', message: 'msg' }),
    appointment_confirmed_via_sms: jest.fn().mockReturnValue({ title: 'Confirmed', message: 'm' }),
    appointment_reschedule_requested: jest.fn().mockReturnValue({ title: 'Reschedule', message: 'm' }),
    appointment_reschedule_preference_received: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    sms_opt_out: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
  },
}));
jest.mock('../../src/models/SmsOptOut.model', () => ({
  __esModule: true,
  default: {
    updateOne: jest.fn(),
    findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }),
  },
}));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/aiOperatingMode.service', () => require('./helpers/legacyAiModeMock').legacyAiModeMock((orgId: any) => mockResolveAiAgentSettings(orgId)));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  processAlexTurn: mockProcessAlexTurn,
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: jest.fn().mockResolvedValue('staff-1') }));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(async (input: any) => ({ ...input, version: 1 })),
  finishAiAttentionCheck: mockFinishAiAttentionCheck,
  screenAiHumanAttention: jest.fn().mockResolvedValue(true),
  canSendAiReply: jest.fn().mockResolvedValue(true),
  assertAiReplyAllowed: jest.fn(),
  claimAiGeneration: mockClaimAiGeneration,
  claimAiReplyDispatch: jest.fn(),
  AiReplySuppressedError: class AiReplySuppressedError extends Error {},
  attentionOrgIds: (id: string) => [id],
  recoverAiHumanAttention: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import { handleInboundSms, triggerSmsAiReply } from '../../src/services/communication.service';

function conversation(customerPhone: string) {
  return { _id: 'conv-1', leadId: 'lead-1', customerPhone, toObject() { return { ...this }; } };
}

describe('Alex SMS replies and untextable numbers', () => {
  const check: any = { kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1', version: 1 };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
  });

  it.each(['+639171234567', '+385503586912', '+180170268'])(
    'releases the turn and logs a skip for %p before claiming or generating a reply',
    async (phone) => {
      await triggerSmsAiReply('org-1', conversation(phone), { _id: 'lead-1' }, check, 'Is it still available?', true);

      expect(mockFinishAiAttentionCheck).toHaveBeenCalledWith(check);
      expect(mockClaimAiGeneration).not.toHaveBeenCalled();
      expect(mockProcessAlexTurn).not.toHaveBeenCalled();
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(mockMessageCreate).not.toHaveBeenCalled();
      expect(mockAiAgentLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', channel: 'sms', leadId: 'lead-1', status: 'skipped' }),
      );
    },
  );

  it('keeps the normal Alex path for a valid US number', async () => {
    await triggerSmsAiReply('org-1', conversation('+13855035869'), { _id: 'lead-1' }, check, 'Is it still available?', true);

    expect(mockClaimAiGeneration).toHaveBeenCalledWith(check);
    expect(mockAiAgentLogCreate).not.toHaveBeenCalled();
  });
});

describe('inbound YES/CANCEL replies from a number automatic texts cannot reach', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;

  beforeEach(() => {
    jest.clearAllMocks();
    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') {
        return {
          updateOne: jest.fn().mockResolvedValue({}),
          findById: jest.fn(),
          create: jest.fn(),
          findOne: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }),
          find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() {}, close: jest.fn() }) }) }) }) }),
        } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });
    process.env.COMM_ORG_ID = 'org-1';
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
    mockConvFindOneAndUpdate.mockResolvedValue(conversation('+639171234567'));
    mockMessageFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockMessageCreate.mockImplementation(async (doc: any) => ({
      _id: 'msg-in',
      createdAt: new Date(),
      ...doc,
      toObject() { return { ...doc, _id: 'msg-in' }; },
    }));
    mockAppointmentFindOne.mockReturnValue({
      sort: jest.fn().mockReturnValue(
        Promise.resolve({
          _id: 'appt-1',
          title: 'Test drive',
          status: 'scheduled',
          startTime: new Date('2026-10-23T18:00:00.000Z'),
          leadId: 'lead-1',
          customerBooking: { firstName: 'Pat', lastName: 'Lee', phone: '+639171234567' },
        }),
      ),
    });
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
    delete process.env.COMM_ORG_ID;
  });

  it('still confirms the appointment and tells staff, without creating an outbound text', async () => {
    await handleInboundSms({ from: '+639171234567', to: '+18015550000', text: 'YES', id: 'wh-intl-yes' });

    expect(mockAppointmentUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appt-1' }),
      expect.objectContaining({ $set: { status: 'confirmed' } }),
    );
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith('org-1', 'appointment_confirmed_via_sms', 'Confirmed', 'm', { appointmentId: 'appt-1' });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockMessageCreate.mock.calls.every(([doc]: any[]) => doc.direction === 'inbound')).toBe(true);
  });

  it('still records the reschedule request and tells staff', async () => {
    await handleInboundSms({ from: '+639171234567', to: '+18015550000', text: 'CANCEL', id: 'wh-intl-cancel' });

    expect(mockAppointmentUpdateOne).toHaveBeenCalledWith({ _id: 'appt-1' }, { $set: { rescheduleAwaitingReplyAt: expect.any(Date) } });
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith('org-1', 'appointment_reschedule_requested', 'Reschedule', 'm', { appointmentId: 'appt-1' });
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});

describe('Do Not Contact customers', () => {
  const restriction = jest.requireMock('../../src/services/contactRestriction.service');
  const { ContactRestrictedError } = jest.requireActual('../../src/services/contactRestriction.service');
  const check: any = { kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1', version: 1 };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
  });

  afterEach(() => {
    restriction.checkContactForSend.mockImplementation(async () => ({ status: 'allowed' }));
    restriction.assertContactAllowed.mockImplementation(async () => undefined);
  });

  it.each([
    [{ status: 'restricted', leadIds: ['lead-old'], onThisLead: false }, '(do_not_contact)'],
    [{ status: 'unavailable' }, '(restriction_lookup_unavailable)'],
  ])('Alex skips before generating anything and records why (%p)', async (result, code) => {
    restriction.checkContactForSend.mockImplementation(async () => result);

    await triggerSmsAiReply('org-1', { ...conversation('+13855035869'), customerId: 'cust-1' }, { _id: 'lead-1' }, check, 'Is it still available?', true);

    expect(restriction.checkContactForSend).toHaveBeenCalledWith({
      organizationId: 'org-1',
      phone: '+13855035869',
      leadId: 'lead-1',
      customerId: 'cust-1',
    }, expect.objectContaining({ channel: 'sms', purpose: 'alex_sms_reply', actor: expect.objectContaining({ kind: 'ai' }) }));
    expect(mockFinishAiAttentionCheck).toHaveBeenCalledWith(check);
    expect(mockClaimAiGeneration).not.toHaveBeenCalled();
    expect(mockProcessAlexTurn).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockAiAgentLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      leadId: 'lead-1',
      status: 'skipped',
      failureReason: expect.stringContaining(code),
    }));
  });

  describe('inbound replies', () => {
    let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;

    beforeEach(() => {
      mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
        if (name === 'Lead') {
          return {
            updateOne: jest.fn().mockResolvedValue({}),
            findById: jest.fn(),
            create: jest.fn(),
            findOne: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }),
            find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() {}, close: jest.fn() }) }) }) }) }),
          } as any;
        }
        throw new Error(`Schema hasn't been registered for model "${name}".`);
      });
      process.env.COMM_ORG_ID = 'org-1';
      mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
      mockConvFindOneAndUpdate.mockResolvedValue(conversation('+13855035869'));
      mockMessageFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      mockMessageCreate.mockImplementation(async (doc: any) => ({
        _id: 'msg-in',
        createdAt: new Date(),
        ...doc,
        toObject() { return { ...doc, _id: 'msg-in' }; },
      }));
      mockAppointmentFindOne.mockReturnValue({
        sort: jest.fn().mockReturnValue(
          Promise.resolve({
            _id: 'appt-1',
            title: 'Test drive',
            status: 'scheduled',
            startTime: new Date('2026-10-23T18:00:00.000Z'),
            leadId: 'lead-1',
            customerBooking: { firstName: 'Pat', lastName: 'Lee', phone: '+13855035869' },
          }),
        ),
      });
      restriction.assertContactAllowed.mockImplementation(async () => {
        throw new ContactRestrictedError({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false });
      });
    });

    afterEach(() => {
      mongooseModelSpy.mockRestore();
      delete process.env.COMM_ORG_ID;
    });

    it('records the customer\'s YES, confirms the appointment, and tells staff, but sends no automatic reply', async () => {
      await handleInboundSms({ from: '+13855035869', to: '+18015550000', text: 'YES', id: 'wh-dnc-yes' });

      expect(mockMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ direction: 'inbound', body: 'YES' }));
      expect(mockAppointmentUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'appt-1' }),
        expect.objectContaining({ $set: { status: 'confirmed' } }),
      );
      expect(mockNotifyOrgAdmins).toHaveBeenCalledWith('org-1', 'appointment_confirmed_via_sms', 'Confirmed', 'm', { appointmentId: 'appt-1' });
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(mockMessageCreate.mock.calls.every(([doc]: any[]) => doc.direction === 'inbound')).toBe(true);
    });
  });
});
