const mockConvFindOneAndUpdate = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageFindOneAndUpdate = jest.fn().mockResolvedValue(null);
const mockSendSms = jest.fn();
const mockGetSocketIO = jest.fn().mockReturnValue(null);
const mockFindUniqueCustomerByPhone = jest.fn().mockResolvedValue(null);
const mockMessageDeleteOne = jest.fn().mockResolvedValue({});
const mockAssertAiDispatchAllowed = jest.fn();
const mockCallOrder: string[] = [];

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
    deleteOne: mockMessageDeleteOne,
    findOneAndUpdate: mockMessageFindOneAndUpdate,
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
jest.mock('../../src/models/SmsOptOut.model', () => ({ __esModule: true, default: { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }) } }));
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
  AiReplySuppressedError: jest.requireActual('../../src/utils/aiReplySuppressed').AiReplySuppressedError,
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

jest.mock('../../src/services/aiOperatingMode.service', () => ({
  ...jest.requireActual('../../src/services/aiOperatingMode.service'),
  assertAiDispatchAllowed: mockAssertAiDispatchAllowed,
}));

import { sendStaffAttributedSms, sendAutomatedSms } from '../../src/services/communication.service';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

describe('AI dispatch guard at the SMS provider boundary', () => {
  const aiActor = { userId: 'ai-agent', name: 'Alex' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallOrder.length = 0;
    mockFindUniqueCustomerByPhone.mockResolvedValue(null);
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', toObject() { return { _id: 'conv-1' }; } });
    mockConvUpdateOne.mockResolvedValue({});
    mockMessageCreate.mockImplementation(async () => {
      const doc: any = { _id: 'msg-1', status: 'queued', toObject() { return { ...this }; }, save: jest.fn().mockResolvedValue(undefined) };
      return doc;
    });
    mockSendSms.mockImplementation(async () => {
      mockCallOrder.push('telnyx');
      return { id: 'telnyx-1', to: [] };
    });
  });

  it('when the mode flips to training after generation, the AI text never reaches Telnyx and the queued row is removed', async () => {
    mockAssertAiDispatchAllowed.mockRejectedValue(new AiReplySuppressedError());
    await expect(
      sendStaffAttributedSms({ orgId: 'org-1', toPhone: '+13855550199', body: 'hi', leadId: 'lead-1', actor: aiActor, aiWorkflow: 'sms_reply' }),
    ).rejects.toBeInstanceOf(AiReplySuppressedError);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockMessageDeleteOne).toHaveBeenCalledWith({ _id: 'msg-1', orgId: 'org-1', status: 'queued' });
  });

  it('checks the mode for the exact recipient, workflow, and lead right before the provider call', async () => {
    mockAssertAiDispatchAllowed.mockImplementation(async () => {
      mockCallOrder.push('guard');
      return { action: 'send' };
    });
    const claim = jest.fn(async () => {
      mockCallOrder.push('claim');
    });
    await sendStaffAttributedSms({
      orgId: 'org-1', toPhone: '+13855550199', body: 'hi', leadId: 'lead-1', actor: aiActor,
      aiWorkflow: 'sms_followup', beforeDispatch: claim,
    });
    expect(mockAssertAiDispatchAllowed).toHaveBeenCalledWith({
      organizationId: 'org-1', channel: 'sms', workflow: 'sms_followup', toPhone: '+13855550199', leadId: 'lead-1',
    });
    expect(mockCallOrder).toEqual(['claim', 'guard', 'telnyx']);
  });

  it('manual staff texts are never mode-checked', async () => {
    await sendStaffAttributedSms({ orgId: 'org-1', toPhone: '+13855550199', body: 'hi', actor: { userId: 'staff-1', name: 'Rep' } });
    expect(mockAssertAiDispatchAllowed).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });

  it('system-attributed AI texts (vehicle re-engagement) are guarded too', async () => {
    mockAssertAiDispatchAllowed.mockRejectedValue(new AiReplySuppressedError());
    await expect(
      sendAutomatedSms({ orgId: 'org-1', toPhone: '+13855550199', body: 'new arrival', leadId: 'lead-1', aiWorkflow: 'vehicle_reengagement' }),
    ).rejects.toBeInstanceOf(AiReplySuppressedError);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockAssertAiDispatchAllowed).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'vehicle_reengagement', channel: 'sms' }));
  });

  it('templated automated texts (reminders, missed-call) are not mode-checked', async () => {
    await sendAutomatedSms({ orgId: 'org-1', toPhone: '+13855550199', body: 'Reminder: your appointment' });
    expect(mockAssertAiDispatchAllowed).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });
});
