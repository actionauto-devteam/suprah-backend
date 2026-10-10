import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import MarketingContact from '../src/models/MarketingContact.model';
import EmailOptOut from '../src/models/EmailOptOut.model';
import EmailCampaign from '../src/models/EmailCampaign.model';
import EmailCampaignRecipient from '../src/models/EmailCampaignRecipient.model';
import tokenService from '../src/services/token.service';

async function makeOrgAndAdmin(label: string) {
  const org = await Organization.create({
    name: `${label} Org`,
    slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    status: 'active',
    metadata: { physicalMailingAddress: '123 Main St, Salt Lake City, UT 84101' },
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

async function makeContact(orgId: string, importedBy: any, overrides: Partial<any> = {}) {
  return MarketingContact.create({
    organizationId: orgId,
    email: overrides.email || `contact-${new mongoose.Types.ObjectId()}@example.com`,
    firstName: 'Synthetic',
    lastName: 'Contact',
    source: 'Synthetic Test',
    consentStatus: 'documented',
    importLabel: 'Phase 4 Test Batch',
    importedBy,
    ...overrides,
  });
}

describe('Email Campaign creation with Marketing Contacts audience source (real-DB)', () => {
  jest.setTimeout(30000);

  let org: any;
  let adminUser: any;
  let adminToken: string;
  let otherOrg: any;
  let otherAdminToken: string;

  const campaignIds: any[] = [];

  beforeAll(async () => {
    ({ org, user: adminUser, token: adminToken } = await makeOrgAndAdmin('Phase4Campaign'));
    ({ org: otherOrg, token: otherAdminToken } = await makeOrgAndAdmin('Phase4CampaignOther'));
  });

  afterAll(async () => {
    await EmailCampaignRecipient.deleteMany({ campaignId: { $in: campaignIds } });
    await EmailCampaign.deleteMany({ _id: { $in: campaignIds } });
    await MarketingContact.deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await EmailOptOut.deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await Lead.deleteMany({ organizationId: { $in: [org._id, otherOrg._id] } });
    await User.deleteOne({ _id: adminUser._id });
    await Organization.deleteMany({ _id: { $in: [org._id, otherOrg._id] } });
  });

  const basePayload = {
    name: 'Phase 4 Test Campaign',
    subject: 'Test Subject',
    greetingText: 'Hi {firstName},',
    bodyText: 'This is a synthetic test campaign body.',
  };

  it('preserves the existing Lead-based audience path unchanged', async () => {
    const lead = await Lead.create({
      firstName: 'Lead',
      lastName: 'Based',
      email: `lead-based-${Date.now()}@example.com`,
      phone: '+18015550199',
      organizationId: org._id,
      createdBy: adminUser._id,
      source: 'Manual Entry',
      channel: 'web',
      status: 'New',
      vehicle: {},
      comments: '',
    });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...basePayload, statuses: ['New'] })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.campaign.totalRecipients).toBe(1);
    expect(res.body.data.selection).toBeUndefined();

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(1);
    expect(String(recipients[0].leadId)).toBe(String(lead._id));
    expect(recipients[0].marketingContactId).toBeUndefined();
  });

  it('creates a campaign from selected, eligible Marketing Contacts', async () => {
    const contactA = await makeContact(String(org._id), adminUser._id);
    const contactB = await makeContact(String(org._id), adminUser._id);

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(contactA._id), String(contactB._id)],
      })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.campaign.totalRecipients).toBe(2);
    expect(res.body.data.selection).toMatchObject({
      requested: 2,
      notFoundOrWrongOrg: 0,
      excludedConsentNotEligible: 0,
      excludedSuppressed: 0,
      included: 2,
    });

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(2);
    expect(recipients.every((r: any) => r.marketingContactId)).toBe(true);
    expect(recipients.every((r: any) => !r.leadId)).toBe(true);
  });

  it('excludes contact IDs belonging to a different organization', async () => {
    const ownContact = await makeContact(String(org._id), adminUser._id);
    const otherOrgContact = await makeContact(String(otherOrg._id), adminUser._id);

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(ownContact._id), String(otherOrgContact._id)],
      })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.selection).toMatchObject({ requested: 2, notFoundOrWrongOrg: 1, included: 1 });

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(1);
    expect(String(recipients[0].marketingContactId)).toBe(String(ownContact._id));
  });

  it('treats a nonexistent ID and a duplicate ID safely (excluded and de-duplicated respectively)', async () => {
    const contact = await makeContact(String(org._id), adminUser._id);
    const fakeId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(contact._id), String(contact._id), fakeId],
      })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.selection).toMatchObject({ requested: 2, notFoundOrWrongOrg: 1, included: 1 });

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(1);
  });

  it('excludes unknown/claimed_verbal consent contacts even when explicitly selected, and reports why', async () => {
    const unknownContact = await makeContact(String(org._id), adminUser._id, { consentStatus: 'unknown' });
    const verbalContact = await makeContact(String(org._id), adminUser._id, { consentStatus: 'claimed_verbal' });
    const documentedContact = await makeContact(String(org._id), adminUser._id, { consentStatus: 'documented' });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(unknownContact._id), String(verbalContact._id), String(documentedContact._id)],
      })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.selection).toMatchObject({ requested: 3, excludedConsentNotEligible: 2, included: 1 });

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(1);
    expect(String(recipients[0].marketingContactId)).toBe(String(documentedContact._id));
  });

  it('rejects a campaign where every selected contact is consent-ineligible', async () => {
    const unknownContact = await makeContact(String(org._id), adminUser._id, { consentStatus: 'unknown' });

    await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(unknownContact._id)],
      })
      .expect(400);
  });

  it('excludes a documented but suppressed contact', async () => {
    const suppressedEmail = `suppressed-campaign-${Date.now()}@example.com`;
    const contact = await makeContact(String(org._id), adminUser._id, { email: suppressedEmail });
    await EmailOptOut.create({ organizationId: String(org._id), email: suppressedEmail, optedOut: true });

    const otherContact = await makeContact(String(org._id), adminUser._id);

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...basePayload,
        audienceSource: 'marketingContacts',
        marketingContactIds: [String(contact._id), String(otherContact._id)],
      })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    expect(res.body.data.selection).toMatchObject({ excludedSuppressed: 1, included: 1 });

    const recipients = await EmailCampaignRecipient.find({ campaignId: res.body.data.campaign._id }).lean();
    expect(recipients).toHaveLength(1);
    expect(recipients[0].email).toBe(otherContact.email);
  });

  it('enforces the 500-recipient cap on the number of selected contact IDs', async () => {
    const tooMany = Array.from({ length: 501 }, () => new mongoose.Types.ObjectId().toString());

    await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...basePayload, audienceSource: 'marketingContacts', marketingContactIds: tooMany })
      .expect(400);
  });

  it('treats campaign recipients as a fixed snapshot: a later import under the same label does not expand the campaign', async () => {
    const contact = await makeContact(String(org._id), adminUser._id, { importLabel: 'Snapshot Batch' });

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...basePayload, audienceSource: 'marketingContacts', marketingContactIds: [String(contact._id)] })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    const campaignId = res.body.data.campaign._id;

    await makeContact(String(org._id), adminUser._id, { importLabel: 'Snapshot Batch' });
    await makeContact(String(org._id), adminUser._id, { importLabel: 'Snapshot Batch' });

    const campaignAfter = await EmailCampaign.findById(campaignId).lean();
    const recipientsAfter = await EmailCampaignRecipient.find({ campaignId }).lean();
    expect((campaignAfter as any)?.totalRecipients).toBe(1);
    expect(recipientsAfter).toHaveLength(1);
  });

  it('deleting a MarketingContact after campaign creation does not remove or corrupt its EmailCampaignRecipient snapshot', async () => {
    const contact = await makeContact(String(org._id), adminUser._id);

    const res = await request(app)
      .post('/api/crm/email-campaigns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...basePayload, audienceSource: 'marketingContacts', marketingContactIds: [String(contact._id)] })
      .expect(201);

    campaignIds.push(res.body.data.campaign._id);
    const campaignId = res.body.data.campaign._id;
    const contactEmail = contact.email;

    await request(app)
      .delete(`/api/crm/marketing-contacts/${contact._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const recipient = await EmailCampaignRecipient.findOne({ campaignId }).lean();
    expect(recipient).not.toBeNull();
    expect((recipient as any)?.email).toBe(contactEmail);
    expect((recipient as any)?.status).toBe('pending');

    const contactStillExists = await MarketingContact.findById(contact._id);
    expect(contactStillExists).toBeNull();
  });
});
