const mockConvFindOneAndUpdate = jest.fn();
const mockConvFindById = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageFindOne = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockCallFindOne = jest.fn();
const mockSmsOptOutUpdateOne = jest.fn();
const mockAppointmentFindOne = jest.fn();
const mockAppointmentUpdateOne = jest.fn();
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);
const mockResolveOrgSystemUserId = jest.fn();
const mockResolveAiAgentSettings = jest.fn();
const mockGetSocketIO = jest.fn().mockReturnValue(null);

jest.mock('../../src/models/communication.model', () => {
  const { Schema } = require('mongoose');
  return {
    __esModule: true,
    Conversation: {
      findOneAndUpdate: mockConvFindOneAndUpdate,
      findById: mockConvFindById,
      updateOne: mockConvUpdateOne,
    },
    CommunicationMessage: {
      findOne: mockMessageFindOne,
      create: mockMessageCreate,
      updateOne: mockMessageUpdateOne,
      countDocuments: jest.fn().mockResolvedValue(0),
    },
    CallLog: {
      findOne: mockCallFindOne,
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
    },
    TelephonyCredential: {},
    ActorRefSchema: new Schema({ userId: Schema.Types.Mixed, name: String, email: String }, { _id: false }),
  };
});
jest.mock('../../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550000' }));
jest.mock('../../src/services/customerIdentity.service', () => ({ findUniqueCustomerByPhone: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ getInboundRoutingConfig: jest.fn().mockResolvedValue(null), getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: mockGetSocketIO }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { findOne: mockAppointmentFindOne, updateOne: mockAppointmentUpdateOne },
}));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: mockNotifyOrgAdmins }));
jest.mock('../../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn() }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({
  notificationTemplates: {
    new_lead: jest.fn().mockReturnValue({ title: 'New Lead', message: 'msg' }),
    appointment_confirmed_via_sms: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    appointment_reschedule_requested: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    appointment_reschedule_preference_received: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
    sms_opt_out: jest.fn().mockReturnValue({ title: 't', message: 'm' }),
  },
}));
jest.mock('../../src/models/SmsOptOut.model', () => ({
  __esModule: true,
  default: { updateOne: mockSmsOptOutUpdateOne },
}));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  processAlexTurn: jest.fn(),
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: mockResolveOrgSystemUserId }));
const mockScreenAiHumanAttention = jest.fn().mockResolvedValue(true);
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(async input => ({ ...input, version: 1 })),
  finishAiAttentionCheck: jest.fn().mockResolvedValue(undefined),
  screenAiHumanAttention: mockScreenAiHumanAttention,
  canSendAiReply: jest.fn().mockResolvedValue(true),
  claimAiGeneration: jest.fn().mockResolvedValue(null),
  attentionOrgIds: (id: string) => [id],
  recoverAiHumanAttention: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import { findOrCreateLeadForContact, handleInboundSms, handleCallInitiated } from '../../src/services/communication.service';

function makeConversation(overrides: Partial<{ _id: any; leadId: any; customerPhone: string }> = {}) {
  return {
    _id: overrides._id ?? 'conv-1',
    leadId: overrides.leadId ?? null,
    customerPhone: overrides.customerPhone ?? '+18015550100',
    toObject() {
      return { ...this };
    },
  };
}

