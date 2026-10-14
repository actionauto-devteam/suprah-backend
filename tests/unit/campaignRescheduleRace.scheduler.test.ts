const mockSmsCampaignFind = jest.fn();
const mockSmsCampaignFindOneAndUpdate = jest.fn();
const mockSmsCampaignFindOne = jest.fn();
const mockSmsCampaignUpdateOne = jest.fn().mockResolvedValue({});
const mockSmsRecipientFind = jest.fn();
const mockSmsRecipientFindOneAndUpdate = jest.fn();
const mockSmsRecipientUpdateOne = jest.fn().mockResolvedValue({});
const mockSmsRecipientCountDocuments = jest.fn().mockResolvedValue(0);
const mockSendStaffAttributedSms = jest.fn();

const mockEmailCampaignFind = jest.fn();
const mockEmailCampaignFindOneAndUpdate = jest.fn();
const mockEmailCampaignFindOne = jest.fn();
const mockEmailCampaignUpdateOne = jest.fn().mockResolvedValue({});
const mockEmailRecipientFind = jest.fn();
const mockEmailRecipientFindOneAndUpdate = jest.fn();
const mockEmailRecipientUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const mockEmailRecipientUpdateMany = jest.fn().mockResolvedValue({});
const mockEmailRecipientCountDocuments = jest.fn().mockResolvedValue(0);
const mockSendCampaignEmail = jest.fn();

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/utils/sendingWindow', () => ({ isWithinSendingHours: jest.fn().mockReturnValue(true) }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../../src/services/communication.service', () => ({ sendStaffAttributedSms: mockSendStaffAttributedSms }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: { sendCampaignEmail: mockSendCampaignEmail } }));

jest.mock('../../src/models/SmsCampaign.model', () => ({
  __esModule: true,
  default: {
    find: mockSmsCampaignFind,
    findOneAndUpdate: mockSmsCampaignFindOneAndUpdate,
    findOne: mockSmsCampaignFindOne,
    updateOne: mockSmsCampaignUpdateOne,
  },
}));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({
  __esModule: true,
  default: {
    find: mockSmsRecipientFind,
    findOneAndUpdate: mockSmsRecipientFindOneAndUpdate,
    updateOne: mockSmsRecipientUpdateOne,
    countDocuments: mockSmsRecipientCountDocuments,
  },
}));
jest.mock('../../src/models/EmailCampaign.model', () => ({
  __esModule: true,
  default: {
    find: mockEmailCampaignFind,
    findOneAndUpdate: mockEmailCampaignFindOneAndUpdate,
    findOne: mockEmailCampaignFindOne,
    updateOne: mockEmailCampaignUpdateOne,
  },
}));
jest.mock('../../src/models/EmailCampaignRecipient.model', () => ({
  __esModule: true,
  default: {
    find: mockEmailRecipientFind,
    findOneAndUpdate: mockEmailRecipientFindOneAndUpdate,
    updateOne: mockEmailRecipientUpdateOne,
    updateMany: mockEmailRecipientUpdateMany,
    countDocuments: mockEmailRecipientCountDocuments,
  },
}));

import { runSmsCampaignSweep } from '../../src/schedulers/smsCampaign.scheduler';
import { runEmailCampaignSweep } from '../../src/schedulers/emailCampaign.scheduler';

function chainable(result: any) {
  const self: any = {};
  self.select = jest.fn().mockReturnValue(self);
  self.limit = jest.fn().mockReturnValue(self);
  self.sort = jest.fn().mockReturnValue(self);
  self.lean = jest.fn().mockResolvedValue(result);
  return self;
}

function seedSmsCampaigns(campaigns: any[]) {
  mockSmsCampaignFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(campaigns) }) }),
  });
}

function seedEmailCampaigns(campaigns: any[]) {
  mockEmailCampaignFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(campaigns) }) }),
  });
}

const scheduledCampaign = { _id: 'campaign-1', organizationId: 'org-1', status: 'scheduled', message: 'Hi', subject: 's', greetingText: 'g', bodyText: 'b' };

