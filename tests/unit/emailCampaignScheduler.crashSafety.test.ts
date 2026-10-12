const mockEmailCampaignFind = jest.fn();
const mockEmailCampaignUpdateOne = jest.fn().mockResolvedValue({});
const mockRecipientFind = jest.fn();
const mockRecipientFindOneAndUpdate = jest.fn();
const mockRecipientUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const mockRecipientUpdateMany = jest.fn().mockResolvedValue({});
const mockRecipientCountDocuments = jest.fn().mockResolvedValue(0);
const mockSendCampaignEmail = jest.fn();

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/utils/sendingWindow', () => ({ isWithinSendingHours: jest.fn().mockReturnValue(true) }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendCampaignEmail: mockSendCampaignEmail },
}));
jest.mock('../../src/models/EmailCampaign.model', () => ({
  __esModule: true,
  default: {
    find: mockEmailCampaignFind,
    updateOne: mockEmailCampaignUpdateOne,
  },
}));
jest.mock('../../src/models/EmailCampaignRecipient.model', () => ({
  __esModule: true,
  default: {
    find: mockRecipientFind,
    findOneAndUpdate: mockRecipientFindOneAndUpdate,
    updateOne: mockRecipientUpdateOne,
    updateMany: mockRecipientUpdateMany,
    countDocuments: mockRecipientCountDocuments,
  },
}));

import { runEmailCampaignSweep } from '../../src/schedulers/emailCampaign.scheduler';

function chainable(result: any) {
  const self: any = {};
  self.select = jest.fn().mockReturnValue(self);
  self.limit = jest.fn().mockReturnValue(self);
  self.sort = jest.fn().mockReturnValue(self);
  self.lean = jest.fn().mockResolvedValue(result);
  return self;
}

function seedReclaimRows(staleRows: any[]) {
  mockRecipientFind.mockReturnValueOnce(chainable(staleRows));
}

function seedPendingRecipients(recipients: any[]) {
  mockRecipientFind.mockReturnValueOnce(chainable(recipients));
}

function seedCampaign(campaign: any) {
  mockEmailCampaignFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([campaign]) }) }),
  });
}

const campaign = { _id: 'campaign-1', organizationId: 'org-1', subject: 's', greetingText: 'g', bodyText: 'b' };