describe('findOrCreateLeadForContact', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;
  let mockLeadFindById: jest.Mock;
  let mockLeadCreate: jest.Mock;
  let mockLeadFindOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadFindById = jest.fn();
    mockLeadCreate = jest.fn();
    mockLeadFindOne = jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') {
return { findById: mockLeadFindById, create: mockLeadCreate, findOne: mockLeadFindOne, find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() {}, close: jest.fn() }) }) }) }) }) } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });

    mockResolveOrgSystemUserId.mockResolvedValue('staff-1');
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
    mockGetSocketIO.mockReturnValue(null);
  });


  it('short-circuits on an already-matched existing Lead (no claim attempted)', async () => {
    const existingLead = { _id: 'lead-existing' };
    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation(),
      existingLead,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(result).toEqual({ lead: existingLead, created: false });
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("short-circuits when Conversation.leadId is already set (no claim attempted)", async () => {
const linkedLead = { _id: 'lead-linked', phone: '+18015550100' };
    mockLeadFindOne.mockResolvedValue(linkedLead);

    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation({ leadId: 'lead-linked' }),
      existingLead: null,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(result).toEqual({ lead: linkedLead, created: false });
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('claims and creates a new Lead on a clean win', async () => {
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', leadId: 'candidate' });
    const createdLead = { _id: 'lead-new', firstName: 'Unknown' };
    mockLeadCreate.mockResolvedValue(createdLead);

    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation(),
      existingLead: null,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(mockConvFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', leadId: null },
      expect.objectContaining({ $set: expect.objectContaining({ leadId: expect.any(mongoose.Types.ObjectId) }) }),
      { new: true },
    );
    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    const [createArgs] = mockLeadCreate.mock.calls[0];
    expect(createArgs.organizationId).toBe('org-1');
    expect(createArgs.channel).toBe('sms');
    expect(createArgs.source).toBe('Inbound SMS');
    expect(createArgs.vehicleId).toBeUndefined();
    expect(createArgs.location).toBeUndefined();
    expect(result).toEqual({ lead: createdLead, created: true });
  });

  it('on a clean loss, re-reads the winning leadId and never calls Lead.create', async () => {
    mockConvFindOneAndUpdate.mockResolvedValue(null);
    mockConvFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ leadId: 'lead-winner' }) }) });
    const winnerLead = { _id: 'lead-winner' };
mockLeadFindOne.mockResolvedValue(winnerLead);

    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation(),
      existingLead: null,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ lead: winnerLead, created: false });
  });

  it('proves the concurrency guarantee: two simultaneous callers never both create a Lead', async () => {
    let claimed = false;
    mockConvFindOneAndUpdate.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { _id: 'conv-1', leadId: 'candidate' };
      }
      return null;
    });
    mockConvFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ leadId: 'lead-winner' }) }) });
    mockLeadCreate.mockResolvedValue({ _id: 'lead-winner' });
mockLeadFindOne.mockResolvedValue({ _id: 'lead-winner' });

    const attempt = () =>
      findOrCreateLeadForContact({
        orgId: 'org-1',
        conversation: makeConversation(),
        existingLead: null,
        phone: '+18015550100',
        customer: null,
        channel: 'sms',
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
  });

  it('rolls back the claim if Lead.create fails, and resolves (never throws)', async () => {
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', leadId: 'candidate' });
    mockLeadCreate.mockRejectedValue(new Error('db write failed'));

    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation(),
      existingLead: null,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(result).toEqual({ lead: null, created: false });
    expect(mockConvUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'conv-1', leadId: expect.any(mongoose.Types.ObjectId) }),
      { $set: { leadId: null } },
    );
  });

  it('rolls back the claim if no org system user is configured, and resolves (never throws)', async () => {
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', leadId: 'candidate' });
    mockResolveOrgSystemUserId.mockResolvedValue(null);

    const result = await findOrCreateLeadForContact({
      orgId: 'org-1',
      conversation: makeConversation(),
      existingLead: null,
      phone: '+18015550100',
      customer: null,
      channel: 'sms',
    });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ lead: null, created: false });
    expect(mockConvUpdateOne).toHaveBeenCalledTimes(1);
  });
});

