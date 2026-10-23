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

jest.mock('../../src/services/aiOperatingMode.service', () => require('./helpers/legacyAiModeMock').legacyAiModeMock((orgId: any) => mockResolveAiAgentSettings(orgId)));
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
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import mongoose from 'mongoose';
import { runAiLeadFollowupSweep } from '../../src/schedulers/aiLeadFollowup.scheduler';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

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
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex', followUpIntervalHours: 24 });
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

  it('an in-flight follow-up whose mode leaves Live at dispatch is marked skipped, never failed, with no retry scheduled', async () => {
    seedCandidates([baseLead()]);
    mockSendStaffAttributedSms.mockRejectedValue(new AiReplySuppressedError());

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(stats.sent).toBe(0);
    const updates = mockLeadUpdateOne.mock.calls.map(([, update]) => update);
    expect(updates).toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'skipped' }),
      $unset: { 'followUp.aiFollowUpNextRetryAt': 1 },
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'failed' }),
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'sent' }),
    }));
  });

  it('never generates or sends for a customer marked Do Not Contact, and records why', async () => {
    const restriction = jest.requireMock('../../src/services/contactRestriction.service');
    restriction.checkContactForSend.mockImplementationOnce(async () => ({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false }));
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockGenerateProactiveFollowUp).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
    const updates = mockLeadUpdateOne.mock.calls.map(([, update]) => update);
    expect(updates).toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({
        'followUp.aiFollowUpStatus': 'skipped',
        'followUp.aiFollowUpFailureReason': expect.stringContaining('Do Not Contact'),
      }),
    }));
  });

  it('marks a Do Not Contact block at the send boundary as skipped, never failed', async () => {
    const { ContactRestrictedError } = jest.requireActual('../../src/services/contactRestriction.service');
    seedCandidates([baseLead()]);
    mockSendStaffAttributedSms.mockRejectedValue(new ContactRestrictedError({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false }));

    const stats = await runAiLeadFollowupSweep();

    expect(stats).toEqual(expect.objectContaining({ skipped: 1, sent: 0, errors: 0 }));
    const updates = mockLeadUpdateOne.mock.calls.map(([, update]) => update);
    expect(updates).toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'skipped' }),
      $inc: { 'followUp.aiFollowUpAttemptCount': -1 },
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'failed' }),
    }));
  });

  it('tags the follow-up send as an AI workflow so the dispatch guard runs', async () => {
    seedCandidates([baseLead()]);
    await runAiLeadFollowupSweep();
    expect(mockSendStaffAttributedSms).toHaveBeenCalledWith(expect.objectContaining({ aiWorkflow: 'sms_followup' }));
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
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({
      createdAt: tenDaysAgo,
      followUp: { aiFollowUpCount: 1, lastAutomatedOutreachAt: threeDaysAgo },
    })]);

    const stats = await runAiLeadFollowupSweep();

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

  it('has no max-count cap at all: a lead many follow-ups deep, still silent, is still sent as long as the interval has elapsed', async () => {
    seedCandidates([baseLead({
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      followUp: { aiFollowUpCount: 9 },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
  });

  it('is not due before the configured interval elapses (default: Daily / 24h)', async () => {
    seedCandidates([baseLead({
      createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
      followUp: { aiFollowUpCount: 0 },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is due once the configured interval has elapsed (default: Daily / 24h)', async () => {
    seedCandidates([baseLead({
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      followUp: { aiFollowUpCount: 0 },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
  });

  it('honors a longer admin-configured interval (Every 3 days / 72h): not due at 48h even though the default 24h would have fired', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex', followUpIntervalHours: 72 });
    seedCandidates([baseLead({
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      followUp: { aiFollowUpCount: 0 },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('applies the same configured interval regardless of how many follow-ups have already gone out (no special first-touch interval)', async () => {
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Alex', followUpIntervalHours: 48 });
    seedCandidates([baseLead({
      createdAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000),
      followUp: { aiFollowUpCount: 4, lastRepResponseAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a customer SMS reply resets the inactivity timer — not due immediately after the reply, even though the lead\'s original creation date is long overdue on its own', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({
      createdAt,
      followUp: { aiFollowUpCount: 0, lastCustomerActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ 'followUp.aiFollowUpStatus': 'stopped' }) }),
      expect.anything(),
    );
  });

  it('becomes due again once the configured interval has elapsed since that reply — a reply only resets the clock, it does not stop follow-ups permanently', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({
      createdAt,
      followUp: { aiFollowUpCount: 0, lastCustomerActivityAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
  });

  it('an inbound call also resets the inactivity timer, same as an SMS reply', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({ createdAt, followUp: { aiFollowUpCount: 0 } })]);
    const callLean = jest.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    mockCallFindOne.mockReturnValue({ sort: jest.fn(() => ({ select: jest.fn(() => ({ lean: callLean })) })) });

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not falsely treat the lead-creation timestamp itself as a reply: lastCustomerActivityAt set only a few seconds after createdAt (normal creation bookkeeping, not a real reply) does not block sending once genuinely overdue', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({
      createdAt,
      followUp: { aiFollowUpCount: 0, lastCustomerActivityAt: new Date(createdAt.getTime() + 5 * 1000) },
    })]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
  });

  it('a reply never sets a permanent "stopped" status — only an explicit SMS opt-out does', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    seedCandidates([baseLead({
      createdAt,
      followUp: { aiFollowUpCount: 0, lastCustomerActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })]);

    await runAiLeadFollowupSweep();

    const stoppedCall = mockLeadUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.['followUp.aiFollowUpStatus'] === 'stopped',
    );
    expect(stoppedCall).toBeUndefined();
  });

  it('the candidate query only excludes pending_reconciliation leads — there is no permanent reply-based exclusion', async () => {
    seedCandidates([]);
    await runAiLeadFollowupSweep();

    const query = mockLeadFind.mock.calls[0][0];
    expect(query['followUp.aiFollowUpStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });

  it('still stops normally on an SMS opt-out, independent of the reply-based stop', async () => {
    mockIsSmsOptedOut.mockResolvedValue(true);
    seedCandidates([baseLead()]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
    expect(mockLeadUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'lead-1' }),
      expect.objectContaining({
        $set: expect.objectContaining({ 'followUp.aiFollowUpFailureReason': 'Customer opted out of SMS' }),
      }),
      { timestamps: false },
    );
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

  it('excludes a pending_reconciliation lead from the atomic claim filter too, so two concurrent workers (or a worker racing a fresh restart) can never both claim it for a resend', async () => {
    seedCandidates([baseLead()]);
    await runAiLeadFollowupSweep();

    const claimFilter = mockLeadFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter['followUp.aiFollowUpStatus']).toEqual({ $ne: 'pending_reconciliation' });
  });
});

describe('AI lead follow-up scheduler — customers with multiple vehicle inquiries', () => {
  const PHONE = '+13853365062';
  const HOUR = 60 * 60 * 1000;
  let modelSpy: jest.SpiedFunction<typeof mongoose.model>;

  const crv = baseLead({ _id: 'lead-crv', phone: PHONE, vehicle: { year: '2024', make: 'Honda', model: 'CR-V' }, updatedAt: new Date(Date.now() - 5 * 24 * HOUR) });
  const jeep = { _id: 'lead-jeep', phone: '385-336-5062', vehicle: { year: '2022', make: 'Jeep', model: 'Grand Cherokee 4xe' }, updatedAt: new Date(Date.now() - 2 * 24 * HOUR) };

  function seedSiblings(siblings: any[]) {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(siblings),
    };
    modelSpy = jest.spyOn(mongoose, 'model').mockReturnValue({ find: jest.fn().mockReturnValue(chain) } as any);
  }

  function seedSharedConversationActivity(lastMessageAt: Date | null) {
    mockConversationFindOne.mockReturnValue({
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(lastMessageAt ? { _id: 'conv-1', lastMessageAt } : null) })),
    });
    mockCommFind.mockReturnValue({ sort: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) })) });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'unpaused' });
    mockIsSmsOptedOut.mockResolvedValue(false);
    mockAppointmentExists.mockResolvedValue(false);
    mockResolveAiAgentSettings.mockResolvedValue({ enabled: true, agentName: 'Anna', followUpIntervalHours: 24 });
    mockResolveDealerName.mockResolvedValue('Action Auto Utah');
    mockGenerateProactiveFollowUp.mockResolvedValue({ text: 'Hi Jamie, just checking in on the CR-V!' });
    mockValidateOutboundMessage.mockReturnValue({ ok: true, reasons: [] });
    mockClassifyAlexReplySafety.mockResolvedValue('SAFE');
    mockSendStaffAttributedSms.mockResolvedValue({ message: { _id: 'msg-1' } });
    mockLeadFindOneAndUpdate.mockResolvedValue({ _id: 'lead-crv' });
    mockLeadUpdateOne.mockResolvedValue({});
    emptyMessageLookup();
  });

  afterEach(() => modelSpy?.mockRestore());

  it('pins the check-in to this inquiry and tells the model not to mention the customer\'s other vehicle', async () => {
    seedSiblings([crv, jeep]);
    seedSharedConversationActivity(new Date(Date.now() - 3 * 24 * HOUR));
    seedCandidates([crv]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
    const call = mockGenerateProactiveFollowUp.mock.calls[0][0];
    expect(call.leadVehicleInterest).toBe('2024 Honda CR-V');
    expect(call.vehicleContextNote).toContain('This message is about the 2024 Honda CR-V only');
    expect(call.vehicleContextNote).toContain('2022 Jeep Grand Cherokee 4xe');
  });

  it('defers (no claim, no send) while the shared text thread is active about any inquiry', async () => {
    seedSiblings([crv, jeep]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));
    seedCandidates([crv]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.skipped).toBe(1);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockGenerateProactiveFollowUp).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
  });

  it('treats duplicate leads for the same vehicle as one inquiry (no deferral, no extra instruction)', async () => {
    const crvDuplicate = { ...jeep, _id: 'lead-crv-dup', vehicle: { year: '2024', make: 'Honda', model: 'CR-V' } };
    seedSiblings([crv, crvDuplicate]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));
    seedCandidates([crv]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
    expect(mockGenerateProactiveFollowUp.mock.calls[0][0].vehicleContextNote).toBeUndefined();
  });

  it('leaves single-inquiry customers unchanged, even when their thread was active recently', async () => {
    seedSiblings([crv]);
    seedSharedConversationActivity(new Date(Date.now() - 2 * HOUR));
    seedCandidates([crv]);

    const stats = await runAiLeadFollowupSweep();

    expect(stats.sent).toBe(1);
    expect(mockGenerateProactiveFollowUp.mock.calls[0][0].vehicleContextNote).toBeUndefined();
  });

  it.each(['+639171234567', '385-503-5869 ext 4', '+180170268'])(
    'does not generate, claim or send for the untextable number %p',
    async (phone) => {
      seedCandidates([baseLead({ phone })]);

      const stats = await runAiLeadFollowupSweep();

      expect(stats.skipped).toBe(1);
      expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockGenerateProactiveFollowUp).not.toHaveBeenCalled();
      expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
      expect(mockLeadUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'lead-1', 'followUp.aiFollowUpStatus': { $ne: 'processing' } }),
        {
          $set: expect.objectContaining({
            'followUp.aiFollowUpStatus': 'skipped',
            'followUp.aiFollowUpFailureReason': expect.any(String),
            'followUp.aiFollowUpNextRetryAt': expect.any(Date),
          }),
        },
        { timestamps: false },
      );
    },
  );
});
