const mockLeadFind = jest.fn();
const mockLeadFindOneAndUpdate = jest.fn();
const mockLeadUpdateOne = jest.fn();
const mockAppointmentExists = jest.fn();
const mockCommunicationFindOne = jest.fn();
const mockCommFind = jest.fn();
const mockCallFindOne = jest.fn();
const mockConversationFindOne = jest.fn();
const mockIsSmsOptedOut = jest.fn();
const mockSendStaffAttributedSms = jest.fn();
const mockCheckConversationPauseForLead = jest.fn();
const mockResolveDealerName = jest.fn();
const mockResolveAiAgentSettings = jest.fn();
const mockGenerateProactiveFollowUp = jest.fn();
const mockClassifyAlexReplySafety = jest.fn();
const mockValidateOutboundMessage = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind, findOneAndUpdate: mockLeadFindOneAndUpdate, updateOne: mockLeadUpdateOne },
}));

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { exists: mockAppointmentExists },
}));

jest.mock('../../src/models/communication.model', () => ({
  CommunicationMessage: { findOne: mockCommunicationFindOne, find: mockCommFind },
  CallLog: { findOne: mockCallFindOne },
  Conversation: { findOne: mockConversationFindOne },
}));

class MockSmsDeliveryUncertainError extends Error {
  messageId: string;
  providerMessageId: string;
  constructor(message: string, info: { messageId: string; providerMessageId: string }) {
    super(message);
    this.name = 'SmsDeliveryUncertainError';
    this.messageId = info.messageId;
    this.providerMessageId = info.providerMessageId;
  }
}

jest.mock('../../src/services/communication.service', () => ({
  isSmsOptedOut: mockIsSmsOptedOut,
  sendLeadNurtureText: jest.fn(),
  sendStaffAttributedSms: mockSendStaffAttributedSms,
  checkConversationPauseForLead: mockCheckConversationPauseForLead,
  shouldDeferAutomatedFollowUp: (result: { status: string }) => result.status !== 'unpaused',
  resolveDealerName: mockResolveDealerName,
  SmsDeliveryUncertainError: MockSmsDeliveryUncertainError,
}));

jest.mock('../../src/services/aiAgent.service', () => ({
  resolveAiAgentSettings: mockResolveAiAgentSettings,
  generateProactiveFollowUp: mockGenerateProactiveFollowUp,
  classifyAlexReplySafety: mockClassifyAlexReplySafety,
}));

jest.mock('../../src/utils/aiOutboundSafety', () => ({
  validateOutboundMessage: mockValidateOutboundMessage,
}));

jest.mock('../../src/controllers/lead.controller', () => ({
  getCentralOAuth2Client: jest.fn(),
}));

jest.mock('../../src/utils/sendingWindow', () => ({
  isWithinSendingHours: jest.fn(() => true),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

import { runAiLeadFollowupSweep } from '../../src/schedulers/aiLeadFollowup.scheduler';

function baseLead(overrides: Record<string, any> = {}) {
  return {
    _id: 'lead-1',
    organizationId: 'org-1',
    firstName: 'Jamie',
    phone: '+13035550123',
    vehicle: { year: 2024, make: 'Honda', model: 'CR-V' },
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    followUp: { aiFollowUpCount: 0 },
    ...overrides,
  };
}

function seedCandidates(items: any[]) {
  const lean = jest.fn().mockResolvedValue(items);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  const select = jest.fn(() => ({ sort }));
  mockLeadFind.mockReturnValue({ select });
}

function emptyMessageLookup() {
  const lean = jest.fn().mockResolvedValue(null);
  mockCommunicationFindOne.mockReturnValue({ sort: jest.fn(() => ({ select: jest.fn(() => ({ lean })) })) });
  mockCallFindOne.mockReturnValue({ sort: jest.fn(() => ({ select: jest.fn(() => ({ lean })) })) });
  mockConversationFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) });
}

