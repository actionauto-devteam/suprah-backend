import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockCreate = jest.fn();
const mockSendSms = jest.fn().mockResolvedValue({ id: 'local-provider-id' });
const mockEmit = jest.fn();
const mockPush = jest.fn().mockResolvedValue({});
const mockSendLeadReplyEmail = jest.fn();
const mockFetchThread = jest.fn().mockResolvedValue([]);
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550999', sendSms: mockSendSms }));
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: mockEmit, emitToUser: mockEmit, emitToCrmUser: mockEmit, getSocketIO: () => null }));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: mockPush } }));
jest.mock('../src/controllers/lead.controller', () => ({
  ...jest.requireActual('../src/controllers/lead.controller'),
  sendLeadReplyEmail: mockSendLeadReplyEmail,
  fetchGmailThreadMessages: mockFetchThread,
}));

process.env.GEMINI_API_KEY = 'test-key';
process.env.LOCAL_UI_ACCEPTANCE_MODE = '';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '2000';

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import Notification from '../src/models/Notification.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { normalizeIdentityPhone, normalizeIdentityEmail } from '../src/utils/contactIdentity';
import { handleInboundSms } from '../src/services/communication.service';
import { triggerAiEmailReplyForNewInquiry } from '../src/services/aiEmailReply.service';
import { sendVisitorMessage } from '../src/controllers/webchat.controller';

const orgId = new mongoose.Types.ObjectId();
const creator = new mongoose.Types.ObjectId();
const repId = new mongoose.Types.ObjectId();
const DRAFT_TEXT = 'Thanks! I will check with the team and follow up shortly.';
let serial = 0;
let intent = 'none';
let calls: Array<{ system: string; user: string }> = [];

const app = express();
app.use(express.json());
app.post('/visitor/:sessionId', sendVisitorMessage);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const MODES = (mode: string) => ({ sms: mode, email: mode, webchat: mode });

async function setOrg(metadata: any) {
  await Organization.updateOne({ _id: orgId }, { $set: { metadata } });
}

async function seedLead(overrides: any = {}) {
  const phone = overrides.phone ?? `+1801555${String(2000 + ++serial)}`;
  const email = overrides.email ?? `shadow.inbound.${serial}@example.com`;
  const doc: any = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    createdBy: creator,
    firstName: 'Riley',
    lastName: 'Inbound',
    phone,
    normalizedPhone: phone ? normalizeIdentityPhone(phone) : null,
    email,
    normalizedEmail: email ? normalizeIdentityEmail(email) : null,
    vehicle: { year: '2022', make: 'Toyota', model: 'Camry' },
    assignedTo: repId,
    status: 'New',
    source: 'Inbound SMS',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await Lead.collection.insertOne(doc);
  return doc;
}

const smsPayload = (lead: any, text: string, id = `msg-${crypto.randomUUID()}`) => ({
  id, text, from: { phone_number: lead.phone }, to: [{ phone_number: '+18015550999' }],
});

async function waitFor(condition: () => Promise<any>, ms = 3000): Promise<any> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
const draftsFor = (sourceMessageId: string) => AiAgentDraft.find({ organizationId: String(orgId), sourceMessageId }).lean();
const generationCalls = () => calls.filter((call) => !call.system.includes('Classify the latest') && !call.system.includes('strict compliance classifier'));

