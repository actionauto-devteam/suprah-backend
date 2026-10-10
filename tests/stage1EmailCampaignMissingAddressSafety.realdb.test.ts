const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

jest.mock('../src/utils/sendingWindow', () => ({
  isWithinSendingHours: () => true,
}));

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import MarketingContact from '../src/models/MarketingContact.model';
import EmailCampaign from '../src/models/EmailCampaign.model';
import EmailCampaignRecipient from '../src/models/EmailCampaignRecipient.model';
import tokenService from '../src/services/token.service';
import request from 'supertest';
import app from '../src/server';
import { runEmailCampaignSweep } from '../src/schedulers/emailCampaign.scheduler';

async function makeOrgAndAdmin(label: string) {
  const org = await Organization.create({
    name: `${label} Org`,
    slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    status: 'active',
    metadata: { physicalMailingAddress: '123 Stage1 Safety St, Salt Lake City, UT 84101' },
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
  const token = tokenService.generateAccessToken(user as any);
  return { org, user, token };
}

describe('Stage 1 QA: scheduler safety when mailing address is removed after campaign creation (real-DB, one-time sweep only)', () => {
  jest.setTimeout(30000);

  let org: any;
  let admin: any;
  let token: string;
  let campaignId: string;
  let recipientId: string;

  beforeAll(async () => {
    ({ org, user: admin, token } = await makeOrgAndAdmin('Stage1Safety'));

    const contact = await MarketingContact.create({
      organizationId: String(org._id),
      email: `stage1-safety-contact-${Date.now()}@example.com`,
      firstName: 'Safety',
      lastName: 'Test',
      source: 'Stage1 QA Test',
      consentStatus: 'documented',
      importLabel: 'Stage1 Safety Batch',
      importedBy: admin._id,
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Stage1 Safety Campaign',
        subject: 'Test',
        greetingText: 'Hi {firstName},',
        bodyText: 'Synthetic QA body',
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(contact._id)],
      })
      .expect(201);

    campaignId = res.body.data.campaign._id;

    const recipient = await EmailCampaignRecipient.findOne({ campaignId }).lean();
    recipientId = String((recipient as any)._id);

    await Organization.updateOne({ _id: org._id }, { $set: { 'metadata.physicalMailingAddress': '' } });
  });

  afterAll(async () => {
    await EmailCampaignRecipient.deleteMany({ campaignId });
    await EmailCampaign.deleteMany({ _id: campaignId });
    await MarketingContact.deleteMany({ organizationId: String(org._id) });
    await User.deleteMany({ _id: admin._id });
    await Organization.deleteMany({ _id: org._id });
  });

  it('marks the recipient failed (never sent) with a clear reason when the address disappears after creation', async () => {
    const stats = await runEmailCampaignSweep();
    expect(stats.campaignsProcessed).toBeGreaterThanOrEqual(1);

    const recipient = await EmailCampaignRecipient.findById(recipientId).lean();
    expect((recipient as any).status).toBe('failed');
    expect((recipient as any).failureReason).toMatch(/mailing address/i);

    const campaign = await EmailCampaign.findById(campaignId).lean();
    expect((campaign as any).sentCount).toBe(0);
    expect((campaign as any).failedCount).toBe(1);

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('does not retry the failed recipient on a second sweep (no uncontrolled retry loop)', async () => {
    const before = await EmailCampaign.findById(campaignId).lean();
    const stats = await runEmailCampaignSweep();
    const after = await EmailCampaign.findById(campaignId).lean();

    expect((after as any).failedCount).toBe((before as any).failedCount);
    expect((after as any).sentCount).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
    void stats;
  });

  it('never throws/crashes the sweep itself', async () => {
    await expect(runEmailCampaignSweep()).resolves.toBeDefined();
  });
});