describe('Campaign scheduler — reschedule/send race (SMS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSmsRecipientFind.mockReturnValue(chainable([]));
    seedSmsCampaigns([scheduledCampaign]);
  });

  it('exits without sending when the campaign was rescheduled to a future time between discovery and claim (the atomic claim filter re-checks scheduledAt, not the stale in-memory snapshot)', async () => {
    // Simulates the exact race: the sweep's find() read the campaign while it still
    // looked due, but by the time processCampaign's own atomic claim runs, a reschedule
    // request has already pushed scheduledAt into the future — the claim's own $lte:now
    // check (re-evaluated at claim time, not discovery time) must fail.
    mockSmsCampaignFindOneAndUpdate.mockResolvedValue(null);
    mockSmsCampaignFindOne.mockResolvedValue(null); // not 'sending' either — genuinely not claimable right now

    const stats = await runSmsCampaignSweep();

    expect(mockSmsRecipientFind).not.toHaveBeenCalled();
    expect(mockSendStaffAttributedSms).not.toHaveBeenCalled();
    expect(stats.campaignsProcessed).toBe(1); // loop still iterates the campaign; processCampaign itself is the one that no-ops

    const claimFilter = mockSmsCampaignFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.$or).toEqual([
      { status: 'queued' },
      { status: 'scheduled', scheduledAt: { $lte: expect.any(Date) } },
    ]);
  });

  it('claims and sends normally when a scheduled campaign is genuinely due', async () => {
    mockSmsCampaignFindOneAndUpdate.mockResolvedValue({ _id: 'campaign-1', status: 'sending' });
    mockSmsRecipientFind.mockReturnValue(chainable([{ _id: 'r-1', phone: '+13035550123', customerName: 'Jamie' }]));
    mockSmsRecipientFindOneAndUpdate.mockResolvedValue({ _id: 'r-1' });
    mockSendStaffAttributedSms.mockResolvedValue(true);

    const stats = await runSmsCampaignSweep();

    expect(mockSendStaffAttributedSms).toHaveBeenCalledTimes(1);
    expect(stats.campaignsProcessed).toBe(1);
  });

  it('a "queued" (immediate-send) campaign claims unconditionally, with no scheduledAt gate', async () => {
    seedSmsCampaigns([{ _id: 'campaign-2', organizationId: 'org-1', status: 'queued', message: 'Hi' }]);
    mockSmsCampaignFindOneAndUpdate.mockResolvedValue({ _id: 'campaign-2', status: 'sending' });
    mockSmsRecipientFind.mockReturnValue(chainable([]));

    await runSmsCampaignSweep();

    const claimFilter = mockSmsCampaignFindOneAndUpdate.mock.calls[0][0];
    const queuedClause = claimFilter.$or.find((c: any) => c.status === 'queued');
    expect(queuedClause).toEqual({ status: 'queued' });
  });

  it('continues an already-"sending" campaign from a previous tick without re-claiming it as a fresh start (falls back to a plain status check, not the fresh-claim transition)', async () => {
    seedSmsCampaigns([{ _id: 'campaign-3', organizationId: 'org-1', status: 'sending', message: 'Hi' }]);
    mockSmsCampaignFindOneAndUpdate.mockResolvedValue(null); // not freshly claimable — it's already 'sending'
    mockSmsCampaignFindOne.mockResolvedValue({ _id: 'campaign-3', status: 'sending' }); // confirms it's still in-flight
    mockSmsRecipientFind.mockReturnValue(chainable([{ _id: 'r-2', phone: '+13035550124', customerName: 'Alex' }]));
    mockSmsRecipientFindOneAndUpdate.mockResolvedValue({ _id: 'r-2' });
    mockSendStaffAttributedSms.mockResolvedValue(true);

    await runSmsCampaignSweep();

    expect(mockSmsCampaignFindOne).toHaveBeenCalledWith({ _id: 'campaign-3', status: 'sending' });
    expect(mockSendStaffAttributedSms).toHaveBeenCalledTimes(1);
  });
});

describe('Campaign scheduler — reschedule/send race (Email)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmailRecipientFind.mockReturnValue(chainable([]));
    seedEmailCampaigns([scheduledCampaign]);
  });

  it('exits without sending when the campaign was rescheduled to a future time between discovery and claim', async () => {
    mockEmailCampaignFindOneAndUpdate.mockResolvedValue(null);
    mockEmailCampaignFindOne.mockResolvedValue(null);

    const stats = await runEmailCampaignSweep();

    // One call is the unrelated stale-processing reclaim pass, which always runs;
    // a second call would mean the campaign's own pending recipients were fetched,
    // which must not happen when the claim fails.
    expect(mockEmailRecipientFind).toHaveBeenCalledTimes(1);
    expect(mockSendCampaignEmail).not.toHaveBeenCalled();
    expect(stats.campaignsProcessed).toBe(1);

    const claimFilter = mockEmailCampaignFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.$or).toEqual([
      { status: 'queued' },
      { status: 'scheduled', scheduledAt: { $lte: expect.any(Date) } },
    ]);
  });

  it('claims and sends normally when a scheduled campaign is genuinely due', async () => {
    mockEmailCampaignFindOneAndUpdate.mockResolvedValue({ _id: 'campaign-1', status: 'sending' });
    mockEmailRecipientFind
      .mockReturnValueOnce(chainable([])) // stale-processing reclaim pass
      .mockReturnValueOnce(chainable([{ _id: 'r-1', email: 'jamie@example.com', customerName: 'Jamie' }]));
    mockEmailRecipientFindOneAndUpdate.mockResolvedValue({ _id: 'r-1' });
    mockSendCampaignEmail.mockResolvedValue(true);

    const stats = await runEmailCampaignSweep();

    expect(mockSendCampaignEmail).toHaveBeenCalledTimes(1);
    expect(stats.campaignsProcessed).toBe(1);
  });

  it('continues an already-"sending" campaign from a previous tick without re-claiming it as a fresh start', async () => {
    seedEmailCampaigns([{ _id: 'campaign-3', organizationId: 'org-1', status: 'sending', subject: 's', greetingText: 'g', bodyText: 'b' }]);
    mockEmailCampaignFindOneAndUpdate.mockResolvedValue(null);
    mockEmailCampaignFindOne.mockResolvedValue({ _id: 'campaign-3', status: 'sending' });
    mockEmailRecipientFind
      .mockReturnValueOnce(chainable([])) // stale-processing reclaim pass
      .mockReturnValueOnce(chainable([{ _id: 'r-2', email: 'alex@example.com', customerName: 'Alex' }]));
    mockEmailRecipientFindOneAndUpdate.mockResolvedValue({ _id: 'r-2' });
    mockSendCampaignEmail.mockResolvedValue(true);

    await runEmailCampaignSweep();

    expect(mockEmailCampaignFindOne).toHaveBeenCalledWith({ _id: 'campaign-3', status: 'sending' });
    expect(mockSendCampaignEmail).toHaveBeenCalledTimes(1);
  });
});
