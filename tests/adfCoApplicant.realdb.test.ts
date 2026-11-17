jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: jest.fn(),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/services/leadIntakeIntegration', () => ({
  ...jest.requireActual('../src/services/leadIntakeIntegration'),
  startNewLeadAutomations: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import { processGmailMessageThroughIntake } from '../src/services/gmailLeadIntake';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const owner = new mongoose.Types.ObjectId();
const LEAD_SOURCE = 'leads@dealer-feed.example.com';
let serial = 0;

const person = (name: string, email: string, phone: string) => `<contact>
        <name part="full">${name}</name>
        <email>${email}</email>
        <phone type="voice">${phone}</phone>
        <address><street>12 Test Way</street><city>Orem</city><regioncode>UT</regioncode><postalcode>84057</postalcode></address>
      </contact>`;

const leadEmail = (people: string[]) => `Credit application\n\n<?xml version="1.0"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <requestdate>2026-11-16T18:08:00-07:00</requestdate>
    <vehicle interest="buy" status="used"><id sequence="1">ST-${++serial}</id><year>2020</year><make>TOYOTA</make><model>TACOMA</model></vehicle>
    <customer>
      ${people.join('\n      <comments>Applicant</comments>\n      ')}
      <comments>Applicant</comments>
    </customer>
    <vendor><name part="full">Test Motors Orem</name></vendor>
    <provider><name part="full">Credit Application</name></provider>
  </prospect>
</adf>`;

const gmailMessage = () => ({
  id: `gm-${new mongoose.Types.ObjectId()}`,
  threadId: `th-${new mongoose.Types.ObjectId()}`,
  internalDate: String(Date.now()),
  payload: { headers: [{ name: 'Subject', value: 'Credit Application lead for 2020 TOYOTA TACOMA' }, { name: 'From', value: `Dealer Feed <${LEAD_SOURCE}>` }] },
});

const receive = (rawBody: string) => processGmailMessageThroughIntake({
  organizationId: ORG,
  message: gmailMessage(),
  rawBody,
  leadSourceEmail: LEAD_SOURCE,
  systemUserId: String(owner),
  allowNewInquiry: true,
});

describe('Real-DB: two-person ADF leads keep the applicant contact (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), Customer.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Co-applicant Dealer', slug: `coapp-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: owner, name: 'Olivia Owner', email: `coapp-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    clearLeadIntakeModeCache(ORG);
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('opens the lead under the applicant with their phone and email, and lists the co-applicant', async () => {
    const result: any = await receive(leadEmail([
      person('Sam Rivera', 'sam.rivera@example.com', '801-555-0101'),
      person('Alex Moreno', 'alex.moreno@example.com', '801-555-0102'),
    ]));
    expect(result).toMatchObject({ status: 'associated', created: true });
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', email: 'sam.rivera@example.com', phone: '801-555-0101', channel: 'adf' });
    expect(lead.normalizedPhone).toBeTruthy();
    expect(lead.normalizedEmail).toBe('sam.rivera@example.com');
    expect(lead.parsedContent).toContain('Name: Sam Rivera');
    expect(lead.parsedContent).toContain('— Co-applicant —\nName: Alex Moreno');
    expect(lead.parsedContent).not.toContain('Unknown');
    const inquiry: any = await LeadInquiry.findById(result.inquiryId).lean();
    expect(inquiry.contact).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', phone: '801-555-0101', email: 'sam.rivera@example.com' });
  });

  it('adds a second application from the same applicant to their existing lead instead of opening an "Unknown" lead', async () => {
    const first: any = await receive(leadEmail([
      person('Jordan Price', 'jordan.price@example.com', '801-555-0201'),
      person('Casey Lane', 'casey.lane@example.com', '801-555-0202'),
    ]));
    const second: any = await receive(leadEmail([
      person('Jordan Price', 'jordan.price@example.com', '801-555-0201'),
      person('Casey Lane', 'casey.lane@example.com', '801-555-0202'),
    ]));
    expect(first).toMatchObject({ status: 'associated', created: true });
    expect(second.status).not.toBe('inactive');
    expect(await Lead.countDocuments({ organizationId: orgId, firstName: 'Unknown' })).toBe(0);
    expect(await Lead.countDocuments({ organizationId: orgId, normalizedEmail: 'jordan.price@example.com' })).toBe(1);
  });

  it('still opens one-person leads as before', async () => {
    const result: any = await receive(leadEmail([person('Riley Stone', 'riley.stone@example.com', '801-555-0301')]));
    expect(result).toMatchObject({ status: 'associated', created: true });
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead).toMatchObject({ firstName: 'Riley', lastName: 'Stone', phone: '801-555-0301' });
    expect(lead.parsedContent).not.toContain('Co-applicant');
  });
});
