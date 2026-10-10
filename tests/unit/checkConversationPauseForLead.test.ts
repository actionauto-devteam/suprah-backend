const mockConvFindOne = jest.fn();
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

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: {
    findOne: mockConvFindOne,
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
}));
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
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn(), shouldSuppressHandoffNoteNotification: jest.fn() }));
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
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn(async (input: any) => ({ ...input, version: 1 })),
  finishAiAttentionCheck: jest.fn().mockResolvedValue(undefined),
  screenAiHumanAttention: jest.fn().mockResolvedValue(true),
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
  canReceiveIvrCall: jest.fn().mockResolvedValue(true),
  ivrAgentFailed: jest.fn(),
  recoverIvrCalls: jest.fn().mockResolvedValue(undefined),
}));

import { checkConversationPauseForLead, shouldDeferAutomatedFollowUp } from '../../src/services/communication.service';

function selectLean(result: any) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

describe('checkConversationPauseForLead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('confirms unpaused immediately when the candidate has no phone (nothing to match against)', async () => {
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: undefined, leadId: 'lead-1' });
    expect(result).toEqual({ status: 'unpaused' });
    expect(mockConvFindOne).not.toHaveBeenCalled();
  });

  it('confirms unpaused when no Conversation exists for this org+phone', async () => {
    mockConvFindOne.mockReturnValue(selectLean(null));
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result).toEqual({ status: 'unpaused' });
  });

  it('confirms paused for a durable human-attention pause', async () => {
    mockConvFindOne.mockReturnValue(
      selectLean({ leadId: 'lead-1', aiHumanAttention: { reason: 'Customer requested human', taskId: 't1', messageId: 'm1', detectedAt: new Date() } }),
    );
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('paused');
  });

  it('confirms paused for a manual AI pause (aiPausedAt set, no human-attention record)', async () => {
    mockConvFindOne.mockReturnValue(selectLean({ leadId: 'lead-1', aiPausedAt: new Date() }));
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('paused');
  });

  it('confirms paused for an active temporary staff-takeover pause (aiAutoPausedUntil in the future)', async () => {
    mockConvFindOne.mockReturnValue(
      selectLean({ leadId: 'lead-1', aiAutoPausedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('paused');
  });

  it('confirms unpaused once the temporary pause window has expired', async () => {
    mockConvFindOne.mockReturnValue(
      selectLean({ leadId: 'lead-1', aiAutoPausedUntil: new Date(Date.now() - 10 * 60 * 1000) }),
    );
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result).toEqual({ status: 'unpaused' });
  });

  it('confirms unpaused for a normal, unpaused conversation', async () => {
    mockConvFindOne.mockReturnValue(selectLean({ leadId: 'lead-1' }));
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result).toEqual({ status: 'unpaused' });
  });

  it('returns unknown (not confirmed-unpaused) when the matched Conversation is linked to a different Lead, even if that conversation is itself paused', async () => {
    mockConvFindOne.mockReturnValue(selectLean({ leadId: 'some-other-lead', aiPausedAt: new Date() }));
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('unknown');
  });

  it('trusts the pause state when the Conversation has no leadId linked yet', async () => {
    mockConvFindOne.mockReturnValue(selectLean({ leadId: null, aiPausedAt: new Date() }));
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('paused');
  });

  it('returns unknown (not confirmed-unpaused) when the Conversation lookup throws', async () => {
    mockConvFindOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('db down')) }),
    });
    const result = await checkConversationPauseForLead({ organizationId: 'org-1', phone: '+18015550100', leadId: 'lead-1' });
    expect(result.status).toBe('unknown');
  });
});

describe('shouldDeferAutomatedFollowUp', () => {
  it('only proceeds (returns false) on a confirmed-unpaused result', () => {
    expect(shouldDeferAutomatedFollowUp({ status: 'unpaused' })).toBe(false);
  });

  it('defers on a confirmed-paused result', () => {
    expect(shouldDeferAutomatedFollowUp({ status: 'paused', reason: 'x' })).toBe(true);
  });

  it('defers on an unknown result (fail toward not sending, per the approved hardening)', () => {
    expect(shouldDeferAutomatedFollowUp({ status: 'unknown', reason: 'x' })).toBe(true);
  });
});
