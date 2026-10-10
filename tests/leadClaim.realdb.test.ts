import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import CustomerIdentityLock from '../src/models/CustomerIdentityLock.model';
import { Conversation } from '../src/models/communication.model';
import { getOrCreateConversation, findOrCreateLeadForContact } from '../src/services/communication.service';

describe('Real-DB proof: findOrCreateLeadForContact never creates two Leads for the same new contact', () => {
  let testOrg: any;
  let testUser: any;

  beforeAll(async () => {
    jest.setTimeout(30000);
    testOrg = await Organization.create({
      name: 'Stage 36 Real-DB Test Org',
      slug: 'stage36-realdb-' + Date.now(),
      status: 'active',
    });
    testUser = await User.create({
      email: `stage36-admin-${Date.now()}@example.com`,
      role: 'admin',
      organizationId: testOrg._id,
      password: 'Password123!',
      name: 'Stage 36 Admin',
    });
  });

  afterAll(async () => {
    if (testOrg) {
      await Lead.deleteMany({ organizationId: testOrg._id });
      await Customer.deleteMany({ organizationId: String(testOrg._id) });
      await CustomerIdentityLock.deleteMany({ organizationId: String(testOrg._id) });
      await Conversation.deleteMany({ orgId: testOrg._id });
      await User.deleteOne({ _id: testUser?._id });
      await Organization.deleteOne({ _id: testOrg._id });
    }
  });

  it('two simultaneous findOrCreateLeadForContact calls for the same brand-new phone number create exactly one Lead', async () => {
    const phone = '+18015550' + Math.floor(1000 + Math.random() * 8999);
    const conversation = await getOrCreateConversation({ orgId: testOrg._id, phone });

    const attempt = () =>
      findOrCreateLeadForContact({
        orgId: testOrg._id,
        conversation,
        existingLead: null,
        phone,
        customer: null,
        channel: 'sms',
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(String(first.lead?._id)).toBe(String(second.lead?._id));

    const leadCount = await Lead.countDocuments({ organizationId: testOrg._id, phone });
    expect(leadCount).toBe(1);

    const freshConversation: any = await Conversation.findById(conversation._id).lean();
    expect(String(freshConversation.leadId)).toBe(String(first.lead?._id));
  });

  it('a call and an SMS racing for the same brand-new number converge on the same one Lead (cross-channel)', async () => {
    const phone = '+18015551' + Math.floor(1000 + Math.random() * 8999);

    const smsConversation = await getOrCreateConversation({ orgId: testOrg._id, phone });
    const callConversation = await getOrCreateConversation({ orgId: testOrg._id, phone });
    expect(String(smsConversation._id)).toBe(String(callConversation._id));

    const [smsResult, callResult] = await Promise.all([
      findOrCreateLeadForContact({
        orgId: testOrg._id,
        conversation: smsConversation,
        existingLead: null,
        phone,
        customer: null,
        channel: 'sms',
      }),
      findOrCreateLeadForContact({
        orgId: testOrg._id,
        conversation: callConversation,
        existingLead: null,
        phone,
        customer: null,
        channel: 'phone',
      }),
    ]);

    expect([smsResult.created, callResult.created].filter(Boolean)).toHaveLength(1);
    expect(String(smsResult.lead?._id)).toBe(String(callResult.lead?._id));

    const leadCount = await Lead.countDocuments({ organizationId: testOrg._id, phone });
    expect(leadCount).toBe(1);
  });

  it('an already-matched existing Lead is reused, never duplicated', async () => {
    const phone = '+18015552' + Math.floor(1000 + Math.random() * 8999);
    const existingLead = await Lead.create({
      organizationId: testOrg._id,
      createdBy: testUser._id,
      firstName: 'Pre',
      lastName: 'Existing',
      phone,
      channel: 'web',
      source: 'Website Chat',
      status: 'New',
    });
    const conversation = await getOrCreateConversation({ orgId: testOrg._id, phone, leadId: existingLead._id });

    const result = await findOrCreateLeadForContact({
      orgId: testOrg._id,
      conversation,
      existingLead,
      phone,
      customer: null,
      channel: 'sms',
    });

    expect(result.created).toBe(false);
    expect(String(result.lead._id)).toBe(String(existingLead._id));

    const leadCount = await Lead.countDocuments({ organizationId: testOrg._id, phone });
    expect(leadCount).toBe(1);
  });
});
