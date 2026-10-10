const mockAppointmentFind = jest.fn();
const mockAppointmentFindOneAndUpdate = jest.fn();
const mockAppointmentUpdateOne = jest.fn();
const mockSendReviewRequestText = jest.fn();
const mockSendReviewRequestEmail = jest.fn();
const mockCheckConversationPauseForLead = jest.fn();

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: {
    find: mockAppointmentFind,
    findOneAndUpdate: mockAppointmentFindOneAndUpdate,
    updateOne: mockAppointmentUpdateOne,
  },
}));

jest.mock('../../src/services/communication.service', () => ({
  sendReviewRequestText: mockSendReviewRequestText,
  checkConversationPauseForLead: mockCheckConversationPauseForLead,
  shouldDeferAutomatedFollowUp: (result: { status: string }) => result.status !== 'unpaused',
}));

jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendReviewRequestEmail: mockSendReviewRequestEmail },
}));

jest.mock('../../src/utils/sendingWindow', () => ({
  isWithinSendingHours: jest.fn(() => true),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

import { runReviewRequestSweep } from '../../src/schedulers/reviewRequest.scheduler';

function smsAppointment() {
  return {
    _id: 'appt-1',
    organizationId: 'org-1',
    leadId: 'lead-1',
    customerBooking: { phone: '+13035550123', firstName: 'Jordan' },
    reviewRequestAttemptCount: 0,
  };
}

function emailAppointment() {
  return {
    _id: 'appt-2',
    organizationId: 'org-1',
    leadId: 'lead-2',
    customerBooking: { email: 'jordan@example.com', phone: '+13035550199', firstName: 'Jordan' },
    reviewRequestEmailAttemptCount: 0,
  };
}

function seedFind(items: any[]) {
  const lean = jest.fn().mockResolvedValue(items);
  const limit = jest.fn(() => ({ lean }));
  const select = jest.fn(() => ({ limit }));
  mockAppointmentFind.mockReturnValueOnce({ select });
}

describe('review request scheduler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, REVIEW_REQUEST_ENABLED: 'true', REVIEW_REQUEST_EMAIL_ENABLED: 'true' };
    mockCheckConversationPauseForLead.mockResolvedValue({ status: 'unpaused' });
    mockAppointmentUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('SMS path', () => {
    it('does not claim or send when the conversation is confirmed paused at the initial eligibility check', async () => {
      seedFind([smsAppointment()]);
      seedFind([]);
      mockCheckConversationPauseForLead.mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

      const stats = await runReviewRequestSweep();

      expect(stats.skipped).toBe(1);
      expect(mockAppointmentFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockSendReviewRequestText).not.toHaveBeenCalled();
    });

    it('does not claim or send when the pause state cannot be reliably determined (unknown defers)', async () => {
      seedFind([smsAppointment()]);
      seedFind([]);
      mockCheckConversationPauseForLead.mockResolvedValueOnce({ status: 'unknown', reason: 'Could not confirm pause state (lookup failed)' });

      const stats = await runReviewRequestSweep();

      expect(stats.skipped).toBe(1);
      expect(mockAppointmentFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockSendReviewRequestText).not.toHaveBeenCalled();
    });

    it('skips and reverses the claim when the pause activates after eligibility but before sending (race), without permanently excluding the appointment', async () => {
      seedFind([smsAppointment()]);
      seedFind([]);
      mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(smsAppointment());
      mockCheckConversationPauseForLead
        .mockResolvedValueOnce({ status: 'unpaused' })
        .mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

      const stats = await runReviewRequestSweep();

      expect(stats.skipped).toBe(1);
      expect(mockAppointmentFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockSendReviewRequestText).not.toHaveBeenCalled();
      const [filter, update, options] = mockAppointmentUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'appt-1', reviewRequestStatus: 'processing' });
      expect(update.$set.reviewRequestFailureReason).toBe('Suppressed: AI conversation is currently paused');
      expect(update.$set.reviewRequestStatus).toBeUndefined();
      expect(update.$unset).toEqual({ reviewRequestStatus: 1, reviewRequestLastAttemptAt: 1 });
      expect(update.$inc).toEqual({ reviewRequestAttemptCount: -1 });
      expect(options).toEqual({ timestamps: false });
    });

    it('sends normally when the conversation is confirmed unpaused (regression)', async () => {
      seedFind([smsAppointment()]);
      seedFind([]);
      mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(smsAppointment());
      mockSendReviewRequestText.mockResolvedValue(true);

      const stats = await runReviewRequestSweep();

      expect(stats.sent).toBe(1);
      expect(mockCheckConversationPauseForLead).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', phone: '+13035550123', leadId: 'lead-1' }),
      );
      expect(mockSendReviewRequestText).toHaveBeenCalledTimes(1);
    });
  });

  describe('email path (parity with SMS)', () => {
    it('does not claim or send when the conversation is confirmed paused at the initial eligibility check', async () => {
      seedFind([]);
      seedFind([emailAppointment()]);
      mockCheckConversationPauseForLead.mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

      const stats = await runReviewRequestSweep();

      expect(stats.emailSkipped).toBe(1);
      expect(mockAppointmentFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockSendReviewRequestEmail).not.toHaveBeenCalled();
    });

    it('skips and reverses the claim when the pause activates after eligibility but before sending (race), without permanently excluding the appointment', async () => {
      seedFind([]);
      seedFind([emailAppointment()]);
      mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(emailAppointment());
      mockCheckConversationPauseForLead
        .mockResolvedValueOnce({ status: 'unpaused' })
        .mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

      const stats = await runReviewRequestSweep();

      expect(stats.emailSkipped).toBe(1);
      expect(mockAppointmentFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockSendReviewRequestEmail).not.toHaveBeenCalled();
      const [filter, update, options] = mockAppointmentUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'appt-2', reviewRequestEmailStatus: 'processing' });
      expect(update.$set.reviewRequestEmailFailureReason).toBe('Suppressed: AI conversation is currently paused');
      expect(update.$set.reviewRequestEmailStatus).toBeUndefined();
      expect(update.$unset).toEqual({ reviewRequestEmailStatus: 1, reviewRequestEmailLastAttemptAt: 1 });
      expect(update.$inc).toEqual({ reviewRequestEmailAttemptCount: -1 });
      expect(options).toEqual({ timestamps: false });
    });

    it('sends normally when the conversation is confirmed unpaused (regression)', async () => {
      seedFind([]);
      seedFind([emailAppointment()]);
      mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(emailAppointment());
      mockSendReviewRequestEmail.mockResolvedValue(true);

      const stats = await runReviewRequestSweep();

      expect(stats.emailSent).toBe(1);
      expect(mockCheckConversationPauseForLead).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', phone: '+13035550199', leadId: 'lead-2' }),
      );
      expect(mockSendReviewRequestEmail).toHaveBeenCalledTimes(1);
    });
  });

  it('a pause-suppressed appointment never sets reviewRequestStatus to the terminal "skipped" value (would permanently exclude it from the $nin candidate filter)', async () => {
    seedFind([smsAppointment()]);
    seedFind([]);
    mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(smsAppointment());
    mockCheckConversationPauseForLead
      .mockResolvedValueOnce({ status: 'unpaused' })
      .mockResolvedValueOnce({ status: 'paused', reason: 'AI conversation is currently paused' });

    await runReviewRequestSweep();

    const [, update] = mockAppointmentUpdateOne.mock.calls[0];
    expect(update.$set.reviewRequestStatus).not.toBe('skipped');
    expect(update.$unset.reviewRequestStatus).toBe(1);
  });

  it('existing opt-out-style failure behavior on SMS still resolves to a terminal skipped status (regression — this is a genuine terminal case, unlike pause)', async () => {
    seedFind([smsAppointment()]);
    seedFind([]);
    mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(smsAppointment());
    mockSendReviewRequestText.mockResolvedValue(false);

    const stats = await runReviewRequestSweep();

    expect(stats.skipped).toBe(1);
    expect(mockAppointmentUpdateOne).toHaveBeenCalledWith(
      { _id: 'appt-1', reviewRequestStatus: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({ reviewRequestStatus: 'skipped' }),
      }),
      { timestamps: false },
    );
  });

  it('skips the whole sweep outside sending hours (existing scheduling behavior, regression)', async () => {
    const { isWithinSendingHours } = require('../../src/utils/sendingWindow');
    (isWithinSendingHours as jest.Mock).mockReturnValueOnce(false);

    const stats = await runReviewRequestSweep();

    expect(stats).toEqual({ scanned: 0, sent: 0, skipped: 0, errors: 0, emailScanned: 0, emailSent: 0, emailSkipped: 0, emailErrors: 0 });
    expect(mockAppointmentFind).not.toHaveBeenCalled();
  });
});
