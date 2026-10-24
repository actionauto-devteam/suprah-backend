const mockSendSms = jest.fn();
const mockAiEmail = jest.fn();
const mockProcessAlexTurn = jest.fn();

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
jest.mock('../src/services/aiEmailReply.service', () => ({ triggerAiEmailReplyForNewInquiry: mockAiEmail }));
jest.mock('../src/services/aiAgent.service', () => ({
  ...jest.requireActual('../src/services/aiAgent.service'),
  processAlexTurn: mockProcessAlexTurn,
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Vehicle from '../src/models/Vehicle.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import Notification from '../src/models/Notification.model';
import ContactRestrictionAudit from '../src/models/ContactRestrictionAudit.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmWebchatRoutes from '../src/routes/crmWebchat.routes';
import * as webchat from '../src/controllers/webchat.controller';
import appointmentController from '../src/controllers/appointment.controller';
import { telnyxWebhook } from '../src/controllers/communication.controller';
import leadService from '../src/services/lead.service';
import { handleInboundSms, handleCallInitiated, handleCallHangup, retainInboundSms } from '../src/services/communication.service';
import { recoverLeadIntake, submitLeadInquiry } from '../src/services/leadIntake.service';
import { adfInquiryRequest } from '../src/services/leadIntakeIntegration';
import { processGmailMessageThroughIntake } from '../src/services/gmailLeadIntake';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { isStaffTakeover, sessionControlToCarry } from '../src/utils/conversationOwnership';

const app = express();
app.use(express.json());
app.post('/public/book', appointmentController.createPublicTestDriveBooking);
app.post('/public/chat', webchat.startSession);
app.post('/public/chat/:sessionId/messages', webchat.sendVisitorMessage);
app.post('/webhooks/telnyx', telnyxWebhook);
app.use('/api/crm/webchat', crmWebchatRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const aiOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const AI_ORG = String(aiOrgId);
const ids = {
  owner: new mongoose.Types.ObjectId(),
  aiOwner: new mongoose.Types.ObjectId(),
  crmAdmin: new mongoose.Types.ObjectId(),
  aiCrmEmployee: new mongoose.Types.ObjectId(),
  crmEmployee: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
};
const truckId = new mongoose.Types.ObjectId();
const admin = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(4000 + (++serial)).slice(-4)}`;
const nextEmail = () => `safety${++serial}@example.com`;
const smsId = () => `sms-${new mongoose.Types.ObjectId()}`;
const HOUR = 60 * 60 * 1000;
const savedEnv: Record<string, string | undefined> = {};
const alexRuns: Promise<unknown>[] = [];

async function setMode(mode: 'off' | 'active' | 'paused', org = ORG) {
  await setLeadIntakeMode({ organizationId: org, mode, reason: `test ${mode}`, actor: admin });
  clearLeadIntakeModeCache();
}

async function makeLead(org: mongoose.Types.ObjectId, contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: org, createdBy: org.equals(aiOrgId) ? ids.aiOwner : ids.owner, firstName: 'Pat', lastName: 'Lee',
    phone: contact.phone, email: contact.email, source: 'Manual Entry', channel: 'sms', status: 'New', isRead: true, ...extra,
  });
}

const sms = (org: string, from: string, text: string, id = smsId()) => handleInboundSms({ from, to: '+18015550999', text, id }, org);

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

const settle = (ms = 1200) => new Promise((resolve) => setTimeout(resolve, ms));
const alexCallsFor = (leadId: unknown) => mockProcessAlexTurn.mock.calls.filter(([ctx]) => String(ctx?.leadId) === String(leadId)).length;
const webhook = (payload: Record<string, unknown>) => request(app).post('/webhooks/telnyx').send({ data: { event_type: 'message.received', payload } });
const smsPayload = (from: string, text: string, id = smsId()) => ({ id, from: { phone_number: from }, to: [{ phone_number: '+18015550999' }], text });

function gmailMessage(input: { from: string; subject: string; body: string; threadId?: string; headers?: Array<{ name: string; value: string }>; id?: string }) {
  return {
    message: {
      id: input.id || `gm-${new mongoose.Types.ObjectId()}`,
      threadId: input.threadId || `th-${new mongoose.Types.ObjectId()}`,
      internalDate: String(Date.now()),
      payload: { headers: [{ name: 'From', value: input.from }, { name: 'Subject', value: input.subject }, ...(input.headers || [])] },
    },
    rawBody: input.body,
  };
}

describe('Real-DB: lifecycle intake safety (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    for (const key of ['COMM_ORG_ID', 'AI_AGENT_ENABLED', 'LOCAL_UI_ACCEPTANCE_MODE', 'LOCAL_ATTENTION_MOCK_CLASSIFIER']) savedEnv[key] = process.env[key];
    process.env.COMM_ORG_ID = ORG;
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    process.env.LOCAL_ATTENTION_MOCK_CLASSIFIER = 'true';
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(), IntakeClaim.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Safety Dealer', slug: `safety-${orgId}`, status: 'active', metadata: {} },
      { _id: aiOrgId, name: 'Alex Dealer', slug: `safety-${aiOrgId}`, status: 'active', metadata: { aiAgentName: 'Anna', aiAgentEnabled: true, aiAgentModes: { sms: 'live', webchat: 'live', email: 'off' } } },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `safety-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.aiOwner, name: 'Alan Owner', email: `safety-ai-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: aiOrgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.crmAdmin, organizationId: orgId, fullName: 'Ada Admin', username: `safety-${ids.crmAdmin}`, email: `safety-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.crmEmployee, organizationId: orgId, fullName: 'Erin Employee', username: `safety-${ids.crmEmployee}`, email: `safety-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.aiCrmEmployee, organizationId: aiOrgId, fullName: 'Ivy Employee', username: `safety-${ids.aiCrmEmployee}`, email: `safety-ai-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await Vehicle.collection.insertOne({ _id: truckId, organizationId: ORG, year: 2021, make: 'Toyota', modelName: 'Tacoma', vin: '1HGBH41JXMN109999', stockNumber: 'T900', status: 'Ready for Sale', dealerCity: 'Lehi', price: 30000 } as any);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'sales@safety.example.com', accessToken: 'x', refreshToken: 'x',
      expiryDate: Date.now() + HOUR, gmailConnected: true, isActive: true, leadSourceEmail: 'leads@dealerscloud.com',
    } as any);
    tokens.employee = generateCrmToken(String(ids.crmEmployee));
    tokens.aiEmployee = generateCrmToken(String(ids.aiCrmEmployee));
  });

  beforeEach(async () => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockResolvedValue({ id: `out-${new mongoose.Types.ObjectId()}` });
    mockAiEmail.mockReset();
    mockAiEmail.mockResolvedValue(undefined);
    mockProcessAlexTurn.mockReset();
    mockProcessAlexTurn.mockImplementation((ctx: any) => {
      const run = ctx.send('Happy to help with that!');
      alexRuns.push(run.catch(() => undefined));
      return run;
    });
    process.env.COMM_ORG_ID = ORG;
  });

  afterEach(async () => {
    await Promise.allSettled(alexRuns.splice(0));
    await settle(300);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  describe('fresh-lead Alex eligibility', () => {
    beforeAll(async () => { await setMode('active', AI_ORG); });

    it('keeps a session takeover as it is and only carries an automatic timer while it is still running', () => {
      const now = Date.now();
      const staff = { userId: String(ids.crmEmployee), name: 'Erin' };
      expect(sessionControlToCarry({ aiPausedAt: new Date(now - 30 * 24 * HOUR), aiPausedBy: staff }, now)).toMatchObject({ aiPausedBy: staff });
      expect(sessionControlToCarry({ aiPausedAt: new Date(now - 60_000), aiPausedBy: { userId: 'system', name: 'Suprah AI' } }, now)).toMatchObject({ aiPausedBy: { userId: 'system' } });
      expect(sessionControlToCarry({ aiAutoPausedUntil: new Date(now + 60_000) }, now)).toMatchObject({ aiAutoPausedUntil: expect.any(Date) });
      expect(sessionControlToCarry({ aiAutoPausedUntil: new Date(now - 60_000) }, now)).toBeUndefined();
      expect(sessionControlToCarry({}, now)).toBeUndefined();
      expect(isStaffTakeover({ aiPausedAt: new Date(), aiPausedBy: staff })).toBe(true);
      expect(isStaffTakeover({ aiPausedAt: new Date(), aiPausedBy: { userId: 'system' } })).toBe(false);
    });

    it('does not carry an old text pause from a closed lead onto the fresh lead', async () => {
      const phone = nextPhone();
      const closed = await makeLead(aiOrgId, { phone }, { status: 'Sold' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: closed._id, aiPausedAt: new Date(Date.now() - 2 * 24 * HOUR), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } });
      const sent: any = await sms(AI_ORG, phone, 'Do you have any other trucks?');
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect(String(message.leadId)).not.toBe(String(closed._id));
      const conversation: any = await Conversation.findOne({ orgId: AI_ORG, customerPhone: phone }).lean();
      expect(String(conversation.leadId)).toBe(String(message.leadId));
      expect(conversation.aiPausedAt ?? null).toBeNull();
      await waitFor(async () => alexCallsFor(message.leadId), (count) => count >= 1);
      expect(alexCallsFor(message.leadId)).toBe(1);
      await waitFor(async () => mockSendSms.mock.calls.length, (count) => count >= 1);
      expect(mockSendSms).toHaveBeenCalledTimes(1);
    });

    it('treats a staff pause on a finished lead as that lead’s history, however recent', async () => {
      const phone = nextPhone();
      const closed = await makeLead(aiOrgId, { phone }, { status: 'Closed' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: closed._id, aiPausedAt: new Date(Date.now() - 5 * 60_000), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } });
      const sent: any = await sms(AI_ORG, phone, 'Are you still there?');
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      const conversation: any = await Conversation.findOne({ orgId: AI_ORG, customerPhone: phone }).lean();
      expect(String(conversation.leadId)).toBe(String(message.leadId));
      expect(conversation.aiPausedAt ?? null).toBeNull();
      await waitFor(async () => alexCallsFor(message.leadId), (count) => count >= 1);
      expect(alexCallsFor(message.leadId)).toBe(1);
    });

    it('keeps a running automatic pause timer on the fresh lead until it expires', async () => {
      const phone = nextPhone();
      const closed = await makeLead(aiOrgId, { phone }, { status: 'Closed' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: closed._id, aiAutoPausedUntil: new Date(Date.now() + 20 * 60_000) });
      const sent: any = await sms(AI_ORG, phone, 'Hello?');
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect((await Conversation.findOne({ orgId: AI_ORG, customerPhone: phone }).lean() as any).aiAutoPausedUntil).toBeTruthy();
      await settle();
      expect(alexCallsFor(message.leadId)).toBe(0);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('never clears an automatic safety pause just because a fresh lead opened', async () => {
      const phone = nextPhone();
      const closed = await makeLead(aiOrgId, { phone }, { status: 'Closed' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: closed._id, aiPausedAt: new Date(Date.now() - 2 * 24 * HOUR), aiPausedBy: { userId: 'system', name: 'Suprah AI' } });
      const sent: any = await sms(AI_ORG, phone, 'Hello?');
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect((await Conversation.findOne({ orgId: AI_ORG, customerPhone: phone }).lean() as any).aiPausedAt).toBeTruthy();
      await settle();
      expect(alexCallsFor(message.leadId)).toBe(0);
    });

    it('keeps a staff text takeover on the open lead no matter how much time passes', async () => {
      const phone = nextPhone();
      const open = await makeLead(aiOrgId, { phone }, { status: 'Contacted' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: open._id, aiPausedAt: new Date(Date.now() - 2 * 24 * HOUR), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } });
      await sms(AI_ORG, phone, 'Any update?');
      await settle();
      expect(alexCallsFor(open._id)).toBe(0);
      expect((await Conversation.findOne({ orgId: AI_ORG, customerPhone: phone }).lean() as any).aiPausedAt).toBeTruthy();
    });

    it('never lets a fresh lead reach Alex when the customer asked not to be contacted', async () => {
      const phone = nextPhone();
      const dnc = await makeLead(aiOrgId, { phone }, { status: 'Do Not Contact' });
      await Conversation.create({ orgId: AI_ORG, customerPhone: phone, leadId: dnc._id, aiPausedAt: new Date(Date.now() - 2 * 24 * HOUR), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } });
      const sent: any = await sms(AI_ORG, phone, 'Hello?');
      await settle();
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect(alexCallsFor(message.leadId)).toBe(0);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('never texts a fresh lead whose number opted out of texts', async () => {
      const phone = nextPhone();
      await makeLead(aiOrgId, { phone }, { status: 'Closed' });
      await SmsOptOut.create({ organizationId: AI_ORG, phone, optedOut: true });
      await sms(AI_ORG, phone, 'Hi there');
      await settle();
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('leaves Alex off for a dealership whose AI is not turned on', async () => {
      await setMode('active');
      const phone = nextPhone();
      await makeLead(orgId, { phone }, { status: 'Closed' });
      const sent: any = await sms(ORG, phone, 'Hello again');
      await settle();
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect(message.leadId).toBeTruthy();
      expect(alexCallsFor(message.leadId)).toBe(0);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    async function startAiChat(email = nextEmail()) {
      const started = await request(app).post('/public/chat').send({ orgKey: `safety-${aiOrgId}`, name: 'Wren Visitor', email, message: 'Hi there' });
      expect(started.status).toBe(201);
      await waitFor(async () => mockProcessAlexTurn.mock.calls.length, (count) => count >= 1);
      await Promise.allSettled(alexRuns.splice(0));
      const session: any = await WebChatSession.findById(started.body.data.sessionId).lean();
      mockProcessAlexTurn.mockClear();
      return { ...started.body.data, session, email };
    }

    async function closedChat(pause: Record<string, unknown>) {
      const { sessionId, token, session } = await startAiChat();
      await Lead.updateOne({ _id: session.leadId }, { $set: { status: 'Closed' } });
      if (Object.keys(pause).length) await WebChatSession.updateOne({ _id: sessionId }, { $set: pause });
      const sent = await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'I am back' });
      expect(sent.status).toBe(201);
      const fresh: any = await WebChatSession.findById(sent.body.data.session.sessionId).lean();
      return { fresh, oldLeadId: session.leadId };
    }

    it('gives a returning chat visitor with no takeover a fresh conversation that Alex can answer', async () => {
      const { fresh, oldLeadId } = await closedChat({});
      expect(String(fresh.leadId)).not.toBe(String(oldLeadId));
      expect(fresh.aiPausedAt ?? null).toBeNull();
      await waitFor(async () => alexCallsFor(fresh.leadId), (count) => count >= 1);
      expect(alexCallsFor(fresh.leadId)).toBe(1);
    });

    it('keeps an explicit staff takeover on the visitor’s continuing chat, even days later', async () => {
      const { fresh } = await closedChat({ aiPausedAt: new Date(Date.now() - 2 * 24 * HOUR), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } });
      expect(fresh.aiPausedAt).toBeTruthy();
      expect(fresh.aiPausedBy).toMatchObject({ userId: String(ids.aiCrmEmployee) });
      await settle();
      expect(alexCallsFor(fresh.leadId)).toBe(0);
    });

    it('keeps an automatic safety pause on the continuing chat until someone resumes it', async () => {
      const { fresh } = await closedChat({ aiPausedAt: new Date(Date.now() - 60_000), aiPausedBy: { userId: 'system', name: 'Suprah AI' } });
      expect(fresh.aiPausedAt).toBeTruthy();
      await settle();
      expect(alexCallsFor(fresh.leadId)).toBe(0);
    });

    it('does not let a brand-new chat inherit a takeover from an earlier chat', async () => {
      const first = await startAiChat();
      await WebChatSession.updateOne({ _id: first.sessionId }, { $set: { aiPausedAt: new Date(), aiPausedBy: { userId: String(ids.aiCrmEmployee), name: 'Ivy' } } });
      const second = await request(app).post('/public/chat').send({ orgKey: `safety-${aiOrgId}`, name: 'Wren Visitor', email: first.email, message: 'New question' });
      expect(second.status).toBe(201);
      const session: any = await WebChatSession.findById(second.body.data.sessionId).lean();
      expect(session.aiPausedAt ?? null).toBeNull();
      await waitFor(async () => alexCallsFor(session.leadId), (count) => count >= 1);
      expect(alexCallsFor(session.leadId)).toBe(1);
    });

    it('keeps a staff chat takeover until someone selects Resume AI, however long it has been', async () => {
      const { sessionId, token, session } = await startAiChat();
      const staff = { Authorization: `Bearer ${tokens.aiEmployee}` };
      const reply = await request(app).post(`/api/crm/webchat/leads/${session.leadId}/messages`).set(staff).send({ body: 'This is Ivy, I can help.' });
      expect(reply.status).toBe(201);
      const takenOver: any = await WebChatSession.findById(sessionId).lean();
      expect(takenOver.aiPausedAt).toBeTruthy();
      await WebChatSession.updateOne({ _id: sessionId }, { $set: { aiPausedAt: new Date(Date.now() - 3 * HOUR) } });
      expect((await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'Are you still there?' })).status).toBe(201);
      await settle();
      expect(alexCallsFor(session.leadId)).toBe(0);
      expect((await WebChatSession.findById(sessionId).lean() as any).aiPausedAt).toBeTruthy();

      const resumed = await request(app).post(`/api/crm/webchat/leads/${session.leadId}/ai-resume`).set(staff).send({});
      expect(resumed.status).toBe(200);
      expect((await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'One more question' })).status).toBe(201);
      await waitFor(async () => alexCallsFor(session.leadId), (count) => count >= 1);
      expect(alexCallsFor(session.leadId)).toBe(1);
    });
  });

  describe('paused intake on every channel', () => {
    beforeEach(async () => { await setMode('paused'); });

    it('opens a safe, isolated chat right away, lets staff answer, and files it once when intake resumes', async () => {
      const phone = nextPhone();
      const open = await makeLead(orgId, { phone }, { status: 'Contacted' });
      const clientRequestId = `chat-${new mongoose.Types.ObjectId()}`;
      const first = await request(app).post('/public/chat').send({ orgKey: `safety-${orgId}`, name: 'Pat Lee', phone, message: 'Is the truck available?', clientRequestId });
      const again = await request(app).post('/public/chat').send({ orgKey: `safety-${orgId}`, name: 'Pat Lee', phone, message: 'Is the truck available?', clientRequestId });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.body.data.sessionId).toBe(first.body.data.sessionId);
      const session: any = await WebChatSession.findById(first.body.data.sessionId).lean();
      const chatLead: any = await Lead.findById(session.leadId).lean();
      expect(String(chatLead._id)).not.toBe(String(open._id));
      expect(chatLead).toMatchObject({ intakeIdentity: 'unverified', source: 'Website Chat' });
      expect(chatLead.customerLink?.status).not.toBe('linked');
      const event: any = await LeadInquiry.findById(chatLead.sourceInquiryId).lean();
      expect(event.association.state).toBe('received');
      const announced = await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': String(chatLead._id) });
      expect(announced).toBeGreaterThanOrEqual(1);

      const reply = await request(app).post(`/api/crm/webchat/leads/${chatLead._id}/messages`).set({ Authorization: `Bearer ${tokens.employee}` }).send({ body: 'Yes, it is here!' });
      expect(reply.status).toBe(201);

      await setMode('active');
      await recoverLeadIntake({ organizationId: ORG });
      const filed: any = await waitFor(() => LeadInquiry.findById(event._id).lean(), (doc: any) => doc?.association?.state === 'associated');
      expect(String(filed.association.leadId)).toBe(String(chatLead._id));
      expect(filed.review).toMatchObject({ state: 'pending', kind: 'possible_match' });
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(2);
      await settle(300);
      expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': String(chatLead._id) })).toBe(announced);
    });

    it('keeps the Do Not Contact rules for a paused chat: only the approved live-chat window, always audited', async () => {
      const phone = nextPhone();
      await makeLead(orgId, { phone }, { status: 'Do Not Contact' });
      const started = await request(app).post('/public/chat').send({ orgKey: `safety-${orgId}`, name: 'Dee Visitor', phone, message: 'Hello' });
      expect(started.status).toBe(201);
      const session: any = await WebChatSession.findById(started.body.data.sessionId).lean();
      const reply = (body: string) => request(app).post(`/api/crm/webchat/leads/${session.leadId}/messages`).set({ Authorization: `Bearer ${tokens.employee}` }).send({ body });
      expect((await reply('We can help in this chat.')).status).toBe(201);
      expect(await ContactRestrictionAudit.countDocuments({ sessionId: session._id, event: 'webchat_exception_reply' })).toBe(1);
      await WebChatMessage.collection.updateMany({ sessionId: session._id, direction: 'inbound' }, { $set: { createdAt: new Date(Date.now() - 40 * 60_000) } });
      expect((await reply('Following up later')).status).toBeGreaterThanOrEqual(400);
      expect(await WebChatMessage.countDocuments({ sessionId: session._id, direction: 'outbound' })).toBe(1);
      expect((await Lead.findById(session.leadId).lean() as any).intakeIdentity).toBe('unverified');
    });

    it('starts an isolated chat instead of reopening a closed chat lead', async () => {
      const started = await request(app).post('/public/chat').send({ orgKey: `safety-${orgId}`, name: 'Rae Visitor', email: nextEmail(), message: 'Hi' });
      const { sessionId, token } = started.body.data;
      const session: any = await WebChatSession.findById(sessionId).lean();
      await Lead.updateOne({ _id: session.leadId }, { $set: { status: 'Closed' } });
      const sent = await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'Back again' });
      expect(sent.status).toBe(201);
      const fresh: any = await WebChatSession.findById(sent.body.data.session.sessionId).lean();
      expect(String(fresh.leadId)).not.toBe(String(session.leadId));
      expect((await Lead.findById(fresh.leadId).lean() as any).intakeIdentity).toBe('unverified');
      expect(await WebChatMessage.countDocuments({ leadId: session.leadId, body: 'Back again' })).toBe(0);
    });

    it('holds website inquiries, bookings, provider leads, Gmail, texts and calls without creating or attaching leads', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const closed = await makeLead(orgId, { phone, email }, { status: 'Closed' });
      await leadService.processInquiry({ organizationId: ORG, customerId: String(ids.customer), vehicleId: String(truckId), customerName: { first: 'Pat', last: 'Lee' }, customerEmail: email, customerPhone: phone, comments: 'Paused website' });
      const booking = await request(app).post('/public/book').send({ vehicleId: String(truckId), firstName: 'Pat', lastName: 'Lee', email, phone, startTime: new Date(Date.now() + 86400000).toISOString() });
      expect(booking.status).toBe(201);
      expect(booking.body.data.leadId).toBeNull();
      const adf = adfInquiryRequest({ organizationId: ORG, adf: { firstName: 'Pat', lastName: 'Lee', email, phone, provider: 'AutoTrader', providerInquiryId: `at-${serial}`, vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' }, comments: 'Paused ADF' } as any, receivedAt: new Date(), channel: 'adf', source: 'Third-Party Lead', leadDraft: { createdBy: ids.owner } });
      expect((await submitLeadInquiry(adf)).status).toBe('held');
      expect((await submitLeadInquiry(adf)).status).toBe('held');
      const mail = gmailMessage({ from: 'leads@dealerscloud.com', subject: 'New lead', body: `<?xml version="1.0"?><adf><prospect><customer><contact><name part="first">Pat</name><email>${email}</email><phone>${phone}</phone></contact><comments>Paused Gmail</comments></customer></prospect></adf>` });
      const gmailInput = { organizationId: ORG, ...mail, leadSourceEmail: 'leads@dealerscloud.com', systemUserId: String(ids.owner), allowNewInquiry: true };
      expect((await processGmailMessageThroughIntake(gmailInput)).status).toBe('held');
      expect((await processGmailMessageThroughIntake(gmailInput)).status).toBe('held');
      const text: any = await sms(ORG, phone, 'Paused text');
      const callControlId = `cc-${new mongoose.Types.ObjectId()}`;
      const callSessionId = `cs-${new mongoose.Types.ObjectId()}`;
      await handleCallInitiated({ direction: 'incoming', call_control_id: callControlId, call_session_id: callSessionId, from: phone, to: '+18015550999' });

      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(1);
      expect((await Lead.findById(closed._id).lean() as any)).toMatchObject({ status: 'Closed', isRead: true });
      expect((await CommunicationMessage.findById(text._id).lean() as any).leadId ?? null).toBeNull();
      expect((await CallLog.findOne({ providerCallControlId: callControlId }).lean() as any).leadId ?? null).toBeNull();
      const appointment: any = await Appointment.findById(booking.body.data.appointmentId).lean();
      expect(appointment.leadId ?? null).toBeNull();
      const held = await LeadInquiry.find({ organizationId: orgId, 'contact.normalizedPhone': phone }).lean();
      expect(held.length).toBe(6);
      expect(held.every((event: any) => event.association.state === 'received')).toBe(true);

      await setMode('off');
      await recoverLeadIntake({ organizationId: ORG });
      expect(await LeadInquiry.countDocuments({ organizationId: orgId, 'contact.normalizedPhone': phone, 'association.state': 'received' })).toBe(6);

      await setMode('active');
      await recoverLeadIntake({ organizationId: ORG });
      await waitFor(
        () => LeadInquiry.countDocuments({ organizationId: orgId, 'contact.normalizedPhone': phone, 'association.state': 'associated', 'sideEffects.conversationRecord.state': { $in: ['done', 'skipped'] } }),
        (count) => count === 6,
      );
      const leads: any[] = await Lead.find({ organizationId: orgId, phone }).lean();
      expect(leads).toHaveLength(2);
      const fresh = leads.find((lead) => String(lead._id) !== String(closed._id));
      expect((await Lead.findById(closed._id).lean() as any).status).toBe('Closed');
      const linkedText: any = await waitFor(() => CommunicationMessage.findById(text._id).lean(), (doc: any) => Boolean(doc?.leadId));
      expect(String(linkedText.leadId)).toBe(String(fresh._id));
      expect(String((await CallLog.findOne({ providerCallControlId: callControlId }).lean() as any).leadId)).toBe(String(fresh._id));
      expect(String((await Appointment.findById(booking.body.data.appointmentId).lean() as any).leadId)).toBe(String(fresh._id));
      expect(await LeadInquiry.countDocuments({ organizationId: orgId, 'contact.normalizedPhone': phone, 'association.state': 'associated' })).toBe(6);
      await handleCallHangup({ call_control_id: callControlId, call_session_id: callSessionId, hangup_cause: 'normal_clearing' });
    });
  });

  describe('Telnyx webhook', () => {
    it('handles a normal text with lifecycle intake off and treats repeated or simultaneous deliveries as one', async () => {
      await setMode('off', AI_ORG);
      process.env.COMM_ORG_ID = AI_ORG;
      const phone = nextPhone();
      const payload = smsPayload(phone, 'Hi, is the Tacoma available?');
      const responses = await Promise.all([webhook(payload), webhook(payload), webhook(payload)]);
      expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
      await webhook(payload);
      const messages = await waitFor(() => CommunicationMessage.find({ orgId: AI_ORG, providerMessageId: payload.id }).lean(), (docs) => docs.length >= 1);
      expect(messages).toHaveLength(1);
      const lead: any = await waitFor(() => Lead.findOne({ organizationId: aiOrgId, phone }).lean(), (doc) => Boolean(doc));
      expect(await Lead.countDocuments({ organizationId: aiOrgId, phone })).toBe(1);
      await waitFor(async () => alexCallsFor(lead._id), (count) => count >= 1);
      await settle();
      expect(alexCallsFor(lead._id)).toBe(1);
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': String(lead._id) })).toBe(1);
    });

    it('asks Telnyx to retry when the text cannot be stored, then stores it exactly once on the retry (intake off and on)', async () => {
      for (const mode of ['off', 'active'] as const) {
        await setMode(mode);
        const phone = nextPhone();
        const payload = smsPayload(phone, `Retry check ${mode}`);
        const target = mode === 'off' ? IntakeClaim : LeadInquiry;
        const method = mode === 'off' ? 'findOneAndUpdate' : 'create';
        const outage = jest.spyOn(target as any, method).mockImplementationOnce(() => { throw new Error('database unavailable'); });
        const failed = await webhook(payload);
        outage.mockRestore();
        expect(failed.status).toBe(503);
        expect(await CommunicationMessage.countDocuments({ orgId: ORG, providerMessageId: payload.id })).toBe(0);
        const retried = await webhook(payload);
        expect(retried.status).toBe(200);
        await webhook(payload);
        const stored = await waitFor(() => CommunicationMessage.countDocuments({ orgId: ORG, providerMessageId: payload.id }), (count) => count >= 1);
        expect(stored).toBe(1);
        await settle(300);
        expect(await CommunicationMessage.countDocuments({ orgId: ORG, providerMessageId: payload.id })).toBe(1);
      }
    });

    it('answers Telnyx before slow follow-up work finishes', async () => {
      await setMode('off');
      const phone = nextPhone();
      const lead = await makeLead(orgId, { phone });
      await Appointment.create({
        organizationId: orgId, createdBy: ids.owner, createdByModel: 'User', participants: [ids.owner], participantModel: 'User',
        title: 'Test drive', startTime: new Date(Date.now() + 2 * 86400000), endTime: new Date(Date.now() + 2 * 86400000 + HOUR),
        type: 'test-drive', entryType: 'appointment', status: 'scheduled', leadId: lead._id, reminderSent: true, reminderSentAt: new Date(),
        customerBooking: { firstName: 'Pat', lastName: 'Lee', email: nextEmail(), phone, isCustomerBooking: false },
      });
      mockSendSms.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ id: `out-${serial}` }), 1500)));
      const started = Date.now();
      const res = await webhook(smsPayload(phone, 'YES'));
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(1000);
      expect(mockSendSms).not.toHaveBeenCalled();
      await waitFor(async () => mockSendSms.mock.calls.length, (count) => count >= 1);
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      await settle(1700);
    });

    it.each(['off', 'active'] as const)('keeps STOP, START, HELP, YES, CANCEL and reschedule replies working with intake %s', async (mode) => {
      await setMode(mode);
      const phone = nextPhone();
      const lead = await makeLead(orgId, { phone });
      const appointment = await Appointment.create({
        organizationId: orgId, createdBy: ids.owner, createdByModel: 'User', participants: [ids.owner], participantModel: 'User',
        title: 'Test drive', startTime: new Date(Date.now() + 3 * 86400000), endTime: new Date(Date.now() + 3 * 86400000 + HOUR),
        type: 'test-drive', entryType: 'appointment', status: 'scheduled', leadId: lead._id, reminderSent: true, reminderSentAt: new Date(),
        customerBooking: { firstName: 'Pat', lastName: 'Lee', email: nextEmail(), phone, isCustomerBooking: false },
      });
      await sms(ORG, phone, 'YES');
      expect((await Appointment.findById(appointment._id).lean() as any).status).toBe('confirmed');
      await sms(ORG, phone, 'CANCEL');
      expect((await Appointment.findById(appointment._id).lean() as any).rescheduleAwaitingReplyAt).toBeTruthy();
      await sms(ORG, phone, 'Tuesday at 3pm works');
      expect((await Appointment.findById(appointment._id).lean() as any).rescheduleStatedPreference).toBe('Tuesday at 3pm works');
      await sms(ORG, phone, 'STOP');
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone }).lean() as any)?.optedOut).toBe(true);
      await sms(ORG, phone, 'START');
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone }).lean() as any)?.optedOut).toBe(false);
      const help: any = await sms(ORG, phone, 'HELP');
      expect(help?._id).toBeTruthy();
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(1);
      expect(await CommunicationMessage.countDocuments({ orgId: ORG, from: phone, direction: 'inbound' })).toBe(6);
    });
  });

  describe('conflicting contact details', () => {
    beforeAll(async () => { await setMode('active'); });
    beforeEach(async () => { await setMode('active'); });

    it('opens a separate lead for a website inquiry with the same phone but a different email', async () => {
      const phone = nextPhone();
      const open = await makeLead(orgId, { phone, email: nextEmail() });
      const other = nextEmail();
      await leadService.processInquiry({ organizationId: ORG, customerId: String(new mongoose.Types.ObjectId()), vehicleId: String(truckId), customerName: { first: 'Sam', last: 'Lee' }, customerEmail: other, customerPhone: phone, comments: 'Different person' });
      const created: any = await Lead.findOne({ organizationId: orgId, email: other }).lean();
      expect(created).toBeTruthy();
      expect(String(created._id)).not.toBe(String(open._id));
      const untouched: any = await Lead.findById(open._id).lean();
      expect(untouched.isRead).toBe(true);
      expect(untouched.inquiryCount ?? 1).toBe(1);
    });

    it('opens a separate lead for a booking with the same email but a different phone', async () => {
      const email = nextEmail();
      const open = await makeLead(orgId, { phone: nextPhone(), email });
      const res = await request(app).post('/public/book').send({ vehicleId: String(truckId), firstName: 'Sam', lastName: 'Lee', email, phone: nextPhone(), startTime: new Date(Date.now() + 86400000).toISOString() });
      expect(res.status).toBe(201);
      expect(String(res.body.data.leadId)).not.toBe(String(open._id));
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(2);
    });

    it('adds a provider lead with the same phone and email to the open lead', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const open = await makeLead(orgId, { phone, email });
      const result: any = await submitLeadInquiry(adfInquiryRequest({ organizationId: ORG, adf: { firstName: 'Pat', lastName: 'Lee', email, phone, provider: 'Cars.com', providerInquiryId: `cc-${serial}`, comments: 'Same person' } as any, receivedAt: new Date(), channel: 'adf', source: 'Third-Party Lead', leadDraft: { createdBy: ids.owner } }));
      expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(open._id) });
    });

    it('does not treat missing details as a conflict', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const open = await makeLead(orgId, { phone, email });
      const text: any = await sms(ORG, phone, 'Text without an email');
      expect(String(text.leadId)).toBe(String(open._id));
      const mail = gmailMessage({ from: 'leads@dealerscloud.com', subject: 'New lead', body: `<?xml version="1.0"?><adf><prospect><customer><contact><name part="first">Pat</name><email>${email}</email></contact></customer></prospect></adf>` });
      const result: any = await processGmailMessageThroughIntake({ organizationId: ORG, ...mail, leadSourceEmail: 'leads@dealerscloud.com', systemUserId: String(ids.owner), allowNewInquiry: true });
      expect(result).toMatchObject({ status: 'associated', leadId: String(open._id) });
      expect(await Lead.countDocuments({ organizationId: orgId, $or: [{ phone }, { email }] })).toBe(1);
    });
  });

  describe('crash after Telnyx was answered', () => {
    beforeEach(async () => { await setMode('active'); });

    async function retainedOnly(from: string, text: string) {
      const retention = await retainInboundSms({ id: smsId(), from, to: '+18015550999', text }, ORG);
      await LeadInquiry.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(retention!.inquiryId)) }, { $set: { receivedAt: new Date(Date.now() - 5 * 60_000) } });
      return retention!;
    }

    it('rebuilds a saved text and files it when the server stopped right after answering Telnyx', async () => {
      const phone = nextPhone();
      const open = await makeLead(orgId, { phone });
      const retention = await retainedOnly(phone, 'Can I come at 4?');
      expect(await CommunicationMessage.countDocuments({ _id: retention.messageId })).toBe(0);
      await recoverLeadIntake({ organizationId: ORG, minAgeMs: 2 * 60_000 });
      const restored: any = await waitFor(() => CommunicationMessage.findById(retention.messageId).lean(), (doc: any) => Boolean(doc?.leadId));
      expect(restored).toMatchObject({ body: 'Can I come at 4?', direction: 'inbound' });
      expect(String(restored.leadId)).toBe(String(open._id));
      await recoverLeadIntake({ organizationId: ORG, minAgeMs: 2 * 60_000 });
      expect(await CommunicationMessage.countDocuments({ _id: retention.messageId })).toBe(1);
    });

    it('still honors a saved STOP after a crash, never makes a lead from it, and never lets an old STOP undo a newer START', async () => {
      const phone = nextPhone();
      const stop = await retainedOnly(phone, 'STOP');
      await recoverLeadIntake({ organizationId: ORG, minAgeMs: 2 * 60_000 });
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone }).lean() as any)?.optedOut).toBe(true);
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(0);
      expect((await LeadInquiry.findById(stop.inquiryId).lean() as any).association).toMatchObject({ state: 'resolved', reason: 'sms_keyword' });

      const later = nextPhone();
      await SmsOptOut.create({ organizationId: ORG, phone: later, optedOut: false, changedAt: new Date(), keyword: 'START' });
      await retainedOnly(later, 'STOP');
      await recoverLeadIntake({ organizationId: ORG, minAgeMs: 2 * 60_000 });
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone: later }).lean() as any)?.optedOut).toBe(false);
      await SmsOptOut.deleteMany({ organizationId: ORG, phone: { $in: [phone, later] } });
    });

    it('leaves a brand-new saved text to the live handler for two minutes before rebuilding it', async () => {
      const phone = nextPhone();
      const retention = await retainInboundSms({ id: smsId(), from: phone, to: '+18015550999', text: 'Just arrived' }, ORG);
      await recoverLeadIntake({ organizationId: ORG, minAgeMs: 2 * 60_000 });
      expect(await CommunicationMessage.countDocuments({ _id: retention!.messageId })).toBe(0);
      expect((await LeadInquiry.findById(retention!.inquiryId).lean() as any).association.state).toBe('received');
    });
  });

  describe('Gmail after a lead closes', () => {
    beforeEach(async () => { await setMode('active'); });
    const direct = (from: string, subject: string, body: string, threadId?: string, extra: { headers?: Array<{ name: string; value: string }>; id?: string } = {}) =>
      processGmailMessageThroughIntake({ organizationId: ORG, ...gmailMessage({ from, subject, body, threadId, ...extra }), leadSourceEmail: null, systemUserId: String(ids.owner), allowNewInquiry: true });

    it('opens a fresh lead when a closed-lead customer emails about a specific vehicle in stock, and leaves the old lead alone', async () => {
      const email = nextEmail();
      const closed = await makeLead(orgId, { email }, { status: 'Sold' });
      const result: any = await direct(`Pat Lee <${email}>`, 'Another truck', 'Hi, is the 2021 Toyota Tacoma still available for a test drive?');
      expect(result).toMatchObject({ status: 'associated', created: true, reason: 'previous_lead_finished' });
      const fresh: any = await Lead.findById(result.leadId).lean();
      expect(String(fresh.vehicleId)).toBe(String(truckId));
      expect(fresh).toMatchObject({ status: 'New', email, location: 'Lehi' });
      const old: any = await Lead.findById(closed._id).lean();
      expect(old).toMatchObject({ status: 'Sold', isRead: true });
      expect(old.inquiryCount ?? 1).toBe(1);
      const event: any = await LeadInquiry.findById(result.inquiryId).lean();
      expect(event).toMatchObject({ intentAssurance: 'confirmed', evidence: { automated: false, isReply: false, vehicleMatch: 'year_make_model' } });
    });

    it('accepts a VIN or stock number from this dealership\u2019s inventory as evidence too', async () => {
      const byVin = nextEmail();
      await makeLead(orgId, { email: byVin }, { status: 'Closed' });
      expect(await direct(`A <${byVin}>`, 'Question', 'Is VIN 1HGBH41JXMN109999 sold?')).toMatchObject({ status: 'associated', created: true });
      const byStock = nextEmail();
      await makeLead(orgId, { email: byStock }, { status: 'Closed' });
      expect(await direct(`B <${byStock}>`, 'Question', 'Can I see stock # T900 tomorrow?')).toMatchObject({ status: 'associated', created: true });
    });

    it('keeps a reply or a vehicle that is not in this dealership\u2019s inventory in review', async () => {
      const replying = nextEmail();
      await makeLead(orgId, { email: replying }, { status: 'Closed' });
      expect(await direct(`A <${replying}>`, 'Re: Your Tacoma', 'Is the 2021 Toyota Tacoma still there?')).toMatchObject({ status: 'review', reason: 'email_after_lead_closed' });
      const threaded = nextEmail();
      await makeLead(orgId, { email: threaded }, { status: 'Closed' });
      expect(await direct(`B <${threaded}>`, 'Tacoma', 'Is the 2021 Toyota Tacoma still there?', undefined, { headers: [{ name: 'In-Reply-To', value: '<abc@mail.example.com>' }] }))
        .toMatchObject({ status: 'review' });
      const elsewhere = nextEmail();
      await makeLead(orgId, { email: elsewhere }, { status: 'Closed' });
      expect(await direct(`C <${elsewhere}>`, 'Car', 'Do you have a 2019 Honda Accord?')).toMatchObject({ status: 'review', reason: 'email_after_lead_closed' });
      for (const address of [replying, threaded, elsewhere]) expect(await Lead.countDocuments({ organizationId: orgId, email: address })).toBe(1);
    });

    it('never creates leads from bulk or automatically sent mail, even when it mentions a vehicle', async () => {
      const email = nextEmail();
      await makeLead(orgId, { email }, { status: 'Closed' });
      expect(await direct(`News <${email}>`, 'Weekly deals', 'The 2021 Toyota Tacoma is on sale', undefined, { headers: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }] }))
        .toMatchObject({ status: 'dismissed' });
      expect(await direct(`Pat <${email}>`, 'Away', 'About the 2021 Toyota Tacoma', undefined, { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }))
        .toMatchObject({ status: 'dismissed' });
      expect(await direct(`Pat <${email}>`, 'Hello', 'Price list for the 2021 Toyota Tacoma', undefined, { headers: [{ name: 'Precedence', value: 'bulk' }] }))
        .toMatchObject({ status: 'dismissed' });
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('turns a Gmail message seen by both sync paths into one lead and one set of notifications', async () => {
      const email = nextEmail();
      await makeLead(orgId, { email }, { status: 'Closed' });
      const id = `gm-${new mongoose.Types.ObjectId()}`;
      const first: any = await direct(`Pat <${email}>`, 'Tacoma', 'Is the 2021 Toyota Tacoma available?', undefined, { id });
      const second: any = await direct(`Pat <${email}>`, 'Tacoma', 'Is the 2021 Toyota Tacoma available?', undefined, { id });
      expect(first).toMatchObject({ status: 'associated', created: true });
      expect(second).toMatchObject({ status: 'duplicate', leadId: first.leadId });
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(2);
      expect(await LeadInquiry.countDocuments({ organizationId: orgId, 'sourceIds.gmailMessageId': id })).toBe(1);
      const notified = await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': first.leadId });
      await direct(`Pat <${email}>`, 'Tacoma', 'Is the 2021 Toyota Tacoma available?', undefined, { id });
      expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': first.leadId })).toBe(notified);
    });

    it('sends a direct email from a closed-lead customer to review instead of guessing', async () => {
      const email = nextEmail();
      await makeLead(orgId, { email }, { status: 'Sold' });
      const result: any = await direct(`Pat Lee <${email}>`, 'Thanks again', 'Thanks for everything!');
      expect(result).toMatchObject({ status: 'review', reason: 'email_after_lead_closed' });
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('treats a brand-new sender as a new inquiry', async () => {
      const email = nextEmail();
      const result: any = await direct(`New Person <${email}>`, 'Question about a truck', 'Do you finance?');
      expect(result).toMatchObject({ status: 'associated', created: true });
    });

    it('never creates leads from auto-replies or bounces', async () => {
      const email = nextEmail();
      await makeLead(orgId, { email }, { status: 'Closed' });
      expect(await direct(`Pat Lee <${email}>`, 'Automatic reply: Out of office', 'I am away')).toMatchObject({ status: 'dismissed' });
      expect(await direct('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', 'Undeliverable')).toMatchObject({ status: 'dismissed' });
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('sends a reply on a closed lead’s email thread to review', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      await makeLead(orgId, { email }, { status: 'Closed', threadId });
      const result: any = await direct(`Pat Lee <${email}>`, 'Re: Your truck', 'One more question', threadId);
      expect(result).toMatchObject({ status: 'review', reason: 'reply_after_lead_closed' });
    });

    it('opens a fresh lead from a genuine lead-source notification after closure', async () => {
      const email = nextEmail();
      const closed = await makeLead(orgId, { email }, { status: 'Closed' });
      const mail = gmailMessage({ from: 'leads@dealerscloud.com', subject: 'New lead', body: `<?xml version="1.0"?><adf><prospect><customer><contact><name part="first">Pat</name><email>${email}</email></contact><comments>Back for another one</comments></customer></prospect></adf>` });
      const result: any = await processGmailMessageThroughIntake({ organizationId: ORG, ...mail, leadSourceEmail: 'leads@dealerscloud.com', systemUserId: String(ids.owner), allowNewInquiry: true });
      expect(result).toMatchObject({ status: 'associated', created: true });
      expect(result.leadId).not.toBe(String(closed._id));
    });
  });
});
