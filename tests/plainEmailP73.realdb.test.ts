const mockAiEmail = jest.fn();
const mockSendSms = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), batchModify: jest.fn(), modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), once: jest.fn(), credentials: {} })) },
    calendar: jest.fn(() => ({ events: { update: jest.fn(), insert: jest.fn(), delete: jest.fn(), watch: jest.fn() }, channels: { stop: jest.fn() } })),
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

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import Notification from '../src/models/Notification.model';
import { processGmailMessageThroughIntake } from '../src/services/gmailLeadIntake';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ownerId = new mongoose.Types.ObjectId();
const crmAdminId = new mongoose.Types.ObjectId();
const MAIN = 'sales@dealer-p73.test';
const OLD = 'oldbox@gmail.com';
const LEAD_SOURCE = 'leads@dealerscloud.com';
const STAMP = Date.now();
let serial = 0;

const uid = () => `${++serial}-${STAMP}`;
const customerEmail = (tag = 'cust') => `${tag}.${uid()}@gmail.com`;

function gmailMessage(input: { from: string; subject?: string; body?: string; threadId?: string; messageId?: string; headers?: Array<{ name: string; value: string }> }) {
  const n = uid();
  const body = input.body || 'Hi, is the truck still available?';
  return {
    id: `gm-${n}`,
    threadId: input.threadId || `th-${n}`,
    internalDate: String(Date.now()),
    snippet: body.slice(0, 80),
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: input.from },
        { name: 'To', value: MAIN },
        { name: 'Subject', value: input.subject || 'Question about a car' },
        { name: 'Message-ID', value: input.messageId || `<msg-${n}@mail.example.com>` },
        ...(input.headers || []),
      ],
      body: { data: Buffer.from(body).toString('base64') },
    },
  };
}

function adfBody(first: string, last: string, email: string) {
  return `<?xml version="1.0"?><?adf version="1.0"?><adf><prospect><requestdate>2026-11-19T10:00:00-07:00</requestdate><vehicle interest="buy"><year>2020</year><make>Honda</make><model>Civic</model></vehicle><customer><contact><name part="first">${first}</name><name part="last">${last}</name><email>${email}</email></contact></customer></prospect></adf>`;
}

function run(message: any, overrides: Record<string, unknown> = {}) {
  const body = Buffer.from(message.payload.body.data, 'base64').toString('utf8');
  return processGmailMessageThroughIntake({
    organizationId: ORG,
    message,
    rawBody: body,
    leadSourceEmail: LEAD_SOURCE,
    systemUserId: String(ownerId),
    allowNewInquiry: false,
    mailbox: MAIN,
    plainEmailLeads: true,
    ownAddresses: [MAIN, OLD],
    staffEmails: new Set(['rep@dealer-p73.test']),
    notLeadSenders: ['vendor@ads-p73.test'],
    ...overrides,
  } as any);
}

const notificationCount = () => Notification.countDocuments({});

async function expectOthers(message: any, reason: string) {
  const before = await notificationCount();
  const aiBefore = mockAiEmail.mock.calls.length;
  const smsBefore = mockSendSms.mock.calls.length;
  const result: any = await run(message);
  expect(result.status).toBe('sorted');
  expect(result.reason).toBe(reason);
  const lead: any = await Lead.findById(result.leadId).lean();
  expect(lead).toBeTruthy();
  expect(lead.status).toBe('Not a Lead');
  expect(lead.statusHistory[lead.statusHistory.length - 1].reason).toBe(reason);
  expect(lead.identityEmailExcluded).toBe(true);
  expect(lead.threadId).toBeFalsy();
  expect(await notificationCount()).toBe(before);
  expect(mockAiEmail.mock.calls.length).toBe(aiBefore);
  expect(mockSendSms.mock.calls.length).toBe(smsBefore);
  const inquiry: any = await LeadInquiry.findById(result.inquiryId).lean();
  expect(inquiry.sideEffects?.alexReply?.state).not.toBe('done');
  return { result, lead };
}

