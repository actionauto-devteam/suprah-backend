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
import { CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import communicationRoutes from '../src/routes/communication.routes';
import { encrypt } from '../src/utils/crypto';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use('/api/crm/communications', communicationRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids = { owner: new mongoose.Types.ObjectId(), employee: new mongoose.Types.ObjectId(), otherEmployee: new mongoose.Types.ObjectId() };
const admin = { userId: String(ids.employee), name: 'Erin' };
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(7000 + (++serial)).slice(-4)}`;
const nextEmail = () => `composer${++serial}@example.com`;
const nextRequestId = () => `req-${Date.now()}-${++serial}-abcdef`;
const savedAcceptance = process.env.LOCAL_UI_ACCEPTANCE_MODE;

const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const options = (leadId: unknown, who = 'employee') => request(app).get(`/api/leads/${leadId}/reply-options`).set(auth(who));
const sendText = (body: Record<string, unknown>, who = 'employee') =>
  request(app).post('/api/crm/communications/messages').set(auth(who)).send(body);
const sendEmail = (leadId: unknown, fields: Record<string, string>, who = 'employee') => {
  const req = request(app).post(`/api/leads/${leadId}/reply`).set(auth(who));
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  return req;
};
const codeOf = (res: request.Response) => res.body?.code || res.body?.errors?.[0]?.code;

function rawEmail(callIndex = 0): string {
  const raw = mockMessagesSend.mock.calls[callIndex][0].requestBody.raw as string;
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}, organizationId = orgId) {
  return Lead.create({
    organizationId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Website Inquiry', channel: 'web', status: 'New', subject: 'Tacoma inquiry', comments: 'Is the Tacoma available?', ...extra,
  });
}

async function setMode(mode: 'off' | 'active' | 'paused') {
  await setLeadIntakeMode({ organizationId: ORG, mode, reason: `test ${mode}`, actor: admin });
  clearLeadIntakeModeCache();
}

describe('Real-DB: SMS / Email composer (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    await Promise.all([Lead.createIndexes(), LeadIntakeControl.init(), LeadIntakeAudit.init(), ComposerSendClaim.init(), SmsOptOut.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Composer Dealer', slug: `composer-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `composer-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `composer-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertMany([
      { _id: ids.employee, organizationId: orgId, fullName: 'Erin Employee', username: `composer-${ids.employee}`, email: `composer-emp-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.otherEmployee, organizationId: otherOrgId, fullName: 'Other Employee', username: `composer-${ids.otherEmployee}`, email: `composer-other-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await OrgLeadConfig.collection.insertMany([
      {
        organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'sales@composer.example.com', accessToken: encrypt('local-test-access'), refreshToken: encrypt('local-test-refresh'),
        expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true, leadSourceEmail: 'leads@dealerscloud.com',
      },
      {
        organizationId: otherOrgId, connectedBy: ids.owner, gmailAddress: 'sales@other.example.com', refreshToken: '', gmailConnected: false, isActive: true,
      },
    ] as any[]);
    tokens.employee = generateCrmToken(String(ids.employee));
    tokens.other = generateCrmToken(String(ids.otherEmployee));
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `tx-${++serial}` }));
    mockMessagesSend.mockReset();
    mockMessagesSend.mockImplementation(async () => ({ data: { id: `gm-${++serial}`, threadId: `th-${serial}` } }));
    mockThreadsGet.mockReset();
    mockThreadsGet.mockResolvedValue({ data: { messages: [] } });
  });

  afterAll(async () => {
    if (savedAcceptance === undefined) delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    else process.env.LOCAL_UI_ACCEPTANCE_MODE = savedAcceptance;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  describe('reply options', () => {
    it('shows the verified phone number and email, and starts on text for a lead with a phone', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const lead = await makeLead({ phone: `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`, email: email.toUpperCase() });
      const res = await options(lead._id).expect(200);
      expect(res.body.data).toMatchObject({
        mode: 'direct',
        defaultChannel: 'sms',
        sms: { available: true, recipient: phone, reason: null },
        email: { available: true, recipient: email, subject: 'Re: Tacoma inquiry', subjectLocked: false },
      });
    });

    it('starts on email and explains why texting is unavailable when there is no phone', async () => {
      const lead = await makeLead({ email: nextEmail() });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.defaultChannel).toBe('email');
      expect(res.body.data.sms).toMatchObject({ available: false, code: 'NO_PHONE' });
      expect(res.body.data.sms.reason).toMatch(/no valid phone number/i);
    });

    it('does not offer a phone number with an extension, and never switches to email on its own', async () => {
      const lead = await makeLead({ phone: '801-555-0100 ext 4', email: nextEmail() });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.sms).toMatchObject({ available: false, code: 'SMS_INVALID_DESTINATION' });
      expect(res.body.data.defaultChannel).toBe('sms');
      expect(res.body.data.email.available).toBe(true);
    });

    it('turns texting off after STOP but keeps email one click away', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone, email: nextEmail() });
      await SmsOptOut.create({ organizationId: ORG, phone, optedOut: true });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.sms).toMatchObject({ available: false, code: 'SMS_OPTED_OUT', recipient: phone });
      expect(res.body.data.email.available).toBe(true);
      expect(res.body.data.defaultChannel).toBe('sms');
    });

    it('blocks both channels for a Do Not Contact customer', async () => {
      const lead = await makeLead({ phone: nextPhone(), email: nextEmail() }, { status: 'Do Not Contact' });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.sms).toMatchObject({ available: false, code: 'CONTACT_RESTRICTED' });
      expect(res.body.data.email).toMatchObject({ available: false, code: 'CONTACT_RESTRICTED' });
    });

    it('never offers the lead-source or dealership inbox as the customer email', async () => {
      const lead = await makeLead({ phone: nextPhone(), email: 'leads@dealerscloud.com' });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.email).toMatchObject({ available: false, code: 'NO_CUSTOMER_EMAIL', recipient: null });
      const adf = await makeLead({ phone: nextPhone() }, { channel: 'adf', senderEmail: 'leads@dealerscloud.com' });
      expect((await options(adf._id).expect(200)).body.data.email.reason).toMatch(/no customer email on file/);
      const legacy = await makeLead({ phone: nextPhone() }, { channel: 'email', senderEmail: nextEmail() });
      expect((await options(legacy._id).expect(200)).body.data.email.reason).toMatch(/original sender address/);
      const own = await makeLead({ email: 'Sales@Composer.example.com' });
      expect((await options(own._id).expect(200)).body.data.email).toMatchObject({ available: false, code: 'NO_CUSTOMER_EMAIL' });
    });

    it('says so when email is not connected for the dealership', async () => {
      const lead = await makeLead({ email: nextEmail() }, {}, otherOrgId);
      const res = await options(lead._id, 'other').expect(200);
      expect(res.body.data.email).toMatchObject({ available: false, code: 'EMAIL_NOT_CONNECTED' });
    });

    it('locks the subject once the lead has an email thread', async () => {
      const lead = await makeLead({ email: nextEmail() }, { threadId: 'existing-thread' });
      const res = await options(lead._id).expect(200);
      expect(res.body.data.email).toMatchObject({ subject: 'Re: Tacoma inquiry', subjectLocked: true });
    });

    it('keeps Web Chat leads Web Chat only', async () => {
      const lead = await makeLead({ phone: nextPhone(), email: nextEmail() }, { channel: 'webchat', source: 'Website Chat' });
      const res = await options(lead._id).expect(200);
      expect(res.body.data).toMatchObject({ mode: 'webchat', defaultChannel: null, sms: { available: false, code: 'WEBCHAT_ONLY' }, email: { available: false, code: 'WEBCHAT_ONLY' } });
    });

    it('blocks a closed lead only while lifecycle intake is on', async () => {
      const lead = await makeLead({ phone: nextPhone(), email: nextEmail() }, { status: 'Closed' });
      expect((await options(lead._id).expect(200)).body.data.sms.available).toBe(true);
      await setMode('active');
      try {
        const res = await options(lead._id).expect(200);
        expect(res.body.data.sms).toMatchObject({ available: false, code: 'lead_closed' });
        expect(res.body.data.email).toMatchObject({ available: false, code: 'lead_closed' });
      } finally {
        await setMode('off');
      }
    });

    it('keeps reply options private to the dealership and signed-in staff', async () => {
      const lead = await makeLead({ phone: nextPhone(), email: nextEmail() });
      await options(lead._id, 'other').expect(404);
      await request(app).get(`/api/leads/${lead._id}/reply-options`).expect(401);
    });
  });

  describe('text sends', () => {
    it('sends once and returns the original text when the same request is retried', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone, email: nextEmail() });
      const clientRequestId = nextRequestId();
      const body = { toPhone: phone, body: 'Hi Pat, the Tacoma is here.', leadId: String(lead._id), clientRequestId };
      const first = await sendText(body).expect(201);
      const second = await sendText(body).expect(200);
      expect(second.body.data.duplicate).toBe(true);
      expect(String(second.body.data.message._id)).toBe(String(first.body.data.message._id));
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await CommunicationMessage.countDocuments({ leadId: lead._id, direction: 'outbound' })).toBe(1);
    });

    it('sends one text when the same request arrives twice at the same moment', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      mockSendSms.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { id: `tx-${++serial}` };
      });
      const body = { toPhone: phone, body: 'Same moment', leadId: String(lead._id), clientRequestId: nextRequestId() };
      const results = await Promise.all([sendText(body), sendText(body)]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(codeOf(results.find((res) => res.status === 409)!)).toBe('SEND_IN_PROGRESS');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await CommunicationMessage.countDocuments({ leadId: lead._id, direction: 'outbound' })).toBe(1);
    });

    it('refuses a reused request with a different message', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      const clientRequestId = nextRequestId();
      await sendText({ toPhone: phone, body: 'First', leadId: String(lead._id), clientRequestId }).expect(201);
      const res = await sendText({ toPhone: phone, body: 'Changed', leadId: String(lead._id), clientRequestId }).expect(409);
      expect(codeOf(res)).toBe('SEND_REQUEST_MISMATCH');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
    });

    it("refuses to text a number that isn't the lead's current phone", async () => {
      const lead = await makeLead({ phone: nextPhone() });
      const res = await sendText({ toPhone: nextPhone(), body: 'Wrong number', leadId: String(lead._id), clientRequestId: nextRequestId() }).expect(409);
      expect(codeOf(res)).toBe('RECIPIENT_CHANGED');
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('marks an unconfirmed provider outcome and never resends it automatically', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      mockSendSms.mockRejectedValueOnce(new TypeError('fetch failed'));
      const body = { toPhone: phone, body: 'Did this go?', leadId: String(lead._id), clientRequestId: nextRequestId() };
      const first = await sendText(body).expect(409);
      expect(codeOf(first)).toBe('SEND_UNCERTAIN');
      const stored: any = await CommunicationMessage.findOne({ leadId: lead._id, direction: 'outbound' }).lean();
      expect(stored.status).toBe('pending_reconciliation');
      const retry = await sendText(body).expect(409);
      expect(codeOf(retry)).toBe('SEND_UNCERTAIN');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      await sendText({ ...body, clientRequestId: nextRequestId() }).expect(201);
      expect(mockSendSms).toHaveBeenCalledTimes(2);
    });

    it('lets staff retry the same text after the provider clearly rejected it', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      mockSendSms.mockRejectedValueOnce(Object.assign(new Error('Telnyx API error 422'), { status: 422 }));
      const body = { toPhone: phone, body: 'Retry me', leadId: String(lead._id), clientRequestId: nextRequestId() };
      await sendText(body).expect(502);
      await sendText(body).expect(201);
      expect(mockSendSms).toHaveBeenCalledTimes(2);
    });

    it('keeps the old behavior for senders that do not use the composer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      const body = { toPhone: phone, body: 'Legacy send', leadId: String(lead._id) };
      await sendText(body).expect(201);
      await sendText(body).expect(201);
      expect(mockSendSms).toHaveBeenCalledTimes(2);
      mockSendSms.mockRejectedValueOnce(new TypeError('fetch failed'));
      await sendText(body).expect(502);
      const failed: any = await CommunicationMessage.findOne({ leadId: lead._id, status: 'failed' }).lean();
      expect(failed).toBeTruthy();
    });

    it('still blocks STOP, Do Not Contact and closed leads for composer sends', async () => {
      const stopped = nextPhone();
      const stoppedLead = await makeLead({ phone: stopped });
      await SmsOptOut.create({ organizationId: ORG, phone: stopped, optedOut: true });
      const stop = await sendText({ toPhone: stopped, body: 'Hi', leadId: String(stoppedLead._id), clientRequestId: nextRequestId() }).expect(403);
      expect(codeOf(stop)).toBe('SMS_OPTED_OUT');

      const dncPhone = nextPhone();
      const dnc = await makeLead({ phone: dncPhone }, { status: 'Do Not Contact' });
      const blocked = await sendText({ toPhone: dncPhone, body: 'Hi', leadId: String(dnc._id), clientRequestId: nextRequestId() }).expect(403);
      expect(codeOf(blocked)).toBe('CONTACT_RESTRICTED');

      const closedPhone = nextPhone();
      const closed = await makeLead({ phone: closedPhone }, { status: 'Closed' });
      await setMode('active');
      try {
        const res = await sendText({ toPhone: closedPhone, body: 'Hi', leadId: String(closed._id), clientRequestId: nextRequestId() }).expect(409);
        expect(codeOf(res)).toBe('lead_closed');
      } finally {
        await setMode('off');
      }
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it("never sends another dealership's lead", async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await sendText({ toPhone: phone, body: 'Hi', leadId: String(lead._id), clientRequestId: nextRequestId() }, 'other').expect(404);
      expect(mockSendSms).not.toHaveBeenCalled();
    });
  });

  describe('email sends', () => {
    it('sends with the chosen subject once, then keeps that subject for the new thread', async () => {
      const email = nextEmail();
      const lead = await makeLead({ email });
      const clientRequestId = nextRequestId();
      const fields = { message: 'Here are the photos you asked for.', subject: 'Your Tacoma photos', clientRequestId };
      await sendEmail(lead._id, fields).expect(200);
      const retry = await sendEmail(lead._id, fields).expect(200);
      expect(retry.body.duplicate).toBe(true);
      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
      expect(rawEmail()).toContain('Subject: Your Tacoma photos\r\n');
      expect(rawEmail()).toContain(`To: ${email}\r\n`);
      const saved: any = await Lead.findById(lead._id).lean();
      expect(saved.emailThreadSubject).toBe('Your Tacoma photos');
      expect(saved.threadId).toBeTruthy();
      const after = await options(lead._id).expect(200);
      expect(after.body.data.email).toMatchObject({ subject: 'Your Tacoma photos', subjectLocked: true });
    });

    it('keeps the thread subject on an existing email thread', async () => {
      const lead = await makeLead({ email: nextEmail() }, { threadId: 'thread-existing' });
      await sendEmail(lead._id, { message: 'Following up', subject: 'Something else', clientRequestId: nextRequestId() }).expect(200);
      expect(rawEmail()).toContain('Subject: Re: Tacoma inquiry\r\n');
      expect(mockMessagesSend.mock.calls[0][0].requestBody.threadId).toBe('thread-existing');
    });

    it('cannot add extra email headers through the subject', async () => {
      const lead = await makeLead({ email: nextEmail() });
      await sendEmail(lead._id, { message: 'Hi', subject: 'Hello\r\nBcc: someone@example.com', clientRequestId: nextRequestId() }).expect(200);
      const raw = rawEmail();
      expect(raw).toContain('Subject: Hello Bcc: someone@example.com\r\n');
      expect(raw.split('\r\n').some((line) => /^bcc:/i.test(line))).toBe(false);
    });

    it('encodes a subject with accents so it arrives intact', async () => {
      const lead = await makeLead({ email: nextEmail() });
      const subject = 'Prueba de manejo mañana';
      await sendEmail(lead._id, { message: 'Hola', subject, clientRequestId: nextRequestId() }).expect(200);
      const header = rawEmail().split('\r\n').find((line) => line.startsWith('Subject: '))!;
      const encoded = /=\?UTF-8\?B\?([^?]+)\?=/.exec(header)![1];
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(subject);
    });

    it('marks a Gmail timeout as unconfirmed and blocks the automatic resend', async () => {
      const lead = await makeLead({ email: nextEmail() });
      mockMessagesSend.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      const fields = { message: 'Timeout case', clientRequestId: nextRequestId() };
      const first = await sendEmail(lead._id, fields).expect(409);
      expect(codeOf(first)).toBe('SEND_UNCERTAIN');
      const retry = await sendEmail(lead._id, fields).expect(409);
      expect(codeOf(retry)).toBe('SEND_UNCERTAIN');
      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    });

    it('allows a retry after Gmail clearly rejected the email', async () => {
      const lead = await makeLead({ email: nextEmail() });
      mockMessagesSend.mockRejectedValueOnce(Object.assign(new Error('Bad Request'), { response: { status: 400 } }));
      const fields = { message: 'Rejected first', clientRequestId: nextRequestId() };
      await sendEmail(lead._id, fields).expect(502);
      await sendEmail(lead._id, fields).expect(200);
      expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    });

    it('still blocks Do Not Contact and unverified recipients', async () => {
      const dnc = await makeLead({ email: nextEmail() }, { status: 'Do Not Contact' });
      await sendEmail(dnc._id, { message: 'Hi', clientRequestId: nextRequestId() }).expect(403);
      const source = await makeLead({ email: 'leads@dealerscloud.com' });
      await sendEmail(source._id, { message: 'Hi', clientRequestId: nextRequestId() }).expect(400);
      expect(mockMessagesSend).not.toHaveBeenCalled();
    });

    it('keeps the old reply behavior without a request id', async () => {
      const lead = await makeLead({ email: nextEmail() });
      await sendEmail(lead._id, { message: 'Legacy email' }).expect(200);
      await sendEmail(lead._id, { message: 'Legacy email' }).expect(200);
      expect(mockMessagesSend).toHaveBeenCalledTimes(2);
      expect(rawEmail()).toContain('Subject: Re: Tacoma inquiry\r\n');
    });
  });
});
