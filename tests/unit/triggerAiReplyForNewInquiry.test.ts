const mockConvFindOneAndUpdate = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);
const mockResolveOrgSystemUserId = jest.fn();
const mockResolveAiAgentSettings = jest.fn().mockResolvedValue({ enabled: false, agentName: 'Alex' });
const mockGetSocketIO = jest.fn().mockReturnValue(null);
const mockScreenAiHumanAttention = jest.fn().mockResolvedValue(true);
const mockLeadFindOneAndUpdate = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: {
    findOneAndUpdate: mockConvFindOneAndUpdate,
    updateOne: mockConvUpdateOne,
  },
  CommunicationMessage: {
    create: mockMessageCreate,
    updateOne: mockMessageUpdateOne,
    countDocuments: jest.fn().mockResolvedValue(0),
  },
  CallLog: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() },
  TelephonyCredential: {},
}));
jest.mock('../../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015559999' }));
jest.mock('../../src/services/customerIdentity.service', () => ({ findUniqueCustomerByPhone: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ getInboundRoutingConfig: jest.fn().mockResolvedValue(null), getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: mockGetSocketIO }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: mockNotifyOrgAdmins }));
jest.mock('../../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn(), shouldSuppressHandoffNoteNotification: jest.fn() }));
jest.mock('../../src/utils/smsFailure', () => ({ describeSmsFailure: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({ notificationTemplates: {} }));
jest.mock('../../src/models/SmsOptOut.model', () => ({ __esModule: true, default: { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }) } }));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  processAlexTurn: jest.fn(),
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: mockResolveOrgSystemUserId }));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(async (input: any) => ({ ...input, version: 1 })),
  finishAiAttentionCheck: jest.fn().mockResolvedValue(undefined),
  screenAiHumanAttention: mockScreenAiHumanAttention,
  canSendAiReply: jest.fn().mockResolvedValue(true),
  assertAiReplyAllowed: jest.fn().mockResolvedValue(undefined),
  claimAiGeneration: jest.fn().mockResolvedValue(null),
  claimAiReplyDispatch: jest.fn().mockResolvedValue(undefined),
  attentionOrgIds: (id: string) => [id],
  recoverAiHumanAttention: jest.fn().mockResolvedValue(undefined),
  AiReplySuppressedError: class AiReplySuppressedError extends Error {},
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

import mongoose from 'mongoose';
import { triggerAiReplyForNewInquiry } from '../../src/services/communication.service';

function makeConversation(overrides: Partial<{ _id: any; customerPhone: string }> = {}) {
  return {
    _id: overrides._id ?? 'conv-1',
    customerPhone: overrides.customerPhone ?? '+18015550142',
    toObject() {
      return { ...this };
    },
  };
}

describe('triggerAiReplyForNewInquiry', () => {
  let mongooseModelSpy: jest.SpiedFunction<typeof mongoose.model>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
    mockScreenAiHumanAttention.mockResolvedValue(true);
    mockLeadFindOneAndUpdate.mockResolvedValue({ _id: 'lead-1' });
    mockConvFindOneAndUpdate.mockResolvedValue(makeConversation());
    mockMessageCreate.mockResolvedValue({
      _id: 'msg-1',
      createdAt: new Date(),
      body: 'x',
      direction: 'inbound',
      toObject: () => ({ _id: 'msg-1' }),
    });

    mongooseModelSpy = jest.spyOn(mongoose, 'model').mockImplementation((name: any) => {
      if (name === 'Lead') return { findOneAndUpdate: mockLeadFindOneAndUpdate } as any;
      throw new Error(`Schema hasn't been registered for model "${name}".`);
    });
  });

  afterEach(() => {
    mongooseModelSpy.mockRestore();
  });

  const lead = { _id: 'lead-1', firstName: 'Andrew', lastName: 'Witt' };

  it('does nothing when there is no phone number', async () => {
    await triggerAiReplyForNewInquiry('org-1', lead, '', 'I am interested in the Traverse');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when the inquiry text is empty or whitespace-only', async () => {
    await triggerAiReplyForNewInquiry('org-1', lead, '+18015550142', '   ');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when the lead has no _id', async () => {
    await triggerAiReplyForNewInquiry('org-1', {}, '+18015550142', 'Hello');
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('claims atomically on Lead.aiFirstReplyTriggeredAt before doing anything else, so a second call for the same lead is a no-op', async () => {
    mockLeadFindOneAndUpdate.mockResolvedValueOnce(null);
    await triggerAiReplyForNewInquiry('org-1', lead, '+18015550142', 'Interested in the Traverse');

    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'lead-1', organizationId: 'org-1', aiFirstReplyTriggeredAt: null },
      { $set: { aiFirstReplyTriggeredAt: expect.any(Date) } },
    );
    expect(mockConvFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it('on a successful claim, creates the conversation and an inbound CommunicationMessage from the inquiry text, then proceeds into the real Alex pipeline', async () => {
    await triggerAiReplyForNewInquiry('org-1', lead, '+1 (801) 555-0142', 'Interested in the Traverse');

    expect(mockConvFindOneAndUpdate).toHaveBeenCalledWith(
      { orgId: 'org-1', customerPhone: '+18015550142' },
      expect.objectContaining({ $set: expect.objectContaining({ leadId: 'lead-1' }) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 'lead-1',
        direction: 'inbound',
        body: 'Interested in the Traverse',
        from: '+18015550142',
        status: 'received',
      }),
    );
    expect(mockConvUpdateOne).toHaveBeenCalled();
    expect(mockResolveAiAgentSettings).toHaveBeenCalledWith('org-1');
  });

  it('forwards the real conversation phone into screenAiHumanAttention when the org has Alex enabled (reuses the fixed SMS call site, not a bypass)', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });

    await triggerAiReplyForNewInquiry('org-1', lead, '+18015550142', 'Interested in the Traverse');

    expect(mockScreenAiHumanAttention).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-1', phone: '+18015550142' }),
    );
  });

  it('never calls the Alex pipeline at all when Alex is disabled for the org', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });

    await triggerAiReplyForNewInquiry('org-1', lead, '+18015550142', 'Interested in the Traverse');

    expect(mockScreenAiHumanAttention).not.toHaveBeenCalled();
  });

  it('never throws out of the function even if a downstream step rejects (fire-and-forget safe)', async () => {
    mockConvFindOneAndUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      triggerAiReplyForNewInquiry('org-1', lead, '+18015550142', 'Interested in the Traverse'),
    ).resolves.toBeUndefined();
  });
});
