const mockConvFindOneAndUpdate = jest.fn();
const mockConvUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCreate = jest.fn();
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageFindOneAndUpdate = jest.fn().mockResolvedValue(null);
const mockSendSms = jest.fn();
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

import { sendSmsFromUser, sendStaffAttributedSms, SmsDeliveryUncertainError, handleSmsStatus } from '../../src/services/communication.service';

describe('sendSmsFromUser — delivery outcome vs. local recording failure', () => {
  const actor = { userId: 'ai-agent', name: 'Alex' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUniqueCustomerByPhone.mockResolvedValue(null);
    mockConvFindOneAndUpdate.mockResolvedValue({ _id: 'conv-1', toObject() { return { _id: 'conv-1' }; } });
    mockConvUpdateOne.mockResolvedValue({});
  });

  it('on a successful send and a successful local save, records providerMessageId/status=sent and returns normally', async () => {
    mockMessageCreate.mockResolvedValue(makeMessageDoc());
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-1', to: [{ phone_number: '+18015550123' }] });

    const result = await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' });

    expect(result.message.status).toBe('sent');
    expect(result.message.providerMessageId).toBe('telnyx-msg-1');
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  it('on a confirmed provider rejection (sendSms itself throws), marks the message failed and throws a normal rejection error — safe to retry', async () => {
    const doc = makeMessageDoc();
    mockMessageCreate.mockResolvedValue(doc);
    mockSendSms.mockRejectedValue(new Error('Telnyx rejected: invalid destination'));

    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' }),
    ).rejects.toMatchObject({ statusCode: 502 });

    expect(doc.status).toBe('failed');
    expect(doc.errorDetail).toContain('Telnyx rejected');
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  it('on an ambiguous outcome (provider accepts, local save throws), throws SmsDeliveryUncertainError with the real provider id instead of marking the message failed', async () => {
    const doc = makeMessageDoc();
    doc.save = jest.fn().mockRejectedValue(new Error('DB connection lost mid-save'));
    mockMessageCreate.mockResolvedValue(doc);
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-ambiguous', to: [{ phone_number: '+18015550123' }] });

    let caught: any;
    try {
      await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SmsDeliveryUncertainError);
    expect(caught.providerMessageId).toBe('telnyx-msg-ambiguous');
    expect(caught.messageId).toBe('msg-1');
    expect(doc.status).not.toBe('failed');
  });

  it('on an ambiguous outcome, makes a best-effort raw update recording providerMessageId and status=pending_reconciliation so the existing Telnyx delivery-status webhook can still reconcile it later', async () => {
    const doc = makeMessageDoc();
    doc.save = jest.fn().mockRejectedValue(new Error('DB connection lost mid-save'));
    mockMessageCreate.mockResolvedValue(doc);
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-ambiguous-2', to: [{ phone_number: '+18015550123' }] });

    await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' }).catch(() => undefined);

    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      { _id: 'msg-1' },
      { $set: expect.objectContaining({ providerMessageId: 'telnyx-msg-ambiguous-2', status: 'pending_reconciliation' }) },
    );
  });

  it('still throws SmsDeliveryUncertainError (never a silently-swallowed success) even if the best-effort raw update itself also fails', async () => {
    const doc = makeMessageDoc();
    doc.save = jest.fn().mockRejectedValue(new Error('DB connection lost mid-save'));
    mockMessageCreate.mockResolvedValue(doc);
    mockMessageUpdateOne.mockRejectedValueOnce(new Error('DB still down'));
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-ambiguous-3', to: [{ phone_number: '+18015550123' }] });

    await expect(
      sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' }),
    ).rejects.toBeInstanceOf(SmsDeliveryUncertainError);
  });

  it('retries the fallback reconciliation write on a transient failure and succeeds on the second attempt — a brief blip no longer loses the providerMessageId', async () => {
    const doc = makeMessageDoc();
    doc.save = jest.fn().mockRejectedValue(new Error('DB connection lost mid-save'));
    mockMessageCreate.mockResolvedValue(doc);
    mockMessageUpdateOne.mockRejectedValueOnce(new Error('transient blip')).mockResolvedValueOnce({});
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-retry-1', to: [{ phone_number: '+18015550123' }] });

    await sendSmsFromUser({ orgId: 'org-1', user: actor, toPhone: '+18015550123', body: 'hello' }).catch(() => undefined);

    expect(mockMessageUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockMessageUpdateOne).toHaveBeenLastCalledWith(
      { _id: 'msg-1' },
      { $set: expect.objectContaining({ providerMessageId: 'telnyx-msg-retry-1', status: 'pending_reconciliation' }) },
    );
  });

  it('confirms handleSmsStatus (the Telnyx delivery-receipt webhook) CANNOT reconcile a message whose providerMessageId was never persisted — it matches strictly on providerMessageId and finds nothing if that field was never written to any local record', async () => {
    mockMessageFindOneAndUpdate.mockResolvedValue(null);

    const result = await handleSmsStatus({ id: 'telnyx-msg-never-persisted', to: [{ status: 'delivered' }] });

    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      { providerMessageId: 'telnyx-msg-never-persisted' },
      { $set: expect.objectContaining({ status: 'delivered' }) },
      { new: true },
    );
    expect(result).toBeUndefined();
  });

  it('by contrast, once providerMessageId IS persisted (even only via the best-effort fallback write), handleSmsStatus successfully reconciles it to the carrier-reported status', async () => {
    mockMessageFindOneAndUpdate.mockResolvedValue({
      _id: 'msg-1',
      orgId: 'org-1',
      conversationId: 'conv-1',
      status: 'delivered',
    });

    await handleSmsStatus({ id: 'telnyx-msg-persisted', to: [{ status: 'delivered' }] });

    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      { providerMessageId: 'telnyx-msg-persisted' },
      { $set: expect.objectContaining({ status: 'delivered' }) },
      { new: true },
    );
  });

  it('sendStaffAttributedSms (used by the AI follow-up scheduler) propagates SmsDeliveryUncertainError unchanged rather than swallowing it as a plain false/failure', async () => {
    const doc = makeMessageDoc();
    doc.save = jest.fn().mockRejectedValue(new Error('DB connection lost mid-save'));
    mockMessageCreate.mockResolvedValue(doc);
    mockSendSms.mockResolvedValue({ id: 'telnyx-msg-ambiguous-4', to: [{ phone_number: '+18015550123' }] });

    await expect(
      sendStaffAttributedSms({ orgId: 'org-1', toPhone: '+18015550123', body: 'hello', actor }),
    ).rejects.toBeInstanceOf(SmsDeliveryUncertainError);
  });
});