describe('AI lead follow-up scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'unpaused' });
    mockIsSmsOptedOut.mockResolvedValue(false);
    mockAppointmentExists.mockResolvedValue(false);
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
    mockResolveDealerName.mockResolvedValue('Action Auto Utah');
    mockGenerateProactiveFollowUp.mockResolvedValue({ text: 'Hi Jamie, just checking in on the CR-V!' });
    mockValidateOutboundMessage.mockReturnValue({ ok: true, reasons: [] });
    mockClassifyAlexReplySafety.mockResolvedValue('SAFE');
    mockSendStaffAttributedSms.mockResolvedValue({ message: { _id: 'msg-1' } });
    mockLeadFindOneAndUpdate.mockResolvedValue({ _id: 'lead-1' });
    mockLeadUpdateOne.mockResolvedValue({});
    emptyMessageLookup();
  });

  it('skips candidates whose organization has AI disabled, without sending', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: false, agentName: 'Alex' });
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('never sends when the deterministic safety check fails, even though the classifier was never reached', async () => {
    mockValidateOutboundMessage.mockReturnValue({ ok: false, reasons: ['mentions a price'] });
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockClassifyAlexReplySafety).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
  });

  it('never sends when the AI safety classifier returns UNSAFE', async () => {
    mockClassifyAlexReplySafety.mockResolvedValue('UNSAFE');
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
  });

  it('sends through sendStaffAttributedSms under the ai-agent actor when everything checks out', async () => {
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
    expect(mockSendStaffAttributedSms).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: 'ai-agent', name: 'Alex' }, toPhone: '+13035550123' }),
    );
  });

  it('claim query requires lastAutomatedOutreachAt to be absent or outside a 24-hour cross-scheduler lock window (shared with leadNurture, not just a same-tick race window)', async () => {
    seedCandidates([baseLead()]);
    await runAiLeadFollowupSweep();

    const claimFilter = mockLeadFindOneAndUpdate.mock.calls[0][0];
    const claimUpdate = mockLeadFindOneAndUpdate.mock.calls[0][1];
    const lockClause = claimFilter.$and.find((c: any) => JSON.stringify(c).toLowerCase().includes('lastautomatedoutreachat'));
    expect(lockClause).toBeDefined();
    const cutoffCondition = lockClause.$or.find((c: any) => c['followUp.lastAutomatedOutreachAt']?.$lte);
    const cutoffMs = new Date(cutoffCondition['followUp.lastAutomatedOutreachAt'].$lte).getTime();
    const hoursAgo = (Date.now() - cutoffMs) / (60 * 60 * 1000);
    expect(hoursAgo).toBeGreaterThan(23.9);
    expect(hoursAgo).toBeLessThan(24.1);
    expect(claimUpdate.$set['followUp.lastAutomatedOutreachAt']).toBeTruthy();
  });

  it('does not prevent a lead from firing its next step just because the DB query already filtered out any lead with a recent lastAutomatedOutreachAt (lock is enforced at the query layer, not by skipping eligible leads silently)', async () => {
    // Candidates returned by Lead.find already satisfy the DB-level lock condition in
    // production; this test just confirms a lead that legitimately passes that filter
    // (no lastAutomatedOutreachAt at all yet) is still correctly sent.
    seedCandidates([baseLead({ followUp: { aiFollowUpCount: 0 } })]);
    const stats = await runAiLeadFollowupSweep();
    expect(stats.sent).toBe(1);
  });

  it('cadence is measured from the fixed original anchor (creation/last rep response), not reset by this system\'s own prior automated send', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // past the 24h lock, so it reaches the cadence math
    seedCandidates([baseLead({
      createdAt: tenDaysAgo,
      followUp: { aiFollowUpCount: 1, lastAutomatedOutreachAt: threeDaysAgo }, // step 1 = Day 5 (120h) interval
    })]);

    const stats = await runAiLeadFollowupSweep();

    // Fixed-anchor math: 10 days since creation >= 120h (Day 5) -> due, sent.
    // The old rolling-anchor bug would have anchored to the 3-day-old automated touch
    // instead (72h since then < 120h), incorrectly treating it as not yet due.
    expect(stats.sent).toBe(1);
  });

  it('does not re-claim a lead whose findOneAndUpdate returns null (lost the race to another scheduler tick)', async () => {
    mockLeadFindOneAndUpdate.mockResolvedValue(null);
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockGenerateProactiveFollowUp).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
  });

  it('excludes a lead that already reached the maximum follow-up count via the query itself', async () => {
    seedCandidates([]);
    await runAiLeadFollowupSweep();

    const query = mockLeadFind.mock.calls[0][0];
    expect(query['followUp.aiFollowUpCount']).toEqual({ $not: { $gte: 3 } });
  });

  it('skips a lead with an unresolved pause/human-attention state without sending', async () => {
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'paused', reason: 'AI conversation is currently paused' });
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
  });

  it('when the send succeeds but the follow-up-count bookkeeping write then fails, marks the lead pending_reconciliation instead of failed, and schedules no automatic retry (closes the prior known duplicate-send risk: the SMS was already confirmed sent, so a retry would be a confirmed, avoidable duplicate)', async () => {
    seedCandidates([baseLead()]);
    mockSendStaffAttributedSms.mockResolvedValue({ message: { _id: 'msg-1' } });
    mockLeadUpdateOne.mockRejectedValueOnce(new Error('DB connection lost'));

    const stats = await runAiLeadFollowupSweep();

    expect(mockSendStaffAttributedSms).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(0);
    expect(stats.errors).toBe(1);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeDefined();
    expect(reconciliationUpdateCall![1].$set['followUp.aiFollowUpFailureReason']).toContain('SMS was sent successfully');
    expect(reconciliationUpdateCall![1].$unset?.['followUp.aiFollowUpNextRetryAt']).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeUndefined();
  });

  it('when the SMS provider accepts the message but sendStaffAttributedSms itself cannot confirm the local record (ambiguous outcome, SmsDeliveryUncertainError), marks the lead pending_reconciliation with the provider message id and schedules no automatic retry', async () => {
    seedCandidates([baseLead()]);
    mockSendStaffAttributedSms.mockRejectedValue(
      new MockSmsDeliveryUncertainError('SMS was accepted by the provider but the local send record could not be confirmed', {
        messageId: 'msg-ambiguous-1',
        providerMessageId: 'telnyx-msg-999',
      }),
    );

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(stats.errors).toBe(1);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeDefined();
    expect(reconciliationUpdateCall![1].$set['followUp.aiFollowUpPendingProviderMessageId']).toBe('telnyx-msg-999');
    expect(reconciliationUpdateCall![1].$unset?.['followUp.aiFollowUpNextRetryAt']).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeUndefined();
  });

  it('a confirmed pre-acceptance failure (ordinary Error, not SmsDeliveryUncertainError) still schedules a normal retry — ambiguous/confirmed-sent outcomes are not conflated with genuine, safe-to-retry failures', async () => {
    seedCandidates([baseLead()]);
    mockSendStaffAttributedSms.mockRejectedValue(new Error('SMS provider rejected the message'));

    const stats = await runAiLeadFollowupSweep();

    expect(stats.errors).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeDefined();
    expect(failedUpdateCall![1].$set['followUp.aiFollowUpNextRetryAt']).toBeInstanceOf(Date);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeUndefined();
  });

  it('excludes a pending_reconciliation lead from the candidate query itself, so a restart or a later tick can never pick it up for an automatic resend', async () => {
    seedCandidates([]);
    await runAiLeadFollowupSweep();

    const query = mockLeadFind.mock.calls[0][0];
    expect(query['followUp.aiFollowUpStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });

  it('excludes a pending_reconciliation lead from the atomic claim filter too, so two concurrent workers (or a worker racing a fresh restart) can never both claim it for a resend', async () => {
    seedCandidates([baseLead()]);
    await runAiLeadFollowupSweep();

    const claimFilter = mockLeadFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter['followUp.aiFollowUpStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });
});
