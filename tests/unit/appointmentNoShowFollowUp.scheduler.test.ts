const find = jest.fn();
const exists = jest.fn();
const findOneAndUpdate = jest.fn();
const updateOne = jest.fn();
const sendNoShowFollowUpText = jest.fn();

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { find, exists, findOneAndUpdate, updateOne },
}));

jest.mock('../../src/services/communication.service', () => ({
  sendNoShowFollowUpText,
}));

jest.mock('../../src/utils/sendingWindow', () => ({
  isWithinSendingHours: jest.fn(() => true),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

import { runNoShowFollowUpSweep } from '../../src/schedulers/appointmentNoShowFollowUp.scheduler';

const appointment = {
  _id: 'appointment-1',
  title: 'Test drive',
  startTime: new Date('2026-09-21T16:00:00.000Z'),
  organizationId: 'org-1',
  customerBooking: { phone: '+13035550123', firstName: 'Alex' },
  leadId: 'lead-1',
  noShowFollowUpAttemptCount: 0,
};

function seedCandidates(items = [appointment]) {
  const lean = jest.fn().mockResolvedValue(items);
  const limit = jest.fn(() => ({ lean }));
  const select = jest.fn(() => ({ limit }));
  find.mockReturnValue({ select });
}

describe('appointment no-show follow-up scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedCandidates();
    exists.mockResolvedValue(null);
    findOneAndUpdate.mockResolvedValue({ ...appointment, noShowFollowUpAttemptCount: 1 });
    updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('marks the follow-up sent only after the provider accepts it', async () => {
    sendNoShowFollowUpText.mockResolvedValue(true);

    const stats = await runNoShowFollowUpSweep();

    expect(stats).toEqual({ scanned: 1, sent: 1, skipped: 0, errors: 0 });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: appointment._id, noShowFollowUpStatus: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          noShowFollowUpStatus: 'sent',
          noShowFollowUpSentAt: expect.any(Date),
        }),
      }),
      { timestamps: false },
    );
  });

  it('records a retryable failure without marking the follow-up sent', async () => {
    sendNoShowFollowUpText.mockRejectedValue(new Error('provider unavailable'));

    const stats = await runNoShowFollowUpSweep();

    expect(stats.errors).toBe(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: appointment._id, noShowFollowUpStatus: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          noShowFollowUpStatus: 'failed',
          noShowFollowUpFailureReason: 'provider unavailable',
          noShowFollowUpNextRetryAt: expect.any(Date),
        }),
      }),
      { timestamps: false },
    );
    expect(updateOne.mock.calls.flat().join(' ')).not.toContain('noShowFollowUpSentAt');
  });

  it('records an opted-out customer as skipped', async () => {
    sendNoShowFollowUpText.mockResolvedValue(false);

    const stats = await runNoShowFollowUpSweep();

    expect(stats).toEqual({ scanned: 1, sent: 0, skipped: 1, errors: 0 });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: appointment._id, noShowFollowUpStatus: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          noShowFollowUpStatus: 'skipped',
          noShowFollowUpFailureReason: 'Customer opted out of SMS',
        }),
      }),
      { timestamps: false },
    );
  });

  it('does not send when another worker owns the claim', async () => {
    findOneAndUpdate.mockResolvedValue(null);

    const stats = await runNoShowFollowUpSweep();

    expect(stats).toEqual({ scanned: 1, sent: 0, skipped: 0, errors: 0 });
    expect(sendNoShowFollowUpText).not.toHaveBeenCalled();
  });
});
