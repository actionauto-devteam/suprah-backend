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
import AiTechnicalAlertState from '../src/models/AiTechnicalAlertState.model';
import Notification from '../src/models/Notification.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import EmailOptOut from '../src/models/EmailOptOut.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { normalizeIdentityPhone, normalizeIdentityEmail } from '../src/utils/contactIdentity';
import { handleInboundSms } from '../src/services/communication.service';
import { triggerAiEmailReplyForNewInquiry } from '../src/services/aiEmailReply.service';
import { maybeAlertTechnicalFailures } from '../src/services/aiTechnicalAlert.service';
import { sendVisitorMessage, resumeWebchatAi } from '../src/controllers/webchat.controller';
import { resumeSmsAi, pauseSmsAi } from '../src/controllers/communication.controller';
import { listAiAgentTasks, previewTechnicalTaskRecovery, recoverTechnicalTask } from '../src/controllers/aiAgentTask.controller';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const creator = new mongoose.Types.ObjectId();
const repId = new mongoose.Types.ObjectId();
const mainAdminId = new mongoose.Types.ObjectId();
const crmAdminId = new mongoose.Types.ObjectId();
const crmRepId = new mongoose.Types.ObjectId();
const otherAdminId = new mongoose.Types.ObjectId();
const DRAFT_TEXT = 'Thanks! I will check with the team and follow up shortly.';
const SENSITIVE = 'SENSITIVE-HARDENING-TEXT-8812';
let serial = 0;
let behavior = 'none';

const USERS: Record<string, any> = {
  admin: { _id: crmAdminId, fullName: 'Hardening Admin', role: 'admin', org: orgId },
  manager: { _id: crmAdminId, fullName: 'Hardening Manager', role: 'manager', org: orgId },
  rep: { _id: crmRepId, fullName: 'Hardening Rep', role: 'employee', org: orgId },
  other: { _id: otherAdminId, fullName: 'Other Admin', role: 'admin', org: otherOrgId },
};

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const user = USERS[String(req.header('x-as') || 'admin')];
  req.orgId = String(user.org);
  req.crmUser = { _id: user._id, fullName: user.fullName, role: user.role };
  next();
});
app.post('/visitor/:sessionId', sendVisitorMessage);
app.post('/sms/:leadId/resume', resumeSmsAi);
app.post('/sms/:leadId/pause', pauseSmsAi);
app.post('/webchat/:leadId/resume', resumeWebchatAi);
app.get('/tasks', listAiAgentTasks);
app.get('/tasks/:id/recovery', previewTechnicalTaskRecovery);
app.post('/tasks/:id/recover', recoverTechnicalTask);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const MODES = (mode: string) => ({ sms: mode, email: mode, webchat: mode });
type Channel = 'sms' | 'webchat' | 'email';

function classifierReply(): any {
  if (behavior === 'timeout') return new Promise(() => {});
  if (behavior === 'provider_error') throw Object.assign(new Error('provider failure'), { status: 503 });
  return JSON.stringify({ intent: behavior });
}

async function setOrg(metadata: any) {
  await Organization.updateOne({ _id: orgId }, { $set: { metadata } });
}

