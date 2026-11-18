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
import { resolveLeadReview } from '../src/services/leadIntakeReview.service';
import { getAllLeads, getLeadById } from '../src/controllers/lead.controller';
import { runLeadCustomerAreaBackfill } from '../src/services/leadCustomerAreaBackfill.service';

const orgId = new mongoose.Types.ObjectId();
const fillOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const owner = new mongoose.Types.ObjectId();
const LEAD_SOURCE = 'leads@dealer-feed.example.com';
const ADF_ADDRESS = '12 Test Way, Orem, UT, 84057';
let serial = 0;

const person = (name: string, email: string, phone: string, withAddress = true) => `<contact>
        <name part="full">${name}</name>
        <email>${email}</email>
        <phone type="voice">${phone}</phone>
        ${withAddress ? '<address><street>12 Test Way</street><city>Orem</city><regioncode>UT</regioncode><postalcode>84057</postalcode></address>' : ''}
      </contact>`;

const leadEmail = (people: string[]) => `Credit application\n\n<?xml version="1.0"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <requestdate>2026-11-16T18:08:00-07:00</requestdate>
    <vehicle interest="buy" status="used"><id sequence="1">CA-${++serial}</id><year>2020</year><make>TOYOTA</make><model>TACOMA</model></vehicle>
    <customer>
      ${people.join('\n      ')}
      <comments>Applicant ${serial}</comments>
    </customer>
    <vendor><name part="full">Test Motors Orem</name></vendor>
    <provider><name part="full">Credit Application</name></provider>
  </prospect>
</adf>`;

const receive = (rawBody: string) => processGmailMessageThroughIntake({
  organizationId: ORG,
  message: {
    id: `gm-${new mongoose.Types.ObjectId()}`,
    threadId: `th-${new mongoose.Types.ObjectId()}`,
    internalDate: String(Date.now()),
    payload: { headers: [{ name: 'Subject', value: 'Credit Application lead for 2020 TOYOTA TACOMA' }, { name: 'From', value: `Dealer Feed <${LEAD_SOURCE}>` }] },
  },
  rawBody,
  leadSourceEmail: LEAD_SOURCE,
  systemUserId: String(owner),
  allowNewInquiry: true,
});

const base = { organizationId: orgId, createdBy: owner, source: 'Manual Entry', channel: 'sms' as const };
const OLD = new Date('2026-09-01T15:00:00Z');
const stored = async (id: unknown) => (await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;

async function oldLead(fields: Record<string, unknown>) {
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({ _id, organizationId: orgId, createdBy: owner, status: 'New', source: 'Website', channel: 'sms', createdAt: OLD, updatedAt: OLD, ...fields } as any);
  return _id;
}

async function listed(query: Record<string, string> = {}) {
  let body: any = null;
  let statusCode = 200;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: any) { body = payload; return res; },
  };
  await getAllLeads({ orgId: ORG, query: { limit: '200', ...query } } as any, res);
  if (statusCode !== 200 || !Array.isArray(body?.data?.leads)) throw new Error(`Lead list failed with status ${statusCode}`);
  return body.data.leads as any[];
}

const ids = (rows: any[]) => rows.map((row) => String(row._id));
const codes = (rows: any[]) => [...new Set(rows.map((row) => row.customerArea?.code))];

