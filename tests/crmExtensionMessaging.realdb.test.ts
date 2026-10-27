const mockThreadsGet = jest.fn();
const mockMessagesSend = jest.fn();
const mockSendSms = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: mockThreadsGet }, messages: { get: jest.fn(), list: jest.fn(), send: mockMessagesSend, modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), generateAuthUrl: jest.fn(), getToken: jest.fn() })) },
    calendar: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: (...args: unknown[]) => mockSendSms(...args),
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
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import ComposerSendClaim from '../src/models/ComposerSendClaim.model';
import WebChatSession from '../src/models/WebChatSession.model';
import UserActivity from '../src/models/UserActivity.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { issueCrmExtensionToken } from '../src/middleware/crmExtensionAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import extensionRoutes from '../src/routes/crmExtension.routes';
import crmRoutes from '../src/routes/crm.route';
import communicationRoutes from '../src/routes/communication.routes';
import { encrypt } from '../src/utils/crypto';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.use('/api/crm/extension', extensionRoutes);
app.use('/api/crm/communications', communicationRoutes);
app.use('/api/crm', crmRoutes);
app.use(errorHandler);

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids = {
  owner: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  burst: new mongoose.Types.ObjectId(),
  other: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(8000 + (++serial)).slice(-4)}`;
const nextEmail = () => `ext-msg${++serial}@example.com`;
const nextRequestId = () => `ext-${Date.now()}-${++serial}-abcdef`;
const saved = {
  acceptance: process.env.LOCAL_UI_ACCEPTANCE_MODE,
  messaging: process.env.CRM_EXTENSION_MESSAGING_ENABLED,
  ai: process.env.AI_AGENT_ENABLED,
  skipLimit: process.env.SKIP_RATE_LIMIT,
};

const ext = (method: 'get' | 'post', path: string, who = 'employee') =>
  request(app)[method](`/api/crm/extension${path}`).set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${tokens[who]}`);
const replyOptions = (leadId: unknown, who = 'employee') => ext('get', `/leads/${leadId}/reply-options`, who);
const sendText = (leadId: unknown, body: Record<string, unknown>, who = 'employee') => ext('post', `/leads/${leadId}/sms`, who).send(body);
const sendEmail = (leadId: unknown, body: Record<string, unknown>, who = 'employee') => ext('post', `/leads/${leadId}/email`, who).send(body);
const codeOf = (res: request.Response) => res.body?.errors?.[0]?.code || res.body?.code;

function rawEmail(callIndex = 0): string {
  const raw = mockMessagesSend.mock.calls[callIndex][0].requestBody.raw as string;
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}, organizationId = orgId) {
  return Lead.create({
    organizationId, createdBy: ids.owner, firstName: 'Avery', lastName: 'Brooks', phone: contact.phone, email: contact.email,
    source: 'Website Inquiry', channel: 'web', status: 'New', subject: 'Tacoma inquiry', comments: 'Is the Tacoma available?', ...extra,
  });
}

async function setDealershipMessaging(enabled: boolean, organizationId = orgId) {
  await Organization.updateOne({ _id: organizationId }, { $set: { 'metadata.extensionMessagingEnabled': enabled } });
}

async function setMode(mode: 'off' | 'active') {
  await setLeadIntakeMode({ organizationId: ORG, mode, reason: `test ${mode}`, actor: { userId: String(ids.admin), name: 'Morgan Admin' } });
  clearLeadIntakeModeCache();
}

