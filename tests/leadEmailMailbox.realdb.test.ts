const mockThreadsGet = jest.fn();
const mockMessagesSend = jest.fn();
const mockMessagesList = jest.fn();
const mockMessagesGet = jest.fn();
const mockBatchModify = jest.fn();
const mockGoogleSignIn = { tokens: null as any, email: '' };

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => {
  const mailboxOf = (auth: any) => String(auth?.credentials?.refresh_token || '');
  const OAuth2 = jest.fn().mockImplementation(() => {
    const client: any = { credentials: {}, handlers: {} };
    client.setCredentials = (credentials: any) => { client.credentials = credentials; };
    client.on = (event: string, handler: any) => { client.handlers[event] = handler; return client; };
    client.once = client.on;
    client.generateAuthUrl = () => 'https://accounts.google.com/o/oauth2/v2/auth';
    client.getToken = async () => ({ tokens: mockGoogleSignIn.tokens });
    return client;
  });
  return {
    google: {
      gmail: jest.fn((options: any) => ({
        users: {
          threads: { get: (params: any) => mockThreadsGet(params, mailboxOf(options?.auth)) },
          messages: {
            get: (params: any) => mockMessagesGet(params, mailboxOf(options?.auth)),
            list: (params: any) => mockMessagesList(params, mailboxOf(options?.auth)),
            send: (params: any) => mockMessagesSend(params, mailboxOf(options?.auth)),
            batchModify: (params: any) => mockBatchModify(params, mailboxOf(options?.auth)),
            modify: jest.fn(),
          },
        },
      })),
      auth: { OAuth2 },
      calendar: jest.fn(() => ({
        events: { update: jest.fn(), insert: jest.fn(), delete: jest.fn(), watch: jest.fn(async () => ({ data: {} })) },
        channels: { stop: jest.fn() },
      })),
      oauth2: jest.fn(() => ({ userinfo: { get: async () => ({ data: { email: mockGoogleSignIn.email } }) } })),
      drive: jest.fn(() => ({})),
      people: jest.fn(() => ({})),
    },
  };
});
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
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import Customer from '../src/models/Customer.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import ComposerSendClaim from '../src/models/ComposerSendClaim.model';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import orgLeadController from '../src/controllers/orgLead.controller';
import { getCentralOAuth2Client, sendLeadReplyEmail } from '../src/controllers/lead.controller';
import orgGmailService from '../src/services/orgGmail.service';
import { processGmailMessageThroughIntake } from '../src/services/gmailLeadIntake';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { cacheService } from '../src/services/cache.service';
import { decrypt, encrypt } from '../src/utils/crypto';
import { customerEmailedSince, latestCustomerEmailReplyAt } from '../src/schedulers/leadNurture.scheduler';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const switchOrgId = new mongoose.Types.ObjectId();
const SWITCH_ORG = String(switchOrgId);
const ids = { owner: new mongoose.Types.ObjectId(), employee: new mongoose.Types.ObjectId(), switchOwner: new mongoose.Types.ObjectId() };
const NEW_MAILBOX = 'leads@new-mailbox.example.com';
const OLD_MAILBOX = 'old-dev@example.com';
const MAIN_REFRESH = 'local-test-refresh';
const PREVIOUS_REFRESH = 'previous-test-refresh';
const DEALERSCLOUD = 'leads@dealerscloud.com';
const DAY = 24 * 60 * 60 * 1000;
const FULL_SCOPE = ['gmail.readonly', 'gmail.modify', 'gmail.send', 'userinfo.email', 'calendar.events']
  .map((scope) => `https://www.googleapis.com/auth/${scope}`).join(' ');
const savedAcceptance = process.env.LOCAL_UI_ACCEPTANCE_MODE;
const savedFrontend = process.env.FRONTEND_URL;
const threads = new Map<string, Map<string, any[]>>();
const unread = new Map<string, any[]>();
let token = '';
let serial = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextEmail = () => `mailbox${++serial}@example.com`;
const notFound = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });
const threadsIn = (mailbox: string) => {
  if (!threads.has(mailbox)) threads.set(mailbox, new Map());
  return threads.get(mailbox)!;
};
const unreadIn = (mailbox: string) => {
  if (!unread.has(mailbox)) unread.set(mailbox, []);
  return unread.get(mailbox)!;
};
const callsFor = (mock: jest.Mock, mailbox: string) => mock.mock.calls.filter((call) => call[1] === mailbox);
const sendEmail = (leadId: unknown, message = 'Yes, it is still available.') =>
  request(app).post(`/api/leads/${leadId}/reply`).set(auth())
    .field('message', message).field('clientRequestId', `req-${Date.now()}-${++serial}-abcdef`);

function sentEmail(callIndex = 0) {
  const body = mockMessagesSend.mock.calls[callIndex][0].requestBody;
  const raw = Buffer.from(String(body.raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return { threadId: body.threadId, raw };
}

function adfBody(first: string, last: string, vehicle = '<vehicle interest="buy"><year>2020</year><make>Honda</make><model>Civic</model></vehicle>') {
  return `<?xml version="1.0"?><?adf version="1.0"?><adf><prospect><requestdate>2026-11-19T10:00:00-07:00</requestdate>${vehicle}<customer><contact><name part="first">${first}</name><name part="last">${last}</name><email>${first.toLowerCase()}.${last.toLowerCase()}@example.com</email></contact></customer></prospect></adf>`;
}

function gmailMessage(input: { id: string; threadId: string; from: string; subject?: string; body?: string; at?: Date; sent?: boolean }) {
  const at = input.at || new Date();
  const body = input.body || 'Is it still available?';
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: String(at.getTime()),
    snippet: body.slice(0, 80),
    labelIds: input.sent ? ['SENT'] : ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: input.from }, { name: 'Subject', value: input.subject || 'Re: Tacoma inquiry' }],
      body: { data: Buffer.from(body).toString('base64') },
    },
  };
}

