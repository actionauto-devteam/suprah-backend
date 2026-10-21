import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockCreate = jest.fn();
const mockSendSms = jest.fn().mockResolvedValue({ id: 'local-provider-id' });
const mockEmit = jest.fn();
const mockPush = jest.fn().mockResolvedValue({});
const mockSendLeadReplyEmail = jest.fn().mockResolvedValue({ messageId: 'local-email-id', threadId: 'local-thread-id' });
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

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import Notification from '../src/models/Notification.model';
import AiTechnicalAlertState from '../src/models/AiTechnicalAlertState.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { TECHNICAL_ATTENTION_REASONS, AttentionTechnicalCode } from '../src/models/aiHumanAttention';
import { normalizeIdentityPhone, normalizeIdentityEmail } from '../src/utils/contactIdentity';
import logger from '../src/utils/logger';
import { handleInboundSms } from '../src/services/communication.service';
import { triggerAiEmailReplyForNewInquiry } from '../src/services/aiEmailReply.service';
import { sendVisitorMessage, resumeWebchatAi } from '../src/controllers/webchat.controller';
import { resumeSmsAi } from '../src/controllers/communication.controller';
import { listAiAgentTasks } from '../src/controllers/aiAgentTask.controller';

const orgId = new mongoose.Types.ObjectId();
const creator = new mongoose.Types.ObjectId();
const repId = new mongoose.Types.ObjectId();
const crmAdminId = new mongoose.Types.ObjectId();
const DRAFT_TEXT = 'Thanks! I will check with the team and follow up shortly.';
const SENSITIVE = 'SENSITIVE-CUSTOMER-TEXT-4471';
let serial = 0;
let behavior = 'none';
let calls: Array<{ system: string }> = [];

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.orgId = String(orgId); req.crmUser = { _id: crmAdminId, fullName: 'Local Admin', role: 'admin' }; next(); });
app.post('/visitor/:sessionId', sendVisitorMessage);
app.post('/sms/:leadId/resume', resumeSmsAi);
app.post('/webchat/:leadId/resume', resumeWebchatAi);
app.get('/tasks', listAiAgentTasks);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const MODES = (mode: string) => ({ sms: mode, email: mode, webchat: mode });
const TECHNICAL: Array<[string, AttentionTechnicalCode]> = [
  ['timeout', 'timeout'],
  ['provider_error', 'provider_error'],
  ['malformed', 'unreadable_response'],
  ['fenced_invalid', 'unreadable_response'],
  ['uncertain', 'uncertain'],
  ['missing_key', 'missing_api_key'],
];

function classifierReply(): any {
  if (behavior === 'timeout') return new Promise(() => {});
  if (behavior === 'provider_error') throw Object.assign(new Error(`provider failure while reading ${SENSITIVE}`), { status: 503 });
  if (behavior === 'malformed') return 'They probably want a person, I think.';
  if (behavior === 'fenced_invalid') return '```json\n{"intent":"maybe"}\n```';
  if (behavior === 'uncertain') return '{"intent":"uncertain"}';
  if (behavior === 'fenced_none') return '```json\n{"intent":"none"}\n```';
  return JSON.stringify({ intent: behavior });
}

async function setOrg(metadata: any) {
  await Organization.updateOne({ _id: orgId }, { $set: { metadata } });
}

