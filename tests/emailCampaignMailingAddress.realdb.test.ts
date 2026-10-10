const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

import request from 'supertest';
import app from '../src/server';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import MarketingContact from '../src/models/MarketingContact.model';
import EmailCampaign from '../src/models/EmailCampaign.model';
import EmailCampaignRecipient from '../src/models/EmailCampaignRecipient.model';
import tokenService from '../src/services/token.service';
import emailService from '../src/services/email.service';

const TEST_ADDRESS = '123 Main St, Salt Lake City, UT 84101';

async function makeOrgAndAdmin(label: string, metadata: Record<string, unknown> = {}) {
  const org = await Organization.create({
    name: `${label} Org`,
    slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    status: 'active',
    metadata,
  });
  const user = await User.create({
    email: `${label.toLowerCase().replace(/\s+/g, '-')}-admin-${Date.now()}@example.com`,
    password: 'Password123!',
    name: `${label} Admin`,
    role: 'admin',
    organizationId: org._id,
    organizationRole: 'admin',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  const token = tokenService.generateAccessToken(user);
  return { org, user, token };
}

describe('Email Campaign physical mailing address requirement (real-DB)', () => {
  jest.setTimeout(30000);

  let noAddressOrg: any;
  let noAddressAdmin: any;
  let noAddressToken: string;
  let withAddressOrg: any;
  let withAddressAdmin: any;
  let withAddressToken: string;

  const campaignIds: any[] = [];

  beforeAll(async () => {
    ({ org: noAddressOrg, user: noAddressAdmin, token: noAddressToken } = await makeOrgAndAdmin('NoAddr5', {}));
    ({ org: withAddressOrg, user: withAddressAdmin, token: withAddressToken } = await makeOrgAndAdmin('WithAddr5', {
      physicalMailingAddress: TEST_ADDRESS,
      aiAgentName: 'Alex',
    }));
  });

  afterAll(async () => {
    await EmailCampaignRecipient.deleteMany({ campaignId: { $in: campaignIds } });
    await EmailCampaign.deleteMany({ _id: { $in: campaignIds } });
    await Lead.deleteMany({ organizationId: { $in: [noAddressOrg._id, withAddressOrg._id] } });
    await MarketingContact.deleteMany({ organizationId: { $in: [String(noAddressOrg._id), String(withAddressOrg._id)] } });
    await User.deleteMany({ _id: { $in: [noAddressAdmin._id, withAddressAdmin._id] } });
    await Organization.deleteMany({ _id: { $in: [noAddressOrg._id, withAddressOrg._id] } });
  });

  beforeEach(() => {
    sendMailMock.mockClear();
  });

  const basePayload = {
    name: 'Mailing Address Test Campaign',
    subject: 'Test Subject',
    greetingText: 'Hi {firstName},',
    bodyText: 'This is a synthetic test campaign body.',
  };

  it('blocks Lead-status campaign creation when no mailing address is configured', async () => {
    await Lead.create({
      firstName: 'No',
      lastName: 'Address',
      email: `no-address-lead-${Date.now()}@example.com`,
      phone: '+18015550111',
      organizationId: noAddressOrg._id,
      createdBy: noAddressAdmin._id,
      source: 'Manual Entry',
      channel: 'web',
      status: 'New',
      vehicle: {},
      comments: '',
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${noAddressToken}`)
      .send({ ...basePayload, statuses: ['New'] })
      .expect(400);

    expect(res.body.message).toMatch(/mailing address/i);
  });

  it('blocks Marketing Contacts campaign creation when no mailing address is configured', async () => {
    const contact = await MarketingContact.create({
      organizationId: String(noAddressOrg._id),
      email: `no-address-contact-${Date.now()}@example.com`,
      source: 'Synthetic Test',
      consentStatus: 'documented',
      importLabel: 'Phase 5 Test',
      importedBy: noAddressAdmin._id,
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${noAddressToken}`)
      .send({ ...basePayload, audienceSource: 'marketingContacts', marketingContactIds: [String(contact._id)] })
      .expect(400);

    expect(res.body.message).toMatch(/mailing address/i);

    const campaignCount = await EmailCampaign.countDocuments({ organizationId: String(noAddressOrg._id) });
    expect(campaignCount).toBe(0);
  });

  it('allows Lead-status campaign creation once a mailing address is configured', async () => {
    await Lead.create({
      firstName: 'With',
      lastName: 'Address',
      email: `with-address-lead-${Date.now()}@example.com`,
      phone: '+18015550112',
      organizationId: withAddressOrg._id,
      createdBy: withAddressAdmin._id,
      source: 'Manual Entry',
      channel: 'web',
      status: 'New',
      vehicle: {},
      comments: '',
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${withAddressToken}`)
      .send({ ...basePayload, statuses: ['New'] })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.campaign.totalRecipients).toBe(1);
  });

  it('allows Marketing Contacts campaign creation once a mailing address is configured', async () => {
    const contact = await MarketingContact.create({
      organizationId: String(withAddressOrg._id),
      email: `with-address-contact-${Date.now()}@example.com`,
      source: 'Synthetic Test',
      consentStatus: 'documented',
      importLabel: 'Phase 5 Test',
      importedBy: withAddressAdmin._id,
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${withAddressToken}`)
      .send({ ...basePayload, audienceSource: 'marketingContacts', marketingContactIds: [String(contact._id)] })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.campaign.totalRecipients).toBe(1);
  });

  it('round-trips physicalMailingAddress through org-settings without wiping an unrelated existing field', async () => {
    const before = await request(app)
      .get('/api/crm/org-settings')
      .set('Authorization', `Bearer ${withAddressToken}`)
      .expect(200);
    expect(before.body.data.physicalMailingAddress).toBe(TEST_ADDRESS);
    expect(before.body.data.aiAgentName).toBe('Alex');

    const updated = await request(app)
      .patch('/api/crm/org-settings')
      .set('Authorization', `Bearer ${withAddressToken}`)
      .send({ physicalMailingAddress: '456 Second Ave, Provo, UT 84601' })
      .expect(200);

    expect(updated.body.data.physicalMailingAddress).toBe('456 Second Ave, Provo, UT 84601');
    expect(updated.body.data.aiAgentName).toBe('Alex');

    await request(app)
      .patch('/api/crm/org-settings')
      .set('Authorization', `Bearer ${withAddressToken}`)
      .send({ physicalMailingAddress: TEST_ADDRESS })
      .expect(200);
  });

  it('sendCampaignEmail throws and never attempts an actual send when the address is missing', async () => {
    await expect(
      emailService.sendCampaignEmail({
        to: 'blocked-recipient@example.com',
        subject: 'Subject',
        greetingText: 'Hi {firstName},',
        bodyText: 'Body text',
        organizationId: String(noAddressOrg._id),
      }),
    ).rejects.toThrow(/mailing address/i);

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('sendCampaignEmail includes the configured address and preserves the existing unsubscribe link', async () => {
    const delivered = await emailService.sendCampaignEmail({
      to: 'allowed-recipient@example.com',
      customerName: 'Jordan',
      subject: 'Subject',
      greetingText: 'Hi {firstName},',
      bodyText: 'Body text',
      organizationId: String(withAddressOrg._id),
    });

    expect(delivered).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const [mailOptions] = sendMailMock.mock.calls[0];
    expect(mailOptions.html).toContain(TEST_ADDRESS);
    expect(mailOptions.text).toContain(TEST_ADDRESS);
    expect(mailOptions.html).toContain('Unsubscribe from automated emails');
    expect(mailOptions.text).toContain('Unsubscribe from automated emails');
  });
});