function replyWithLogo(input: { id: string; threadId: string; from: string; text: string; at?: Date }) {
  const encode = (value: string) => Buffer.from(value).toString('base64');
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: String((input.at || new Date()).getTime()),
    snippet: input.text.slice(0, 80),
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'multipart/related',
      headers: [{ name: 'From', value: input.from }, { name: 'Subject', value: 'Re: Tacoma inquiry' }],
      body: { size: 0 },
      parts: [
        {
          mimeType: 'multipart/alternative',
          body: { size: 0 },
          parts: [
            { mimeType: 'text/plain', body: { data: encode(input.text) } },
            { mimeType: 'text/html', body: { data: encode(`<div>${input.text}</div>`) } },
          ],
        },
        { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo-1', size: 1200 } },
      ],
    },
  };
}

function matchesQuery(message: any, query: string) {
  const from = String(message.payload.headers.find((header: any) => header.name === 'From')?.value || '').toLowerCase();
  if (query.includes(`-from:${DEALERSCLOUD}`)) return !from.includes(DEALERSCLOUD);
  if (query.includes(`from:${DEALERSCLOUD}`)) return from.includes(DEALERSCLOUD);
  return true;
}

async function makeLead(extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', email: nextEmail(),
    source: 'Website Inquiry', channel: 'email', status: 'New', subject: 'Tacoma inquiry', comments: 'Is the Tacoma available?', ...extra,
  });
}

async function usePreviousMailbox(replacedAt = new Date()) {
  await OrgLeadConfig.updateOne({ organizationId: orgId }, {
    $set: {
      previousMailbox: {
        gmailAddress: OLD_MAILBOX, accessToken: encrypt('previous-test-access'), refreshToken: encrypt(PREVIOUS_REFRESH),
        expiryDate: Date.now() + 3600000, replacedAt,
      },
    },
  });
  await cacheService.del(`config:org:${ORG}`);
}

function callController(handler: any, req: any): Promise<{ redirect?: string; json?: any; error?: any }> {
  return new Promise((resolve) => {
    const res: any = {
      redirect: (url: string) => resolve({ redirect: url }),
      json: (body: any) => resolve({ json: body }),
      status: () => res,
    };
    handler(req, res, (error: any) => resolve({ error }));
  });
}

async function signIn(email: string, refresh: string, scope = FULL_SCOPE) {
  mockGoogleSignIn.tokens = { access_token: `${refresh}-access`, refresh_token: refresh, expiry_date: Date.now() + 3600000, scope };
  mockGoogleSignIn.email = email;
  const result = await callController(orgLeadController.handleCallback, { query: { code: 'google-code', state: SWITCH_ORG } });
  return decodeURIComponent(result.redirect || '');
}

async function switchConfig(): Promise<any> {
  return OrgLeadConfig.findOne({ organizationId: switchOrgId }).lean();
}

async function resetSwitchOrg() {
  await OrgLeadConfig.deleteMany({ organizationId: switchOrgId });
  await OrgLeadConfig.collection.insertOne({
    organizationId: switchOrgId, connectedBy: ids.switchOwner, gmailAddress: OLD_MAILBOX, accessToken: encrypt('old-access'), refreshToken: encrypt('old-refresh'),
    expiryDate: Date.now() + 3600000, gmailConnected: true, calendarConnected: true, isActive: true, leadSourceEmail: DEALERSCLOUD,
    connectedAt: new Date(Date.now() - 200 * DAY),
  } as any);
  await cacheService.del(`config:org:${SWITCH_ORG}`);
}