describe('Real-DB: Phase 73 plain emails to the main lead mailbox (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || mongoose.connection.host !== '127.0.0.1') {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertOne({
      _id: orgId, name: 'P73 Dealer', slug: `p73-${orgId}`, status: 'active',
      metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
    } as any);
    await User.collection.insertOne({
      _id: ownerId, name: 'Olive Owner', email: `p73-owner-${STAMP}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true,
    } as any);
    await CrmUser.collection.insertOne({
      _id: crmAdminId, organizationId: orgId, fullName: 'Ada Admin', username: `p73-${crmAdminId}`, email: `p73-crm-${STAMP}@example.com`, role: 'admin', isActive: true, password: 'x',
    } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    clearLeadIntakeModeCache(ORG);
  });

  it('a customer email makes a new lead with the sender name and email', async () => {
    const email = customerEmail('maria.x');
    const before = await notificationCount();
    const message = gmailMessage({ from: `"Maria Lopez" <${email}>`, messageId: `<CAF-Maria-${uid()}@Mail.Gmail.com>` });
    const result: any = await run(message);
    expect(result.status).toBe('associated');
    expect(result.created).toBe(true);
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead.firstName).toBe('Maria');
    expect(lead.lastName).toBe('Lopez');
    expect(lead.email).toBe(email);
    expect(lead.status).toBe('New');
    const inquiry: any = await LeadInquiry.findById(result.inquiryId).lean();
    expect(inquiry.kind).toBe('provider_inquiry');
    const header = message.payload.headers.find((h: any) => h.name === 'Message-ID')!.value;
    expect(inquiry.sourceIds.emailMessageId).toBe(header.replace(/^<|>$/g, '').toLowerCase());
    expect(inquiry.sourceIds.mailbox).toBe(MAIN);
    expect(await notificationCount()).toBeGreaterThan(before);
  });

  it('the same sender writing again in a new thread is added to the open lead as a reply', async () => {
    const email = customerEmail('repeat');
    const first: any = await run(gmailMessage({ from: `"Rita Perez" <${email}>` }));
    expect(first.status).toBe('associated');
    const second: any = await run(gmailMessage({ from: `"Rita Perez" <${email}>`, subject: 'One more question', body: 'Do you take trade-ins?' }));
    expect(second.status).toBe('associated');
    expect(second.leadId).toBe(first.leadId);
    expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    const inquiry: any = await LeadInquiry.findById(second.inquiryId).lean();
    expect(inquiry.kind).toBe('email_reply');
    expect(String(inquiry.association.leadId)).toBe(String(first.leadId));
  });

  it('an email from a team member goes to Others', async () => {
    await expectOthers(gmailMessage({ from: 'Ryan Rep <rep@dealer-p73.test>', subject: `Deal update ${uid()}` }), 'From a team member');
  });

  it('an email from our own domain goes to Others', async () => {
    await expectOthers(gmailMessage({ from: `Parts Desk <parts@dealer-p73.test>`, subject: `Parts order ${uid()}` }), 'From our own email');
  });

  it('a sender on a free-mail domain is never treated as our own email', async () => {
    const email = customerEmail('freemail');
    const result: any = await run(gmailMessage({ from: `"Gina Free" <${email}>` }));
    expect(result.status).toBe('associated');
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead.status).toBe('New');
    expect(lead.email).toBe(email);
  });

  it('mass mail with a List-Unsubscribe header goes to Others', async () => {
    await expectOthers(gmailMessage({
      from: `Deals Weekly <news.${uid()}@promo-p73.test>`,
      headers: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@promo-p73.test>' }],
    }), 'Mass email or automatic notice');
  });

  it('mass mail with Precedence: bulk goes to Others', async () => {
    await expectOthers(gmailMessage({
      from: `Bulk Sender <bulk.${uid()}@promo-p73.test>`,
      headers: [{ name: 'Precedence', value: 'bulk' }],
    }), 'Mass email or automatic notice');
  });

  it('mail from a no-reply sender goes to Others', async () => {
    await expectOthers(gmailMessage({ from: `Store <no-reply@shop${uid()}-p73.test>`, subject: 'Your receipt' }), 'Mass email or automatic notice');
  });

  it('a sender marked Not a lead goes to Others', async () => {
    await expectOthers(gmailMessage({ from: 'Ad Vendor <vendor@ads-p73.test>', subject: `Ad proposal ${uid()}` }), 'Sender marked Not a lead');
  });

  it('an auto-reply with Auto-Submitted: auto-replied is dismissed and makes no lead', async () => {
    const email = customerEmail('autoreply');
    const result: any = await run(gmailMessage({ from: `"Al Away" <${email}>`, headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }));
    expect(result.status).toBe('dismissed');
    expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(0);
  });

  it('an out-of-office or automatic reply subject is dismissed and makes no lead', async () => {
    const oooEmail = customerEmail('ooo');
    const ooo: any = await run(gmailMessage({ from: `"Olga Out" <${oooEmail}>`, subject: 'Out of Office: back Monday' }));
    expect(ooo.status).toBe('dismissed');
    const autoEmail = customerEmail('auto');
    const auto: any = await run(gmailMessage({ from: `"Andy Auto" <${autoEmail}>`, subject: 'Automatic reply: Question about a car' }));
    expect(auto.status).toBe('dismissed');
    expect(await Lead.countDocuments({ organizationId: orgId, email: { $in: [oooEmail, autoEmail] } })).toBe(0);
  });

  it('a lead source email without ADF content is skipped and makes no lead', async () => {
    const before = await Lead.countDocuments({ organizationId: orgId });
    const result: any = await run(gmailMessage({ from: `DealersCloud <${LEAD_SOURCE}>`, subject: 'Daily summary', body: 'You have 3 new leads today.' }));
    expect(result).toEqual({ status: 'skipped', reason: 'lead_source_notice' });
    expect(await Lead.countDocuments({ organizationId: orgId })).toBe(before);
  });

  it('another address at the lead source domain without ADF content is also skipped', async () => {
    const before = await Lead.countDocuments({ organizationId: orgId });
    const result: any = await run(gmailMessage({ from: 'DealersCloud Support <support@dealerscloud.com>', subject: 'Account notice', body: 'Your invoice is ready.' }));
    expect(result).toEqual({ status: 'skipped', reason: 'lead_source_notice' });
    expect(await Lead.countDocuments({ organizationId: orgId })).toBe(before);
  });

  it('Cars.com notice emails are skipped, one after another, and make no card', async () => {
    const before = await Lead.countDocuments({ organizationId: orgId });
    for (const subject of ['Phone Lead Notice', 'Used Car Lead', 'Finance Intent']) {
      const result: any = await run(gmailMessage({ from: `Cars.com <SalesLeads@cars.com>`, subject, body: `${subject}: a shopper is interested in your 2021 Ford F-150.` }));
      expect(result).toEqual({ status: 'skipped', reason: 'platform_notice' });
    }
    expect(await Lead.countDocuments({ organizationId: orgId })).toBe(before);
  });

  it('a lead source email with ADF content makes a normal lead', async () => {
    const email = `adf.${uid()}@example.com`;
    const result: any = await run(gmailMessage({ from: `DealersCloud <${LEAD_SOURCE}>`, subject: 'New lead', body: adfBody('Lena', 'Adams', email) }), { allowNewInquiry: true });
    expect(result.status).toBe('associated');
    expect(result.created).toBe(true);
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead.firstName).toBe('Lena');
    expect(lead.lastName).toBe('Adams');
    expect(lead.email).toBe(email);
    expect(lead.status).not.toBe('Not a Lead');
  });

  it('the previous mailbox skips a plain customer email that is not in a known thread', async () => {
    const email = customerEmail('oldbox');
    const result: any = await run(gmailMessage({ from: `"Olly Box" <${email}>` }), { mailbox: OLD, plainEmailLeads: false });
    expect(result).toEqual({ status: 'skipped', reason: 'not_a_lead_email' });
    expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(0);
  });

  it('the same plain email seen in both mailboxes makes only one lead', async () => {
    const email = customerEmail('twice');
    const messageId = `<twice-${uid()}@mail.gmail.com>`;
    const main: any = await run(gmailMessage({ from: `"Tina Twice" <${email}>`, messageId }));
    expect(main.status).toBe('associated');
    await run(gmailMessage({ from: `"Tina Twice" <${email}>`, messageId }), { mailbox: OLD, plainEmailLeads: false });
    const again: any = await run(gmailMessage({ from: `"Tina Twice" <${email}>`, messageId }), { mailbox: OLD });
    expect(['duplicate', 'associated']).toContain(again.status);
    expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
  });

  it('the same ADF Message-ID processed once per mailbox makes only one lead', async () => {
    const email = `adftwice.${uid()}@example.com`;
    const messageId = `<adf-twice-${uid()}@dealerscloud.com>`;
    const body = adfBody('Dora', 'Dupe', email);
    const first: any = await run(gmailMessage({ from: `DealersCloud <${LEAD_SOURCE}>`, subject: 'New lead', body, messageId }), { allowNewInquiry: true });
    expect(first.status).toBe('associated');
    const second: any = await run(gmailMessage({ from: `DealersCloud <${LEAD_SOURCE}>`, subject: 'New lead', body, messageId }), { allowNewInquiry: true, mailbox: OLD, plainEmailLeads: false });
    expect(second.status).toBe('duplicate');
    expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
  });
});
