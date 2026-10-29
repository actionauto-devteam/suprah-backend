const mockSendSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import { submitLeadInquiry } from '../src/services/leadIntake.service';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { resolveContactRestriction } from '../src/services/contactRestriction.service';
import { syncLeadCustomerSafely } from '../src/services/customerIdentity.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const owner = new mongoose.Types.ObjectId();
let serial = 0;
const nextPhone = () => `+1801555${String(4000 + (++serial)).slice(-4)}`;

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Third-Party Lead', channel: 'adf', status: 'New', isRead: true, ...extra,
  });
}

const inquiry = (contact: { phone?: string; email?: string }) => ({
  organizationId: ORG,
  kind: 'provider_inquiry',
  receivedAt: new Date(),
  channel: 'adf',
  source: 'Third-Party Lead',
  contact: { firstName: 'Sam', lastName: 'Cruz', ...contact },
  comments: 'Is it available?',
  sourceIds: { providerInquiryKey: `test:${new mongoose.Types.ObjectId()}` },
}) as any;

describe('Real-DB: fake contact details never join different customers (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), Customer.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Placeholder Dealer', slug: `placeholder-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: owner, name: 'Olivia Owner', email: `placeholder-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    clearLeadIntakeModeCache(ORG);
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('opens a new lead when the only shared detail is a fake email', async () => {
    const existing = await makeLead({ email: 'none@none.com', phone: nextPhone() });
    const result: any = await submitLeadInquiry(inquiry({ email: 'none@none.com', phone: nextPhone() }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'no_matching_lead' });
    expect(result.leadId).not.toBe(String(existing._id));
  });

  it('opens a new lead when the only shared detail is a fake phone', async () => {
    const existing = await makeLead({ email: `real${++serial}@example.com`, phone: '888-888-8888' });
    const result: any = await submitLeadInquiry(inquiry({ email: `other${++serial}@example.com`, phone: '888-888-8888' }));
    expect(result).toMatchObject({ status: 'associated', created: true });
    expect(result.leadId).not.toBe(String(existing._id));
  });

  it('still joins the open lead through a real shared detail', async () => {
    const phone = nextPhone();
    const existing = await makeLead({ email: 'noemail@gmail.com', phone });
    const result: any = await submitLeadInquiry(inquiry({ email: 'none@none.com', phone }));
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(existing._id) });
  });

  it('never links different people to one customer record through a fake email', async () => {
    const first = await makeLead({ email: 'none@none.com', phone: nextPhone() }, { firstName: 'Ana' });
    const second = await makeLead({ email: 'none@none.com', phone: nextPhone() }, { firstName: 'Ben' });
    await syncLeadCustomerSafely(ORG, String(first._id));
    await syncLeadCustomerSafely(ORG, String(second._id));
    const [a, b]: any[] = await Promise.all([Lead.findById(first._id).lean(), Lead.findById(second._id).lean()]);
    expect(a.normalizedEmail ?? null).toBeNull();
    expect(b.normalizedEmail ?? null).toBeNull();
    if (a.customerId && b.customerId) expect(String(a.customerId)).not.toBe(String(b.customerId));
    expect(await Customer.countDocuments({ organizationId: orgId, normalizedEmail: 'none@none.com' })).toBe(0);
  });

  it('does not block other customers because a Do Not Contact lead used a fake email', async () => {
    const blockedPhone = nextPhone();
    await makeLead({ email: 'none@none.com', phone: blockedPhone }, { status: 'Do Not Contact' });
    const other = await resolveContactRestriction({ organizationId: ORG, email: 'none@none.com', phone: nextPhone() });
    expect(other).toEqual({ status: 'allowed' });
    const samePhone = await resolveContactRestriction({ organizationId: ORG, email: 'none@none.com', phone: blockedPhone });
    expect(samePhone.status).toBe('restricted');
  });
});
