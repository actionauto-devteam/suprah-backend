const mockMessageFindOneAndUpdate = jest.fn();
const mockRecipientUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const mockEmitToOrg = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
  CommunicationMessage: {
    create: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
    findOneAndUpdate: mockMessageFindOneAndUpdate,
  },
  CallLog: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() },
  TelephonyCredential: {},
}));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({
  __esModule: true,
  default: { updateOne: mockRecipientUpdateOne },
}));
jest.mock('../../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550000',
  sendSms: jest.fn(),
}));
jest.mock('../../src/services/customerIdentity.service', () => ({
  findUniqueCustomerByPhone: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/callRoutingConfig.service', () => ({
  getInboundRoutingConfig: jest.fn().mockResolvedValue(null),
  getConfiguredInboundOrganization: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn().mockReturnValue(null), emitToOrg: mockEmitToOrg }));
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

import { handleSmsStatus } from '../../src/services/communication.service';

function makeMessageDoc(overrides: Partial<{ _id: any; status: string; orgId: string; conversationId: string }> = {}) {
  return {
    _id: overrides._id ?? 'msg-1',
    orgId: overrides.orgId ?? 'org-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    status: overrides.status ?? 'sent',
  };
}

describe('handleSmsStatus — SMS campaign recipient delivery-status reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecipientUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockMessageFindOneAndUpdate.mockResolvedValue(makeMessageDoc());
  });

  it('updates the matching recipient to "delivered" using providerMessageId, and never touches status/sentCount fields', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-1', to: [{ status: 'delivered' }] });

    expect(mockRecipientUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockRecipientUpdateOne.mock.calls[0];
    expect(filter).toEqual({ providerMessageId: 'telnyx-msg-1' });
    expect(update.$set.deliveryStatus).toBe('delivered');
    expect(update.$set.deliveryStatusUpdatedAt).toBeInstanceOf(Date);
    expect(update.$set).not.toHaveProperty('status');
    expect(update.$set).not.toHaveProperty('sentCount');
  });

  it('updates the matching recipient to "delivery_failed" on a failed/sending_failed carrier status', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-2', to: [{ status: 'delivery_failed', errors: [{ code: '40300' }] }] });

    const [filter, update] = mockRecipientUpdateOne.mock.calls[0];
    expect(filter).toEqual({ providerMessageId: 'telnyx-msg-2' });
    expect(update.$set.deliveryStatus).toBe('delivery_failed');
  });

  it('does not touch SmsCampaignRecipient at all for a plain "sent" carrier status (only delivered/failed update deliveryStatus)', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-3', to: [{ status: 'sent' }] });

    expect(mockRecipientUpdateOne).not.toHaveBeenCalled();
  });

  it('is idempotent under a duplicate webhook redelivery of the same "delivered" event', async () => {
    const payload = { id: 'telnyx-msg-4', to: [{ status: 'delivered' }] };
    await handleSmsStatus(payload);
    await handleSmsStatus(payload);

    expect(mockRecipientUpdateOne).toHaveBeenCalledTimes(2);
    for (const call of mockRecipientUpdateOne.mock.calls) {
      expect(call[0]).toEqual({ providerMessageId: 'telnyx-msg-4' });
      expect(call[1].$set.deliveryStatus).toBe('delivered');
    }
  });

  it('lets a later out-of-order "failed" event overwrite an earlier "delivered" one (last-write-wins, no ordering guard) — final state reflects the most recent webhook', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-5', to: [{ status: 'delivered' }] });
    await handleSmsStatus({ id: 'telnyx-msg-5', to: [{ status: 'sending_failed' }] });

    expect(mockRecipientUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockRecipientUpdateOne.mock.calls[0][1].$set.deliveryStatus).toBe('delivered');
    expect(mockRecipientUpdateOne.mock.calls[1][1].$set.deliveryStatus).toBe('delivery_failed');
  });

  it('never throws when no SmsCampaignRecipient matches providerMessageId (a non-campaign SMS) — the update is a harmless no-op', async () => {
    mockRecipientUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    await expect(handleSmsStatus({ id: 'telnyx-msg-6', to: [{ status: 'delivered' }] })).resolves.toBeUndefined();
    expect(mockRecipientUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected SmsCampaignRecipient update (e.g. a transient DB error) without throwing', async () => {
    mockRecipientUpdateOne.mockRejectedValue(new Error('transient db error'));

    await expect(handleSmsStatus({ id: 'telnyx-msg-7', to: [{ status: 'delivered' }] })).resolves.toBeUndefined();
  });

  it('still reconciles CommunicationMessage.status for a non-campaign SMS even when no campaign recipient matches', async () => {
    mockRecipientUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    mockMessageFindOneAndUpdate.mockResolvedValue(makeMessageDoc({ _id: 'msg-99', status: 'delivered' }));

    await handleSmsStatus({ id: 'telnyx-msg-8', to: [{ status: 'delivered' }] });

    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      { providerMessageId: 'telnyx-msg-8', status: { $in: ['queued', 'sent', 'pending_reconciliation'] } },
      { $set: { status: 'delivered', deliveredAt: expect.any(Date) } },
      { new: true },
    );
  });

  it('never lets a late "sent" event overwrite a final status', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-9', to: [{ status: 'sent' }] });
    const [filter] = mockMessageFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ providerMessageId: 'telnyx-msg-9', status: { $in: ['queued', 'pending_reconciliation'] } });
  });

  it('only marks a message failed while it is still in flight', async () => {
    await handleSmsStatus({ id: 'telnyx-msg-10', to: [{ status: 'delivery_failed', errors: [{ code: '40300' }] }] });
    const [filter, update] = mockMessageFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ providerMessageId: 'telnyx-msg-10', status: { $in: ['queued', 'sent', 'pending_reconciliation'] } });
    expect(update.$set.status).toBe('failed');
  });

  it('does not emit a status event when no in-flight message matched', async () => {
    mockMessageFindOneAndUpdate.mockResolvedValue(null);
    await handleSmsStatus({ id: 'telnyx-msg-11', to: [{ status: 'sent' }] });
    expect(mockEmitToOrg).not.toHaveBeenCalled();
  });
});
