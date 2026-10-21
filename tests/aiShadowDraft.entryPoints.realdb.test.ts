import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const signingKeys = crypto.generateKeyPairSync('ed25519');
const rawPublicKey = (signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12);
process.env.TELNYX_PUBLIC_KEY = rawPublicKey.toString('base64');

const mockCreate = jest.fn();
const mockSendSms = jest.fn().mockResolvedValue({ id: 'local-provider-id' });
const mockEmit = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('../src/services/telnyx.service', () => ({
  ...jest.requireActual('../src/services/telnyx.service'),
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
}));
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: mockEmit, emitToUser: mockEmit, emitToCrmUser: mockEmit, getSocketIO: () => null }));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

process.env.GEMINI_API_KEY = 'test-key';
process.env.LOCAL_UI_ACCEPTANCE_MODE = '';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '2000';

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import CustomerIdentityLock from '../src/models/CustomerIdentityLock.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import Notification from '../src/models/Notification.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { normalizeIdentityPhone } from '../src/utils/contactIdentity';
import { triggerAiReplyForNewInquiry } from '../src/services/communication.service';
import { startSession } from '../src/controllers/webchat.controller';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';

const orgId = new mongoose.Types.ObjectId();
const repId = new mongoose.Types.ObjectId();
const slug = `shadow-entry-${orgId}`;
const orgIds = [orgId, String(orgId)];
const DRAFT_TEXT = 'Thanks! I will check with the team and follow up shortly.';
let serial = 0;

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.post('/public/sessions', startSession);
app.use('/webhooks/telnyx', telnyxWebhookRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

function sign(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), signingKeys.privateKey).toString('base64');
  return { signature, timestamp };
}

async function waitFor(condition: () => Promise<any>, ms = 4000): Promise<any> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

const readyDraftFor = (sourceMessageId: string) => async () => {
  const draft: any = await AiAgentDraft.findOne({ organizationId: String(orgId), sourceMessageId }).lean();
  return draft && !['claimed', 'generating'].includes(draft.status) ? draft : null;
};

async function seedLead(overrides: any = {}) {
  const phone = overrides.phone ?? `+1801555${String(3000 + ++serial)}`;
  const doc: any = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    createdBy: repId,
    firstName: 'Jamie',
    lastName: 'Entry',
    phone,
    normalizedPhone: normalizeIdentityPhone(phone),
    vehicle: { year: '2021', make: 'Honda', model: 'Pilot' },
    status: 'New',
    source: 'Third-Party Lead',
    comments: 'Is the Pilot still available?',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await Lead.collection.insertOne(doc);
  return doc;
}