describe('Real-DB: Customer area label on leads (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), Customer.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Area Dealer', slug: `area-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: owner, name: 'Olivia Owner', email: `area-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    clearLeadIntakeModeCache(ORG);
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('1. a new lead gets its area from the address when there is one, otherwise from the phone', async () => {
    const byPhone: any = await Lead.create({ ...base, firstName: 'Pia', lastName: 'Phone', phone: '801-555-0141' });
    expect(byPhone.customerArea).toMatchObject({ code: 'utah', basis: 'phone', detail: '801' });
    expect((await stored(byPhone._id)).customerArea).toEqual({ code: 'utah', basis: 'phone', detail: '801' });

    const byAddress: any = await Lead.create({ ...base, firstName: 'Ada', lastName: 'Address', phone: '949-555-0142', address: '55 S 700 E, St George, UT 84770' });
    expect((await stored(byAddress._id)).customerArea).toEqual({ code: 'southern_utah', basis: 'zip', detail: '84770' });

    const nothing: any = await Lead.create({ ...base, firstName: 'Nia', lastName: 'Nothing', email: 'nia.nothing@example.com' });
    expect((await stored(nothing._id)).customerArea).toBeUndefined();
  });

  it('2. editing the phone or the address updates the saved area and the lead that is returned', async () => {
    const lead: any = await Lead.create({ ...base, firstName: 'Eli', lastName: 'Edit', phone: '801-555-0143' });

    const withAddress: any = await Lead.findOneAndUpdate({ _id: lead._id }, { $set: { address: 'Reno, NV 89501' } }, { new: true });
    expect(withAddress.customerArea).toMatchObject({ code: 'out_of_state', basis: 'state', detail: 'NV' });
    expect((await stored(lead._id)).customerArea).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });

    await Lead.findOneAndUpdate({ _id: lead._id }, { $set: { phone: '435-555-0144' } });
    expect((await stored(lead._id)).customerArea).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });

    const noAddress: any = await Lead.findOneAndUpdate({ _id: lead._id }, { $set: { address: '' } }, { new: true });
    expect(noAddress.customerArea).toMatchObject({ code: 'utah_435', basis: 'phone', detail: '435' });

    const noPhone: any = await Lead.findOneAndUpdate({ _id: lead._id }, { $unset: { phone: 1 } }, { new: true });
    expect(noPhone.customerArea).toBeNull();
    expect(JSON.parse(JSON.stringify(noPhone)).customerArea).toBeNull();
    expect((await stored(lead._id)).customerArea).toBeUndefined();
  });

  it('3. a change that is not about the phone or address leaves the lead alone, and a phone change does not touch its last-updated time', async () => {
    const old = await oldLead({ firstName: 'Otis', lastName: 'Old', phone: '801-555-0145' });
    await Lead.findOneAndUpdate({ _id: old }, { $set: { isRead: true } }, { timestamps: false });
    expect((await stored(old)).customerArea).toBeUndefined();

    await Lead.findOneAndUpdate({ _id: old }, { $set: { phone: '801-555-0199' } }, { timestamps: false });
    const after = await stored(old);
    expect(after.customerArea).toEqual({ code: 'utah', basis: 'phone', detail: '801' });
    expect(after.updatedAt).toEqual(OLD);
  });

  it('4. the older DealersCloud save (one insert-or-skip step) also saves the area, and a repeat delivery changes nothing', async () => {
    const filter = { organizationId: orgId, messageId: `area-${new mongoose.Types.ObjectId()}` };
    const update = { $setOnInsert: { organizationId: orgId, createdBy: owner, firstName: 'Uma', lastName: 'Upsert', phone: '385-555-0146', address: 'Boise, ID 83702', channel: 'adf', source: 'Third-Party Lead' } };
    const options = { upsert: true, new: true, includeResultMetadata: true, setDefaultsOnInsert: true } as const;
    const first: any = await Lead.findOneAndUpdate(filter, update, options);
    expect(first.value.customerArea).toMatchObject({ code: 'out_of_state', basis: 'state', detail: 'ID' });
    const second: any = await Lead.findOneAndUpdate(filter, update, options);
    expect(String(second.value._id)).toBe(String(first.value._id));
    expect((await stored(first.value._id)).customerArea).toEqual({ code: 'out_of_state', basis: 'state', detail: 'ID' });
  });

  it('5. a DealersCloud application saves the address on the new lead, and the address wins over the phone', async () => {
    const result: any = await receive(leadEmail([person('Sam Rivera', 'sam.rivera.area@example.com', '949-555-0147')]));
    expect(result).toMatchObject({ status: 'associated', created: true });
    const lead = await stored(result.leadId);
    expect(lead.address).toBe(ADF_ADDRESS);
    expect(lead.customerArea).toEqual({ code: 'utah', basis: 'zip', detail: '84057' });
    expect(lead.parsedContent).toContain(`Address: ${ADF_ADDRESS}`);
  });

  it('6. an application added to an existing lead fills an empty address, and never replaces one that is already there', async () => {
    const first: any = await receive(leadEmail([person('Ana Append', 'ana.append.area@example.com', '702-555-0148', false)]));
    expect(first).toMatchObject({ status: 'associated', created: true });
    expect((await stored(first.leadId)).customerArea).toEqual({ code: 'out_of_state', basis: 'phone', detail: '702' });

    const second: any = await receive(leadEmail([person('Ana Append', 'ana.append.area@example.com', '702-555-0148')]));
    expect(second).toMatchObject({ status: 'associated', created: false, leadId: first.leadId });
    const filled = await stored(first.leadId);
    expect(filled.address).toBe(ADF_ADDRESS);
    expect(filled.customerArea).toEqual({ code: 'utah', basis: 'zip', detail: '84057' });
    expect(filled.inquiryCount).toBe(2);

    await Lead.findOneAndUpdate({ _id: filled._id }, { $set: { address: 'Elko, NV 89801' } });
    const third: any = await receive(leadEmail([person('Ana Append', 'ana.append.area@example.com', '702-555-0148')]));
    expect(third).toMatchObject({ status: 'associated', created: false, leadId: first.leadId });
    const kept = await stored(first.leadId);
    expect(kept.address).toBe('Elko, NV 89801');
    expect(kept.customerArea).toEqual({ code: 'out_of_state', basis: 'state', detail: 'NV' });
  });

  it('7. an application that staff add to a lead from "Needs review" fills the address once the review is saved', async () => {
    const target: any = await Lead.create({ ...base, firstName: 'Rae', lastName: 'Review', phone: '702-555-0159' });
    const inquiryId = new mongoose.Types.ObjectId();
    const now = new Date();
    await LeadInquiry.collection.insertOne({
      _id: inquiryId, organizationId: orgId, kind: 'provider_inquiry', channel: 'adf', source: 'Third-Party Lead', receivedAt: now,
      contact: { firstName: 'Rae', lastName: 'Review', phone: '702-555-0159' },
      sourceIds: {}, association: { state: 'pending_review' }, processing: { state: 'done', attempts: 1 }, sideEffects: {},
      leadDraft: { createdBy: owner, address: ADF_ADDRESS },
      review: { state: 'pending', kind: 'ambiguous', candidateLeadIds: [target._id] }, version: 1, createdAt: now, updatedAt: now,
    } as any);

    await resolveLeadReview({ organizationId: ORG, inquiryId: String(inquiryId), resolution: 'associate', leadId: String(target._id), actor: { userId: String(owner), name: 'Olivia Owner' } });
    const after = await stored(target._id);
    expect(after.address).toBe(ADF_ADDRESS);
    expect(after.customerArea).toEqual({ code: 'utah', basis: 'zip', detail: '84057' });
    expect(after.inquiryCount).toBe(2);
    const inquiry: any = await LeadInquiry.collection.findOne({ _id: inquiryId });
    expect(inquiry.association).toMatchObject({ state: 'associated', outcome: 'appended' });
  });

  it('8. the Lead Inbox list and the single lead both carry the area, and every Customer area filter choice works', async () => {
    const utah: any = await Lead.create({ ...base, firstName: 'Una', lastName: 'Utah', phone: '801-555-0160' });
    const utah435: any = await Lead.create({ ...base, firstName: 'Paz', lastName: 'Park', phone: '435-555-0161' });
    const southern: any = await Lead.create({ ...base, firstName: 'Sol', lastName: 'South', phone: '801-555-0162', address: 'Cedar City, UT 84720' });
    const away: any = await Lead.create({ ...base, firstName: 'Ola', lastName: 'Out', phone: '702-555-0163' });
    const canada: any = await Lead.create({ ...base, firstName: 'Cam', lastName: 'Canada', phone: '416-555-0149' });
    const abroad: any = await Lead.create({ ...base, firstName: 'Mia', lastName: 'Mexico', phone: '+52 55 1234 5678' });
    const old = await oldLead({ firstName: 'Lena', lastName: 'Legacy', phone: '435-555-0150' });

    const everything = await listed();
    const row = (id: unknown) => everything.find((lead) => String(lead._id) === String(id));
    expect(row(canada._id).customerArea).toEqual({ code: 'canada', basis: 'phone', detail: '416' });
    expect(row(abroad._id).customerArea).toEqual({ code: 'outside_us', basis: 'phone', detail: 'MX' });
    expect(row(old).customerArea).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });

    let single: any = null;
    const res: any = { status() { return res; }, json(payload: any) { single = payload; return res; } };
    await getLeadById({ orgId: ORG, params: { id: String(old) } } as any, res);
    expect(single.data.customerArea).toEqual({ code: 'utah_435', basis: 'phone', detail: '435' });

    const expected: Array<[string, unknown, string[]]> = [
      ['utah', utah._id, ['utah']],
      ['utah_435', utah435._id, ['utah_435']],
      ['southern_utah', southern._id, ['southern_utah']],
      ['out_of_state', away._id, ['out_of_state']],
    ];
    for (const [filter, id, allowed] of expected) {
      const rows = await listed({ customerArea: filter });
      expect(ids(rows)).toContain(String(id));
      expect(codes(rows)).toEqual(allowed);
    }
    expect(ids(await listed({ customerArea: 'outside' })).sort()).toEqual([String(canada._id), String(abroad._id)].sort());
    expect(ids(await listed({ customerArea: 'utah_435' }))).not.toContain(String(old));
    const none = ids(await listed({ customerArea: 'none' }));
    expect(none).toContain(String(old));
    expect(none).not.toContain(String(canada._id));
    expect((await listed({ customerArea: 'texas' })).length).toBe(everything.length);

    const waiting = await listed({ customerArea: 'utah', sortBy: 'waiting_longest' });
    expect(ids(waiting)).toContain(String(utah._id));
    expect(codes(waiting)).toEqual(['utah']);
    const active = await listed({ customerArea: 'out_of_state', sortBy: 'latest_activity' });
    expect(ids(active)).toContain(String(away._id));
    expect(codes(active)).toEqual(['out_of_state']);
  });

  it('9. the one-time fill previews first, then saves areas and DealersCloud addresses for old leads without changing their last-updated time', async () => {
    const inFillOrg = (fields: Record<string, unknown>) => oldLead({ organizationId: fillOrgId, ...fields });
    const adf = await inFillOrg({ firstName: 'Odin', lastName: 'Adf', channel: 'adf', phone: '801-555-0151', address: '', parsedContent: 'New Lead from Credit Application\n\n— Contact Information —\nName: Odin Adf\nPhone: 801-555-0151\nAddress: 9 Elm St, Cedar City, UT, 84720\n\n— Vehicle —\n2020 TOYOTA TACOMA' });
    const texter = await inFillOrg({ firstName: 'Tess', lastName: 'Texter', phone: '702-555-0152' });
    const unknown = await inFillOrg({ firstName: 'Unknown', lastName: '', channel: 'adf', parsedContent: '— Contact Information —\nName: Unknown', subject: 'Credit Application lead', senderEmail: LEAD_SOURCE, body: leadEmail([person('Bo Both', 'bo.both.area@example.com', '801-555-0153'), person('Cy Co', 'cy.co.area@example.com', '801-555-0154')]) });
    const website = await inFillOrg({ firstName: 'Wes', lastName: 'Website', channel: 'web', phone: '212-555-0155', parsedContent: '— Contact Information —\nName: Wes Website\nAddress: 170 West State Road, Lehi, UT, 84043\n\n<adf><vendor><contact><address><postalcode>84043</postalcode></address></contact></vendor></adf>' });
    const typed = await inFillOrg({ firstName: 'Ty', lastName: 'Typed', channel: 'adf', phone: '801-555-0156', address: 'Boise, ID', parsedContent: '— Contact Information —\nName: Ty Typed\nAddress: 1 Main St, Provo, UT, 84601\n\n— Vehicle —' });
    const dealerLine = await inFillOrg({ firstName: 'Dee', lastName: 'Dealer', channel: 'adf', phone: '212-555-0157', parsedContent: 'Dealer: Test Motors Lehi\nAddress: 170 West State Road, Lehi, UT, 84043\nCustomer asked about the Tacoma' });
    const commentLine = await inFillOrg({ firstName: 'Cora', lastName: 'Comment', channel: 'adf', phone: '702-555-0158', parsedContent: '— Contact Information —\nName: Cora Comment\nPhone: 702-555-0158\n\n— Comments —\nShip it to my work\nAddress: 100 Industrial Way, Sandy, UT 84070' });
    const twoLines = await inFillOrg({ firstName: 'Mia', lastName: 'Multi', channel: 'adf', phone: '702-555-0164', parsedContent: '— Contact Information —\nName: Mia Multi\nAddress: 123 Main St\nApt 4, Provo, UT, 84601\n\n— Vehicle —' });
    const empty = await inFillOrg({ firstName: 'Em', lastName: 'Empty', email: 'em.empty.area@example.com' });
    const before = await stored(adf);

    const preview = await runLeadCustomerAreaBackfill({ organizationId: String(fillOrgId) });
    expect(preview).toMatchObject({ apply: false, scanned: 9, toUpdate: 8, saved: 0, addressFilled: 3, areaSet: 8, areaCleared: 0, noArea: 1 });
    expect(preview.byArea).toEqual({ southern_utah: 1, out_of_state: 5, utah: 2 });
    expect(await stored(adf)).toEqual(before);

    const applied = await runLeadCustomerAreaBackfill({ apply: true, organizationId: String(fillOrgId) });
    expect(applied).toMatchObject({ apply: true, scanned: 9, toUpdate: 8, saved: 8, changedMeanwhile: 0, addressFilled: 3 });

    expect(await stored(adf)).toMatchObject({ address: '9 Elm St, Cedar City, UT, 84720', customerArea: { code: 'southern_utah', basis: 'zip', detail: '84720' }, updatedAt: OLD });
    expect((await stored(texter)).customerArea).toEqual({ code: 'out_of_state', basis: 'phone', detail: '702' });
    expect(await stored(unknown)).toMatchObject({ address: ADF_ADDRESS, customerArea: { code: 'utah', basis: 'zip', detail: '84057' } });
    expect(await stored(website)).toMatchObject({ customerArea: { code: 'out_of_state', basis: 'phone', detail: '212' } });
    expect((await stored(website)).address).toBeUndefined();
    expect(await stored(typed)).toMatchObject({ address: 'Boise, ID', customerArea: { code: 'out_of_state', basis: 'state', detail: 'ID' } });
    expect(await stored(dealerLine)).toMatchObject({ customerArea: { code: 'out_of_state', basis: 'phone', detail: '212' } });
    expect((await stored(dealerLine)).address).toBeUndefined();
    expect(await stored(commentLine)).toMatchObject({ customerArea: { code: 'out_of_state', basis: 'phone', detail: '702' } });
    expect((await stored(commentLine)).address).toBeUndefined();
    expect(await stored(twoLines)).toMatchObject({ address: '123 Main St Apt 4, Provo, UT, 84601', customerArea: { code: 'utah', basis: 'zip', detail: '84601' } });
    expect((await stored(empty)).customerArea).toBeUndefined();

    const again = await runLeadCustomerAreaBackfill({ apply: true, organizationId: String(fillOrgId) });
    expect(again).toMatchObject({ scanned: 9, toUpdate: 0, saved: 0, addressFilled: 0, areaSet: 0 });
    expect((await stored(adf)).updatedAt).toEqual(OLD);
  });
});