describe('handleInboundSms — Lead creation never fires for spam/system replies', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;
  let mockLeadFindById: jest.Mock;
  let mockLeadCreate: jest.Mock;
  let mockLeadFindOne: jest.Mock;
  const mockLeadUpdateOne = jest.fn().mockResolvedValue({});
  let availableLeads: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    availableLeads = [];
    mockLeadFindById = jest.fn();
    mockLeadCreate = jest.fn();
    mockLeadFindOne = jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') {
return { updateOne: mockLeadUpdateOne, findById: mockLeadFindById, create: mockLeadCreate, findOne: mockLeadFindOne, find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() { yield* availableLeads; }, close: jest.fn() }) }) }) }) }) } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });

    process.env.COMM_ORG_ID = 'org-1';
    mockConvFindOneAndUpdate.mockResolvedValue(makeConversation());
    mockMessageFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockMessageCreate.mockResolvedValue({
      _id: 'msg-1',
      createdAt: new Date(),
      body: 'x',
      direction: 'inbound',
      toObject: () => ({ _id: 'msg-1' }),
    });
    mockAppointmentFindOne.mockReturnValue({ sort: jest.fn().mockReturnValue(Promise.resolve(null)) });
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
    mockResolveOrgSystemUserId.mockResolvedValue('staff-1');
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
    delete process.env.COMM_ORG_ID;
    mockGetSocketIO.mockReturnValue(null);
  });

  it.each(['org-1', 'org-2'])('keeps Lead and communication events inside %s', async (orgId) => {
    process.env.COMM_ORG_ID = orgId;
    const delivered: Array<{ recipient: string; event: string }> = [];
    const members = new Map([['org:org-1', ['rep-1']], ['org:org-2', ['rep-2']]]);
    const io = {
      emit: jest.fn(),
      to: jest.fn((room: string) => ({ emit: jest.fn((event: string) => {
        for (const recipient of members.get(room) || []) delivered.push({ recipient, event });
      }) })),
    };
    mockGetSocketIO.mockReturnValue(io);
    mockConvFindOneAndUpdate.mockResolvedValueOnce(makeConversation({ orgId }))
      .mockResolvedValueOnce({ _id: 'conv-1', leadId: 'candidate' });
    mockLeadCreate.mockResolvedValue({ _id: 'lead-new', firstName: 'Customer' });
    await handleInboundSms({ from: '+18015550100', to: '+18015550000', text: 'Please contact me', id: 'isolated-message' });
    expect(io.emit).not.toHaveBeenCalled();
    expect(io.to).toHaveBeenCalledWith(`org:${orgId}`);
    expect(delivered.filter(item => item.event === 'lead:new')).toEqual([
      { recipient: orgId === 'org-1' ? 'rep-1' : 'rep-2', event: 'lead:new' },
    ]);
    availableLeads = [{ _id: 'lead-new', phone: '+18015550100', organizationId: orgId }];
    mockConvFindOneAndUpdate.mockResolvedValue(makeConversation({ orgId, leadId: 'lead-new' }));
    await handleInboundSms({ from: '+18015550100', to: '+18015550000', text: 'Following up', id: 'isolated-followup' });
    expect(io.emit).not.toHaveBeenCalled();
    expect(delivered.every(item => item.recipient === (orgId === 'org-1' ? 'rep-1' : 'rep-2'))).toBe(true);
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-new', organizationId: orgId }, expect.any(Object),
    );
    expect(delivered.map(item => item.event)).toContain('lead:update');
  });

  it('a STOP message from an unrecognized number never creates a Lead', async () => {
    await handleInboundSms({ from: '+18015559999', to: '+18015550000', text: 'STOP', id: 'wh-1' });

    expect(mockConvFindOneAndUpdate).toHaveBeenCalledTimes(1); // only getOrCreateConversation — the claim never runs
    expect(mockLeadCreate).not.toHaveBeenCalled();
  });

  it('a bare YES confirmation reply from an unrecognized number never creates a Lead', async () => {
    await handleInboundSms({ from: '+18015559998', to: '+18015550000', text: 'YES', id: 'wh-2' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
  });

  it('a CANCEL/reschedule reply from an unrecognized number never creates a Lead', async () => {
    await handleInboundSms({ from: '+18015559997', to: '+18015550000', text: 'CANCEL', id: 'wh-3' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
  });

  it('a genuine, unhandled first message from an unrecognized number DOES create a Lead and only then triggers Alex', async () => {
    mockConvFindOneAndUpdate
      .mockResolvedValueOnce(makeConversation()) // getOrCreateConversation
      .mockResolvedValueOnce({ _id: 'conv-1', leadId: 'candidate' }); // the claim inside findOrCreateLeadForContact
    mockLeadCreate.mockResolvedValue({ _id: 'lead-new', firstName: 'Unknown', toObject: () => ({ _id: 'lead-new' }) });

    await handleInboundSms({
      from: '+18015559996',
      to: '+18015550000',
      text: 'Hi, do you still have the 2022 Camry?',
      id: 'wh-4',
    });

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      { _id: 'msg-1' },
      { $set: { leadId: 'lead-new' } },
    );
    expect(mockResolveAiAgentSettings).toHaveBeenCalled();
  });
});

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('handleInboundSms — human-attention screening receives the real conversation phone at both call sites', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;
  let mockLeadFindById: jest.Mock;
  let mockLeadCreate: jest.Mock;
  let mockLeadFindOne: jest.Mock;
  const mockLeadUpdateOne = jest.fn().mockResolvedValue({});
  let availableLeads: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    availableLeads = [];
    mockLeadFindById = jest.fn();
    mockLeadCreate = jest.fn();
    mockLeadFindOne = jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') {
        return {
          updateOne: mockLeadUpdateOne,
          findById: mockLeadFindById,
          create: mockLeadCreate,
          findOne: mockLeadFindOne,
          find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() { yield* availableLeads; }, close: jest.fn() }) }) }) }) }),
        } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });

    process.env.COMM_ORG_ID = 'org-1';
    mockMessageFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockMessageCreate.mockResolvedValue({
      _id: 'msg-1',
      createdAt: new Date(),
      body: 'x',
      direction: 'inbound',
      toObject: () => ({ _id: 'msg-1' }),
    });
    mockAppointmentFindOne.mockReturnValue({ sort: jest.fn().mockReturnValue(Promise.resolve(null)) });
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
    mockResolveOrgSystemUserId.mockResolvedValue('staff-1');
    mockScreenAiHumanAttention.mockResolvedValue(true);
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
    delete process.env.COMM_ORG_ID;
    mockGetSocketIO.mockReturnValue(null);
  });

  it('an existing lead takes the earlier, synchronous screening call — and it now receives the real conversation phone (the originally missing call site)', async () => {
    availableLeads = [{ _id: 'lead-existing', phone: '+18015550142', organizationId: 'org-1' }];
    mockConvFindOneAndUpdate.mockResolvedValue(makeConversation({ customerPhone: '+18015550142', leadId: 'lead-existing' }));

    await handleInboundSms({ from: '+18015550142', to: '+18015550000', text: 'Is the Civic still around?', id: 'existing-lead-1' });

    expect(mockScreenAiHumanAttention).toHaveBeenCalledTimes(1);
    expect(mockScreenAiHumanAttention).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-existing', phone: '+18015550142' }),
    );
  });

  it('a brand-new lead (none existed at the early check) takes the later, fire-and-forget screening call inside triggerSmsAiReply — and it also receives the real conversation phone', async () => {
    mockConvFindOneAndUpdate
      .mockResolvedValueOnce(makeConversation({ customerPhone: '+18015550199' }))
      .mockResolvedValueOnce({ _id: 'conv-1', leadId: 'candidate' });
    mockLeadCreate.mockResolvedValue({ _id: 'lead-new', firstName: 'Unknown', phone: '+18015550199', toObject: () => ({ _id: 'lead-new' }) });

    await handleInboundSms({ from: '+18015550199', to: '+18015550000', text: 'Hi, do you still have the 2022 Camry?', id: 'new-lead-1' });
    await flushMicrotasks();

    expect(mockScreenAiHumanAttention).toHaveBeenCalledTimes(1);
    expect(mockScreenAiHumanAttention).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-new', phone: '+18015550199' }),
    );
  });

  it('threads the conversation phone through exactly as-is, even when it is not a demo-pattern number — communication.service.ts does no demo filtering itself; that gate lives downstream in the Gemini QA exception', async () => {
    const realLookingPhone = '+18015551234';
    availableLeads = [{ _id: 'lead-existing', phone: realLookingPhone, organizationId: 'org-1' }];
    mockConvFindOneAndUpdate.mockResolvedValue(makeConversation({ customerPhone: realLookingPhone, leadId: 'lead-existing' }));

    await handleInboundSms({ from: realLookingPhone, to: '+18015550000', text: 'Hello there', id: 'real-phone-1' });

    expect(mockScreenAiHumanAttention).toHaveBeenCalledWith(
      expect.objectContaining({ phone: realLookingPhone }),
    );
  });
});