describe('Real-DB: Chrome extension texting and email (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    process.env.CRM_EXTENSION_MESSAGING_ENABLED = 'true';
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), LeadIntakeControl.init(), LeadIntakeAudit.init(), ComposerSendClaim.init(), SmsOptOut.init()]);
    const liveModes = { aiAgentEnabled: true, aiAgentModes: { sms: 'live', email: 'live', webchat: 'live' } };
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Extension Motors', slug: `ext-msg-${orgId}`, status: 'active', metadata: { ...liveModes } },
      { _id: otherOrgId, name: 'Other Motors', slug: `ext-msg-${otherOrgId}`, status: 'active', metadata: { ...liveModes, extensionMessagingEnabled: true } },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `ext-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertMany([
      { _id: ids.admin, organizationId: orgId, fullName: 'Morgan Admin', username: `ext-admin-${orgId}`, email: `ext-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.employee, organizationId: orgId, fullName: 'Riley Employee', username: `ext-emp-${orgId}`, email: `ext-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.burst, organizationId: orgId, fullName: 'Sam Burst', username: `ext-burst-${orgId}`, email: `ext-burst-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.other, organizationId: otherOrgId, fullName: 'Other Employee', username: `ext-other-${orgId}`, email: `ext-other-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await OrgLeadConfig.collection.insertMany([
      {
        organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'sales@extension.example.com', accessToken: encrypt('local-test-access'), refreshToken: encrypt('local-test-refresh'),
        expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true, leadSourceEmail: 'leads@dealerscloud.com',
      },
    ] as any[]);
    for (const who of ['admin', 'employee', 'burst', 'other'] as const) {
      tokens[who] = (await issueCrmExtensionToken(String(ids[who]))).token;
    }
    tokens.web = generateCrmToken(String(ids.employee));
    tokens.webAdmin = generateCrmToken(String(ids.admin));
  });

  beforeEach(async () => {
    clearLeadIntakeModeCache();
    process.env.CRM_EXTENSION_MESSAGING_ENABLED = 'true';
    await setDealershipMessaging(true);
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `tx-${++serial}` }));
    mockMessagesSend.mockReset();
    mockMessagesSend.mockImplementation(async () => ({ data: { id: `gm-${++serial}`, threadId: `th-${serial}` } }));
    mockThreadsGet.mockReset();
    mockThreadsGet.mockResolvedValue({ data: { messages: [] } });
  });

  afterAll(async () => {
    for (const [key, value] of [
      ['LOCAL_UI_ACCEPTANCE_MODE', saved.acceptance],
      ['CRM_EXTENSION_MESSAGING_ENABLED', saved.messaging],
      ['AI_AGENT_ENABLED', saved.ai],
      ['SKIP_RATE_LIMIT', saved.skipLimit],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  describe('on and off switches', () => {
    it('is off for a dealership until an admin turns it on, and nothing can be sent while off', async () => {
      await setDealershipMessaging(false);
      const phone = nextPhone();
      const lead = await makeLead({ phone, email: nextEmail() });
      const options = await replyOptions(lead._id).expect(200);
      expect(options.body.data.messaging).toMatchObject({ enabled: false, code: 'EXTENSION_MESSAGING_DEALERSHIP_OFF' });
      expect(options.body.data.sms).toBeNull();
      const text = await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(403);
      expect(codeOf(text)).toBe('EXTENSION_MESSAGING_DEALERSHIP_OFF');
      const email = await sendEmail(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: 'x@example.com' }).expect(403);
      expect(codeOf(email)).toBe('EXTENSION_MESSAGING_DEALERSHIP_OFF');
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it('stays off on a server without the extension messaging switch, even when the dealership turned it on', async () => {
      delete process.env.CRM_EXTENSION_MESSAGING_ENABLED;
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      const options = await replyOptions(lead._id).expect(200);
      expect(options.body.data.messaging).toMatchObject({ enabled: false, code: 'EXTENSION_MESSAGING_OFF' });
      const res = await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(403);
      expect(codeOf(res)).toBe('EXTENSION_MESSAGING_OFF');
      process.env.CRM_EXTENSION_MESSAGING_ENABLED = 'yes';
      await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(403);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('lets only an admin change the dealership setting, and the setting starts off', async () => {
      await Organization.updateOne({ _id: orgId }, { $unset: { 'metadata.extensionMessagingEnabled': '' } });
      const before = await request(app).get('/api/crm/org-settings').set('Authorization', `Bearer ${tokens.web}`).expect(200);
      expect(before.body.data.extensionMessagingEnabled).toBe(false);
      expect(before.body.data.extensionMessagingServerEnabled).toBe(true);
      await request(app).patch('/api/crm/org-settings').set('Authorization', `Bearer ${tokens.web}`).send({ extensionMessagingEnabled: true }).expect(403);
      const changed = await request(app).patch('/api/crm/org-settings').set('Authorization', `Bearer ${tokens.webAdmin}`).send({ extensionMessagingEnabled: true, extensionMessagingServerEnabled: false }).expect(200);
      expect(changed.body.data.extensionMessagingEnabled).toBe(true);
      expect((await request(app).get('/api/crm/org-settings').set('Authorization', `Bearer ${tokens.web}`).expect(200)).body.data.extensionMessagingServerEnabled).toBe(true);
      const org: any = await Organization.findById(orgId).lean();
      expect(org.metadata.extensionMessagingEnabled).toBe(true);
      expect(org.metadata.aiAgentModes).toEqual({ sms: 'live', email: 'live', webchat: 'live' });
      await request(app).patch('/api/crm/org-settings').set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${tokens.admin}`).send({ extensionMessagingEnabled: false }).expect(401);
    });
  });

  describe('reply options', () => {
    it('shows the recipient chosen by the server for each channel', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const lead = await makeLead({ phone, email });
      const res = await replyOptions(lead._id).expect(200);
      expect(res.body.data).toMatchObject({
        messaging: { enabled: true },
        mode: 'direct',
        defaultChannel: 'sms',
        sms: { available: true, recipient: phone, recipientDisplay: `(801) 555-${phone.slice(-4)}` },
        email: { available: true, recipient: email, subject: 'Re: Tacoma inquiry' },
      });
    });

    it('explains Web Chat only, missing email, STOP and Do Not Contact', async () => {
      const webchat = await makeLead({ phone: nextPhone(), email: nextEmail() }, { channel: 'webchat', source: 'Website Chat' });
      expect((await replyOptions(webchat._id).expect(200)).body.data.sms).toMatchObject({ available: false, code: 'WEBCHAT_ONLY' });
      const noEmail = await makeLead({ phone: nextPhone() });
      expect((await replyOptions(noEmail._id).expect(200)).body.data.email).toMatchObject({ available: false, code: 'NO_CUSTOMER_EMAIL' });
      const stopped = nextPhone();
      const stoppedLead = await makeLead({ phone: stopped });
      await SmsOptOut.create({ organizationId: ORG, phone: stopped, optedOut: true });
      expect((await replyOptions(stoppedLead._id).expect(200)).body.data.sms).toMatchObject({ available: false, code: 'SMS_OPTED_OUT' });
      const dnc = await makeLead({ phone: nextPhone(), email: nextEmail() }, { status: 'Do Not Contact' });
      const blocked = (await replyOptions(dnc._id).expect(200)).body.data;
      expect(blocked.sms).toMatchObject({ available: false, code: 'CONTACT_RESTRICTED' });
      expect(blocked.email).toMatchObject({ available: false, code: 'CONTACT_RESTRICTED' });
    });

    it("never shows another dealership's lead", async () => {
      const lead = await makeLead({ phone: nextPhone() });
      await replyOptions(lead._id, 'other').expect(404);
      await request(app).get(`/api/crm/extension/leads/${lead._id}/reply-options`).set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${tokens.web}`).expect(401);
    });
  });

  describe('texts', () => {
    it("sends to the lead's own phone, marks it as sent from the extension and pauses the AI Agent for 30 minutes", async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone }, { channel: 'sms', source: 'Inbound SMS' });
      const started = Date.now();
      const res = await sendText(lead._id, { message: '  Hi Avery, the Tacoma is here.  ', clientRequestId: nextRequestId(), recipient: phone, toPhone: '+18015559999' }).expect(201);
      expect(res.body.data).toEqual({ channel: 'sms', duplicate: false });
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(mockSendSms).toHaveBeenCalledWith(phone, 'Hi Avery, the Tacoma is here.');
      const message: any = await CommunicationMessage.findOne({ leadId: lead._id, direction: 'outbound' }).lean();
      expect(message).toMatchObject({ origin: 'chrome_extension', status: 'sent', to: phone, body: 'Hi Avery, the Tacoma is here.' });
      expect(message.sentBy.name).toBe('Riley Employee');
      expect(String(message.sentBy.userId)).toBe(String(ids.employee));
      const conversation: any = await Conversation.findById(message.conversationId).lean();
      const pausedFor = new Date(conversation.aiAutoPausedUntil).getTime() - started;
      expect(pausedFor).toBeGreaterThan(29 * 60000);
      expect(pausedFor).toBeLessThan(31 * 60000);
      expect(conversation.aiPausedAt || null).toBeNull();
    });

    it('sends once when the same request is retried or arrives twice at the same moment', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      const body = { message: 'Only once', clientRequestId: nextRequestId(), recipient: phone };
      await sendText(lead._id, body).expect(201);
      const again = await sendText(lead._id, body).expect(200);
      expect(again.body.data).toEqual({ channel: 'sms', duplicate: true });
      mockSendSms.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { id: `tx-${++serial}` };
      });
      const sameMoment = { message: 'Same moment', clientRequestId: nextRequestId(), recipient: phone };
      const results = await Promise.all([sendText(lead._id, sameMoment), sendText(lead._id, sameMoment)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(codeOf(results.find((r) => r.status === 409)!)).toBe('SEND_IN_PROGRESS');
      expect(mockSendSms).toHaveBeenCalledTimes(2);
      expect(await CommunicationMessage.countDocuments({ leadId: lead._id, direction: 'outbound' })).toBe(2);
    });

    it('refuses when the phone shown in the panel is no longer the lead phone', async () => {
      const lead = await makeLead({ phone: nextPhone() });
      const res = await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: nextPhone() }).expect(409);
      expect(codeOf(res)).toBe('RECIPIENT_CHANGED');
      await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId() }).expect(409);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('requires a message, a valid request id and a reasonable length', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await sendText(lead._id, { message: '   ', clientRequestId: nextRequestId(), recipient: phone }).expect(400);
      await sendText(lead._id, { message: 'Hi', recipient: phone }).expect(400);
      await sendText(lead._id, { message: 'Hi', clientRequestId: 'bad id!', recipient: phone }).expect(400);
      await sendText(lead._id, { message: 'x'.repeat(1601), clientRequestId: nextRequestId(), recipient: phone }).expect(400);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('blocks STOP, Do Not Contact, Web Chat leads, bad numbers and closed leads', async () => {
      const stopped = nextPhone();
      const stoppedLead = await makeLead({ phone: stopped });
      await SmsOptOut.create({ organizationId: ORG, phone: stopped, optedOut: true });
      expect(codeOf(await sendText(stoppedLead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: stopped }).expect(403))).toBe('SMS_OPTED_OUT');

      const dncPhone = nextPhone();
      const dnc = await makeLead({ phone: dncPhone }, { status: 'Do Not Contact' });
      expect(codeOf(await sendText(dnc._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: dncPhone }).expect(403))).toBe('CONTACT_RESTRICTED');

      const chatPhone = nextPhone();
      const chat = await makeLead({ phone: chatPhone }, { channel: 'webchat', source: 'Website Chat' });
      expect(codeOf(await sendText(chat._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: chatPhone }).expect(409))).toBe('WEBCHAT_ONLY');

      const extension = await makeLead({ phone: '385-503-5869 x12' });
      expect(codeOf(await sendText(extension._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: '+13855035869' }).expect(400))).toBe('SMS_INVALID_DESTINATION');

      const closedPhone = nextPhone();
      const closed = await makeLead({ phone: closedPhone }, { status: 'Closed' });
      await setMode('active');
      try {
        expect(codeOf(await sendText(closed._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: closedPhone }).expect(409))).toBe('lead_closed');
      } finally {
        await setMode('off');
      }
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('still blocks a Do Not Contact change made after the panel was opened', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await replyOptions(lead._id).expect(200);
      await Lead.updateOne({ _id: lead._id }, { $set: { status: 'Do Not Contact' } });
      expect(codeOf(await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(403))).toBe('CONTACT_RESTRICTED');
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it("never texts another dealership's lead and rejects a CRM web sign-in", async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await sendText(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }, 'other').expect(404);
      await request(app).post(`/api/crm/extension/leads/${lead._id}/sms`).set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${tokens.web}`)
        .send({ message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(401);
      await request(app).post(`/api/crm/extension/leads/${lead._id}/sms`).set('Origin', 'https://evil.example.com').set('Authorization', `Bearer ${tokens.employee}`)
        .send({ message: 'Hi', clientRequestId: nextRequestId(), recipient: phone }).expect(403);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('marks an unconfirmed provider outcome and never resends it with the same request', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      mockSendSms.mockRejectedValueOnce(new TypeError('fetch failed'));
      const body = { message: 'Did this go?', clientRequestId: nextRequestId(), recipient: phone };
      expect(codeOf(await sendText(lead._id, body).expect(409))).toBe('SEND_UNCERTAIN');
      const stored: any = await CommunicationMessage.findOne({ leadId: lead._id, direction: 'outbound' }).lean();
      expect(stored).toMatchObject({ status: 'pending_reconciliation', origin: 'chrome_extension' });
      expect(codeOf(await sendText(lead._id, body).expect(409))).toBe('SEND_UNCERTAIN');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
    });

    it('limits how many messages one employee can send per minute, without blocking coworkers on the same office connection', async () => {
      process.env.SKIP_RATE_LIMIT = 'false';
      try {
        const phone = nextPhone();
        const lead = await makeLead({ phone });
        for (let i = 0; i < 10; i += 1) {
          await sendText(lead._id, { message: `Burst ${i}`, clientRequestId: nextRequestId(), recipient: phone }, 'burst').expect(201);
        }
        const limited = await sendText(lead._id, { message: 'One too many', clientRequestId: nextRequestId(), recipient: phone }, 'burst').expect(429);
        expect(limited.body.message).toMatch(/Too many messages/);
        await sendText(lead._id, { message: 'Coworker on the same connection', clientRequestId: nextRequestId(), recipient: phone }, 'employee').expect(201);
        expect(mockSendSms).toHaveBeenCalledTimes(11);
      } finally {
        process.env.SKIP_RATE_LIMIT = 'true';
      }
    });
  });

  describe('emails', () => {
    it('sends a plain-text email to the verified customer email with the server subject, without pausing the AI Agent', async () => {
      const email = nextEmail();
      const lead = await makeLead({ email }, { channel: 'email', source: 'Email Inquiry' });
      const body = { message: 'Here are the photos you asked for.', clientRequestId: nextRequestId(), recipient: email.toUpperCase(), subject: 'Ignored subject' };
      const res = await sendEmail(lead._id, body).expect(201);
      expect(res.body.data).toEqual({ channel: 'email', duplicate: false });
      const again = await sendEmail(lead._id, body).expect(200);
      expect(again.body.data).toEqual({ channel: 'email', duplicate: true });
      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
      const raw = rawEmail();
      expect(raw).toContain(`To: ${email}\r\n`);
      expect(raw).toContain('Subject: Re: Tacoma inquiry\r\n');
      expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
      expect(raw).not.toContain('multipart/mixed');
      const after: any = await Lead.findById(lead._id).lean();
      expect(after.status).toBe('Contacted');
      expect(after.aiPausedAt || null).toBeNull();
      expect(after.aiAutoPausedUntil || null).toBeNull();
      const activity: any = await UserActivity.findOne({ 'metadata.leadId': String(lead._id) }).lean();
      expect(activity.metadata).toMatchObject({ source: 'chrome_extension', attachmentCount: 0 });
    });

    it('refuses a changed address, the lead-source inbox, Do Not Contact and a dealership without email connected', async () => {
      const email = nextEmail();
      const lead = await makeLead({ email });
      expect(codeOf(await sendEmail(lead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: nextEmail() }).expect(409))).toBe('RECIPIENT_CHANGED');
      const source = await makeLead({ email: 'leads@dealerscloud.com' });
      expect(codeOf(await sendEmail(source._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: 'leads@dealerscloud.com' }).expect(400))).toBe('NO_CUSTOMER_EMAIL');
      const dncEmail = nextEmail();
      const dnc = await makeLead({ email: dncEmail }, { status: 'Do Not Contact' });
      expect(codeOf(await sendEmail(dnc._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: dncEmail }).expect(403))).toBe('CONTACT_RESTRICTED');
      const otherEmail = nextEmail();
      const otherLead = await makeLead({ email: otherEmail }, {}, otherOrgId);
      expect(codeOf(await sendEmail(otherLead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: otherEmail }, 'other').expect(409))).toBe('EMAIL_NOT_CONNECTED');
      await sendEmail(otherLead._id, { message: 'Hi', clientRequestId: nextRequestId(), recipient: otherEmail }).expect(404);
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it('marks a Gmail timeout as unconfirmed and blocks the same request from sending again', async () => {
      const email = nextEmail();
      const lead = await makeLead({ email });
      mockMessagesSend.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      const body = { message: 'Timeout case', clientRequestId: nextRequestId(), recipient: email };
      expect(codeOf(await sendEmail(lead._id, body).expect(409))).toBe('SEND_UNCERTAIN');
      expect(codeOf(await sendEmail(lead._id, body).expect(409))).toBe('SEND_UNCERTAIN');
      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    });

    it('caps the email length', async () => {
      const email = nextEmail();
      const lead = await makeLead({ email });
      await sendEmail(lead._id, { message: 'x'.repeat(5001), clientRequestId: nextRequestId(), recipient: email }).expect(400);
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });
  });

  describe('AI Agent pause and resume', () => {
    it('pauses and resumes the text conversation with the same rules as Suprah CRM', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone }, { channel: 'sms', source: 'Inbound SMS' });
      await ext('post', `/leads/${lead._id}/ai-pause`).expect(404);
      const conversation = await Conversation.create({ orgId: ORG, customerPhone: phone, leadId: lead._id, lastMessageAt: new Date() });
      const status = await ext('get', `/leads/${lead._id}/ai-status`).expect(200);
      expect(status.body.data).toMatchObject({ channel: 'sms', state: 'live', canControl: true });
      const paused = await ext('post', `/leads/${lead._id}/ai-pause`).expect(200);
      expect(paused.body.data).toEqual({ paused: true });
      const afterPause: any = await Conversation.findById(conversation._id).lean();
      expect(afterPause.aiPausedBy.name).toBe('Riley Employee');
      expect((await ext('get', `/leads/${lead._id}/ai-status`).expect(200)).body.data).toMatchObject({ state: 'paused', label: 'Paused by Riley Employee', canControl: true });
      await ext('post', `/leads/${lead._id}/ai-resume`).expect(200);
      const afterResume: any = await Conversation.findById(conversation._id).lean();
      expect(afterResume.aiPausedAt || null).toBeNull();
      await ext('post', `/leads/${lead._id}/ai-pause`, 'other').expect(404);
    });

    it('uses the email and web chat pause records for those leads', async () => {
      const emailLead = await makeLead({ email: nextEmail() }, { channel: 'email', source: 'Email Inquiry' });
      await ext('post', `/leads/${emailLead._id}/ai-pause`).expect(200);
      expect(((await Lead.findById(emailLead._id).lean()) as any).aiPausedBy.name).toBe('Riley Employee');
      await ext('post', `/leads/${emailLead._id}/ai-resume`).expect(200);
      expect(((await Lead.findById(emailLead._id).lean()) as any).aiPausedAt || null).toBeNull();

      const chatLead = await makeLead({ email: nextEmail() }, { channel: 'webchat', source: 'Website Chat' });
      const session = await WebChatSession.create({ organizationId: ORG, leadId: chatLead._id, tokenHash: `hash-${serial}`, visitorName: 'Avery Brooks', lastMessageAt: new Date() });
      await ext('post', `/leads/${chatLead._id}/ai-pause`).expect(200);
      expect(((await WebChatSession.findById(session._id).lean()) as any).aiPausedAt).toBeTruthy();

      const quiet = await makeLead({}, { channel: 'web' });
      const none = await ext('post', `/leads/${quiet._id}/ai-pause`).expect(409);
      expect(none.body.message).toMatch(/no text, email or chat conversation/);
    });

    it('turns extension Pause and Resume off while extension messaging is off, and the CRM web controls keep working', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone }, { channel: 'sms', source: 'Inbound SMS' });
      const conversation = await Conversation.create({ orgId: ORG, customerPhone: phone, leadId: lead._id, lastMessageAt: new Date() });
      await setDealershipMessaging(false);
      expect((await ext('get', `/leads/${lead._id}/ai-status`).expect(200)).body.data).toMatchObject({ state: 'live', canControl: false });
      expect(codeOf(await ext('post', `/leads/${lead._id}/ai-pause`).expect(403))).toBe('EXTENSION_MESSAGING_DEALERSHIP_OFF');
      expect(((await Conversation.findById(conversation._id).lean()) as any).aiPausedAt || null).toBeNull();
      await request(app).post(`/api/crm/communications/leads/${lead._id}/ai-pause`).set('Authorization', `Bearer ${tokens.web}`).send({}).expect(200);
      expect(((await Conversation.findById(conversation._id).lean()) as any).aiPausedBy.name).toBe('Riley Employee');
      expect(codeOf(await ext('post', `/leads/${lead._id}/ai-resume`).expect(403))).toBe('EXTENSION_MESSAGING_DEALERSHIP_OFF');
      expect(((await Conversation.findById(conversation._id).lean()) as any).aiPausedAt).toBeTruthy();
      await setDealershipMessaging(true);
      delete process.env.CRM_EXTENSION_MESSAGING_ENABLED;
      expect(codeOf(await ext('post', `/leads/${lead._id}/ai-resume`).expect(403))).toBe('EXTENSION_MESSAGING_OFF');
      process.env.CRM_EXTENSION_MESSAGING_ENABLED = 'true';
      await ext('post', `/leads/${lead._id}/ai-resume`).expect(200);
      expect(((await Conversation.findById(conversation._id).lean()) as any).aiPausedAt || null).toBeNull();
    });

    it('shows no pause control while the AI Agent is in training or off', async () => {
      await Organization.updateOne({ _id: orgId }, { $set: { 'metadata.aiAgentModes.email': 'training' } });
      try {
        const lead = await makeLead({ email: nextEmail() }, { channel: 'email', source: 'Email Inquiry' });
        expect((await ext('get', `/leads/${lead._id}/ai-status`).expect(200)).body.data).toMatchObject({ state: 'training', canControl: false });
      } finally {
        await Organization.updateOne({ _id: orgId }, { $set: { 'metadata.aiAgentModes.email': 'live' } });
      }
    });
  });
});