async function seedLead(overrides: any = {}) {
  const phone = overrides.phone !== undefined ? overrides.phone : `+1801555${String(5000 + ++serial)}`;
  const email = overrides.email ?? `attention.technical.${++serial}@example.com`;
  const doc: any = {
    _id: new mongoose.Types.ObjectId(), organizationId: orgId, createdBy: creator,
    firstName: 'Riley', lastName: 'Technical', phone, normalizedPhone: phone ? normalizeIdentityPhone(phone) : null,
    email, normalizedEmail: email ? normalizeIdentityEmail(email) : null,
    vehicle: { year: '2022', make: 'Toyota', model: 'Camry' }, assignedTo: repId,
    status: 'New', source: 'Inbound SMS', createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
  await Lead.collection.insertOne(doc);
  return doc;
}

async function seedSession() {
  const lead = await seedLead({ phone: null, source: 'Website Chat' });
  const token = `technical-token-${crypto.randomUUID()}`;
  const session = await WebChatSession.create({
    organizationId: String(orgId), leadId: lead._id, visitorName: 'Riley Technical',
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
  });
  return { lead, session, token };
}

const smsPayload = (lead: any, text: string) => ({
  id: `msg-${crypto.randomUUID()}`, text, from: { phone_number: lead.phone }, to: [{ phone_number: '+18015550999' }],
});

async function waitFor(condition: () => Promise<any>, ms = 4000): Promise<any> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const classifierCalls = () => calls.filter((call) => call.system.includes('Classify the latest'));
const generationCalls = () => calls.filter((call) => !call.system.includes('Classify the latest') && !call.system.includes('strict compliance classifier'));

type Channel = 'sms' | 'webchat' | 'email';

async function inbound(channel: Channel, text: string, existing?: any): Promise<{ lead: any; sourceId: string; session?: any; token?: string }> {
  if (channel === 'sms') {
    const lead = existing?.lead || await seedLead();
    const message: any = await handleInboundSms(smsPayload(lead, text), orgId);
    return { lead, sourceId: String(message._id) };
  }
  if (channel === 'webchat') {
    const ctx = existing || await seedSession();
    await request(app).post(`/visitor/${ctx.session._id}`).send({ token: ctx.token, message: text }).expect(201);
    const latest: any = await WebChatMessage.findOne({ sessionId: ctx.session._id, direction: 'inbound' }).sort({ createdAt: -1 }).lean();
    return { ...ctx, sourceId: String(latest._id) };
  }
  const lead = existing?.lead || await seedLead({ phone: '', source: 'ADF Email' });
  await triggerAiEmailReplyForNewInquiry(orgId, lead, text);
  return { lead, sourceId: String(lead._id) };
}

async function aiSendCount(channel: Channel, ctx: any): Promise<number> {
  if (channel === 'sms') {
    return mockSendSms.mock.calls.filter((args) => JSON.stringify(args).includes(ctx.lead.phone)).length +
      await CommunicationMessage.countDocuments({ orgId, leadId: ctx.lead._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' });
  }
  if (channel === 'webchat') {
    return WebChatMessage.countDocuments({ sessionId: ctx.session._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' });
  }
  return mockSendLeadReplyEmail.mock.calls.length;
}

async function attentionState(channel: Channel, ctx: any): Promise<any> {
  if (channel === 'sms') return Conversation.findOne({ orgId: { $in: [orgId, String(orgId)] }, leadId: ctx.lead._id }).lean();
  if (channel === 'webchat') return WebChatSession.findById(ctx.session._id).lean();
  return Lead.findById(ctx.lead._id).lean();
}

describe('Real-DB proof: technical attention failures never become customer requests (local dev MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    await Organization.collection.insertOne({ _id: orgId, name: 'Technical Attention Motors', slug: `technical-attention-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: repId, organizationId: orgId, name: 'Technical Rep', email: `technical-rep-${repId}@example.com`, role: 'employee', isActive: true } as any);
    await CrmUser.collection.insertOne({ _id: crmAdminId, organizationId: orgId, fullName: 'Local Admin', email: `technical-admin-${crmAdminId}@example.com`,
      username: `technical-admin-${crmAdminId}`, role: 'admin', isActive: true } as any);
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
    await AiTechnicalAlertState.collection.deleteMany({ organizationId: String(orgId) });
    await Organization.collection.deleteOne({ _id: orgId });
    await User.collection.deleteOne({ _id: repId });
    await CrmUser.collection.deleteOne({ _id: crmAdminId });
    process.env = env;
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'local-test-key';
    process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '2000';
    process.env.AI_AGENT_CLASSIFIER_TIMEOUT_MS = '2000';
    process.env.AI_AGENT_ATTENTION_TIMEOUT_MS = '150';
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    delete process.env.LOCAL_ATTENTION_MOCK_CLASSIFIER;
    delete process.env.DEMO_LAB_ENABLED;
    await AiUsageCounter.deleteMany({ organizationId: String(orgId) });
    await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('live') });
    behavior = 'none';
    calls = [];
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (body: any) => {
      const system = String(body?.messages?.[0]?.content || '');
      calls.push({ system });
      const content = system.includes('Classify the latest') ? await classifierReply()
        : system.includes('strict compliance classifier') ? 'SAFE'
          : system.includes('You select dealership coaching rules') ? '{"relevantRuleIds":[],"suppressed":[]}'
            : DRAFT_TEXT;
      return { model: 'gemini-test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } };
    });
    mockSendSms.mockClear();
    mockSendLeadReplyEmail.mockClear();
    mockFetchThread.mockClear();
    mockPush.mockClear();
  });

  describe.each(['sms', 'webchat', 'email'] as const)('%s', (channel) => {
    it('Live: an ordinary sedan-vs-SUV inquiry is screened as none, gets a real Alex reply, and creates no task', async () => {
      const ctx = await inbound(channel, 'Should I get a sedan or an SUV for a family of five?');
      await waitFor(async () => (await aiSendCount(channel, ctx)) > 0);
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: ctx.lead._id })).toBe(0);
      expect((await attentionState(channel, ctx))?.aiHumanAttention).toBeFalsy();
    });

    it('Live: valid fenced JSON from Gemini is accepted and the reply proceeds', async () => {
      behavior = 'fenced_none';
      const ctx = await inbound(channel, 'Do you have the Camry in blue?');
      await waitFor(async () => (await aiSendCount(channel, ctx)) > 0);
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: ctx.lead._id })).toBe(0);
    });

    it.each([
      ['human_request', 'Customer requested human', 'requested a human representative'],
      ['ai_identity_concern', 'AI identity concern', 'is questioning whether this conversation is automated'],
    ])('Live: a genuine %s keeps the customer wording, notifies staff, and sends nothing', async (intent, reason, wording) => {
      behavior = intent;
      const ctx = await inbound(channel, intent === 'human_request' ? 'Let me talk to a real person.' : 'Are you a bot?');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      expect(task).toMatchObject({ question: reason, attentionKind: 'customer', attentionCode: intent, classifierSource: 'gemini' });
      const notification: any = await waitFor(() => Notification.findOne({ 'metadata.taskId': String(task._id) }).lean());
      expect(notification.message).toContain(wording);
      expect(notification.metadata).toMatchObject({ attentionKind: 'customer', attentionCode: intent });
      await settle();
      expect(await aiSendCount(channel, ctx)).toBe(0);
    });

    it.each(TECHNICAL)('Live: classifier %s pauses Alex with the %s code, technical wording, and no AI send', async (mode, code) => {
      behavior = mode;
      if (mode === 'missing_key') delete process.env.GEMINI_API_KEY;
      const warn = jest.spyOn(logger, 'warn');
      try {
        const ctx = await inbound(channel, `Sedan or SUV? ${SENSITIVE}`);
        const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
        expect(task).toMatchObject({ question: TECHNICAL_ATTENTION_REASONS[code], attentionKind: 'technical', attentionCode: code });
        expect(task.notificationsSuppressedAt).toBeUndefined();
        const state = await attentionState(channel, ctx);
        expect(state.aiHumanAttention).toMatchObject({ kind: 'technical', code, reason: TECHNICAL_ATTENTION_REASONS[code] });
        expect(state.aiPausedAt).toBeInstanceOf(Date);
        expect(state.aiPausedBy?.name).toBe(TECHNICAL_ATTENTION_REASONS[code]);
        const notification: any = await waitFor(() => Notification.findOne({ 'metadata.taskId': String(task._id) }).lean());
        expect(notification.title).toBe(`${TECHNICAL_ATTENTION_REASONS[code]} - customer waiting`);
        expect(notification.message.toLowerCase()).not.toContain('requested a human');
        expect(notification.message.toLowerCase()).not.toContain('identity check');
        expect(notification.message).toContain(code === 'uncertain' ? "couldn't confidently tell" : 'technical issue, not a request from the customer');
        expect(notification.metadata).toMatchObject({ attentionKind: 'technical', attentionCode: code });
        const lead: any = await waitFor(async () => {
          const row: any = await Lead.findById(ctx.lead._id).lean();
          return row?.notes?.length ? row : null;
        });
        expect(lead.notes[0].text.toLowerCase()).not.toContain('requested a human');
        expect(lead.notes[0].text).toContain('Alex is paused until someone resumes it.');
        const log: any = await AiAgentLog.findById(task._id).lean();
        expect(log.failureReason).toContain(code);
        await settle();
        expect(await aiSendCount(channel, ctx)).toBe(0);
        expect(generationCalls()).toHaveLength(0);
        const attentionLogs = JSON.stringify(warn.mock.calls.filter((args) => String(args[1] || '').startsWith('[AiHumanAttention]')));
        expect(attentionLogs).toContain(code);
        expect(attentionLogs).not.toContain(SENSITIVE);
        expect(attentionLogs).not.toContain('local-test-key');
      } finally { warn.mockRestore(); }
    });

    it('Training: a technical failure is recorded under Technical, notifies nobody, and the shadow draft says so', async () => {
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
      behavior = 'timeout';
      const ctx = await inbound(channel, 'Sedan or SUV?');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      expect(task).toMatchObject({ attentionKind: 'technical', attentionCode: 'timeout' });
      expect(task.notificationsSuppressedAt).toBeInstanceOf(Date);
      expect(task.notificationsCompletedAt).toBeUndefined();
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await AiAgentDraft.find({ organizationId: String(orgId), sourceMessageId: ctx.sourceId }).lean();
        return rows.length ? rows : null;
      });
      expect(draft).toMatchObject({ status: 'skipped_technical', statusReason: 'Safety check timed out' });
      const lead: any = await waitFor(async () => {
        const row: any = await Lead.findById(ctx.lead._id).lean();
        return row?.notes?.length ? row : null;
      });
      expect(lead.notes[0].mentionedUserIds).toEqual([]);
      expect(lead.notes[0].text).toContain('Training mode: logged under Technical in AI Tasks; no staff were notified.');
      await settle();
      expect(await Notification.countDocuments({ organizationId: { $in: [orgId, String(orgId)] }, 'metadata.leadId': String(ctx.lead._id) })).toBe(0);
      expect(mockPush).not.toHaveBeenCalled();
      expect(await aiSendCount(channel, ctx)).toBe(0);
      expect(generationCalls()).toHaveLength(0);
    });
  });

  describe('Training mode incident handling', () => {
    beforeEach(async () => {
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
    });

    it('a genuine human request in Training still notifies staff and records skipped_attention', async () => {
      behavior = 'human_request';
      const ctx = await inbound('sms', 'Let me talk to a real person.');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      expect(task.attentionKind).toBe('customer');
      await waitFor(() => Notification.findOne({ 'metadata.taskId': String(task._id) }).lean());
      const [draft]: any[] = await waitFor(async () => {
        const rows: any[] = await AiAgentDraft.find({ organizationId: String(orgId), sourceMessageId: ctx.sourceId }).lean();
        return rows.length ? rows : null;
      });
      expect(draft.status).toBe('skipped_attention');
    });

    it('repeated technical incidents in one conversation keep one task, zero notifications, and one skipped_technical draft per message', async () => {
      behavior = 'provider_error';
      const first = await inbound('sms', 'Sedan or SUV?');
      await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: first.lead._id }).lean());
      const second = await inbound('sms', 'Hello?', first);
      const third = await inbound('sms', 'Anyone there?', first);
      for (const ctx of [first, second, third]) {
        await waitFor(async () => (await AiAgentDraft.countDocuments({ organizationId: String(orgId), sourceMessageId: ctx.sourceId, status: 'skipped_technical' })) === 1);
      }
      await settle();
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: first.lead._id })).toBe(1);
      expect(await Notification.countDocuments({ 'metadata.leadId': String(first.lead._id) })).toBe(0);
      expect(classifierCalls()).toHaveLength(1);
      expect(await aiSendCount('sms', first)).toBe(0);
    });

    it('an outage across several conversations produces one technical task each and still no staff notifications', async () => {
      behavior = 'timeout';
      const contexts = await Promise.all([inbound('sms', 'Sedan?'), inbound('sms', 'SUV?'), inbound('webchat', 'Truck?')]);
      for (const ctx of contexts) {
        await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id, attentionKind: 'technical' }).lean());
      }
      await settle();
      expect(await Notification.countDocuments({ 'metadata.leadId': { $in: contexts.map((ctx) => String(ctx.lead._id)) } })).toBe(0);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('switching the channel to Live means the next message in a technically-paused conversation notifies staff once', async () => {
      behavior = 'timeout';
      const first = await inbound('sms', 'Sedan or SUV?');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: first.lead._id }).lean());
      await settle();
      expect(await Notification.countDocuments({ 'metadata.taskId': String(task._id) })).toBe(0);
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('live') });
      await inbound('sms', 'Still there?', first);
      await waitFor(async () => (await Notification.countDocuments({ 'metadata.taskId': String(task._id) })) === 1);
      await inbound('sms', 'Hello?', first);
      await settle();
      expect(await Notification.countDocuments({ 'metadata.taskId': String(task._id) })).toBe(1);
      expect(await aiSendCount('sms', first)).toBe(0);
    });
  });

  describe('recovery', () => {
    it.each(['sms', 'webchat'] as const)('%s: after a technical pause, staff resume plus a working classifier lets Alex reply again', async (channel) => {
      behavior = 'timeout';
      const ctx = await inbound(channel, 'Sedan or SUV?');
      await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      await settle();
      expect(await aiSendCount(channel, ctx)).toBe(0);
      await request(app).post(`/${channel}/${ctx.lead._id}/resume`).expect(200);
      behavior = 'none';
      await inbound(channel, 'Okay, sedan or SUV then?', ctx);
      await waitFor(async () => (await aiSendCount(channel, ctx)) > 0);
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: ctx.lead._id })).toBe(1);
    });

    it('a technical pause in one conversation does not affect a new conversation once the provider recovers', async () => {
      behavior = 'provider_error';
      const broken = await inbound('sms', 'Sedan or SUV?');
      await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: broken.lead._id }).lean());
      behavior = 'none';
      const healthy = await inbound('sms', 'Do you have SUVs?');
      await waitFor(async () => (await CommunicationMessage.countDocuments({ orgId, leadId: healthy.lead._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' })) === 1);
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: healthy.lead._id })).toBe(0);
      expect(await CommunicationMessage.countDocuments({ orgId, leadId: broken.lead._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' })).toBe(0);
    });
  });

  describe('deterministic local mock classifier', () => {
    beforeEach(async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      process.env.LOCAL_ATTENTION_MOCK_CLASSIFIER = 'true';
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
    });

    it('decides a human request without calling Gemini and labels the task and note as mock', async () => {
      const ctx = await inbound('sms', 'Let me talk to a real person.');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      expect(task).toMatchObject({ question: 'Customer requested human [mock classifier]', attentionKind: 'customer', classifierSource: 'mock' });
      const lead: any = await waitFor(async () => {
        const row: any = await Lead.findById(ctx.lead._id).lean();
        return row?.notes?.length ? row : null;
      });
      expect(lead.notes[0].text).toContain('[mock classifier]');
      expect(classifierCalls()).toHaveLength(0);
    });

    it('simulates a technical failure on demand and keeps it quiet in Training', async () => {
      const ctx = await inbound('webchat', 'Sedan or SUV? [mock:provider_error]');
      const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
      expect(task).toMatchObject({ question: 'Safety check service error [mock classifier]', attentionKind: 'technical',
        attentionCode: 'provider_error', classifierSource: 'mock' });
      await settle();
      expect(await Notification.countDocuments({ 'metadata.taskId': String(task._id) })).toBe(0);
      expect(classifierCalls()).toHaveLength(0);
    });

    it('lets an ordinary inquiry through without creating a task', async () => {
      const ctx = await inbound('sms', 'Should I get a sedan or an SUV?');
      await settle();
      expect(await AiAgentTask.countDocuments({ organizationId: String(orgId), leadId: ctx.lead._id })).toBe(0);
      expect(classifierCalls()).toHaveLength(0);
    });

    it('stays off when NODE_ENV is production, so the real (blocked) path runs instead', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const ctx = await inbound('sms', 'Let me talk to a real person.');
        const task: any = await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
        expect(task).toMatchObject({ attentionKind: 'technical', attentionCode: 'local_qa_blocked', classifierSource: 'skipped' });
        expect(task.question).not.toContain('mock');
      } finally { process.env.NODE_ENV = nodeEnv; }
    });
  });

  describe('AI Tasks Technical filter', () => {
    it('separates technical tasks from customer requests, including legacy unavailable tasks', async () => {
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
      await AiAgentTask.deleteMany({ organizationId: String(orgId) });
      behavior = 'human_request';
      const customer = await inbound('sms', 'Let me talk to a real person.');
      behavior = 'timeout';
      const technical = await inbound('sms', 'Sedan or SUV?');
      await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: customer.lead._id }).lean());
      await waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: technical.lead._id }).lean());
      const legacyLead = await seedLead();
      await AiAgentTask.collection.insertOne({ organizationId: String(orgId), leadId: legacyLead._id, channel: 'sms',
        question: 'Human-attention check unavailable', assigneeIds: [], status: 'pending', waitingSince: new Date() } as any);

      const technicalRes = await request(app).get('/tasks').query({ kind: 'technical' }).expect(200);
      const customerRes = await request(app).get('/tasks').query({ kind: 'customer' }).expect(200);
      const allRes = await request(app).get('/tasks').expect(200);
      const leadsOf = (res: any) => res.body.data.data.map((task: any) => String(task.leadId)).sort();
      expect(leadsOf(technicalRes)).toEqual([String(technical.lead._id), String(legacyLead._id)].sort());
      expect(leadsOf(customerRes)).toEqual([String(customer.lead._id)]);
      expect(allRes.body.data.data).toHaveLength(3);
      expect(technicalRes.body.data.data.every((task: any) => task.attentionKind === 'technical')).toBe(true);
    });
  });
});