describe('handleCallInitiated — shares the same atomic Lead-creation as SMS', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;
  let mockLeadFindById: jest.Mock;
  let mockLeadCreate: jest.Mock;
  let mockLeadFindOne: jest.Mock;
  const mockCallLogCreate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockLeadFindById = jest.fn();
    mockLeadCreate = jest.fn();
    mockLeadFindOne = jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') {
return { findById: mockLeadFindById, create: mockLeadCreate, findOne: mockLeadFindOne, find: () => ({ sort: () => ({ maxTimeMS: () => ({ lean: () => ({ cursor: () => ({ async *[Symbol.asyncIterator]() {}, close: jest.fn() }) }) }) }) }) } as any;
      }
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });

    process.env.COMM_ORG_ID = 'org-1';
    mockCallFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockCallLogCreate.mockResolvedValue({ _id: 'call-1', toObject: () => ({ _id: 'call-1' }) });
    require('../../src/models/communication.model').CallLog.create = mockCallLogCreate;
    mockResolveOrgSystemUserId.mockResolvedValue('staff-1');
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
    jest.useRealTimers();
    delete process.env.COMM_ORG_ID;
  });

  it('creates a Lead for a brand-new inbound caller using the same claim-then-create helper as SMS', async () => {
    mockConvFindOneAndUpdate
      .mockResolvedValueOnce(makeConversation()) // getOrCreateConversation
      .mockResolvedValueOnce({ _id: 'conv-1', leadId: 'candidate' }); // findOrCreateLeadForContact's claim
    mockLeadCreate.mockResolvedValue({ _id: 'lead-new', firstName: 'Unknown', toObject: () => ({ _id: 'lead-new' }) });

    await handleCallInitiated({
      direction: 'incoming',
      call_control_id: 'cc-1',
      call_session_id: 'cs-1',
      from: '+18015559995',
      to: '+18015550000',
    });

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    const [createArgs] = mockLeadCreate.mock.calls[0];
    expect(createArgs.channel).toBe('phone');
    expect(createArgs.source).toBe('Inbound Call');
    expect(mockCallLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-new' }),
    );
  });

  it('never creates a second Lead when SMS already won the race for the same Conversation', async () => {
    // Simulates: an SMS from this same number already claimed and created the
    // Lead moments earlier, so Conversation.leadId is now set when the call arrives.
    mockConvFindOneAndUpdate.mockResolvedValueOnce(makeConversation({ leadId: 'lead-from-sms' }));
    mockLeadFindOne.mockResolvedValue({ _id: 'lead-from-sms', phone: '+18015559994' });

    await handleCallInitiated({
      direction: 'incoming',
      call_control_id: 'cc-2',
      call_session_id: 'cs-2',
      from: '+18015559994',
      to: '+18015550000',
    });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(mockCallLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-from-sms' }),
    );
  });
});
