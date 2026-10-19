const mockLeadFind = jest.fn();
const mockLeadCountDocuments = jest.fn();
const mockLeadFindOne = jest.fn();
const mockRenderCampaignEmail = jest.fn();
const mockEmailCampaignCreate = jest.fn();
const mockEmailCampaignFindOneAndUpdate = jest.fn();
const mockRecipientInsertMany = jest.fn();
const mockOrgFindById = jest.fn();
const mockMarketingContactFind = jest.fn();
const mockMarketingContactCountDocuments = jest.fn();
const mockEmailOptOutFind = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind, countDocuments: mockLeadCountDocuments, findOne: mockLeadFindOne },
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
  default: { find: mockMarketingContactFind, countDocuments: mockMarketingContactCountDocuments },
}));
jest.mock('../../src/models/EmailOptOut.model', () => ({
  __esModule: true,
  default: { find: mockEmailOptOutFind },
}));

jest.mock('../../src/services/email.service', () => {
  const actual = jest.requireActual('../../src/services/email.service');
  return { __esModule: true, ...actual, default: { renderCampaignEmail: mockRenderCampaignEmail } };
});

import { createCampaign, previewCampaign, getAudienceCount } from '../../src/controllers/emailCampaign.controller';

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next };
}

function adminReq(body: Record<string, any>, extra: Record<string, any> = {}) {
  return { orgId: 'org-1', crmUser: { _id: 'user-1', role: 'admin', fullName: 'Admin User' }, body, params: {}, query: {}, ...extra };
}

function leadsResult(leads: any[]) {
  mockLeadFind.mockReturnValue({ select: jest.fn(() => ({ limit: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(leads) })) })) });
}

describe('email campaign personalization stored at creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgFindById.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ metadata: { physicalMailingAddress: '123 Main St' } }) })) });
    mockEmailCampaignCreate.mockResolvedValue({ _id: 'campaign-1' });
    mockRecipientInsertMany.mockResolvedValue([]);
    mockEmailOptOutFind.mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
  });

  it('stores the real first name for lead recipients, keeps multi-word first names, and uses there when missing or last-name only', async () => {
    mockLeadCountDocuments.mockResolvedValue(4);
    leadsResult([
      { _id: 'l1', firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com' },
      { _id: 'l2', firstName: 'Mary Ann', lastName: 'Cruz', email: 'mary@example.com' },
      { _id: 'l3', lastName: 'Narvaez', email: 'narvaez@example.com' },
      { _id: 'l4', email: 'blank@example.com' },
    ]);
    const { next } = await invoke(createCampaign, adminReq({ name: 'N', subject: 'Hi', greetingText: 'Hi {firstName},', bodyText: 'Body', statuses: [] }));
    expect(next).not.toHaveBeenCalled();
    const docs = mockRecipientInsertMany.mock.calls[0][0];
    expect(docs.map((d: any) => d.greetingName)).toEqual(['Jordan', 'Mary Ann', 'there', 'there']);
    expect(docs[2].customerName).toBe('Narvaez');
  });

  it('stores the real first name for marketing-contact recipients', async () => {
    mockMarketingContactFind.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue([
          { _id: 'mc-1', email: 'a@example.com', firstName: 'Ana Marie', consentStatus: 'documented' },
          { _id: 'mc-2', email: 'b@example.com', lastName: 'Only', consentStatus: 'documented' },
        ]),
      })),
    });
    const { next } = await invoke(createCampaign, adminReq({
      name: 'MC', subject: 'Hi', greetingText: 'Hi {firstName},', bodyText: 'Body',
      audienceSource: 'marketingContacts', marketingContactIds: ['mc-1', 'mc-2'],
    }));
    expect(next).not.toHaveBeenCalled();
    const docs = mockRecipientInsertMany.mock.calls[0][0];
    expect(docs.map((d: any) => d.greetingName)).toEqual(['Ana Marie', 'there']);
  });
});

describe('campaign preview endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRenderCampaignEmail.mockImplementation(async (input: any) => ({
      subject: input.subject, html: `<html>${input.bodyHtml || ''}</html>`, text: '', headers: {},
      greetingName: input.greetingName, imageCount: ((input.bodyHtml || '').match(/<img/g) || []).length + (input.bannerImageUrl ? 1 : 0),
      missingMailingAddress: false,
    }));
  });

  it('renders through the same email renderer, in preview mode, with sanitized HTML and the chosen recipient name', async () => {
    const { json, next } = await invoke(previewCampaign, adminReq({
      subject: 'Hi {firstName},', greetingText: 'Hi {firstName},', previewFirstName: 'Mary Ann',
      bannerImageUrl: 'https://cdn.example.com/banner.jpg',
      bodyHtml: '<p onclick="x()">Hello</p><img src="https://cdn.example.com/a.png"><script>alert(1)</script>',
    }));
    expect(next).not.toHaveBeenCalled();
    const [input, mode] = mockRenderCampaignEmail.mock.calls[0];
    expect(mode).toBe('preview');
    expect(input.greetingName).toBe('Mary Ann');
    expect(input.bodyHtml).not.toContain('onclick');
    expect(input.bodyHtml).not.toContain('<script');
    expect(input.bodyHtml).toContain('<img src="https://cdn.example.com/a.png"');
    const data = json.mock.calls[0][0].data;
    expect(data.images).toEqual({ inEditor: 2, inEmail: 2, removedBySanitizer: 0, notHttps: 0 });
  });

  it('reports images the sanitizer removed and images that are not https, so they are not confused with inbox image blocking', async () => {
    const { json } = await invoke(previewCampaign, adminReq({
      subject: 'S', greetingText: 'G',
      bodyHtml: '<p>x</p><img src="data:image/png;base64,AAAA"><img src="http://cdn.example.com/b.png">',
    }));
    const data = json.mock.calls[0][0].data;
    expect(data.images.removedBySanitizer).toBe(1);
    expect(data.images.notHttps).toBe(2);
    expect(data.images.inEmail).toBe(1);
  });

  it('uses there when no first name is chosen', async () => {
    await invoke(previewCampaign, adminReq({ subject: 'S', greetingText: 'Hi {firstName},', previewFirstName: '   ' }));
    expect(mockRenderCampaignEmail.mock.calls[0][0].greetingName).toBe('there');
  });

  it('is admin-only, like sending', async () => {
    const { next } = await invoke(previewCampaign, { orgId: 'org-1', crmUser: { _id: 'u2', role: 'employee' }, body: {} });
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(mockRenderCampaignEmail).not.toHaveBeenCalled();
  });
});

describe('audience count returns a real recipient to preview as', () => {
  it('includes the first matching lead name and email', async () => {
    jest.clearAllMocks();
    mockLeadCountDocuments.mockResolvedValue(3);
    mockLeadFindOne.mockReturnValue({ select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com' }) })) });
    const { json } = await invoke(getAudienceCount, { orgId: 'org-1', query: {} });
    expect(json.mock.calls[0][0].data.previewRecipient).toEqual({ firstName: 'Jordan', displayName: 'Jordan Lee', email: 'jordan@example.com' });
  });
});
