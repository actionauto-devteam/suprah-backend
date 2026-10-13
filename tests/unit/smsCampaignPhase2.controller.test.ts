const mockLeadFind = jest.fn();
const mockLeadCountDocuments = jest.fn();
const mockSmsCampaignCreate = jest.fn();
const mockSmsCampaignFindOneAndUpdate = jest.fn();
const mockRecipientInsertMany = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind, countDocuments: mockLeadCountDocuments },
}));
jest.mock('../../src/models/SmsCampaign.model', () => ({
  __esModule: true,
  default: { create: mockSmsCampaignCreate, findOneAndUpdate: mockSmsCampaignFindOneAndUpdate },
}));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({
  __esModule: true,
  default: { insertMany: mockRecipientInsertMany },
}));

import { createCampaign, rescheduleCampaign } from '../../src/controllers/smsCampaign.controller';

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next };
}

function adminReq(body: Record<string, any>, params: Record<string, any> = {}) {
  return {
    orgId: 'org-1',
    crmUser: { _id: 'user-1', role: 'admin', fullName: 'Admin User' },
    body,
    params,
  };
}

describe('smsCampaign.controller — Phase 2 (scheduling + audience limit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) })) });
    mockLeadCountDocuments.mockResolvedValue(0);
    mockSmsCampaignCreate.mockResolvedValue({ _id: 'campaign-1' });
    mockRecipientInsertMany.mockResolvedValue([]);
  });

  describe('createCampaign — no silent audience truncation', () => {
    it('rejects with an explicit error when the audience exceeds the 500-recipient safe limit, without creating a campaign', async () => {
      mockLeadCountDocuments.mockResolvedValue(734);
      const req = adminReq({ name: 'Big blast', message: 'Hi! Reply STOP to opt out.', statuses: [] });

      const { next } = await invoke(createCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('734');
      expect(err.message).toContain('500');
      expect(mockSmsCampaignCreate).not.toHaveBeenCalled();
    });

    it('proceeds normally when the audience is within the safe limit', async () => {
      mockLeadCountDocuments.mockResolvedValue(42);
      mockLeadFind.mockReturnValue({
        select: jest.fn(() => ({
          limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([{ _id: 'lead-1', firstName: 'Jamie', phone: '+13035550123' }]) })),
        })),
      });
      const req = adminReq({ name: 'Small blast', message: 'Hi! Reply STOP to opt out.', statuses: [] });

      const { json, next } = await invoke(createCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockSmsCampaignCreate).toHaveBeenCalled();
      expect(json).toHaveBeenCalled();
    });
  });

  describe('rescheduleCampaign', () => {
    it('reschedules a queued campaign to a new future time', async () => {
      mockSmsCampaignFindOneAndUpdate.mockResolvedValue({ _id: 'campaign-1', status: 'scheduled' });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const req = adminReq({ scheduledAt: future }, { id: 'campaign-1' });

      const { json, next } = await invoke(rescheduleCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockSmsCampaignFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'campaign-1', organizationId: 'org-1', status: { $in: ['queued', 'scheduled'] } },
        { $set: { status: 'scheduled', scheduledAt: expect.any(Date) } },
        { new: true },
      );
      expect(json).toHaveBeenCalled();
    });

    it('rejects rescheduling a campaign that has already started sending (atomic filter excludes it, returns 404)', async () => {
      mockSmsCampaignFindOneAndUpdate.mockResolvedValue(null);
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const req = adminReq({ scheduledAt: future }, { id: 'campaign-1' });

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain('already started sending');
    });

    it('rejects a scheduledAt less than 30 seconds in the future', async () => {
      const soon = new Date(Date.now() + 5000).toISOString();
      const req = adminReq({ scheduledAt: soon }, { id: 'campaign-1' });

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(mockSmsCampaignFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a missing scheduledAt', async () => {
      const req = adminReq({}, { id: 'campaign-1' });

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
    });

    it('rejects a non-admin user', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const req = {
        orgId: 'org-1',
        crmUser: { _id: 'user-1', role: 'employee' },
        body: { scheduledAt: future },
        params: { id: 'campaign-1' },
      };

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
      expect(mockSmsCampaignFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