describe('Real-DB proof: inbound shadow draft hooks (local dev MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    await Organization.collection.insertOne({ _id: orgId, name: 'Shadow Inbound Motors', slug: `shadow-inbound-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: repId, organizationId: orgId, name: 'Shadow Rep', email: `shadow-rep-${repId}@example.com`, role: 'employee', isActive: true } as any);
  });

  afterAll(async () => {
    const ids = [orgId, String(orgId)];
    await AiAgentDraft.deleteMany({ organizationId: String(orgId) });
    await AiUsageCounter.deleteMany({ organizationId: String(orgId) });
    await Lead.collection.deleteMany({ organizationId: orgId });
    await Conversation.collection.deleteMany({ orgId: { $in: ids } });
    await CommunicationMessage.collection.deleteMany({ orgId: { $in: ids } });
    await WebChatSession.collection.deleteMany({ organizationId: String(orgId) });
    await WebChatMessage.collection.deleteMany({ organizationId: String(orgId) });
    await AiAgentTask.collection.deleteMany({ organizationId: { $in: ids } });
    await AiAgentLog.collection.deleteMany({ organizationId: { $in: ids } });
    await Notification.collection.deleteMany({ organizationId: { $in: ids } });
    await Organization.collection.deleteOne({ _id: orgId });
    await User.collection.deleteOne({ _id: repId });
    process.env = env;
  });

  beforeEach(async () => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    delete process.env.DEMO_LAB_ENABLED;
    await AiUsageCounter.deleteMany({ organizationId: String(orgId) });
    await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
    intent = 'none';
    calls = [];
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (body: any) => {
      const system = String(body?.messages?.[0]?.content || '');
      const user = String(body?.messages?.[1]?.content || '');
      calls.push({ system, user });
      const content = system.includes('Classify the latest') ? JSON.stringify({ intent })
        : system.includes('strict compliance classifier') ? 'SAFE'
          : system.includes('You select dealership coaching rules') ? '{"relevantRuleIds":[],"suppressed":[]}'
            : DRAFT_TEXT;
      return { model: 'gemini-test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } };
    });
    mockSendSms.mockClear();
    mockSendLeadReplyEmail.mockClear();
    mockFetchThread.mockClear();
  });

  describe('SMS', () => {
    it('Training: stores a shadow draft keyed to the inbound CommunicationMessage and sends nothing', async () => {
      const lead = await seedLead();
      const message: any = await handleInboundSms(smsPayload(lead, 'Is the Camry still around?'), orgId);
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await draftsFor(String(message._id));
        return rows.length && rows[0].status !== 'generating' && rows[0].status !== 'claimed' ? rows : null;
      });
      expect(draft).toMatchObject({ channel: 'sms', sourceMessageModel: 'CommunicationMessage', status: 'ready', modeAtClaim: 'training' });
      expect(String(draft.conversationId)).toBe(String(message.conversationId));
      expect(String(draft.leadId)).toBe(String(lead._id));
      expect(draft.draftText).toBe(DRAFT_TEXT);
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(await CommunicationMessage.countDocuments({ conversationId: message.conversationId, direction: 'outbound' })).toBe(0);
      expect(await AiAgentLog.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(0);
    });

    it('a Telnyx redelivery of the same message never creates a second draft', async () => {
      const lead = await seedLead();
      const payload = smsPayload(lead, 'Hello again');
      const first: any = await handleInboundSms(payload, orgId);
      await waitFor(async () => (await draftsFor(String(first._id))).length);
      const second: any = await handleInboundSms(payload, orgId);
      await settle();
      expect(String(second._id)).toBe(String(first._id));
      expect(await AiAgentDraft.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(1);
      expect(await CommunicationMessage.countDocuments({ orgId, leadId: lead._id, direction: 'inbound' })).toBe(1);
    });

    it.each([
      ['the global shadow flag is off', () => { delete process.env.AI_SHADOW_DRAFTS_ENABLED; }, null],
      ['the organization has not enabled shadow drafts', () => undefined, { aiAgentName: 'Alex', aiAgentModes: MODES('training') }],
      ['the channel is in Testing', () => undefined, { aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('testing') }],
      ['the channel is Off', () => undefined, { aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('off') }],
    ])('no draft when %s, and the live inbound result is unchanged', async (_label, applyEnv, metadata) => {
      applyEnv();
      if (metadata) await setOrg(metadata);
      const lead = await seedLead();
      const message: any = await handleInboundSms(smsPayload(lead, 'Any update?'), orgId);
      await settle();
      expect(await draftsFor(String(message._id))).toHaveLength(0);
      expect(generationCalls()).toHaveLength(0);
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(await CommunicationMessage.countDocuments({ conversationId: message.conversationId })).toBe(1);
      expect(await AiUsageCounter.countDocuments({ organizationId: String(orgId), kind: 'shadow_draft' })).toBe(0);
    });

    it('Live: Alex still replies for real and no shadow draft is made', async () => {
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentEnabled: true, aiAgentModes: { sms: 'live', email: 'training', webchat: 'training' } });
      const lead = await seedLead();
      const message: any = await handleInboundSms(smsPayload(lead, 'What time do you open?'), orgId);
      await waitFor(async () => mockSendSms.mock.calls.length > 0);
      await settle();
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await CommunicationMessage.countDocuments({ conversationId: message.conversationId, direction: 'outbound', 'sentBy.userId': 'ai-agent' })).toBe(1);
      expect(await draftsFor(String(message._id))).toHaveLength(0);
    });

    it('a customer asking for a person keeps the live escalation and records skipped_attention without generating', async () => {
      intent = 'human_request';
      const lead = await seedLead();
      const message: any = await handleInboundSms(smsPayload(lead, 'Can I talk to a real person please?'), orgId);
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await draftsFor(String(message._id));
        return rows.length ? rows : null;
      });
      expect(draft).toMatchObject({ status: 'skipped_attention', statusReason: 'Customer requested human' });
      expect(draft.draftText).toBeUndefined();
      expect(generationCalls()).toHaveLength(0);
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(1);
      expect(await AiUsageCounter.countDocuments({ organizationId: String(orgId), kind: 'shadow_draft' })).toBe(0);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('Demo Lab simulated sends in Training are unchanged and make no shadow draft', async () => {
      process.env.DEMO_LAB_ENABLED = 'true';
      const lead = await seedLead({ phone: '+18015550142', source: 'Demo' });
      const message: any = await handleInboundSms(smsPayload(lead, 'Demo question'), orgId);
      await waitFor(async () => mockSendSms.mock.calls.length > 0);
      await settle();
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await draftsFor(String(message._id))).toHaveLength(0);
    });
  });

  describe('webchat', () => {
    async function seedSession() {
      const lead = await seedLead({ phone: null, source: 'Website Chat' });
      const token = `shadow-token-${crypto.randomUUID()}`;
      const session = await WebChatSession.create({
        organizationId: String(orgId), leadId: lead._id, visitorName: 'Riley Inbound',
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      });
      return { lead, session, token };
    }

    it('Training: draft keyed to the WebChatMessage, the visitor ack still goes out once, and the draft never sees the ack', async () => {
      const { session, token } = await seedSession();
      const res = await request(app).post(`/visitor/${session._id}`).send({ token, message: 'Do you have SUVs in stock?' }).expect(201);
      const inbound: any = await WebChatMessage.findOne({ sessionId: session._id, direction: 'inbound' }).lean();
      expect(res.body.data.message).toBeTruthy();
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await draftsFor(String(inbound._id));
        return rows.length && rows[0].status === 'ready' ? rows : null;
      });
      expect(draft).toMatchObject({ channel: 'webchat', sourceMessageModel: 'WebChatMessage' });
      expect(String(draft.sessionId)).toBe(String(session._id));
      const outbound: any[] = await WebChatMessage.find({ sessionId: session._id, direction: 'outbound' }).lean();
      expect(outbound).toHaveLength(1);
      expect(outbound[0].body).toContain('Thanks for reaching out to');
      expect(outbound.some((row) => row.sentBy?.userId === 'ai-agent')).toBe(false);
      const prompt = generationCalls()[0].user;
      expect(prompt).toContain('Do you have SUVs in stock?');
      expect(prompt).not.toContain('Thanks for reaching out to');
    });

    it('flags off: the visitor ack still goes out and no draft is made', async () => {
      delete process.env.AI_SHADOW_DRAFTS_ENABLED;
      const { session, token } = await seedSession();
      await request(app).post(`/visitor/${session._id}`).send({ token, message: 'Hello there' }).expect(201);
      await settle();
      expect(await AiAgentDraft.countDocuments({ organizationId: String(orgId), sessionId: session._id })).toBe(0);
      expect(await WebChatMessage.countDocuments({ sessionId: session._id, direction: 'outbound' })).toBe(1);
      expect(generationCalls()).toHaveLength(0);
    });
  });

  describe('email first inquiry', () => {
    it('Training: one draft keyed to the Lead, no email sent, and a repeat trigger adds nothing', async () => {
      const lead = await seedLead({ phone: '' , source: 'ADF Email' });
      await triggerAiEmailReplyForNewInquiry(orgId, lead, 'Is the Camry available for a test drive Saturday?');
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await draftsFor(String(lead._id));
        return rows.length && rows[0].status === 'ready' ? rows : null;
      });
      expect(draft).toMatchObject({ channel: 'email', sourceMessageModel: 'Lead', classifierVerdict: 'SAFE' });
      expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
      await triggerAiEmailReplyForNewInquiry(orgId, lead, 'Is the Camry available for a test drive Saturday?');
      await settle();
      expect(await AiAgentDraft.countDocuments({ organizationId: String(orgId), leadId: lead._id })).toBe(1);
      expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
    });

    it('flags off: nothing is drafted or sent', async () => {
      delete process.env.AI_SHADOW_DRAFTS_ENABLED;
      const lead = await seedLead({ phone: '', source: 'ADF Email' });
      await triggerAiEmailReplyForNewInquiry(orgId, lead, 'Looking for pricing info');
      await settle();
      expect(await draftsFor(String(lead._id))).toHaveLength(0);
      expect(mockSendLeadReplyEmail).not.toHaveBeenCalled();
      expect(generationCalls()).toHaveLength(0);
    });
  });
});
