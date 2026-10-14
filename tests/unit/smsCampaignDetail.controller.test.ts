const mockSmsCampaignFindOne = jest.fn();
const mockRecipientFind = jest.fn();
const mockRecipientAggregate = jest.fn();

jest.mock('../../src/models/SmsCampaign.model', () => ({
  __esModule: true,
  default: { findOne: mockSmsCampaignFindOne },
}));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({
  __esModule: true,
  default: { find: mockRecipientFind, aggregate: mockRecipientAggregate },
}));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: {} }));

import { getCampaign } from '../../src/controllers/smsCampaign.controller';

function selectLimitLean(value: unknown) {
  return { select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })) })) };
}

describe('smsCampaign.controller — getCampaign delivery status breakdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSmsCampaignFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'campaign-1', organizationId: 'org-1', name: 'Test' }) });
    mockRecipientFind.mockReturnValue(selectLimitLean([]));
    mockRecipientAggregate.mockResolvedValue([]);
  });

  it('maps aggregate rows into a deliveryStatusCounts object, defaulting a null deliveryStatus to "accepted"', async () => {
    mockRecipientAggregate.mockResolvedValue([
      { _id: 'delivered', count: 8 },
      { _id: 'delivery_failed', count: 1 },
      { _id: null, count: 3 },
    ]);

    const req = { params: { id: 'campaign-1' }, orgId: 'org-1' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCampaign(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    const response = json.mock.calls[0][0];
    expect(response.data.deliveryStatusCounts).toEqual({ delivered: 8, delivery_failed: 1, accepted: 3 });
    expect(mockRecipientAggregate).toHaveBeenCalledWith([
      { $match: { campaignId: 'campaign-1', status: 'sent' } },
      { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
    ]);
  });

  it('returns an empty deliveryStatusCounts object when nothing has sent yet', async () => {
    const req = { params: { id: 'campaign-1' }, orgId: 'org-1' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCampaign(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const response = json.mock.calls[0][0];
    expect(response.data.deliveryStatusCounts).toEqual({});
  });
});