describe('Real-DB: switching the dealership email account (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || mongoose.connection.host !== '127.0.0.1') {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    process.env.FRONTEND_URL = 'http://front.test';
    await Promise.all([
      Lead.createIndexes(), ComposerSendClaim.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(), Customer.init(), IntakeClaim.init(),
    ]);
    for (const index of CUSTOMER_IDENTITY_INDEXES) {
      await mongoose.connection.db!.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    }
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Mailbox Dealer', slug: `mailbox-${orgId}`, status: 'active', metadata: {} },
      { _id: switchOrgId, name: 'Switch Dealer', slug: `mailbox-switch-${switchOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `mailbox-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.switchOwner, name: 'Sam Switch', email: `mailbox-switch-${switchOrgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: switchOrgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertOne({ _id: ids.employee, organizationId: orgId, fullName: 'Erin Employee', username: `mailbox-${ids.employee}`, email: `mailbox-emp-${orgId}@example.com`, role: 'admin', isActive: true, permissions: [] } as any);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: NEW_MAILBOX, accessToken: encrypt('local-test-access'), refreshToken: encrypt(MAIN_REFRESH),
      expiryDate: Date.now() + 3600000, gmailConnected: true, calendarConnected: true, isActive: true, leadSourceEmail: DEALERSCLOUD,
    } as any);
    token = generateCrmToken(String(ids.employee));
  });

  beforeEach(async () => {
    threads.clear();
    unread.clear();
    mockThreadsGet.mockReset();
    mockThreadsGet.mockImplementation(async ({ id }: { id: string }, mailbox: string) => {
      const stored = threadsIn(mailbox).get(String(id));
      if (stored) return { data: { id, messages: stored } };
      if (String(id).startsWith('old-') || mailbox !== MAIN_REFRESH) throw notFound();
      return { data: { id, messages: [] } };
    });
    mockMessagesSend.mockReset();
    mockMessagesSend.mockImplementation(async () => ({ data: { id: `gm-${++serial}`, threadId: `th-${serial}` } }));
    mockMessagesList.mockReset();
    mockMessagesList.mockImplementation(async ({ q }: { q: string }, mailbox: string) => ({
      data: { messages: unreadIn(mailbox).filter((message) => matchesQuery(message, q)).map((message) => ({ id: message.id, threadId: message.threadId })) },
    }));
    mockMessagesGet.mockReset();
    mockMessagesGet.mockImplementation(async ({ id }: { id: string }, mailbox: string) => {
      const message = unreadIn(mailbox).find((entry) => entry.id === id);
      if (!message) throw notFound();
      return { data: message };
    });
    mockBatchModify.mockReset();
    mockBatchModify.mockImplementation(async ({ requestBody }: any, mailbox: string) => {
      unread.set(mailbox, unreadIn(mailbox).filter((entry) => !requestBody.ids.includes(entry.id)));
      return { data: {} };
    });
    await OrgLeadConfig.updateOne({ organizationId: orgId }, { $unset: { previousMailbox: 1 } });
    await cacheService.del(`config:org:${ORG}`);
  });

  afterAll(async () => {
    await wait(300);
    if (savedAcceptance === undefined) delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    else process.env.LOCAL_UI_ACCEPTANCE_MODE = savedAcceptance;
    if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = savedFrontend;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/_test$/.test(dbName) && mongoose.connection.host === '127.0.0.1') await mongoose.connection.db!.dropDatabase();
  });

  describe('replying and opening leads after the switch', () => {
    it('a reply on a lead whose email thread is in the previous account starts a new email and remembers the old thread', async () => {
      const lead = await makeLead({ threadId: 'old-thread-1', messageId: 'old-message-1', emailThreadSubject: 'Tacoma inquiry' });

      await sendEmail(lead._id).expect(200);

      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
      const sent = sentEmail();
      expect(sent.threadId).toBeUndefined();
      expect(sent.raw).not.toMatch(/In-Reply-To:/);
      expect(sent.raw).not.toMatch(/References:/);
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.threadId).toMatch(/^th-\d+$/);
      expect(after.previousThreadIds).toEqual(['old-thread-1']);
    });

    it('two replies that both start a new email at the same moment keep both new threads on the lead', async () => {
      const lead = await makeLead({ threadId: 'old-race-1', messageId: 'old-race-message-1', emailThreadSubject: 'Tacoma inquiry' });
      const stale: any = await Lead.findById(lead._id).lean();

      const first = await sendLeadReplyEmail({ ...stale }, 'First answer', String(ids.employee), ORG);
      const second = await sendLeadReplyEmail({ ...stale }, 'Second answer', String(ids.employee), ORG);

      expect(first.threadId).not.toBe(second.threadId);
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.threadId).toBe(first.threadId);
      expect(after.previousThreadIds).toEqual(['old-race-1', second.threadId]);
    });

    it('a reply on a lead whose thread is in the connected account stays in that thread', async () => {
      const lead = await makeLead({ threadId: 'live-thread-1', messageId: 'live-message-1', emailThreadSubject: 'Tacoma inquiry' });

      await sendEmail(lead._id).expect(200);

      const sent = sentEmail();
      expect(sent.threadId).toBe('live-thread-1');
      expect(sent.raw).toMatch(/In-Reply-To: live-message-1/);
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.threadId).toBe('live-thread-1');
      expect(after.previousThreadIds).toBeUndefined();
    });

    it('a lead with no email thread yet gets the new thread saved, as before', async () => {
      const lead = await makeLead();
      await sendEmail(lead._id).expect(200);
      expect(sentEmail().threadId).toBeUndefined();
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.threadId).toMatch(/^th-\d+$/);
      expect(after.previousThreadIds).toBeUndefined();
    });

    it('without a previous account, the lead opens with a short note instead of an email error', async () => {
      const lead = await makeLead({ threadId: 'old-thread-2', messageId: 'old-message-2' });

      const conversation = await request(app).get(`/api/leads/${lead._id}/conversation`).set(auth()).expect(200);
      expect(conversation.body.data.unavailableSources).toContain('email_not_in_mailbox');
      expect(conversation.body.data.unavailableSources).not.toContain('email');

      const thread = await request(app).get(`/api/leads/${lead._id}/thread`).set(auth()).expect(200);
      expect(thread.body.data.messages).toEqual([]);
    });

    it('other Gmail errors still show the usual email warning', async () => {
      const lead = await makeLead({ threadId: 'busy-thread-1' });
      mockThreadsGet.mockImplementation(async () => { throw Object.assign(new Error('Backend Error'), { code: 500 }); });

      const conversation = await request(app).get(`/api/leads/${lead._id}/conversation`).set(auth()).expect(200);
      expect(conversation.body.data.unavailableSources).toContain('email');
      expect(conversation.body.data.unavailableSources).not.toContain('email_not_in_mailbox');
    });

    it('the follow-up checks treat an old thread as no reply instead of failing', async () => {
      const lead: any = await makeLead({ threadId: 'old-thread-3' });
      await expect(customerEmailedSince(lead, 0)).resolves.toBe(false);
      await expect(latestCustomerEmailReplyAt(lead)).resolves.toBe(0);

      mockThreadsGet.mockImplementation(async () => { throw Object.assign(new Error('Backend Error'), { code: 500 }); });
      await expect(customerEmailedSince(lead, 0)).rejects.toThrow('Backend Error');
    });

    it('an older lead shows its emails from the previous account; a thread in neither account shows the note', async () => {
      await usePreviousMailbox();
      const lead = await makeLead({ threadId: 'old-prev-conv-1' });
      threadsIn(PREVIOUS_REFRESH).set('old-prev-conv-1', [
        gmailMessage({ id: 'prev-in-1', threadId: 'old-prev-conv-1', from: `Pat Lee <${lead.email}>`, body: 'Is the Tacoma still there?', at: new Date(Date.now() - 2 * DAY) }),
        gmailMessage({ id: 'prev-out-1', threadId: 'old-prev-conv-1', from: `Action Auto <${OLD_MAILBOX}>`, body: 'Yes it is!', at: new Date(Date.now() - DAY), sent: true }),
      ]);

      const conversation = await request(app).get(`/api/leads/${lead._id}/conversation`).set(auth()).expect(200);
      const emails = conversation.body.data.items.filter((item: any) => item.channel === 'email');
      expect(emails.map((item: any) => [item.messageId, item.direction])).toEqual([['prev-in-1', 'inbound'], ['prev-out-1', 'outbound']]);
      expect(conversation.body.data.unavailableSources).toEqual([]);

      const thread = await request(app).get(`/api/leads/${lead._id}/thread`).set(auth()).expect(200);
      expect(thread.body.data.messages.map((message: any) => [message.id, message.direction])).toEqual([['prev-in-1', 'inbound'], ['prev-out-1', 'outbound']]);

      const gone = await makeLead({ threadId: 'old-gone-1' });
      const goneConversation = await request(app).get(`/api/leads/${gone._id}/conversation`).set(auth()).expect(200);
      expect(goneConversation.body.data.unavailableSources).toEqual(['email_not_in_mailbox']);
    });

    it('after a reply from the new account the lead shows the earlier and the new emails, and an answer to the old email still reaches it', async () => {
      await usePreviousMailbox();
      const lead = await makeLead({
        threadId: 'old-prev-conv-2', messageId: 'prev-first-2', emailThreadSubject: 'Tacoma inquiry',
        followUp: { lastCustomerActivityAt: new Date(Date.now() - 10 * DAY) },
      });
      threadsIn(PREVIOUS_REFRESH).set('old-prev-conv-2', [
        gmailMessage({ id: 'prev-first-2', threadId: 'old-prev-conv-2', from: `Pat Lee <${lead.email}>`, body: 'Is it available?', at: new Date(Date.now() - 3 * DAY) }),
        gmailMessage({ id: 'prev-out-2', threadId: 'old-prev-conv-2', from: `Action Auto <${OLD_MAILBOX}>`, body: 'It is! Want to see it?', at: new Date(Date.now() - 2 * DAY), sent: true }),
      ]);

      await sendEmail(lead._id).expect(200);

      expect(callsFor(mockMessagesSend, MAIN_REFRESH)).toHaveLength(1);
      expect(callsFor(mockMessagesSend, PREVIOUS_REFRESH)).toHaveLength(0);
      const saved: any = await Lead.findById(lead._id).lean();
      expect(saved.previousThreadIds).toEqual(['old-prev-conv-2']);
      threadsIn(MAIN_REFRESH).set(saved.threadId, [
        gmailMessage({ id: 'new-out-2', threadId: saved.threadId, from: `Action Auto <${NEW_MAILBOX}>`, body: 'Yes, it is still available.', sent: true }),
      ]);

      const conversation = await request(app).get(`/api/leads/${lead._id}/conversation`).set(auth()).expect(200);
      const emailIds = conversation.body.data.items.filter((item: any) => item.channel === 'email').map((item: any) => item.messageId);
      expect(emailIds).toEqual(expect.arrayContaining(['prev-first-2', 'prev-out-2', 'new-out-2']));
      expect(emailIds.indexOf('prev-first-2')).toBeLessThan(emailIds.indexOf('prev-out-2'));
      expect(emailIds.indexOf('prev-out-2')).toBeLessThan(emailIds.indexOf('new-out-2'));

      const thread = await request(app).get(`/api/leads/${lead._id}/thread`).set(auth()).expect(200);
      expect(thread.body.data.messages.map((message: any) => message.id)).toEqual(['prev-out-2', 'new-out-2']);

      const answeredAt = new Date(Date.now() - 60000);
      unreadIn(PREVIOUS_REFRESH).push(gmailMessage({ id: `prev-late-reply-${++serial}`, threadId: 'old-prev-conv-2', from: `Pat Lee <${lead.email}>`, body: 'Can I come Saturday?', at: answeredAt }));
      await orgGmailService.syncLeadsForOrg(ORG);
      const answered: any = await Lead.findById(lead._id).lean();
      expect(answered.followUp.lastCustomerActivityAt.getTime()).toBe(answeredAt.getTime());
    });

    it('an earlier thread that cannot be read right now does not hide the emails of the current one', async () => {
      await usePreviousMailbox();
      const lead = await makeLead({ threadId: 'live-current-3', previousThreadIds: ['old-broken-3'] });
      threadsIn(MAIN_REFRESH).set('live-current-3', [
        gmailMessage({ id: 'live-in-3', threadId: 'live-current-3', from: `Pat Lee <${lead.email}>`, body: 'See you at 3.' }),
      ]);
      mockThreadsGet.mockImplementation(async ({ id }: { id: string }, mailbox: string) => {
        const stored = threadsIn(mailbox).get(String(id));
        if (stored) return { data: { id, messages: stored } };
        if (mailbox === PREVIOUS_REFRESH) throw Object.assign(new Error('Backend Error'), { code: 500 });
        throw notFound();
      });

      const conversation = await request(app).get(`/api/leads/${lead._id}/conversation`).set(auth()).expect(200);
      expect(conversation.body.data.items.filter((item: any) => item.channel === 'email').map((item: any) => item.messageId)).toEqual(['live-in-3']);
      expect(conversation.body.data.unavailableSources).toEqual(['email']);

      const thread = await request(app).get(`/api/leads/${lead._id}/thread`).set(auth()).expect(200);
      expect(thread.body.data.messages.map((message: any) => message.id)).toEqual(['live-in-3']);
    });
  });

  describe('reading the previous account', () => {
    it('the sync also reads the previous account: a DealersCloud email there becomes a lead and a customer answer to an old email reaches its lead', async () => {
      await usePreviousMailbox();
      const lead = await makeLead({
        threadId: `th-live-${++serial}`, previousThreadIds: ['old-prev-thread-1'],
        followUp: { lastCustomerActivityAt: new Date(Date.now() - 10 * DAY) },
      });
      const repliedAt = new Date(Date.now() - 60000);
      const leadEmail = gmailMessage({ id: `prev-dc-${++serial}`, threadId: `old-prev-dc-${serial}`, from: `DealersCloud <${DEALERSCLOUD}>`, subject: 'New Internet Lead', body: adfBody('Sam', 'Stone') });
      const reply = gmailMessage({ id: `prev-reply-${++serial}`, threadId: 'old-prev-thread-1', from: `Pat Lee <${lead.email}>`, body: 'Yes, I still want it.', at: repliedAt });
      unreadIn(PREVIOUS_REFRESH).push(leadEmail, reply);

      await orgGmailService.syncLeadsForOrg(ORG);

      expect(callsFor(mockMessagesList, MAIN_REFRESH).length).toBeGreaterThan(0);
      const created: any = await Lead.findOne({ organizationId: orgId, messageId: leadEmail.id }).lean();
      expect(created?.threadId).toBe(leadEmail.threadId);
      expect(callsFor(mockBatchModify, PREVIOUS_REFRESH).flatMap((call) => call[0].requestBody.ids)).toContain(leadEmail.id);
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.followUp.lastCustomerActivityAt.getTime()).toBe(repliedAt.getTime());
      await wait(300);
    });

    it('when the old and the new account both get the same DealersCloud email, only one lead is made', async () => {
      await usePreviousMailbox();
      const n = ++serial;
      const body = adfBody('Dana', `Double${n}`);
      unreadIn(MAIN_REFRESH).push(gmailMessage({ id: `main-dc-${n}`, threadId: `main-dc-thread-${n}`, from: `DealersCloud <${DEALERSCLOUD}>`, subject: 'New Internet Lead', body }));
      unreadIn(PREVIOUS_REFRESH).push(gmailMessage({ id: `prev-dc-${n}`, threadId: `old-dc-thread-${n}`, from: `DealersCloud <${DEALERSCLOUD}>`, subject: 'New Internet Lead', body }));

      await orgGmailService.syncLeadsForOrg(ORG);

      expect(await Lead.countDocuments({ organizationId: orgId, body })).toBe(1);
      expect(callsFor(mockBatchModify, MAIN_REFRESH).flatMap((call) => call[0].requestBody.ids)).toContain(`main-dc-${n}`);
      expect(callsFor(mockBatchModify, PREVIOUS_REFRESH).flatMap((call) => call[0].requestBody.ids)).toContain(`prev-dc-${n}`);
      await wait(300);
    });

    it('without a previous account the sync works exactly as before: each email becomes its own lead', async () => {
      const n = ++serial;
      const body = adfBody('Sam', `Same${n}`, '<vehicle interest="buy"><year>2018</year><make>Ford</make><model>F-150</model></vehicle>');
      unreadIn(MAIN_REFRESH).push(
        gmailMessage({ id: `main-dc-a-${n}`, threadId: `main-dc-thread-a-${n}`, from: `DealersCloud <${DEALERSCLOUD}>`, subject: 'New Internet Lead', body }),
        gmailMessage({ id: `main-dc-b-${n}`, threadId: `main-dc-thread-b-${n}`, from: `DealersCloud <${DEALERSCLOUD}>`, subject: 'New Internet Lead', body }),
      );

      await orgGmailService.syncLeadsForOrg(ORG);

      expect(await Lead.countDocuments({ organizationId: orgId, body })).toBe(2);
      expect(callsFor(mockMessagesList, PREVIOUS_REFRESH)).toHaveLength(0);
      await wait(300);
    });

    it('a Google rate limit during Sync Now does not mark the account as not connected; a real loss of access does, without telling anyone to disconnect', async () => {
      mockMessagesList.mockImplementation(async (_params: any, mailbox: string) => {
        if (mailbox === MAIN_REFRESH) throw Object.assign(new Error('User-rate limit exceeded.'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] });
        return { data: { messages: [] } };
      });
      const limited = await callController(orgLeadController.sync, { orgId: ORG, user: { _id: ids.owner } });
      expect(limited.json?.statusCode).toBe(200);
      expect(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).gmailConnected).toBe(true);

      mockMessagesList.mockImplementation(async (_params: any, mailbox: string) => {
        if (mailbox === MAIN_REFRESH) throw Object.assign(new Error('Daily Limit Exceeded'), { status: 403, response: { status: 403, data: { error: { errors: [{ reason: 'dailyLimitExceeded' }] } } } });
        return { data: { messages: [] } };
      });
      const daily = await callController(orgLeadController.sync, { orgId: ORG, user: { _id: ids.owner } });
      expect(daily.json?.statusCode).toBe(200);
      expect(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).gmailConnected).toBe(true);

      expect((await callController(orgLeadController.getConfig, { orgId: ORG })).json.data.gmailConnected).toBe(true);
      mockMessagesList.mockImplementation(async (_params: any, mailbox: string) => {
        if (mailbox === MAIN_REFRESH) throw Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 });
        return { data: { messages: [] } };
      });
      const lost = await callController(orgLeadController.sync, { orgId: ORG, user: { _id: ids.owner } });
      expect(lost.error?.statusCode).toBe(403);
      expect(lost.error?.message).toMatch(/connect the same account again/);
      expect(lost.error?.message).not.toMatch(/disconnect/i);
      expect(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).gmailConnected).toBe(false);
      expect((await callController(orgLeadController.getConfig, { orgId: ORG })).json.data.gmailConnected).toBe(false);

      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { gmailConnected: true, calendarConnected: true } });
      await cacheService.del(`config:org:${ORG}`);
    });

    it('the previous account is no longer read 90 days after the switch', async () => {
      await usePreviousMailbox(new Date(Date.now() - 91 * DAY));
      unreadIn(PREVIOUS_REFRESH).push(gmailMessage({ id: `prev-late-${++serial}`, threadId: 'old-late-1', from: 'Pat Lee <late@example.com>' }));

      await orgGmailService.syncLeadsForOrg(ORG);

      expect(callsFor(mockMessagesList, MAIN_REFRESH).length).toBeGreaterThan(0);
      expect(callsFor(mockMessagesList, PREVIOUS_REFRESH)).toHaveLength(0);
    });

    it('a Google error on the previous account does not stop the new one; once Google stops giving access, the previous account is forgotten', async () => {
      await usePreviousMailbox();
      mockMessagesList.mockImplementation(async (_params: any, mailbox: string) => {
        if (mailbox === PREVIOUS_REFRESH) throw Object.assign(new Error('Backend Error'), { code: 500 });
        return { data: { messages: [] } };
      });
      await expect(orgGmailService.syncLeadsForOrg(ORG)).resolves.toEqual({ total: 0, synced: 0 });
      expect(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).previousMailbox?.gmailAddress).toBe(OLD_MAILBOX);

      mockMessagesList.mockImplementation(async (_params: any, mailbox: string) => {
        if (mailbox === PREVIOUS_REFRESH) throw Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
        return { data: { messages: [] } };
      });
      await expect(orgGmailService.syncLeadsForOrg(ORG)).resolves.toEqual({ total: 0, synced: 0 });
      expect(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).previousMailbox).toBeUndefined();
      expect(callsFor(mockMessagesList, MAIN_REFRESH).length).toBeGreaterThan(1);
    });

    it('with lead intake on, a customer answer to an email from before the switch is added to the lead that had that email', async () => {
      const intakeOrg = new mongoose.Types.ObjectId();
      await Organization.collection.insertOne({
        _id: intakeOrg, name: 'Intake Mailbox Dealer', slug: `mailbox-intake-${intakeOrg}`, status: 'active',
        metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
      } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(String(intakeOrg));
      const lead = await Lead.create({
        organizationId: intakeOrg, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', email: nextEmail(), source: 'Website Inquiry',
        channel: 'email', status: 'New', threadId: 'th-new-intake-1', previousThreadIds: ['old-intake-1'],
      });
      const message = gmailMessage({ id: `intake-reply-${++serial}`, threadId: 'old-intake-1', from: `Pat Lee <${lead.email}>` });

      const result = await processGmailMessageThroughIntake({
        organizationId: String(intakeOrg), message, rawBody: 'Is it still available?', leadSourceEmail: DEALERSCLOUD,
        systemUserId: String(ids.owner), allowNewInquiry: false,
      });

      expect(result.status).toBe('associated');
      const inquiry: any = await LeadInquiry.findOne({ organizationId: intakeOrg, 'sourceIds.gmailMessageId': message.id }).lean();
      expect(inquiry.kind).toBe('email_reply');
      expect(String(inquiry.association.leadId)).toBe(String(lead._id));
    });

    it('with lead intake on, a customer answer that has a logo or an attachment still reaches the lead through the sync', async () => {
      const intakeOrg = new mongoose.Types.ObjectId();
      const intakeOwner = new mongoose.Types.ObjectId();
      await Organization.collection.insertOne({
        _id: intakeOrg, name: 'Logo Reply Dealer', slug: `mailbox-logo-${intakeOrg}`, status: 'active',
        metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
      } as any);
      await User.collection.insertOne({ _id: intakeOwner, name: 'Lou Logo', email: `mailbox-logo-${intakeOrg}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: intakeOrg, isActive: true } as any);
      await OrgLeadConfig.collection.insertOne({
        organizationId: intakeOrg, connectedBy: intakeOwner, gmailAddress: 'logo-dealer@example.com', accessToken: encrypt('logo-access'), refreshToken: encrypt('logo-refresh'),
        expiryDate: Date.now() + 3600000, gmailConnected: true, calendarConnected: true, isActive: true, leadSourceEmail: DEALERSCLOUD,
      } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(String(intakeOrg));
      const lead = await Lead.create({
        organizationId: intakeOrg, createdBy: intakeOwner, firstName: 'Pat', lastName: 'Lee', email: nextEmail(), source: 'Website Inquiry',
        channel: 'email', status: 'New', threadId: 'th-logo-1',
      });
      const reply = replyWithLogo({ id: `logo-reply-${++serial}`, threadId: 'th-logo-1', from: `Pat Lee <${lead.email}>`, text: 'Yes, Saturday at 10 works. Photos of my trade-in attached.' });
      unreadIn('logo-refresh').push(reply);

      await orgGmailService.syncLeadsForOrg(String(intakeOrg));

      const inquiry: any = await LeadInquiry.findOne({ organizationId: intakeOrg, 'sourceIds.gmailMessageId': reply.id }).lean();
      expect(inquiry?.kind).toBe('email_reply');
      expect(String(inquiry?.association?.leadId)).toBe(String(lead._id));
      expect(inquiry?.comments).toContain('Saturday at 10 works');
      expect(callsFor(mockBatchModify, 'logo-refresh').flatMap((call) => call[0].requestBody.ids)).toContain(reply.id);
    });

    it('the Leads tab email panel shows the text of an email that has a logo or an attachment', async () => {
      const lead = await makeLead({ threadId: 'live-logo-thread-1' });
      threadsIn(MAIN_REFRESH).set('live-logo-thread-1', [
        replyWithLogo({ id: 'live-logo-1', threadId: 'live-logo-thread-1', from: `Pat Lee <${lead.email}>`, text: 'Here are the photos you asked for.' }),
      ]);

      const thread = await request(app).get(`/api/leads/${lead._id}/thread`).set(auth()).expect(200);

      expect(thread.body.data.messages.map((message: any) => [message.id, message.body])).toEqual([['live-logo-1', 'Here are the photos you asked for.']]);
    });

    it('a late sign-in refresh from the replaced account does not overwrite the new account', async () => {
      const original: any = await OrgLeadConfig.findOne({ organizationId: orgId }).lean();
      const stale: any = await getCentralOAuth2Client(ORG);
      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { refreshToken: encrypt('switched-refresh'), accessToken: encrypt('switched-access') } });

      await stale.handlers.tokens({ access_token: 'late-old-access', expiry_date: Date.now() + 3600000 });
      expect(decrypt(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).accessToken)).toBe('switched-access');

      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { refreshToken: original.refreshToken, accessToken: original.accessToken } });
      await cacheService.del(`config:org:${ORG}`);
      const current: any = await getCentralOAuth2Client(ORG);
      await current.handlers.tokens({ access_token: 'fresh-access', expiry_date: Date.now() + 3600000 });
      expect(decrypt(((await OrgLeadConfig.findOne({ organizationId: orgId }).lean()) as any).accessToken)).toBe('fresh-access');
      await OrgLeadConfig.updateOne({ organizationId: orgId }, { $set: { accessToken: original.accessToken } });
      await cacheService.del(`config:org:${ORG}`);
    });
  });

  describe('switching the account from Lead Integrations', () => {
    it('Switch account keeps the old account as the previous one, and signing in again with the same account keeps it', async () => {
      await resetSwitchOrg();

      const redirect = await signIn('leads@actionauto.example.com', 'leads-refresh');

      expect(redirect).toBe('http://front.test/crm/settings/integrations?success=gmail_connected');
      let config = await switchConfig();
      expect(config.gmailAddress).toBe('leads@actionauto.example.com');
      expect(decrypt(config.refreshToken)).toBe('leads-refresh');
      expect(config.calendarConnected).toBe(true);
      expect(config.previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
      expect(decrypt(config.previousMailbox.refreshToken)).toBe('old-refresh');
      expect(decrypt(config.previousMailbox.accessToken)).toBe('old-access');
      expect(Date.now() - new Date(config.previousMailbox.replacedAt).getTime()).toBeLessThan(60000);

      await signIn('LEADS@actionauto.example.com', 'leads-refresh-2');
      config = await switchConfig();
      expect(decrypt(config.refreshToken)).toBe('leads-refresh-2');
      expect(config.previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
      expect(decrypt(config.previousMailbox.refreshToken)).toBe('old-refresh');
    });

    it('picking the wrong Google account first does not lose the old account', async () => {
      await resetSwitchOrg();
      await signIn('someone.personal@example.com', 'personal-refresh');
      await signIn('leads@actionauto.example.com', 'leads-refresh');
      let config = await switchConfig();
      expect(config.gmailAddress).toBe('leads@actionauto.example.com');
      expect(config.previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
      expect(decrypt(config.previousMailbox.refreshToken)).toBe('old-refresh');

      await resetSwitchOrg();
      await signIn('someone.personal@example.com', 'personal-refresh');
      await signIn(OLD_MAILBOX, 'old-refresh-again');
      config = await switchConfig();
      expect(config.gmailAddress).toBe(OLD_MAILBOX);
      expect(config.previousMailbox).toBeUndefined();
    });

    it('the old account is kept even when an earlier Google error had marked it as not connected', async () => {
      await resetSwitchOrg();
      await OrgLeadConfig.updateOne({ organizationId: switchOrgId }, { $set: { gmailConnected: false, calendarConnected: false } });

      await signIn('leads@actionauto.example.com', 'leads-refresh');

      const config = await switchConfig();
      expect(config.gmailAddress).toBe('leads@actionauto.example.com');
      expect(config.gmailConnected).toBe(true);
      expect(config.previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
      expect(decrypt(config.previousMailbox.refreshToken)).toBe('old-refresh');
    });

    it('a switch a day or more after the last one keeps the account being replaced', async () => {
      await resetSwitchOrg();
      await signIn('leads@actionauto.example.com', 'leads-refresh');
      await OrgLeadConfig.updateOne({ organizationId: switchOrgId }, { $set: { 'previousMailbox.replacedAt': new Date(Date.now() - 2 * DAY) } });

      await signIn('sales@actionauto.example.com', 'sales-refresh');

      const config = await switchConfig();
      expect(config.gmailAddress).toBe('sales@actionauto.example.com');
      expect(config.previousMailbox.gmailAddress).toBe('leads@actionauto.example.com');
      expect(decrypt(config.previousMailbox.refreshToken)).toBe('leads-refresh');
    });

    it('a Google sign-in without email access is refused and changes nothing; without calendar access the email still connects', async () => {
      await resetSwitchOrg();
      const before = await switchConfig();

      const refused = await signIn('leads@actionauto.example.com', 'leads-refresh', FULL_SCOPE.replace('https://www.googleapis.com/auth/gmail.modify', ''));

      expect(refused).toBe('http://front.test/crm/settings/integrations?error=email_access');
      const after = await switchConfig();
      expect(after.gmailAddress).toBe(OLD_MAILBOX);
      expect(after.refreshToken).toBe(before.refreshToken);
      expect(after.previousMailbox).toBeUndefined();

      await signIn('leads@actionauto.example.com', 'leads-refresh', FULL_SCOPE.replace('https://www.googleapis.com/auth/calendar.events', ''));
      const connected = await switchConfig();
      expect(connected.gmailAddress).toBe('leads@actionauto.example.com');
      expect(connected.gmailConnected).toBe(true);
      expect(connected.calendarConnected).toBe(false);
    });

    it('saving the lead source email does not send any sign-in data back', async () => {
      await resetSwitchOrg();
      await signIn('leads@actionauto.example.com', 'leads-refresh');

      const saved = (await callController(orgLeadController.updateConfig, { orgId: SWITCH_ORG, body: { leadSourceEmail: DEALERSCLOUD, isActive: true } })).json;

      expect(saved.data).toEqual({ leadSourceEmail: DEALERSCLOUD, isActive: true });
      expect(JSON.stringify(saved)).not.toMatch(/token|secret/i);
      expect((await switchConfig()).previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
    });

    it('Lead Integrations shows the previous account while it is still checked, and Disconnect forgets it', async () => {
      await resetSwitchOrg();
      await signIn('leads@actionauto.example.com', 'leads-refresh');

      let shown = (await callController(orgLeadController.getConfig, { orgId: SWITCH_ORG })).json.data;
      expect(shown.gmailAddress).toBe('leads@actionauto.example.com');
      expect(shown.previousMailbox.gmailAddress).toBe(OLD_MAILBOX);
      expect(new Date(shown.previousMailbox.readUntil).getTime() - Date.now()).toBeGreaterThan(89 * DAY);
      expect(JSON.stringify(shown)).not.toMatch(/refresh|accessToken/i);

      await OrgLeadConfig.updateOne({ organizationId: switchOrgId }, { $set: { 'previousMailbox.replacedAt': new Date(Date.now() - 91 * DAY) } });
      await cacheService.del(`config:org:${SWITCH_ORG}`);
      shown = (await callController(orgLeadController.getConfig, { orgId: SWITCH_ORG })).json.data;
      expect(shown.previousMailbox).toBeNull();

      await callController(orgLeadController.disconnect, { orgId: SWITCH_ORG });
      expect((await switchConfig()).previousMailbox).toBeUndefined();
    });
  });
});
