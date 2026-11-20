const mockSendSms = jest.fn();
const mockAiEmail = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn(), batchModify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), once: jest.fn(), credentials: {} })) },
    calendar: jest.fn(() => ({ events: {}, channels: {} })),
    oauth2: jest.fn(() => ({ userinfo: { get: jest.fn() } })),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
  playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
  hangupCall: jest.fn().mockResolvedValue(undefined),
  speakIvr: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/services/aiEmailReply.service', () => ({
  triggerAiEmailReplyForNewInquiry: mockAiEmail,
}));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import { CommunicationMessage } from '../src/models/communication.model';
import { submitLeadInquiry, LeadIntakeRequest } from '../src/services/leadIntake.service';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { loadConversationItems } from '../src/services/leadConversation.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const ids = { owner: new mongoose.Types.ObjectId(), otherOwner: new mongoose.Types.ObjectId() };
const admin = { userId: String(new mongoose.Types.ObjectId()), name: 'Ada Admin' };
const stamp = Date.now();
let serial = 0;
const uniq = () => `${stamp}${++serial}`;
const nextEmail = () => `p73dup${uniq()}@example.com`;
const nextPhone = () => `+1385${String(2100000 + (((stamp % 100000) * 37 + (++serial) * 101) % 7800000))}`;
const nextName = (prefix: string) => `${prefix}${uniq()}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);
const truck = { year: '2021', make: 'Ford', model: 'F-150', vin: '1FTFW1E50MFA00001' };
const sedan = { year: '2020', make: 'Honda', model: 'Civic', vin: '2HGFC2F59LH000002' };

type Input = Partial<LeadIntakeRequest> & { mailbox?: string; messageId?: string; gmailId?: string };

function submit(input: Input) {
  const { mailbox, messageId, gmailId, ...rest } = input;
  return submitLeadInquiry({
    organizationId: ORG,
    kind: 'provider_inquiry',
    receivedAt: new Date(),
    channel: 'email',
    source: 'Email Lead',
    sourceProvider: 'Cars.com',
    ...rest,
    sourceIds: {
      ...(mailbox ? { mailbox } : {}),
      ...(messageId ? { emailMessageId: messageId } : {}),
      ...(gmailId ? { gmailMessageId: gmailId } : {}),
      ...(rest.sourceIds || {}),
    },
  } as LeadIntakeRequest) as Promise<any>;
}

async function setMode(mode: 'off' | 'active' | 'paused', org = ORG) {
  await setLeadIntakeMode({ organizationId: org, mode, reason: `test ${mode}`, actor: admin });
  clearLeadIntakeModeCache();
}

const leadById = (id: unknown) => Lead.findById(id).lean<any>();
const inquiryById = (id: unknown) => LeadInquiry.findById(id).lean<any>();

async function expectFolded(result: any, first: any) {
  expect(result.status).toBe('duplicate');
  expect(String(result.leadId)).toBe(String(first.leadId));
  const inquiry = await inquiryById(result.inquiryId);
  expect(inquiry.association).toMatchObject({ state: 'resolved', outcome: 'dismissed', reason: 'duplicate_same_request' });
  expect(String(inquiry.association.duplicateOf)).toBe(String(first.inquiryId));
  const lead = await leadById(first.leadId);
  expect(lead.inquiryCount).toBe(1);
}

async function expectAppended(result: any, first: any) {
  expect(result.status).toBe('associated');
  expect(result.created).toBe(false);
  expect(String(result.leadId)).toBe(String(first.leadId));
  const inquiry = await inquiryById(result.inquiryId);
  expect(inquiry.association).toMatchObject({ state: 'associated', outcome: 'appended' });
  const lead = await leadById(first.leadId);
  expect(lead.inquiryCount).toBe(2);
}

describe('Real-DB: Phase 73 no duplicate lead cards or inquiries (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Duplicate Dealer', slug: `p73-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `p73-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `p73-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.otherOwner, name: 'Other Owner', email: `p73-other-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: otherOrgId, isActive: true },
    ] as any[]);
    await setMode('active');
    await setMode('active', OTHER);
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockResolvedValue({ id: `out-${new mongoose.Types.ObjectId()}` });
    mockAiEmail.mockReset();
    mockAiEmail.mockResolvedValue(undefined);
  });

  describe('rule A: same email Message-ID', () => {
    it('drops the copy of one email that arrives in a second mailbox and stores the Message-ID lowercased', async () => {
      const email = nextEmail();
      const messageId = `<ABC-${uniq()}@Mail.Example.COM>`;
      const contact = { firstName: 'Morgan', lastName: nextName('Hale'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Is the F-150 still available?', mailbox: 'Leads@Dealer.example.com', messageId, gmailId: `g-${uniq()}` });
      expect(first).toMatchObject({ status: 'associated', created: true });
      const stored = await inquiryById(first.inquiryId);
      expect(stored.sourceIds.emailMessageId).toBe(messageId.toLowerCase());
      expect(stored.sourceIds.mailbox).toBe('leads@dealer.example.com');

      const second = await submit({ contact, vehicle: truck, comments: 'Is the F-150 still available?', mailbox: 'sales@dealer.example.com', messageId: messageId.toLowerCase(), gmailId: `g-${uniq()}` });
      expect(second.status).toBe('duplicate');
      expect(String(second.leadId)).toBe(String(first.leadId));
      const copy = await inquiryById(second.inquiryId);
      expect(copy.association).toMatchObject({ state: 'resolved', outcome: 'dismissed', reason: 'duplicate_same_email_message' });
      expect(String(copy.association.duplicateOf)).toBe(String(first.inquiryId));
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
      expect((await leadById(first.leadId)).inquiryCount).toBe(1);
    });

    it('treats the same Message-ID as a duplicate even when the parsed text differs', async () => {
      const email = nextEmail();
      const messageId = `<parse-${uniq()}@mail.example.com>`;
      const contact = { firstName: 'Riley', lastName: nextName('Shaw'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Hello, what is the best price?', mailbox: 'leads@dealer.example.com', messageId });
      const second = await submit({ contact, vehicle: sedan, comments: 'Totally different parse of the same message body', mailbox: 'sales@dealer.example.com', messageId });
      expect(second.status).toBe('duplicate');
      expect((await inquiryById(second.inquiryId)).association.reason).toBe('duplicate_same_email_message');
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
      expect((await leadById(first.leadId)).inquiryCount).toBe(1);
    });

    it('does not touch another organization that sees the same Message-ID', async () => {
      const email = nextEmail();
      const messageId = `<shared-${uniq()}@mail.example.com>`;
      const contact = { firstName: 'Casey', lastName: nextName('Dunn'), email };
      const mine = await submit({ contact, vehicle: truck, comments: 'Interested in the truck', mailbox: 'leads@dealer.example.com', messageId });
      const theirs = await submit({ organizationId: OTHER, contact, vehicle: truck, comments: 'Interested in the truck', mailbox: 'leads@other.example.com', messageId });
      expect(mine).toMatchObject({ status: 'associated', created: true });
      expect(theirs).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: otherOrgId, email })).toBe(1);
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('does not treat a Message-ID seen more than 7 days ago as the same email', async () => {
      const email = nextEmail();
      const messageId = `<old-${uniq()}@mail.example.com>`;
      const contact = { firstName: 'Drew', lastName: nextName('Park'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Old question about the truck', mailbox: 'leads@dealer.example.com', messageId, receivedAt: minutesAgo(8 * 24 * 60) });
      expect(first).toMatchObject({ status: 'associated', created: true });
      await LeadInquiry.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.inquiryId) }, { $set: { createdAt: minutesAgo(8 * 24 * 60) } });
      const second = await submit({ contact, vehicle: truck, comments: 'Old question about the truck', mailbox: 'sales@dealer.example.com', messageId });
      await expectAppended(second, first);
    });
  });

  describe('rule B: same customer and same request within 2 hours', () => {
    it('folds a second-mailbox copy of the same VIN when it adds no new words', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Sam', lastName: nextName('Ortiz'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Hi! Is this truck still available? I can come Saturday.', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(30) });
      const second = await submit({ contact, vehicle: { vin: truck.vin.toLowerCase() }, comments: 'is this truck still available', mailbox: 'sales@dealer.example.com' });
      await expectFolded(second, first);
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('keeps a second-mailbox copy that adds new words as a new inquiry on the same lead, so nothing the customer wrote is lost', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Sam', lastName: nextName('Ortega'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Is this truck available?', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(30) });
      const second = await submit({ contact, vehicle: { vin: truck.vin.toLowerCase() }, comments: 'Is this truck available? Can I test drive at 5 today? Trading my 2014 Accord.', mailbox: 'sales@dealer.example.com' });
      await expectAppended(second, first);
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('folds a website copy with no message, matched by phone, where the model reads F-150 XLT', async () => {
      const phone = nextPhone();
      const first = await submit({ contact: { firstName: 'Lee', lastName: nextName('Fox'), email: nextEmail(), phone }, vehicle: { year: '2021', make: 'Ford', model: 'F-150' }, comments: 'Can I test drive it?', receivedAt: minutesAgo(45) });
      const second = await submit({
        kind: 'website_inquiry', channel: 'web', source: 'Website Inquiry', sourceProvider: undefined,
        contact: { firstName: 'Lee', phone }, vehicle: { year: '2021', make: 'ford', model: 'F-150 XLT' }, comments: '',
      });
      await expectFolded(second, first);
    });

    it('keeps a copy that names the unit another way (VIN against stock) as a new inquiry', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Lee', lastName: nextName('Vance'), email };
      const camry = { year: '2020', make: 'Toyota', model: 'Camry' };
      const first = await submit({ contact, vehicle: { ...camry, stock: 'A1' }, comments: 'Is it available?', receivedAt: minutesAgo(30) });
      const second = await submit({ contact, vehicle: { ...camry, vin: '4T1B11HK0LU000009' }, comments: '', sourceProvider: 'AutoTrader' });
      await expectAppended(second, first);
    });

    it('keeps a copy that adds a VIN the first one did not have', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Lee', lastName: nextName('Varga'), email };
      const camry = { year: '2020', make: 'Toyota', model: 'Camry' };
      const first = await submit({ contact, vehicle: camry, comments: 'Is it available?', receivedAt: minutesAgo(30) });
      const second = await submit({ contact, vehicle: { ...camry, vin: '4T1B11HK0LU000010' }, comments: 'Is it available?', sourceProvider: 'AutoTrader' });
      await expectAppended(second, first);
    });

    it('folds a copy that only drops the VIN the first one had', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Lee', lastName: nextName('Voss'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Is it available?', receivedAt: minutesAgo(30) });
      const second = await submit({ contact, vehicle: { year: '2021', make: 'Ford', model: 'F-150' }, comments: '', sourceProvider: 'AutoTrader' });
      await expectFolded(second, first);
    });

    it('folds a copy of a closed lead request within 30 minutes, but starts a new lead after that', async () => {
      const soonEmail = nextEmail();
      const soonContact = { firstName: 'Ira', lastName: nextName('Cole'), email: soonEmail };
      const soon = await submit({ contact: soonContact, vehicle: truck, comments: 'Is the truck available?', receivedAt: minutesAgo(20) });
      await Lead.collection.updateOne({ _id: new mongoose.Types.ObjectId(soon.leadId) }, { $set: { status: 'Not a Lead' } });
      const soonCopy = await submit({ contact: soonContact, vehicle: truck, comments: 'Is the truck available?', sourceProvider: 'AutoTrader' });
      expect(soonCopy.status).toBe('duplicate');
      expect(await Lead.countDocuments({ organizationId: orgId, email: soonEmail })).toBe(1);

      const lateEmail = nextEmail();
      const lateContact = { firstName: 'Ira', lastName: nextName('Cobb'), email: lateEmail };
      const late = await submit({ contact: lateContact, vehicle: truck, comments: 'Is the truck available?', receivedAt: minutesAgo(50) });
      await Lead.collection.updateOne({ _id: new mongoose.Types.ObjectId(late.leadId) }, { $set: { status: 'Bad Lead' } });
      const again = await submit({ contact: lateContact, vehicle: truck, comments: 'Is the truck available?', sourceProvider: 'AutoTrader' });
      expect(again).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, email: lateEmail })).toBe(2);
    });

    it('keeps a blank-first request and a later message with words as two inquiries on one lead', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Lee', lastName: nextName('Fenn'), email };
      const first = await submit({ contact, vehicle: truck, comments: '', sourceProvider: 'CarGurus', receivedAt: minutesAgo(60) });
      const second = await submit({ contact, vehicle: truck, comments: 'Can I test drive at 5 today?', kind: 'website_inquiry', channel: 'web', source: 'Website Inquiry', sourceProvider: undefined });
      await expectAppended(second, first);
    });

    it('folds the same request from the same route when the text is the same', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Alex', lastName: nextName('Moss'), email };
      const first = await submit({ contact, vehicle: { stock: 'T-1001' }, comments: 'What is your best out the door price?', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(20) });
      const second = await submit({ contact, vehicle: { stock: 't1001' }, comments: 'What is your best out the door price?', mailbox: 'leads@dealer.example.com' });
      await expectFolded(second, first);
    });

    it('appends the same vehicle from the same route when the text is clearly different', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Alex', lastName: nextName('Reed'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'What is your best out the door price?', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(20) });
      const second = await submit({ contact, vehicle: truck, comments: 'Do you take trade-ins? I have a 2015 Camry', mailbox: 'leads@dealer.example.com' });
      await expectAppended(second, first);
    });

    it('folds two requests without a vehicle when the texts are the same', async () => {
      const phone = nextPhone();
      const contact = { firstName: 'Jamie', lastName: nextName('Cole'), phone };
      const first = await submit({ contact, comments: 'Please call me about financing options', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(15) });
      const second = await submit({ contact, comments: 'Please call me about financing options!', mailbox: 'sales@dealer.example.com' });
      await expectFolded(second, first);
    });

    it('appends two requests without a vehicle when the texts differ', async () => {
      const phone = nextPhone();
      const contact = { firstName: 'Jamie', lastName: nextName('Wolfe'), phone };
      const first = await submit({ contact, comments: 'Please call me about financing options', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(15) });
      const second = await submit({ contact, comments: 'What hours are you open on Saturday?', mailbox: 'sales@dealer.example.com' });
      await expectAppended(second, first);
    });

    it('appends when only one of the two names a vehicle', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Taylor', lastName: nextName('Nash'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Interested in this vehicle', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(10) });
      const second = await submit({ contact, comments: 'Interested in this vehicle', mailbox: 'sales@dealer.example.com' });
      await expectAppended(second, first);
    });

    it('appends when the two name different vehicles', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Taylor', lastName: nextName('Vance'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Interested in this vehicle', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(10) });
      const second = await submit({ contact, vehicle: sedan, comments: 'Interested in this vehicle', mailbox: 'sales@dealer.example.com' });
      await expectAppended(second, first);
    });

    it('appends the same request when it comes 3 hours later', async () => {
      const email = nextEmail();
      const contact = { firstName: 'Quinn', lastName: nextName('Hart'), email };
      const first = await submit({ contact, vehicle: truck, comments: 'Is the truck available?', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(180) });
      const second = await submit({ contact, vehicle: truck, comments: 'Is the truck available?', mailbox: 'sales@dealer.example.com' });
      await expectAppended(second, first);
    });
  });

  describe('rule B2: same full name and same vehicle without shared contact', () => {
    it('keeps one card when the same named person sends a copy for the same VIN with only a phone, and fills in the missing phone', async () => {
      const lastName = nextName('Kimball');
      const email = nextEmail();
      const phone = nextPhone();
      const first = await submit({ contact: { firstName: 'Jordan', lastName, email }, vehicle: truck, comments: 'Looking at the F-150', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(40) });
      const second = await submit({ contact: { firstName: 'jordan', lastName: lastName.toUpperCase(), phone }, vehicle: { vin: truck.vin }, comments: 'Looking at the F-150', sourceProvider: 'AutoTrader' });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName: { $in: [lastName, lastName.toUpperCase()] } })).toBe(1);
      await expectFolded(second, first);
      const lead = await leadById(first.leadId);
      expect(lead.email).toBe(email);
      expect(lead.phone).toBe(phone);
    });

    it('keeps two cards when the same name matches only by year, make and model', async () => {
      const lastName = nextName('Yates');
      const ymm = { year: '2021', make: 'Ford', model: 'F-150' };
      const first = await submit({ contact: { firstName: 'Jordan', lastName, email: nextEmail() }, vehicle: ymm, comments: 'Looking at the F-150', receivedAt: minutesAgo(20) });
      const second = await submit({ contact: { firstName: 'Jordan', lastName, phone: nextPhone() }, vehicle: ymm, comments: 'Looking at the F-150', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName })).toBe(2);
    });

    it('keeps two cards for a placeholder name like Facebook User', async () => {
      const vin = `1FTFW1E50MF${String(uniq()).slice(-6)}`;
      const first = await submit({ contact: { firstName: 'Facebook', lastName: 'User', email: nextEmail() }, vehicle: { vin }, comments: 'Is this available?', receivedAt: minutesAgo(20) });
      const second = await submit({ contact: { firstName: 'Facebook', lastName: 'User', phone: nextPhone() }, vehicle: { vin }, comments: 'Is this available?', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
    });

    it('keeps two cards when the same name and VIN come with two different phone numbers', async () => {
      const lastName = nextName('Pryce');
      const first = await submit({ contact: { firstName: 'Jordan', lastName, phone: nextPhone() }, vehicle: truck, comments: 'Looking at the F-150', receivedAt: minutesAgo(20) });
      const second = await submit({ contact: { firstName: 'Jordan', lastName, phone: nextPhone() }, vehicle: { vin: truck.vin }, comments: 'Looking at the F-150', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName })).toBe(2);
    });

    it('keeps two cards when a same-name copy adds new words', async () => {
      const lastName = nextName('Quill');
      const first = await submit({ contact: { firstName: 'Jordan', lastName, email: nextEmail() }, vehicle: truck, comments: 'Looking at the F-150', receivedAt: minutesAgo(20) });
      const second = await submit({ contact: { firstName: 'Jordan', lastName, phone: nextPhone() }, vehicle: { vin: truck.vin }, comments: 'Looking at the F-150. Do you finance with bad credit?', sourceProvider: 'AutoTrader' });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName })).toBe(2);
    });

    it('never folds a customer named Unknown', async () => {
      const lastName = nextName('Unk');
      const first = await submit({ contact: { firstName: 'Unknown', lastName, email: nextEmail() }, vehicle: truck, comments: 'Truck question', receivedAt: minutesAgo(10) });
      const second = await submit({ contact: { firstName: 'Unknown', lastName, phone: nextPhone() }, vehicle: truck, comments: 'Truck question', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName })).toBe(2);
    });

    it('never folds when the last name is missing', async () => {
      const firstName = nextName('Avery');
      const first = await submit({ contact: { firstName, email: nextEmail() }, vehicle: truck, comments: 'Truck question', receivedAt: minutesAgo(10) });
      const second = await submit({ contact: { firstName, phone: nextPhone() }, vehicle: truck, comments: 'Truck question', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, firstName })).toBe(2);
    });

    it('keeps two cards when the same name asks about a different vehicle', async () => {
      const lastName = nextName('Blake');
      const first = await submit({ contact: { firstName: 'Jordan', lastName, email: nextEmail() }, vehicle: truck, comments: 'Truck question', receivedAt: minutesAgo(10) });
      const second = await submit({ contact: { firstName: 'Jordan', lastName, phone: nextPhone() }, vehicle: sedan, comments: 'Sedan question', sourceProvider: 'AutoTrader' });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'associated', created: true });
      expect(await Lead.countDocuments({ organizationId: orgId, lastName })).toBe(2);
    });
  });

  describe('rule C: fill empty fields only', () => {
    it('fills missing email, vehicle and address but never overwrites phone, name or comments', async () => {
      const lastName = nextName('Ford');
      const phone = nextPhone();
      const email = nextEmail();
      const first = await submit({ contact: { firstName: 'Pat', lastName, phone }, vehicle: truck, comments: 'Original question', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(30) });
      await Lead.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.leadId) }, { $unset: { vehicle: '' } });
      const second = await submit({
        contact: { firstName: 'Patrick', lastName: 'Other', phone, email }, vehicle: { ...truck, trim: 'XLT' },
        comments: 'original question', mailbox: 'sales@dealer.example.com', leadDraft: { address: '12 Main St, Lehi UT' },
      });
      await expectFolded(second, first);
      const lead = await leadById(first.leadId);
      expect(lead).toMatchObject({ firstName: 'Pat', lastName, phone, email, comments: 'Original question', address: '12 Main St, Lehi UT' });
      expect(lead.vehicle).toMatchObject({ vin: truck.vin, make: 'Ford', model: 'F-150', trim: 'XLT' });
    });

    it('does not fill an email the copy marks as excluded', async () => {
      const lastName = nextName('Gray');
      const phone = nextPhone();
      const first = await submit({ contact: { firstName: 'Robin', lastName, phone }, vehicle: truck, comments: 'Truck question', receivedAt: minutesAgo(20) });
      const second = await submit({ contact: { firstName: 'Robin', lastName, phone, email: nextEmail(), emailExcluded: true }, vehicle: truck, comments: 'Truck question', sourceProvider: 'AutoTrader' });
      await expectFolded(second, first);
      const lead = await leadById(first.leadId);
      expect(lead.email || '').toBe('');
    });

    it('leaves a Do Not Contact lead unchanged', async () => {
      const lastName = nextName('Stone');
      const email = nextEmail();
      const first = await submit({ contact: { firstName: 'Kai', lastName, email }, vehicle: truck, comments: 'Truck question', receivedAt: minutesAgo(20) });
      await Lead.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.leadId) }, { $set: { status: 'Do Not Contact' }, $unset: { comments: '' } });
      const second = await submit({ contact: { firstName: 'Kai', lastName, email, phone: nextPhone() }, vehicle: truck, comments: 'Truck question', sourceProvider: 'AutoTrader', leadDraft: { address: '9 Elm St' } });
      expect(second.status).toBe('duplicate');
      const lead = await leadById(first.leadId);
      expect(lead.status).toBe('Do Not Contact');
      expect(lead.phone || '').toBe('');
      expect(lead.comments || '').toBe('');
      expect(lead.address || '').toBe('');
    });
  });

  describe('conversation view', () => {
    it('shows a request that came twice within 2 hours as one card and blanks an inquiry already shown as a text', async () => {
      const email = nextEmail();
      const phone = nextPhone();
      const contact = { firstName: 'Noel', lastName: nextName('Pike'), email, phone };
      const first = await submit({ contact, vehicle: truck, comments: 'Is the F-150 available?', mailbox: 'leads@dealer.example.com', receivedAt: minutesAgo(60) });
      expect(first).toMatchObject({ status: 'associated', created: true });
      const leadId = new mongoose.Types.ObjectId(first.leadId);
      const association = { state: 'associated', outcome: 'appended', leadId };
      const repeat = await LeadInquiry.create({
        organizationId: orgId, kind: 'provider_inquiry', receivedAt: minutesAgo(40), channel: 'email', source: 'Email Lead', sourceProvider: 'Cars.com',
        contact: { email }, vehicle: truck, comments: 'is the f-150 available', sourceIds: { mailbox: 'sales@dealer.example.com' }, association,
      });
      const followUp = await LeadInquiry.create({
        organizationId: orgId, kind: 'provider_inquiry', receivedAt: minutesAgo(35), channel: 'email', source: 'Email Lead', sourceProvider: 'Cars.com',
        contact: { email }, vehicle: truck, comments: 'Is the F-150 available? Also, do you take trades?', sourceIds: { mailbox: 'sales@dealer.example.com' }, association,
      });
      const longer = 'Can I see the Civic Saturday morning? I will bring my trade-in.';
      const withMore = await LeadInquiry.create({
        organizationId: orgId, kind: 'website_inquiry', receivedAt: minutesAgo(5), channel: 'web', source: 'Website Inquiry',
        contact: { email }, vehicle: { year: '2018', make: 'Toyota', model: 'Tacoma' }, comments: longer, association,
      });
      await CommunicationMessage.collection.insertOne({
        orgId: ORG, conversationId: new mongoose.Types.ObjectId(), leadId, direction: 'inbound', body: 'Can I see the Civic Saturday morning?',
        from: phone, to: '+18015550999', status: 'received', createdAt: minutesAgo(6), updatedAt: minutesAgo(6),
      } as any);
      const texted = 'Can I come see the Civic on Saturday morning?';
      const other = await LeadInquiry.create({
        organizationId: orgId, kind: 'provider_inquiry', receivedAt: minutesAgo(10), channel: 'email', source: 'Email Lead', sourceProvider: 'Cars.com',
        contact: { email }, vehicle: sedan, comments: texted, sourceIds: { mailbox: 'leads@dealer.example.com' }, association,
      });
      await CommunicationMessage.collection.insertOne({
        orgId: ORG, conversationId: new mongoose.Types.ObjectId(), leadId, direction: 'inbound', body: texted,
        from: phone, to: '+18015550999', status: 'received', createdAt: minutesAgo(12), updatedAt: minutesAgo(12),
      } as any);
      const lead = await leadById(first.leadId);
      const page: any = await loadConversationItems(ORG, lead);
      const cards = page.items.filter((item: any) => item.kind === 'inquiry');
      const cardIds = cards.map((item: any) => item.id);
      expect(cardIds).toContain(`inquiry:${first.inquiryId}`);
      expect(cardIds).not.toContain(`inquiry:${repeat._id}`);
      expect(cardIds).toContain(`inquiry:${followUp._id}`);
      expect(cardIds).toContain(`inquiry:${other._id}`);
      expect(cards.find((item: any) => item.id === `inquiry:${followUp._id}`).body).toBe('Is the F-150 available? Also, do you take trades?');
      expect(cards.find((item: any) => item.id === `inquiry:${withMore._id}`).body).toBe(longer);
      expect(cards.filter((item: any) => item.inquiry?.isOriginal)).toHaveLength(1);
      expect(cards.find((item: any) => item.id === `inquiry:${first.inquiryId}`).body).toBe('Is the F-150 available?');
      expect(cards.find((item: any) => item.id === `inquiry:${other._id}`).body).toBe('');
      expect(page.items.some((item: any) => item.kind === 'message' && item.channel === 'sms' && item.body === texted)).toBe(true);
    });
  });
});
