const mockLeadFind = jest.fn();
const mockLeadCountDocuments = jest.fn();
const mockEmailCampaignCreate = jest.fn();
const mockEmailCampaignFindOneAndUpdate = jest.fn();
const mockRecipientInsertMany = jest.fn();
const mockOrgFindById = jest.fn();
const mockMarketingContactFind = jest.fn();
const mockEmailOptOutFind = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind, countDocuments: mockLeadCountDocuments },
}));
jest.mock('../../src/models/EmailCampaign.model', () => ({
  __esModule: true,
  default: { create: mockEmailCampaignCreate, findOneAndUpdate: mockEmailCampaignFindOneAndUpdate },
}));
jest.mock('../../src/models/EmailCampaignRecipient.model', () => ({
  __esModule: true,
  default: { insertMany: mockRecipientInsertMany },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrgFindById },
}));
jest.mock('../../src/models/MarketingContact.model', () => ({
  __esModule: true,
  default: { find: mockMarketingContactFind },
}));
jest.mock('../../src/models/EmailOptOut.model', () => ({
  __esModule: true,
  default: { find: mockEmailOptOutFind },
}));

import { createCampaign, rescheduleCampaign } from '../../src/controllers/emailCampaign.controller';

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

describe('emailCampaign.controller — Phase 2 (scheduling + audience limit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgFindById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ metadata: { physicalMailingAddress: '123 Main St' } }) })) });
    mockLeadFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })) })) });
    mockLeadCountDocuments.mockResolvedValue(0);
    mockEmailCampaignCreate.mockResolvedValue({ _id: 'campaign-1' });
    mockRecipientInsertMany.mockResolvedValue([]);
  });

  describe('createCampaign (leadStatus audience) — no silent audience truncation', () => {
    it('rejects with an explicit error when the audience exceeds the 500-recipient safe limit, without creating a campaign', async () => {
      mockLeadCountDocuments.mockResolvedValue(812);
      const req = adminReq({
        name: 'Big blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body', statuses: [],
      });

      const { next } = await invoke(createCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('812');
      expect(err.message).toContain('500');
      expect(mockEmailCampaignCreate).not.toHaveBeenCalled();
    });

    it('proceeds normally when the audience is within the safe limit', async () => {
      mockLeadCountDocuments.mockResolvedValue(10);
      mockLeadFind.mockReturnValue({
        select: jest.fn(() => ({
          limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([{ _id: 'lead-1', firstName: 'Jamie', email: 'jamie@example.com' }]) })),
        })),
      });
      const req = adminReq({
        name: 'Small blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body', statuses: [],
      });

      const { json, next } = await invoke(createCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockEmailCampaignCreate).toHaveBeenCalled();
      expect(json).toHaveBeenCalled();
    });
  });

  describe('createCampaign (marketingContacts audience) — consent + permission-override recheck', () => {
    beforeEach(() => {
      mockEmailOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    });

    it('includes a documented-consent contact (baseline, unchanged behavior)', async () => {
      mockMarketingContactFind.mockReturnValue({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([
            { _id: 'mc-1', email: 'a@example.com', firstName: 'A', consentStatus: 'documented' },
          ]),
        })),
      });
      const req = adminReq({
        name: 'MC blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body',
        audienceSource: 'marketingContacts', marketingContactIds: ['mc-1'],
      });

      const { next, json } = await invoke(createCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockRecipientInsertMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ email: 'a@example.com' })]),
      );
      expect(json).toHaveBeenCalled();
    });

    it('excludes an unknown-consent contact with no permission override (the exact case the user hit live)', async () => {
      mockMarketingContactFind.mockReturnValue({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([
            { _id: 'mc-2', email: 'new@example.com', consentStatus: 'unknown' },
          ]),
        })),
      });
      const req = adminReq({
        name: 'MC blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body',
        audienceSource: 'marketingContacts', marketingContactIds: ['mc-2'],
      });

      const { next } = await invoke(createCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('consent not documented');
      expect(mockEmailCampaignCreate).not.toHaveBeenCalled();
    });

    it('includes an unknown-consent contact once an admin has set a permissionOverride', async () => {
      mockMarketingContactFind.mockReturnValue({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'mc-3', email: 'confirmed@example.com', consentStatus: 'unknown',
              permissionOverride: { confirmedBy: 'user-9', confirmedByName: 'Jordan', confirmedAt: new Date() },
            },
          ]),
        })),
      });
      const req = adminReq({
        name: 'MC blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body',
        audienceSource: 'marketingContacts', marketingContactIds: ['mc-3'],
      });

      const { next } = await invoke(createCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockRecipientInsertMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ email: 'confirmed@example.com' })]),
      );
    });

    it('still excludes a permission-overridden contact who has separately opted out — suppression always wins over an override', async () => {
      mockMarketingContactFind.mockReturnValue({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'mc-4', email: 'stopped@example.com', consentStatus: 'unknown',
              permissionOverride: { confirmedBy: 'user-9', confirmedByName: 'Jordan', confirmedAt: new Date() },
            },
          ]),
        })),
      });
      mockEmailOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['stopped@example.com']) });
      const req = adminReq({
        name: 'MC blast', subject: 'Hi', greetingText: 'Hi {firstName}', bodyText: 'Body',
        audienceSource: 'marketingContacts', marketingContactIds: ['mc-4'],
      });

      const { next } = await invoke(createCampaign, req);

      expect(next).toHaveBeenCalled();
      expect(next.mock.calls[0][0].statusCode).toBe(400);
      expect(mockEmailCampaignCreate).not.toHaveBeenCalled();
    });
  });

  describe('rescheduleCampaign', () => {
    it('reschedules a queued campaign to a new future time', async () => {
      mockEmailCampaignFindOneAndUpdate.mockResolvedValue({ _id: 'campaign-1', status: 'scheduled' });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const req = adminReq({ scheduledAt: future }, { id: 'campaign-1' });

      const { json, next } = await invoke(rescheduleCampaign, req);

      expect(next).not.toHaveBeenCalled();
      expect(mockEmailCampaignFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'campaign-1', organizationId: 'org-1', status: { $in: ['queued', 'scheduled'] } },
        { $set: { status: 'scheduled', scheduledAt: expect.any(Date) } },
        { new: true },
      );
      expect(json).toHaveBeenCalled();
    });

    it('rejects rescheduling a campaign that has already started sending', async () => {
      mockEmailCampaignFindOneAndUpdate.mockResolvedValue(null);
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const req = adminReq({ scheduledAt: future }, { id: 'campaign-1' });

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(404);
    });

    it('rejects a scheduledAt less than 30 seconds in the future', async () => {
      const soon = new Date(Date.now() + 1000).toISOString();
      const req = adminReq({ scheduledAt: soon }, { id: 'campaign-1' });

      const { next } = await invoke(rescheduleCampaign, req);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(mockEmailCampaignFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