describe('emailCampaign.scheduler — crash-safe recipient processing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecipientUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockRecipientUpdateMany.mockResolvedValue({});
    mockEmailCampaignUpdateOne.mockResolvedValue({});
    mockRecipientCountDocuments.mockResolvedValue(0);
    seedCampaign(campaign);
  });

  it('claims a pending recipient into "processing" (not "sent") before attempting the send, so a crash before the send resolves never leaves a false "sent" row', async () => {
    const recipient = { _id: 'r-1', email: 'a@example.com', customerName: 'A' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);

    await runEmailCampaignSweep();

    expect(mockRecipientFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'r-1', status: 'pending' },
      { $set: { status: 'processing', processingStartedAt: expect.any(Date) }, $inc: { attemptCount: 1 } },
      { new: false },
    );
  });

  it('on a confirmed successful send, transitions processing -> sent and increments sentCount', async () => {
    const recipient = { _id: 'r-2', email: 'b@example.com', customerName: 'B' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);

    const stats = await runEmailCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'r-2', status: 'processing' },
      { $set: { status: 'sent', sentAt: expect.any(Date) } },
    );
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { sentCount: 1 } });
    expect(stats.reclaimedUncertain).toBe(0);
  });

  it('counter race: if the recipient was already reclaimed as "uncertain" by the time a slow-but-successful send resolves, sentCount is NOT incremented (would otherwise double-count a recipient that is also marked uncertain)', async () => {
    const recipient = { _id: 'r-2b', email: 'b2@example.com', customerName: 'B2' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);
    mockRecipientUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await runEmailCampaignSweep();

    const sentCountCall = mockEmailCampaignUpdateOne.mock.calls.find((call: any) => call[1]?.$inc?.sentCount);
    expect(sentCountCall).toBeUndefined();
  });

  it('simulated failure: a thrown send error marks the recipient "failed" (not "uncertain") since we have concrete evidence the attempt did not resolve as a confirmed success, and does not retry automatically', async () => {
    const recipient = { _id: 'r-3', email: 'c@example.com', customerName: 'C' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockRejectedValue(new Error('SMTP connection refused'));

    await runEmailCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'r-3', status: 'processing' },
      { $set: { status: 'failed', failureReason: 'SMTP connection refused' } },
    );
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { failedCount: 1 } });
    expect(mockSendCampaignEmail).toHaveBeenCalledTimes(1);
  });

  it('counter race: if the recipient was already reclaimed as "uncertain" by the time a failed send is recorded, failedCount is NOT incremented', async () => {
    const recipient = { _id: 'r-3b', email: 'c2@example.com', customerName: 'C2' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockRejectedValue(new Error('SMTP connection refused'));
    mockRecipientUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await runEmailCampaignSweep();

    const failedCountCall = mockEmailCampaignUpdateOne.mock.calls.find((call: any) => call[1]?.$inc?.failedCount);
    expect(failedCountCall).toBeUndefined();
  });

  it('a delivered:false outcome (customer opted out mid-sweep) marks the recipient "skipped", not "failed" or "sent"', async () => {
    const recipient = { _id: 'r-4', email: 'd@example.com', customerName: 'D' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(false);

    await runEmailCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'r-4', status: 'processing' },
      { $set: { status: 'skipped', failureReason: 'Customer opted out of email' } },
    );
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { skippedCount: 1 } });
  });

  it('counter race: if the recipient was already reclaimed as "uncertain" by the time an opted-out outcome is recorded, skippedCount is NOT incremented', async () => {
    const recipient = { _id: 'r-4b', email: 'd2@example.com', customerName: 'D2' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(false);
    mockRecipientUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await runEmailCampaignSweep();

    const skippedCountCall = mockEmailCampaignUpdateOne.mock.calls.find((call: any) => call[1]?.$inc?.skippedCount);
    expect(skippedCountCall).toBeUndefined();
  });

  it('simulated failure: the email is confirmed sent, but recording that outcome fails even after retrying — marks the recipient "uncertain" (never "failed") and bumps uncertainCount, so a human reviews it instead of it being silently lost or auto-resent as a duplicate', async () => {
    const recipient = { _id: 'r-5', email: 'e@example.com', customerName: 'E' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);
    mockRecipientUpdateOne
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    await runEmailCampaignSweep();

    const uncertainCall = mockRecipientUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$set?.status === 'uncertain',
    );
    expect(uncertainCall).toBeDefined();
    expect(uncertainCall![0]).toEqual({ _id: 'r-5', status: 'processing' });
    expect(uncertainCall![1].$set.failureReason).toContain('sent successfully but could not be recorded');
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { uncertainCount: 1 } });
    const failedCall = mockEmailCampaignUpdateOne.mock.calls.find(
      (call: any) => call[1]?.$inc?.failedCount,
    );
    expect(failedCall).toBeUndefined();
  });

  it('counter race: if retryDbWrite\'s own recovery update also finds the row already reclaimed, uncertainCount is NOT double-incremented (the reclaim sweep already counted it once)', async () => {
    const recipient = { _id: 'r-5b', email: 'e2@example.com', customerName: 'E2' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);
    mockRecipientUpdateOne
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await runEmailCampaignSweep();

    const uncertainCountCall = mockEmailCampaignUpdateOne.mock.calls.find((call: any) => call[1]?.$inc?.uncertainCount);
    expect(uncertainCountCall).toBeUndefined();
  });

  it('restart recovery: a recipient left stuck in "processing" past the stale timeout (simulating a crash/restart mid-send) is reclaimed as "uncertain", bumps the owning campaign\'s uncertainCount, and is never auto-resent', async () => {
    const staleRecipient = { _id: 'r-stale', campaignId: 'campaign-1' };
    seedReclaimRows([staleRecipient]);
    seedPendingRecipients([]);

    const stats = await runEmailCampaignSweep();

    expect(mockRecipientUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['r-stale'] }, status: 'processing' },
      {
        $set: {
          status: 'uncertain',
          failureReason: expect.stringContaining('process may have restarted mid-send'),
        },
      },
    );
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { uncertainCount: 1 } });
    expect(mockSendCampaignEmail).not.toHaveBeenCalled();
    expect(stats.reclaimedUncertain).toBe(1);
  });

  it('restart recovery runs even outside sending hours, so stuck rows from a crash are reconciled promptly rather than waiting for the next sending window', async () => {
    const isWithinSendingHours: jest.Mock = require('../../src/utils/sendingWindow').isWithinSendingHours;
    isWithinSendingHours.mockReturnValueOnce(false);
    const staleRecipient = { _id: 'r-stale-2', campaignId: 'campaign-1' };
    seedReclaimRows([staleRecipient]);

    const stats = await runEmailCampaignSweep();

    expect(mockRecipientUpdateMany).toHaveBeenCalled();
    expect(stats.reclaimedUncertain).toBe(1);
    expect(stats.campaignsProcessed).toBe(0);
  });

  it('a campaign with zero remaining pending/processing recipients is marked completed even when some ended up uncertain', async () => {
    const recipient = { _id: 'r-6', email: 'f@example.com', customerName: 'F' };
    seedReclaimRows([]);
    seedPendingRecipients([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockSendCampaignEmail.mockResolvedValue(true);
    mockRecipientCountDocuments.mockResolvedValue(0);

    await runEmailCampaignSweep();

    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith(
      { _id: 'campaign-1', status: { $in: ['queued', 'sending'] } },
      { $set: { status: 'completed', completedAt: expect.any(Date) } },
    );
    expect(mockRecipientCountDocuments).toHaveBeenCalledWith({
      campaignId: 'campaign-1',
      status: { $in: ['pending', 'processing'] },
    });
  });
});
