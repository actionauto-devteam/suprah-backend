const mockCreate = jest.fn();
const mockSms = jest.fn();
const mockSendMail = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSms,
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
  createTransport: () => ({ sendMail: mockSendMail }),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import ContactRestrictionAudit from '../src/models/ContactRestrictionAudit.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import tokenService from '../src/services/token.service';
import webchatRoutes from '../src/routes/webchat.route';
import crmWebchatRoutes from '../src/routes/crmWebchat.routes';
import leadRoutes from '../src/routes/lead.route';

const app = express();
app.use(express.json());
app.use('/api/webchat', webchatRoutes);
app.use('/api/crm/webchat', crmWebchatRoutes);
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, code: error.code }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const SLUG = `wcsec-${orgId}`;
const people = {
  owner: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  inactive: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const auth = (who: keyof typeof people) => ({ Authorization: `Bearer ${tokens[who]}` });
const PHONE = { dnc: '+18015550141', late: '+18015550142', open: '+18015550143' };
const dncLeadId = new mongoose.Types.ObjectId();
const lateDncLeadId = new mongoose.Types.ObjectId();
const olderLeadId = new mongoose.Types.ObjectId();
let olderSessionId: mongoose.Types.ObjectId;
const ALEX_DNC_NOTE = 'You may only answer what they asked in this live chat';
const SECRET_NOTE = 'INTERNAL NOTE do not show visitors';
const OLDER_MESSAGE = 'OLDER CONVERSATION from a previous chat';
let chat: { res: any; sessionId: string; token: string; leadId: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the local chat to finish');
    await wait(100);
  }
}
const alexReplies = (sessionId: string) =>
  WebChatMessage.countDocuments({ sessionId, direction: 'outbound', 'sentBy.userId': 'ai-agent' });
const generationPrompts = () => mockCreate.mock.calls
  .map(([input]: any[]) => JSON.stringify(input?.messages || []))
  .filter((text: string) => !text.includes('Classify the latest') && !text.includes('strict compliance classifier'));

async function startChat(phone: string, message: string) {
  const res = await request(app).post('/api/webchat/public/sessions').send({ orgKey: SLUG, name: 'Pat Visitor', phone, message });
  expect(res.status).toBe(201);
  const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
  return { res, sessionId: String(res.body.data.sessionId), token: String(res.body.data.token), leadId: String(session.leadId) };
}
const visitorSays = (sessionId: string, token: string, message: string) =>
  request(app).post(`/api/webchat/public/sessions/${sessionId}/messages`).send({ token, message });

