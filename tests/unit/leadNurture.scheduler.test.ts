const mockLeadFind = jest.fn();
const mockLeadFindOneAndUpdate = jest.fn();
const mockLeadUpdateOne = jest.fn();
const mockAppointmentExists = jest.fn();
const mockCommunicationFindOne = jest.fn();
const mockCallFindOne = jest.fn();
const mockIsSmsOptedOut = jest.fn();
const mockSendLeadNurtureText = jest.fn();
const mockCheckConversationPauseForLead = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: {
    find: mockLeadFind,
    findOneAndUpdate: mockLeadFindOneAndUpdate,
    updateOne: mockLeadUpdateOne,
  },
}));

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { exists: mockAppointmentExists },
}));

jest.mock('../../src/models/communication.model', () => ({
  CommunicationMessage: { findOne: mockCommunicationFindOne },
  CallLog: { findOne: mockCallFindOne },
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
  sendLeadNurtureText: mockSendLeadNurtureText,
  checkConversationPauseForLead: mockCheckConversationPauseForLead,
  shouldDeferAutomatedFollowUp: (result: { status: string }) => result.status !== 'unpaused',
  SmsDeliveryUncertainError: MockSmsDeliveryUncertainError,
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

import { runLeadNurtureSweep } from '../../src/schedulers/leadNurture.scheduler';
import { NURTURE_ELIGIBLE_STATUSES } from '../../src/constants/leadStatus';

function oldLead() {
  return {
    _id: 'lead-1',
    organizationId: 'org-1',
    firstName: 'Alex',
    phone: '+13035550123',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    followUp: { nurtureCount: 0 },
  };
}

function emptyLookup() {
  return {
    sort: jest.fn(() => ({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) })),
  };
}

function seedCandidates(items = [oldLead()]) {
  const lean = jest.fn().mockResolvedValue(items);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  const select = jest.fn(() => ({ sort }));
  mockLeadFind.mockReturnValue({ select });
}

describe('lead nurture scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedCandidates();
    mockCommunicationFindOne.mockImplementation(emptyLookup);
    mockCallFindOne.mockImplementation(emptyLookup);
    mockAppointmentExists.mockResolvedValue(null);
    mockIsSmsOptedOut.mockResolvedValue(false);
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'unpaused' });
    mockLeadFindOneAndUpdate.mockResolvedValue(oldLead());
    mockLeadUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('advances the nurture sequence only after a successful send', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);

    const stats = await runLeadNurtureSweep();

    expect(stats).toEqual({ scanned: 1, sent: 1, skipped: 0, errors: 0 });
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'sent',
          'followUp.nurtureAttemptCount': 0,
        }),
        $inc: { 'followUp.nurtureCount': 1 },
      }),
      { timestamps: false },
    );
  });

  it('keeps the current nurture step when the provider fails', async () => {
    mockSendLeadNurtureText.mockRejectedValue(new Error('provider unavailable'));

    const stats = await runLeadNurtureSweep();

    expect(stats.errors).toBe(1);
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'failed',
          'followUp.nurtureFailureReason': 'provider unavailable',
          'followUp.nurtureNextRetryAt': expect.any(Date),
        }),
      }),
      { timestamps: false },
    );
  });

  it('does not claim or send an opted-out lead', async () => {
    mockIsSmsOptedOut.mockResolvedValue(true);

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', status: { $in: NURTURE_ELIGIBLE_STATUSES } },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'skipped',
          'followUp.nurtureFailureReason': 'Customer opted out of SMS',
        }),
      }),
      { timestamps: false },
    );
  });

  it('does not claim or send when the lead has an upcoming appointment', async () => {
    mockAppointmentExists.mockResolvedValue({ _id: 'appointment-2' });

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
  });

  it('does not claim or send when the conversation is confirmed paused at the initial eligibility check', async () => {
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'paused', reason: 'AI conversation is currently paused' });

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).not.toHaveBeenCalled();
  });

  it('does not claim or send when the pause state cannot be reliably determined (unknown defers, same as paused)', async () => {
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'unknown', reason: 'Could not confirm pause state (lookup failed)' });

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
  });

  it('skips and reverses the claim when the pause activates after eligibility but before sending (race)', async () => {
    mockCheckConversationPauseForLead
      .mockResolvedValueOnce({ status: 'unpaused' })
      .mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

    const stats = await runLeadNurtureSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockSendLeadNurtureText).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureStatus': 'skipped',
          'followUp.nurtureFailureReason': 'Suppressed: AI conversation is currently paused',
        }),
        $inc: { 'followUp.nurtureAttemptCount': -1 },
      }),
      { timestamps: false },
    );
  });

  it('records the specific unknown-state reason when the late recheck cannot confirm pause status', async () => {
    mockCheckConversationPauseForLead
      .mockResolvedValueOnce({ status: 'unpaused' })
      .mockResolvedValueOnce({ status: 'unknown', reason: "Could not confirm pause state (phone matched a different lead's conversation)" });

    await runLeadNurtureSweep();

    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      { _id: 'lead-1', 'followUp.nurtureStatus': 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'followUp.nurtureFailureReason': "Suppressed: Could not confirm pause state (phone matched a different lead's conversation)",
        }),
      }),
      { timestamps: false },
    );
  });

  it('sends normally when the conversation is confirmed unpaused (regression)', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);

    const stats = await runLeadNurtureSweep();

    expect(stats.sent).toBe(1);
    expect(mockCheckConversationPauseForLead).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', phone: '+13035550123', leadId: 'lead-1' }),
    );
    expect(mockSendLeadNurtureText).toHaveBeenCalledTimes(1);
  });

  it('claim query enforces a 24-hour cross-scheduler lock on followUp.lastAutomatedOutreachAt, shared with aiLeadFollowup.scheduler.ts (not just a same-tick race window)', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);
    await runLeadNurtureSweep();

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

  it('when the send succeeds but the nurture-count bookkeeping write then fails, marks the lead pending_reconciliation instead of failed, and schedules no automatic retry (the SMS was already confirmed sent, so a retry would be a confirmed, avoidable duplicate)', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);
    mockLeadUpdateOne.mockRejectedValueOnce(new Error('DB connection lost'));

    const stats = await runLeadNurtureSweep();

    expect(mockSendLeadNurtureText).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(0);
    expect(stats.errors).toBe(1);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeDefined();
    expect(reconciliationUpdateCall![1].$set['followUp.nurtureFailureReason']).toContain('SMS was sent successfully');
    expect(reconciliationUpdateCall![1].$unset?.['followUp.nurtureNextRetryAt']).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeUndefined();
  });

  it('when sendLeadNurtureText rejects with SmsDeliveryUncertainError (provider accepted, local record unconfirmed), marks pending_reconciliation with the provider message id and schedules no automatic retry', async () => {
    mockSendLeadNurtureText.mockRejectedValue(
      new MockSmsDeliveryUncertainError('SMS was accepted by the provider but the local send record could not be confirmed', {
        messageId: 'msg-ambiguous-1',
        providerMessageId: 'telnyx-msg-999',
      }),
    );

    const stats = await runLeadNurtureSweep();

    expect(stats.errors).toBe(1);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeDefined();
    expect(reconciliationUpdateCall![1].$set['followUp.nurturePendingProviderMessageId']).toBe('telnyx-msg-999');
    expect(reconciliationUpdateCall![1].$unset?.['followUp.nurtureNextRetryAt']).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeUndefined();
  });

  it('a confirmed pre-acceptance failure (ordinary Error, not SmsDeliveryUncertainError) still schedules a normal retry for Lead Nurture — ambiguous outcomes are not conflated with genuine, safe-to-retry failures', async () => {
    mockSendLeadNurtureText.mockRejectedValue(new Error('SMS provider rejected the message'));

    const stats = await runLeadNurtureSweep();

    expect(stats.errors).toBe(1);
    const failedUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'failed',
    );
    expect(failedUpdateCall).toBeDefined();
    expect(failedUpdateCall![1].$set['followUp.nurtureNextRetryAt']).toBeInstanceOf(Date);
    const reconciliationUpdateCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.nurtureStatus'] === 'pending_reconciliation',
    );
    expect(reconciliationUpdateCall).toBeUndefined();
  });

  it('excludes a pending_reconciliation lead from the candidate query itself, so a restart or a later tick can never pick it up for an automatic resend', async () => {
    seedCandidates([]);
    await runLeadNurtureSweep();

    const query = mockLeadFind.mock.calls[0][0];
    expect(query['followUp.nurtureStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });

  it('excludes a pending_reconciliation lead from the atomic claim filter too, so two concurrent workers (or a worker racing a fresh restart) can never both claim it for a resend', async () => {
    mockSendLeadNurtureText.mockResolvedValue(true);
    await runLeadNurtureSweep();

    const claimFilter = mockLeadFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter['followUp.nurtureStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });
});