describe('Real-DB proof: shadow drafts from the remaining live entry points (local dev MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    await Organization.collection.insertOne({
      _id: orgId, name: 'Shadow Entry Motors', slug, status: 'active',
      metadata: { aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } },
    } as any);
    await User.collection.insertOne({ _id: repId, organizationId: orgId, name: 'Entry Rep', email: `entry-rep-${repId}@example.com`, role: 'employee', isActive: true } as any);
  });

  afterAll(async () => {
    const ids = [orgId, String(orgId)];
    for (const model of [AiAgentDraft, AiUsageCounter, AiAgentLog, AiAgentTask, Notification, WebChatSession, WebChatMessage, Customer, CustomerIdentityLock] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: ids } });
    }
    await Lead.collection.deleteMany({ organizationId: { $in: ids } });
    await Conversation.collection.deleteMany({ orgId: { $in: ids } });
    await CommunicationMessage.collection.deleteMany({ orgId: { $in: ids } });
    await User.collection.deleteOne({ _id: repId });
    await Organization.collection.deleteOne({ _id: orgId });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    process.env.COMM_ORG_ID = String(orgId);
    delete process.env.DEMO_LAB_ENABLED;
    delete process.env.WEBCHAT_ENABLED;
    mockSendSms.mockClear();
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (body: any) => {
      const system = String(body?.messages?.[0]?.content || '');
      const content = system.includes('Classify the latest') ? JSON.stringify({ intent: 'none' })
        : system.includes('strict compliance classifier') ? 'SAFE'
          : system.includes('You select dealership coaching rules') ? '{"relevantRuleIds":[],"suppressed":[]}'
            : DRAFT_TEXT;
      return { model: 'gemini-test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } };
    });
  });

  it('signed Telnyx webhook: a verified message.received produces one shadow draft and no outbound text', async () => {
    const lead = await seedLead();
    const body = JSON.stringify({ data: { id: crypto.randomUUID(), event_type: 'message.received', payload: {
      id: `telnyx-${crypto.randomUUID()}`, text: 'Hi, can I see the Pilot tomorrow?',
      from: { phone_number: lead.phone }, to: [{ phone_number: '+18015550999' }],
    } } });
    const { signature, timestamp } = sign(body);
    await request(app).post('/webhooks/telnyx').set('Content-Type', 'application/json')
      .set('telnyx-signature-ed25519', signature).set('telnyx-timestamp', timestamp).send(body).expect(200);

    const inbound: any = await waitFor(async () => CommunicationMessage.findOne({ orgId: { $in: orgIds }, leadId: lead._id, direction: 'inbound' }).lean());
    const draft = await waitFor(readyDraftFor(String(inbound._id)));
    expect(draft).toMatchObject({ channel: 'sms', sourceMessageModel: 'CommunicationMessage', status: 'ready' });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await CommunicationMessage.countDocuments({ orgId: { $in: orgIds }, leadId: lead._id, direction: 'outbound' })).toBe(0);
  });

  it('signed Telnyx webhook: a bad signature is rejected before anything is stored or drafted', async () => {
    const lead = await seedLead();
    const body = JSON.stringify({ data: { id: crypto.randomUUID(), event_type: 'message.received', payload: {
      id: `telnyx-${crypto.randomUUID()}`, text: 'Forged message', from: { phone_number: lead.phone }, to: [{ phone_number: '+18015550999' }],
    } } });
    const { timestamp } = sign(body);
    const forged = sign('{"different":true}', timestamp).signature;
    await request(app).post('/webhooks/telnyx').set('Content-Type', 'application/json')
      .set('telnyx-signature-ed25519', forged).set('telnyx-timestamp', timestamp).send(body).expect(401);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await CommunicationMessage.countDocuments({ orgId: { $in: orgIds }, leadId: lead._id })).toBe(0);
    expect(await AiAgentDraft.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(0);
  });

  it('webchat startSession: the first visitor message produces a shadow draft and the ack still goes out once', async () => {
    const res = await request(app).post('/public/sessions').send({
      orgKey: slug, name: 'Casey Visitor', email: `casey.${crypto.randomUUID()}@example.com`, message: 'Hi! Do you have any hybrid SUVs?',
    }).expect(201);
    const sessionId = res.body.data.sessionId;
    const first: any = await WebChatMessage.findOne({ sessionId, direction: 'inbound' }).lean();
    const draft = await waitFor(readyDraftFor(String(first._id)));
    expect(draft).toMatchObject({ channel: 'webchat', sourceMessageModel: 'WebChatMessage', status: 'ready' });
    expect(String(draft.sessionId)).toBe(String(sessionId));
    await waitFor(async () => (await WebChatMessage.countDocuments({ sessionId, direction: 'outbound' })) === 1);
    const outbound: any[] = await WebChatMessage.find({ sessionId, direction: 'outbound' }).lean();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].sentBy?.userId).not.toBe('ai-agent');
  });

  it('new-inquiry SMS (ADF / Add Lead path): one shadow draft for the created inquiry message, never twice', async () => {
    const lead = await seedLead();
    await triggerAiReplyForNewInquiry(orgId, lead, lead.phone, lead.comments);
    const inbound: any = await CommunicationMessage.findOne({ orgId: { $in: orgIds }, leadId: lead._id, direction: 'inbound' }).lean();
    expect(inbound.body).toBe(lead.comments);
    const draft = await waitFor(readyDraftFor(String(inbound._id)));
    expect(draft).toMatchObject({ channel: 'sms', status: 'ready', vehicleResolution: 'new_inquiry' });
    await triggerAiReplyForNewInquiry(orgId, lead, lead.phone, lead.comments);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await AiAgentDraft.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