async function seedLead(overrides: any = {}) {
  const phone = overrides.phone !== undefined ? overrides.phone : `+1801555${String(6000 + ++serial)}`;
  const email = overrides.email ?? `hardening.${++serial}@example.com`;
  const doc: any = {
    _id: new mongoose.Types.ObjectId(), organizationId: orgId, createdBy: creator,
    firstName: 'Riley', lastName: 'Hardening', phone, normalizedPhone: phone ? normalizeIdentityPhone(phone) : null,
    email, normalizedEmail: email ? normalizeIdentityEmail(email) : null,
    vehicle: { year: '2022', make: 'Toyota', model: 'Camry' }, assignedTo: repId,
    status: 'New', source: 'Inbound SMS', createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
  await Lead.collection.insertOne(doc);
  return doc;
}

async function seedSession() {
  const lead = await seedLead({ phone: null, source: 'Website Chat' });
  const token = `hardening-token-${crypto.randomUUID()}`;
  const session = await WebChatSession.create({
    organizationId: String(orgId), leadId: lead._id, visitorName: 'Riley Hardening',
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
  });
  return { lead, session, token };
}

const smsPayload = (lead: any, text: string, id = `msg-${crypto.randomUUID()}`) => ({
  id, text, from: { phone_number: lead.phone }, to: [{ phone_number: '+18015550999' }],
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

async function inbound(channel: Channel, text: string, existing?: any): Promise<any> {
  if (channel === 'sms') {
    const lead = existing?.lead || await seedLead();
    const payload = smsPayload(lead, text);
    const message: any = await handleInboundSms(payload, orgId);
    return { lead, sourceId: String(message._id), providerId: payload.id, text };
  }
  if (channel === 'webchat') {
    const ctx = existing || await seedSession();
    await request(app).post(`/visitor/${ctx.session._id}`).send({ token: ctx.token, message: text }).expect(201);
    return ctx;
  }
  const lead = existing?.lead || await seedLead({ phone: '', source: 'ADF Email' });
  await triggerAiEmailReplyForNewInquiry(orgId, lead, text);
  return { lead };
}

async function aiSendCount(channel: Channel, ctx: any): Promise<number> {
  if (channel === 'sms') {
    return Math.max(mockSendSms.mock.calls.filter((args) => JSON.stringify(args).includes(ctx.lead.phone)).length,
      await CommunicationMessage.countDocuments({ orgId, leadId: ctx.lead._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' }));
  }
  if (channel === 'webchat') {
    return WebChatMessage.countDocuments({ sessionId: ctx.session._id, direction: 'outbound', 'sentBy.userId': 'ai-agent' });
  }
  return mockSendLeadReplyEmail.mock.calls.filter((args) => String(args[0]?._id) === String(ctx.lead._id)).length;
}

async function stateOf(channel: Channel, ctx: any): Promise<any> {
  if (channel === 'sms') return Conversation.findOne({ orgId: { $in: [orgId, String(orgId)] }, leadId: ctx.lead._id }).lean();
  if (channel === 'webchat') return WebChatSession.findById(ctx.session._id).lean();
  return Lead.findById(ctx.lead._id).lean();
}

const taskFor = (ctx: any) => waitFor(() => AiAgentTask.findOne({ organizationId: String(orgId), leadId: ctx.lead._id }).lean());
const alertCount = () => Notification.countDocuments({ organizationId: { $in: [orgId, String(orgId)] }, type: 'ai_technical_failures_alert' });

async function technicalIncident(channel: Channel, existing?: any) {
  behavior = 'provider_error';
  const ctx = await inbound(channel, `Sedan or SUV? ${SENSITIVE}`, existing);
  const task: any = await taskFor(ctx);
  await waitFor(async () => (await stateOf(channel, ctx))?.aiHumanAttention);
  await settle();
  return { ctx, task };
}

describe('Real-DB proof: technical-incident hardening (local dev MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    await SmsOptOut.init();
    await EmailOptOut.init();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Hardening Motors', slug: `hardening-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Hardening Other', slug: `hardening-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any);
    await User.collection.insertMany([
      { _id: repId, organizationId: orgId, name: 'Hardening Rep User', email: `hardening-rep-${repId}@example.com`, role: 'employee', isActive: true },
      { _id: mainAdminId, organizationId: orgId, name: 'Hardening Boss', email: `hardening-boss-${mainAdminId}@example.com`, role: 'admin', isActive: true },
    ] as any);
    await CrmUser.collection.insertMany([
      { _id: crmAdminId, organizationId: orgId, fullName: 'Hardening Admin', email: `hardening-admin-${crmAdminId}@example.com`, username: `hardening-admin-${crmAdminId}`, role: 'admin', isActive: true },
      { _id: crmRepId, organizationId: orgId, fullName: 'Hardening Rep', email: `hardening-crmrep-${crmRepId}@example.com`, username: `hardening-crmrep-${crmRepId}`, role: 'employee', isActive: true },
      { _id: otherAdminId, organizationId: otherOrgId, fullName: 'Other Admin', email: `hardening-other-${otherAdminId}@example.com`, username: `hardening-other-${otherAdminId}`, role: 'admin', isActive: true },
    ] as any);
  });

  afterAll(async () => {
    const ids = [orgId, String(orgId), otherOrgId, String(otherOrgId)];
    await AiAgentDraft.deleteMany({ organizationId: { $in: ids.map(String) } });
    await AiUsageCounter.deleteMany({ organizationId: { $in: ids.map(String) } });
    await Lead.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } });
    await Conversation.collection.deleteMany({ orgId: { $in: ids } });
    await CommunicationMessage.collection.deleteMany({ orgId: { $in: ids } });
    await WebChatSession.collection.deleteMany({ organizationId: { $in: ids.map(String) } });
    await WebChatMessage.collection.deleteMany({ organizationId: { $in: ids.map(String) } });
    await AiAgentTask.collection.deleteMany({ organizationId: { $in: ids } });
    await AiAgentLog.collection.deleteMany({ organizationId: { $in: ids } });
    await AiTechnicalAlertState.collection.deleteMany({ organizationId: { $in: ids.map(String) } });
    await Notification.collection.deleteMany({ organizationId: { $in: ids } });
    await SmsOptOut.collection.deleteMany({ organizationId: { $in: ids.map(String) } });
    await EmailOptOut.collection.deleteMany({ organizationId: { $in: ids.map(String) } });
    await Organization.collection.deleteMany({ _id: { $in: [orgId, otherOrgId] } });
    await User.collection.deleteMany({ _id: { $in: [repId, mainAdminId] } });
    await CrmUser.collection.deleteMany({ _id: { $in: [crmAdminId, crmRepId, otherAdminId] } });
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
    process.env.AI_TECHNICAL_ALERT_THRESHOLD = '100';
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    delete process.env.LOCAL_ATTENTION_MOCK_CLASSIFIER;
    delete process.env.DEMO_LAB_ENABLED;
    await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('live') });
    behavior = 'none';
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (body: any) => {
      const system = String(body?.messages?.[0]?.content || '');
      const content = system.includes('Classify the latest') ? await classifierReply()
        : system.includes('strict compliance classifier') ? 'SAFE'
          : system.includes('You select dealership coaching rules') ? '{"relevantRuleIds":[],"suppressed":[]}'
            : DRAFT_TEXT;
      return { model: 'gemini-test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } };
    });
    mockSendSms.mockClear();
    mockSendLeadReplyEmail.mockClear();
    mockPush.mockClear();
  });

  describe('AI Tasks pagination', () => {
    beforeAll(async () => {
      await AiAgentTask.deleteMany({ organizationId: { $in: [String(orgId), String(otherOrgId)] } });
      const base = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const rows = Array.from({ length: 230 }, (_, i) => ({
        organizationId: String(orgId), leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'Safety check timed out',
        assigneeIds: [], status: 'pending', attentionKind: 'technical', attentionCode: 'timeout', waitingSince: new Date(base + i * 60_000),
      }));
      const customers = Array.from({ length: 7 }, (_, i) => ({
        organizationId: String(orgId), leadId: new mongoose.Types.ObjectId(), channel: 'webchat', question: 'Customer requested human',
        assigneeIds: [], status: 'pending', attentionKind: 'customer', attentionCode: 'human_request', waitingSince: new Date(base + i * 90_000),
      }));
      const foreign = Array.from({ length: 5 }, () => ({
        organizationId: String(otherOrgId), leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'Safety check timed out',
        assigneeIds: [], status: 'pending', attentionKind: 'technical', waitingSince: new Date(),
      }));
      await AiAgentTask.collection.insertMany([...rows, ...customers, ...foreign] as any);
    });
    afterAll(async () => { await AiAgentTask.deleteMany({ organizationId: { $in: [String(orgId), String(otherOrgId)] } }); });

    it('returns newest first with totals and does not stop at 200', async () => {
      const first = (await request(app).get('/tasks').query({ kind: 'technical', limit: 25 }).expect(200)).body.data;
      expect(first).toMatchObject({ total: 230, page: 1, limit: 25, totalPages: 10 });
      const times = first.data.map((task: any) => new Date(task.waitingSince).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const last = (await request(app).get('/tasks').query({ kind: 'technical', limit: 25, page: 10 }).expect(200)).body.data;
      expect(last.data).toHaveLength(5);
      const all: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = (await request(app).get('/tasks').query({ kind: 'technical', limit: 100, page }).expect(200)).body.data;
        all.push(...res.data.map((task: any) => task.id));
      }
      expect(new Set(all).size).toBe(230);
    });

    it('keeps the kind filters and clamps oversized or out-of-range paging', async () => {
      expect((await request(app).get('/tasks').query({ kind: 'customer' }).expect(200)).body.data.total).toBe(7);
      expect((await request(app).get('/tasks').expect(200)).body.data.total).toBe(237);
      const big = (await request(app).get('/tasks').query({ limit: 5000 }).expect(200)).body.data;
      expect(big.limit).toBe(100);
      const beyond = (await request(app).get('/tasks').query({ kind: 'technical', limit: 25, page: 99 }).expect(200)).body.data;
      expect(beyond.page).toBe(10);
      await request(app).get('/tasks').query({ leadId: 'not-an-id' }).expect(400);
    });

    it('never shows another organization\'s tasks', async () => {
      const mine = (await request(app).get('/tasks').query({ limit: 100 }).expect(200)).body.data;
      expect(mine.data.every((task: any) => task.organizationId === String(orgId))).toBe(true);
      const theirs = (await request(app).get('/tasks').set('x-as', 'other').query({ limit: 100 }).expect(200)).body.data;
      expect(theirs.total).toBe(5);
      expect(theirs.data.every((task: any) => task.organizationId === String(otherOrgId))).toBe(true);
    });

    it('shows a brand-new technical failure on the first page even with hundreds of older tasks', async () => {
      const { task } = await technicalIncident('sms');
      const first = (await request(app).get('/tasks').query({ kind: 'technical', limit: 25 }).expect(200)).body.data;
      expect(first.data[0].id).toBe(String(task._id));
    });
  });

  describe('aggregated technical-failure alert', () => {
    beforeEach(async () => {
      await AiAgentTask.deleteMany({ organizationId: String(orgId) });
      await AiTechnicalAlertState.deleteMany({ organizationId: String(orgId) });
      await Notification.deleteMany({ organizationId: { $in: [orgId, String(orgId)] }, type: 'ai_technical_failures_alert' });
      process.env.AI_TECHNICAL_ALERT_THRESHOLD = '5';
      await setOrg({ aiAgentName: 'Alex', aiShadowDraftsEnabled: true, aiAgentModes: MODES('training') });
    });

    it('Training: four failures alert nobody; the fifth sends exactly one alert to admins; more failures add none', async () => {
      const contexts: any[] = [];
      for (let i = 0; i < 4; i++) contexts.push((await technicalIncident(i % 2 ? 'webchat' : 'sms')).ctx);
      expect(await alertCount()).toBe(0);
      expect(await Notification.countDocuments({ type: 'ai_agent_handoff_needed', 'metadata.leadId': { $in: contexts.map((c) => String(c.lead._id)) } })).toBe(0);
      await technicalIncident('email');
      const alerts = await waitFor(async () => {
        const rows = await Notification.find({ organizationId: { $in: [orgId, String(orgId)] }, type: 'ai_technical_failures_alert' }).lean();
        return rows.length ? rows : null;
      });
      const recipients = alerts.map((row: any) => String(row.userId)).sort();
      expect(recipients).toEqual([String(mainAdminId), String(crmAdminId)].sort());
      expect(alerts[0].title).toBe("Alex's safety check failed 5 times in the last hour");
      expect(alerts[0].metadata).toMatchObject({ route: '/crm/ai-tasks?kind=technical', count: 5, threshold: 5, codes: { provider_error: 5 } });
      const serialized = JSON.stringify(alerts);
      expect(serialized).not.toContain(SENSITIVE);
      expect(serialized).not.toContain('Riley');
      expect(serialized).not.toContain('+1801555');
      await technicalIncident('sms');
      await technicalIncident('webchat');
      await settle();
      expect(await alertCount()).toBe(alerts.length);
    });

    it('concurrent failures and concurrent evaluations still produce a single alert', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, i) => technicalIncident(i % 2 ? 'webchat' : 'sms')));
      await settle();
      const afterIncidents = await alertCount();
      expect(afterIncidents).toBe(2);
      const results = await Promise.all(Array.from({ length: 10 }, () => maybeAlertTechnicalFailures({ organizationId: String(orgId) })));
      expect(results.filter((r) => r.alerted)).toHaveLength(0);
      expect(await alertCount()).toBe(2);
      expect(await AiTechnicalAlertState.countDocuments({ organizationId: String(orgId) })).toBe(1);
    });

    it('a fresh org evaluated ten times at once sends exactly one alert', async () => {
      const now = new Date();
      await AiAgentTask.collection.insertMany(Array.from({ length: 6 }, () => ({
        organizationId: String(orgId), leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'Safety check timed out',
        assigneeIds: [], status: 'pending', attentionKind: 'technical', attentionCode: 'timeout', waitingSince: now, createdAt: now, updatedAt: now,
      })) as any);
      const results = await Promise.all(Array.from({ length: 10 }, () => maybeAlertTechnicalFailures({ organizationId: String(orgId), now })));
      expect(results.filter((r) => r.alerted)).toHaveLength(1);
      expect(await alertCount()).toBe(2);
    });

    it('alerts again only after the hour has passed, counting only failures inside the new hour', async () => {
      const t0 = new Date();
      const seed = (at: Date, n: number) => AiAgentTask.collection.insertMany(Array.from({ length: n }, () => ({
        organizationId: String(orgId), leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'Safety check timed out',
        assigneeIds: [], status: 'pending', attentionKind: 'technical', attentionCode: 'timeout', waitingSince: at, createdAt: at, updatedAt: at,
      })) as any);
      await seed(t0, 5);
      expect((await maybeAlertTechnicalFailures({ organizationId: String(orgId), now: t0 })).alerted).toBe(true);
      const t30 = new Date(t0.getTime() + 30 * 60_000);
      await seed(t30, 5);
      expect(await maybeAlertTechnicalFailures({ organizationId: String(orgId), now: t30 })).toMatchObject({ alerted: false, reason: 'recently_alerted' });
      const t95 = new Date(t0.getTime() + 95 * 60_000);
      expect(await maybeAlertTechnicalFailures({ organizationId: String(orgId), now: t95 })).toMatchObject({ alerted: false, reason: 'below_threshold', count: 0 });
      const t70 = new Date(t0.getTime() + 70 * 60_000);
      expect((await maybeAlertTechnicalFailures({ organizationId: String(orgId), now: t70 })).alerted).toBe(true);
    });

    it('does not count another organization\'s failures or customer requests', async () => {
      const now = new Date();
      const row = (organizationId: string, attentionKind: string) => ({
        organizationId, leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'x', assigneeIds: [], status: 'pending',
        attentionKind, waitingSince: now, createdAt: now, updatedAt: now,
      });
      await AiAgentTask.collection.insertMany([
        ...Array.from({ length: 6 }, () => row(String(otherOrgId), 'technical')),
        ...Array.from({ length: 6 }, () => row(String(orgId), 'customer')),
        ...Array.from({ length: 4 }, () => row(String(orgId), 'technical')),
      ] as any);
      expect(await maybeAlertTechnicalFailures({ organizationId: String(orgId), now })).toMatchObject({ alerted: false, count: 4 });
      await AiAgentTask.deleteMany({ organizationId: String(otherOrgId) });
    });
  });

  describe.each(['sms', 'webchat', 'email'] as const)('%s technical-pause recovery', (channel) => {
    beforeEach(async () => {
      await AiTechnicalAlertState.deleteMany({ organizationId: String(orgId) });
    });

    it('an admin resumes a pure technical pause; who and when are recorded; nothing is sent to the waiting messages', async () => {
      const { ctx, task } = await technicalIncident(channel);
      if (channel !== 'email') {
        behavior = 'none';
        await inbound(channel, 'Hello? Anyone?', ctx);
        await inbound(channel, 'Still waiting', ctx);
        await settle();
      }
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview).toMatchObject({ eligible: true, canRecover: true, blockers: [], channel });
      expect(preview.messagesSinceIncident).toBe(channel === 'email' ? null : 3);

      if (channel !== 'email') {
        const stale = await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
        expect(stale.body.errors[0]).toMatchObject({ code: 'messages_changed', count: 3 });
      }
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledgedMessageCount: preview.messagesSinceIncident }).expect(400);
      const res = await request(app).post(`/tasks/${task._id}/recover`)
        .send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: preview.messagesSinceIncident }).expect(200);
      expect(res.body.data).toMatchObject({ recovered: true, channel });

      const state = await stateOf(channel, ctx);
      expect(state.aiHumanAttention).toBeUndefined();
      expect(state.aiPausedAt == null).toBe(true);
      expect(state.aiLastTechnicalRecovery).toMatchObject({
        reason: 'Safety check service error', recoveredBy: { userId: String(crmAdminId), name: 'Hardening Admin', role: 'admin' },
      });
      expect(state.aiLastTechnicalRecovery.recoveredAt).toBeInstanceOf(Date);
      const resolved: any = await AiAgentTask.findById(task._id).lean();
      expect(resolved).toMatchObject({ status: 'resolved', resolutionType: 'technical_recovery', recoveredByName: 'Hardening Admin' });
      expect(String(resolved.resolvedBy)).toBe(String(crmAdminId));
      const lead: any = await Lead.findById(ctx.lead._id).lean();
      expect(lead.notes.some((note: any) => note.text.startsWith('Hardening Admin resumed Alex after a technical safety-check failure'))).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith(String(orgId), channel === 'sms' ? 'comm:ai_paused' : channel === 'webchat' ? 'webchat:ai_paused' : 'email:ai_paused',
        expect.objectContaining({ leadId: String(ctx.lead._id), paused: false }));
      await settle();
      expect(await aiSendCount(channel, ctx)).toBe(0);
    });

    it('a rep cannot resume; another organization cannot even see the task', async () => {
      const { ctx, task } = await technicalIncident(channel);
      const repPreview = (await request(app).get(`/tasks/${task._id}/recovery`).set('x-as', 'rep').expect(200)).body.data;
      expect(repPreview.canRecover).toBe(false);
      await request(app).post(`/tasks/${task._id}/recover`).set('x-as', 'rep').send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: repPreview.messagesSinceIncident }).expect(403);
      await request(app).get(`/tasks/${task._id}/recovery`).set('x-as', 'other').expect(404);
      await request(app).post(`/tasks/${task._id}/recover`).set('x-as', 'other').send({ acknowledged: true }).expect(404);
      expect((await stateOf(channel, ctx)).aiHumanAttention).toBeTruthy();
    });

    it('two simultaneous recoveries: exactly one succeeds', async () => {
      const { task } = await technicalIncident(channel);
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      const body = { acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: preview.messagesSinceIncident };
      const results = await Promise.all([
        request(app).post(`/tasks/${task._id}/recover`).set('x-as', 'admin').send(body),
        request(app).post(`/tasks/${task._id}/recover`).set('x-as', 'manager').send(body),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('refuses a genuine customer request and leaves it paused', async () => {
      behavior = 'human_request';
      const ctx = await inbound(channel, 'Let me talk to a real person.');
      const task: any = await taskFor(ctx);
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toEqual(['not_technical']);
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true }).expect(409);
      expect((await stateOf(channel, ctx)).aiHumanAttention).toMatchObject({ kind: 'customer' });
    });

    it('refuses when the lead is Do Not Contact', async () => {
      const { ctx, task } = await technicalIncident(channel);
      await Lead.updateOne({ _id: ctx.lead._id }, { $set: { status: 'Do Not Contact' } });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('do_not_contact');
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
      expect((await stateOf(channel, ctx)).aiHumanAttention).toBeTruthy();
    });

    it('refuses when staff paused the conversation after the incident', async () => {
      const { ctx, task } = await technicalIncident(channel);
      const model: any = channel === 'sms' ? Conversation : channel === 'webchat' ? WebChatSession : Lead;
      const state = await stateOf(channel, ctx);
      await model.updateOne({ _id: state._id }, { $set: { aiPausedBy: { userId: String(crmRepId), name: 'Hardening Rep' } } });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('paused_for_other_reason');
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
      expect((await stateOf(channel, ctx)).aiPausedBy).toMatchObject({ userId: String(crmRepId) });
    });
  });

  describe('safety corrections before Phase 3B.1', () => {
    it.each(['sms', 'webchat', 'email'] as const)('%s: an attention record that predates prior-pause capture fails closed', async (channel) => {
      const { ctx, task } = await technicalIncident(channel);
      const model: any = channel === 'sms' ? Conversation : channel === 'webchat' ? WebChatSession : Lead;
      const state = await stateOf(channel, ctx);
      await model.collection.updateOne({ _id: state._id }, { $unset: { 'aiHumanAttention.priorPauseChecked': '' } });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.eligible).toBe(false);
      expect(preview.blockers.map((b: any) => b.code)).toContain('unverified_legacy_pause');
      await request(app).post(`/tasks/${task._id}/recover`)
        .send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
      expect((await stateOf(channel, ctx)).aiHumanAttention).toBeTruthy();
    });

    it('a legacy "check unavailable" pause without kind or task classification fails closed', async () => {
      const lead = await seedLead();
      const conversation = await Conversation.create({ orgId, leadId: lead._id, customerPhone: lead.phone });
      const taskId = new mongoose.Types.ObjectId();
      await AiAgentTask.collection.insertOne({ _id: taskId, organizationId: String(orgId), leadId: lead._id, channel: 'sms',
        question: 'Human-attention check unavailable', assigneeIds: [], status: 'pending', waitingSince: new Date(), conversationId: conversation._id } as any);
      await Conversation.collection.updateOne({ _id: conversation._id }, { $set: {
        aiHumanAttention: { reason: 'Human-attention check unavailable', taskId, messageId: String(new mongoose.Types.ObjectId()), detectedAt: new Date() },
        aiPausedAt: new Date(), aiPausedBy: { userId: 'system', name: 'Human-attention check unavailable' },
      } });
      const preview = (await request(app).get(`/tasks/${taskId}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('unverified_legacy_pause');
      await request(app).post(`/tasks/${taskId}/recover`).send({ acknowledged: true, acknowledgedMessageCount: 0 }).expect(409);
      expect((await Conversation.findById(conversation._id).lean() as any).aiHumanAttention).toBeTruthy();
      await request(app).post(`/sms/${lead._id}/resume`).expect(200);
      expect((await Conversation.findById(conversation._id).lean() as any).aiHumanAttention).toBeUndefined();
    });

    it('email recovery requires an explicit manual email-thread review and never claims Suprah checked it', async () => {
      const { ctx, task } = await technicalIncident('email');
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview).toMatchObject({ requiresEmailThreadReview: true, messagesSinceIncident: null });
      const refused = await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true }).expect(400);
      expect(refused.body.message).toContain('Suprah does not check email threads');
      expect((await stateOf('email', ctx)).aiHumanAttention).toBeTruthy();
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true }).expect(200);
      const lead: any = await Lead.findById(ctx.lead._id).lean();
      const note = lead.notes.find((n: any) => n.text.includes('resumed Alex after a technical safety-check failure'));
      expect(note.text).toContain('Staff confirmed a manual review of the email thread; Suprah did not check it for new replies.');
    });

    it('SMS and webchat previews do not ask for an email-thread review', async () => {
      const { task } = await technicalIncident('webchat');
      expect((await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data.requiresEmailThreadReview).toBe(false);
    });

    it('alert deduplication survives a process restart because the claim lives in MongoDB', async () => {
      process.env.AI_TECHNICAL_ALERT_THRESHOLD = '5';
      await AiTechnicalAlertState.deleteMany({ organizationId: String(orgId) });
      await Notification.deleteMany({ organizationId: { $in: [orgId, String(orgId)] }, type: 'ai_technical_failures_alert' });
      const now = new Date();
      await AiAgentTask.collection.insertMany(Array.from({ length: 5 }, () => ({
        organizationId: String(orgId), leadId: new mongoose.Types.ObjectId(), channel: 'sms', question: 'Safety check timed out',
        assigneeIds: [], status: 'pending', attentionKind: 'technical', attentionCode: 'timeout', waitingSince: now, createdAt: now, updatedAt: now,
      })) as any);
      expect((await maybeAlertTechnicalFailures({ organizationId: String(orgId), now })).alerted).toBe(true);
      let restarted: typeof import('../src/services/aiTechnicalAlert.service') | undefined;
      let freshMongoose: typeof mongoose | undefined;
      jest.isolateModules(() => {
        freshMongoose = require('mongoose');
        restarted = require('../src/services/aiTechnicalAlert.service');
      });
      expect(freshMongoose).not.toBe(mongoose);
      await freshMongoose!.connect(String(process.env.MONGODB_URI), { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
      let results: any[] = [];
      try {
        results = await Promise.all(Array.from({ length: 5 }, () =>
          restarted!.maybeAlertTechnicalFailures({ organizationId: String(orgId), now: new Date(now.getTime() + 10 * 60_000) })));
      } finally { await freshMongoose!.disconnect(); }
      expect(results.every((r) => !r.alerted && r.reason === 'recently_alerted')).toBe(true);
      expect(await alertCount()).toBe(2);
      process.env.AI_TECHNICAL_ALERT_THRESHOLD = '100';
    });
  });

  describe('channel-specific recovery guards', () => {
    it('SMS: refuses when the customer opted out of texts', async () => {
      const { ctx, task } = await technicalIncident('sms');
      await SmsOptOut.create({ organizationId: String(orgId), phone: ctx.lead.phone, optedOut: true });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('sms_opted_out');
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
    });

    it('email: refuses when the customer opted out of automated email', async () => {
      const { ctx, task } = await technicalIncident('email');
      await EmailOptOut.create({ organizationId: String(orgId), email: ctx.lead.email, optedOut: true });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('email_opted_out');
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true }).expect(409);
    });

    it('SMS: a conversation manually paused before the incident keeps that pause on record and cannot use technical recovery', async () => {
      const lead = await seedLead();
      behavior = 'none';
      await inbound('sms', 'Hi there', { lead });
      await waitFor(async () => (await aiSendCount('sms', { lead })) > 0);
      await request(app).post(`/sms/${lead._id}/pause`).set('x-as', 'rep').expect(200);
      const { task } = await technicalIncident('sms', { lead });
      const state: any = await stateOf('sms', { lead });
      expect(state.aiHumanAttention.pausedBeforeAttention).toMatchObject({ userId: String(crmRepId), name: 'Hardening Rep' });
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      expect(preview.blockers.map((b: any) => b.code)).toContain('paused_before_incident');
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: 1 }).expect(409);
      await request(app).post(`/sms/${lead._id}/resume`).expect(200);
      expect((await stateOf('sms', { lead })).aiPausedAt == null).toBe(true);
    });

    it.each(['sms', 'webchat'] as const)('%s: after recovery, a redelivered original never gets a reply, but a new message is screened and answered normally', async (channel) => {
      const { ctx, task } = await technicalIncident(channel);
      const preview = (await request(app).get(`/tasks/${task._id}/recovery`).expect(200)).body.data;
      await request(app).post(`/tasks/${task._id}/recover`).send({ acknowledged: true, emailThreadReviewed: true, acknowledgedMessageCount: preview.messagesSinceIncident }).expect(200);
      behavior = 'none';
      if (channel === 'sms') {
        await handleInboundSms(smsPayload(ctx.lead, ctx.text, ctx.providerId), orgId);
        await settle();
        expect(await aiSendCount('sms', ctx)).toBe(0);
      }
      await inbound(channel, 'Okay, which one has more cargo space?', ctx);
      await waitFor(async () => (await aiSendCount(channel, ctx)) === 1);
      await settle();
      expect(await aiSendCount(channel, ctx)).toBe(1);
    });

    it('the normal Resume control still clears a customer-request pause (unchanged behavior)', async () => {
      behavior = 'human_request';
      const ctx = await inbound('sms', 'Let me talk to a real person.');
      await taskFor(ctx);
      await request(app).post(`/sms/${ctx.lead._id}/resume`).expect(200);
      const state = await stateOf('sms', ctx);
      expect(state.aiHumanAttention).toBeUndefined();
      expect(state.aiPausedAt == null).toBe(true);
    });
  });
});
