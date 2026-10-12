const mockEmailCampaignFind = jest.fn();
const mockEmailCampaignUpdateOne = jest.fn().mockResolvedValue({});
const mockRecipientFind = jest.fn();
const mockRecipientFindOneAndUpdate = jest.fn();
const mockRecipientUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const mockRecipientUpdateMany = jest.fn().mockResolvedValue({});
const mockRecipientCountDocuments = jest.fn().mockResolvedValue(0);
const mockSendCampaignEmail = jest.fn().mockResolvedValue(true);

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

/** Every sweep first runs the stale-processing reclaim query (EmailCampaignRecipient.find
 *  for status:'processing'), then the per-campaign pending-recipients query. Seeding an
 *  empty result for the first call keeps that reclaim pass a no-op for these tests, which
 *  are only exercising the normal claim-and-send path. */
function seedRecipientFind(pendingRecipients: any[]) {
  mockRecipientFind
    .mockReturnValueOnce(chainable([]))
    .mockReturnValueOnce(chainable(pendingRecipients));
}

describe('emailCampaign.scheduler — Marketing Contact recipient compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendCampaignEmail.mockResolvedValue(true);
    mockRecipientUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockRecipientUpdateMany.mockResolvedValue({});
    mockEmailCampaignUpdateOne.mockResolvedValue({});
    mockRecipientCountDocuments.mockResolvedValue(0);
  });

  it('processes a marketingContactId-sourced pending recipient identically to a leadId-sourced one', async () => {
    const campaign = {
      _id: 'campaign-1',
      organizationId: 'org-1',
      subject: 'Subject',
      greetingText: 'Hi {firstName},',
      bannerImageUrl: undefined,
      bodyText: 'Body',
      signOffText: undefined,
    };
    mockEmailCampaignFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([campaign]) }) }),
    });

    const recipient = {
      _id: 'recipient-1',
      email: 'marketing-contact@example.com',
      phone: undefined,
      customerName: 'Synthetic Contact',
      marketingContactId: 'mc-1',
      leadId: undefined,
    };
    seedRecipientFind([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);

    const stats = await runEmailCampaignSweep();

    expect(stats.campaignsProcessed).toBe(1);
    expect(mockSendCampaignEmail).toHaveBeenCalledTimes(1);
    expect(mockSendCampaignEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'marketing-contact@example.com',
        customerName: 'Synthetic Contact',
        organizationId: 'org-1',
      }),
    );
    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'recipient-1', status: 'processing' },
      { $set: { status: 'sent', sentAt: expect.any(Date) } },
    );
    expect(mockEmailCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { sentCount: 1 } });
  });

  it('claims a marketingContactId-sourced recipient into "processing" (not directly "sent") using the same atomic pending-status filter as a Lead-sourced one', async () => {
    const campaign = { _id: 'campaign-2', organizationId: 'org-1', subject: 's', greetingText: 'g', bodyText: 'b' };
    mockEmailCampaignFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([campaign]) }) }),
    });

    const recipient = { _id: 'recipient-2', email: 'another@example.com', customerName: 'X', marketingContactId: 'mc-2' };
    seedRecipientFind([recipient]);
    mockRecipientFindOneAndUpdate.mockResolvedValue(null);

    const stats = await runEmailCampaignSweep();

    expect(mockRecipientFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'recipient-2', status: 'pending' },
      { $set: { status: 'processing', processingStartedAt: expect.any(Date) }, $inc: { attemptCount: 1 } },
      { new: false },
    );
    expect(mockSendCampaignEmail).not.toHaveBeenCalled();
    expect(stats.campaignsProcessed).toBe(1);
  });
});