describe('Real-DB: Web Chat security and permissions (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'local-test-key';
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Web Chat Security Dealer', slug: SLUG, status: 'active', metadata: { aiAgentName: 'Anna', aiAgentEnabled: true } },
      { _id: otherOrgId, name: 'Other Dealer', slug: `wcsec-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: people.owner, name: 'Olivia Owner', email: `wcsec-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: people.customer, name: 'Casey Customer', email: `wcsec-customer-${orgId}@example.com`, password: 'x', role: 'customer', organizationId: orgId, isActive: true },
    ] as any[]);
    const crm = (_id: mongoose.Types.ObjectId, role: string, name: string, organizationId = orgId, isActive = true) => ({
      _id, organizationId, fullName: name, username: `wcsec-${_id}`, email: `wcsec-${_id}@example.com`, role, isActive, password: 'x',
    });
    await CrmUser.collection.insertMany([
      crm(people.employee, 'employee', 'Erin Employee'),
      crm(people.inactive, 'employee', 'Ivan Inactive', orgId, false),
      crm(people.otherAdmin, 'admin', 'Olive Other', otherOrgId),
    ] as any[]);
    tokens.employee = generateCrmToken(String(people.employee));
    tokens.inactive = generateCrmToken(String(people.inactive));
    tokens.otherAdmin = generateCrmToken(String(people.otherAdmin));
    tokens.customer = tokenService.generateAccessToken({ _id: people.customer, email: `wcsec-customer-${orgId}@example.com`, role: 'customer', organizationId: orgId });

    const lead = (_id: mongoose.Types.ObjectId, phone: string, status: string, changedAt: Date, extra: Record<string, unknown> = {}) => ({
      _id, organizationId: orgId, createdBy: people.owner, firstName: 'Pat', lastName: 'Visitor', phone, normalizedPhone: phone,
      status, source: 'Manual Entry', channel: 'sms', createdAt: new Date(Date.now() - 86400000), updatedAt: changedAt,
      statusHistory: status === 'Do Not Contact' ? [{ from: 'New', to: 'Do Not Contact', changedAt, changedBy: people.owner }] : [],
      ...extra,
    });
    await Lead.collection.insertMany([
      lead(dncLeadId, PHONE.dnc, 'Do Not Contact', new Date(Date.now() - 2 * 3600000), { notes: [{ text: SECRET_NOTE, createdAt: new Date(), createdBy: people.owner }] }),
      lead(lateDncLeadId, PHONE.late, 'Do Not Contact', new Date(Date.now() + 10 * 60000)),
      lead(olderLeadId, PHONE.dnc, 'Closed', new Date(Date.now() - 3 * 86400000), { channel: 'webchat', source: 'Website Chat' }),
    ] as any[]);
    olderSessionId = (await WebChatSession.create({
      organizationId: ORG, leadId: olderLeadId, tokenHash: `older-${orgId}`, visitorName: 'Pat Visitor', visitorPhone: PHONE.dnc,
    }))._id as mongoose.Types.ObjectId;
    await WebChatMessage.collection.insertOne({
      organizationId: ORG, sessionId: olderSessionId, leadId: olderLeadId, direction: 'inbound', body: OLDER_MESSAGE,
      aiDispatchPending: false, createdAt: new Date(Date.now() - 3 * 86400000), updatedAt: new Date(Date.now() - 3 * 86400000),
    } as any);
  });

  beforeEach(() => {
    mockSms.mockReset();
    mockSms.mockResolvedValue({ id: `tx-${new mongoose.Types.ObjectId()}` });
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'smtp-1' });
    mockCreate.mockImplementation(async (input: any) => {
      const prompt = String(input?.messages?.[0]?.content || '');
      const content = prompt.includes('Classify the latest') ? JSON.stringify({ intent: 'none' })
        : prompt.includes('strict compliance classifier') ? 'SAFE'
          : 'Yes, that truck is on the lot today.';
      return { choices: [{ message: { content } }] };
    });
  });

  afterAll(async () => {
    delete process.env.AI_AGENT_ENABLED;
    delete process.env.GEMINI_API_KEY;
    await wait(500);
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('a public visitor starting a chat gets only their own message back, nothing internal', async () => {
    chat = await startChat(PHONE.dnc, 'Is the white truck still available?');
    const text = JSON.stringify(chat.res.body);
    for (const hidden of [SECRET_NOTE, OLDER_MESSAGE, 'Do Not Contact', String(dncLeadId), String(olderLeadId), chat.leadId, 'restricted']) {
      expect(text).not.toContain(hidden);
    }
    expect(chat.res.body.data.messages).toHaveLength(1);
    expect(Object.keys(chat.res.body.data.messages[0]).sort()).toEqual(['_id', 'body', 'createdAt', 'fromVisitor']);
  });

  it('Alex answers a Do Not Contact customer inside the 30-minute window, with the chat-only instruction, and it is recorded', async () => {
    await waitFor(async () => (await alexReplies(chat.sessionId)) >= 1);
    await waitFor(async () => ContactRestrictionAudit.findOne({ sessionId: chat.sessionId, event: 'webchat_exception_reply', purpose: 'alex_webchat_reply' }).lean());
    expect(generationPrompts().some((prompt) => prompt.includes(ALEX_DNC_NOTE))).toBe(true);
    expect(mockSms).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect((await Lead.findById(dncLeadId).lean())?.status).toBe('Do Not Contact');
  });

  it('visitor sync returns only this session and cannot open another session with this token', async () => {
    const sync = await request(app).post(`/api/webchat/public/sessions/${chat.sessionId}/sync`).send({ token: chat.token });
    expect(sync.status).toBe(200);
    const text = JSON.stringify(sync.body);
    for (const hidden of [SECRET_NOTE, OLDER_MESSAGE, 'Do Not Contact', String(dncLeadId), chat.leadId, 'restricted', 'ai-agent']) {
      expect(text).not.toContain(hidden);
    }
    for (const message of sync.body.data.messages) {
      expect(['_id', 'agentName', 'body', 'createdAt', 'fromVisitor']).toEqual(expect.arrayContaining(Object.keys(message)));
    }
    const other = await request(app).post(`/api/webchat/public/sessions/${olderSessionId}/sync`).send({ token: chat.token });
    expect(other.status).toBe(404);
    const write = await visitorSays(String(olderSessionId), chat.token, 'Trying another chat');
    expect(write.status).toBe(404);
  });

  it('staff chat routes need an active staff account; customers and deactivated staff are refused', async () => {
    const url = `/api/crm/webchat/leads/${chat.leadId}/messages`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set(auth('customer'))).status).toBe(403);
    expect((await request(app).get(url).set(auth('inactive'))).status).toBe(403);
    const staff = await request(app).get(url).set(auth('employee'));
    expect(staff.status).toBe(200);
    expect(staff.body.data.contactPolicy).toMatchObject({ restricted: true, windowMinutes: 30 });
  });

  it('another organization cannot read or change the chat, its Do Not Contact details, or the customer records', async () => {
    const base = `/api/crm/webchat/leads/${chat.leadId}`;
    const read = await request(app).get(`${base}/messages`).set(auth('otherAdmin'));
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain('Do Not Contact');
    expect((await request(app).post(`${base}/messages`).set(auth('otherAdmin')).send({ body: 'Hello from another dealer' })).status).toBe(404);
    expect((await request(app).post(`${base}/ai-pause`).set(auth('otherAdmin'))).status).toBe(404);
    expect((await request(app).get(`/api/leads/${chat.leadId}`).set(auth('otherAdmin'))).status).toBe(404);
    expect((await request(app).get(`/api/leads/${dncLeadId}`).set(auth('otherAdmin'))).status).toBe(404);
    expect(await WebChatMessage.countDocuments({ sessionId: chat.sessionId, body: 'Hello from another dealer' })).toBe(0);
    expect((await WebChatSession.findById(chat.sessionId).lean() as any).aiPausedAt).toBeFalsy();
  });

  it('a staff reply pauses Alex for this chat until an authorized Resume AI', async () => {
    const reply = await request(app).post(`/api/crm/webchat/leads/${chat.leadId}/messages`).set(auth('employee')).send({ body: 'Hi Pat, I can help from here.' });
    expect(reply.status).toBe(201);
    expect((await WebChatSession.findById(chat.sessionId).lean() as any).aiPausedAt).toBeInstanceOf(Date);

    const before = await alexReplies(chat.sessionId);
    expect((await visitorSays(chat.sessionId, chat.token, 'One more question about the price')).status).toBe(201);
    await wait(3000);
    expect(await alexReplies(chat.sessionId)).toBe(before);
    expect((await WebChatSession.findById(chat.sessionId).lean() as any).aiPausedAt).toBeInstanceOf(Date);

    expect((await request(app).post(`/api/crm/webchat/leads/${chat.leadId}/ai-resume`).set(auth('otherAdmin'))).status).toBe(404);
    expect((await request(app).post(`/api/crm/webchat/leads/${chat.leadId}/ai-resume`).set(auth('customer'))).status).toBe(403);
    expect((await WebChatSession.findById(chat.sessionId).lean() as any).aiPausedAt).toBeInstanceOf(Date);

    expect((await request(app).post(`/api/crm/webchat/leads/${chat.leadId}/ai-resume`).set(auth('employee'))).status).toBe(200);
    expect((await WebChatSession.findById(chat.sessionId).lean() as any).aiPausedAt).toBeFalsy();
    expect((await visitorSays(chat.sessionId, chat.token, 'Thanks, last question')).status).toBe(201);
    await waitFor(async () => (await alexReplies(chat.sessionId)) > before);
  });

  it('Alex stays silent when Do Not Contact was set after the customer\'s last message', async () => {
    const late = await startChat(PHONE.late, 'Hello, anyone there?');
    await waitFor(async () => ContactRestrictionAudit.findOne({ sessionId: late.sessionId, event: 'outbound_blocked', purpose: 'alex_webchat_reply' }).lean());
    await wait(1500);
    expect(await WebChatMessage.countDocuments({ sessionId: late.sessionId, direction: 'outbound' })).toBe(0);
    const sync = await request(app).post(`/api/webchat/public/sessions/${late.sessionId}/sync`).send({ token: late.token });
    expect(JSON.stringify(sync.body)).not.toContain('Do Not Contact');
  });

  it('unrestricted customers keep the normal Alex chat with no Do Not Contact instruction or audit', async () => {
    mockCreate.mockClear();
    const open = await startChat(PHONE.open, 'Do you have this in blue?');
    await waitFor(async () => (await alexReplies(open.sessionId)) >= 1);
    expect(generationPrompts().some((prompt) => prompt.includes(ALEX_DNC_NOTE))).toBe(false);
    expect(await ContactRestrictionAudit.countDocuments({ sessionId: open.sessionId })).toBe(0);
    const staff = await request(app).post(`/api/crm/webchat/leads/${open.leadId}/messages`).set(auth('employee')).send({ body: 'Yes, we have a blue one.' });
    expect(staff.status).toBe(201);
    expect((await WebChatSession.findById(open.sessionId).lean() as any).aiPausedAt).toBeInstanceOf(Date);
  });
});
