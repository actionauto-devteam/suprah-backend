import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import AiModeChangeLog from '../src/models/AiModeChangeLog.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import aiShadowDraftRoute from '../src/routes/aiShadowDraft.routes';
import aiOperatingModeRoute from '../src/routes/aiOperatingMode.routes';
import { shadowDraftUsageDay } from '../src/services/aiShadowDraft.service';

const app = express();
app.use(express.json());
app.use('/api/crm/ai-shadow-drafts', aiShadowDraftRoute);
app.use('/api/crm/ai-modes', aiOperatingModeRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const users: Record<string, mongoose.Types.ObjectId> = {
  employee: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const ids: Record<string, any> = {};

const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who = 'admin') => request(app).get(path).set(auth(who));

function draftDoc(org: mongoose.Types.ObjectId, overrides: any = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    organizationId: String(org),
    channel: 'sms',
    sourceMessageId: String(new mongoose.Types.ObjectId()),
    sourceMessageModel: 'CommunicationMessage',
    status: 'ready',
    kind: 'reply',
    draftText: 'Thanks for reaching out! I will check with the team and follow up.',
    classifierVerdict: 'SAFE',
    deterministicOk: true,
    aiModel: 'gemini-test-model',
    latencyMs: 400,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    aiCallCount: 2,
    expiresAt: new Date(Date.now() + 90 * DAY),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function snapshot() {
  const collections = [AiAgentDraft, AiUsageCounter, AiModeChangeLog, Lead, Conversation, CommunicationMessage, WebChatSession, WebChatMessage, Organization] as any[];
  const out: Record<string, any> = {};
  for (const model of collections) out[model.modelName] = await model.collection.find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify(out);
}

describe('Real-DB proof: AI Agent hub read endpoints (local dev MongoDB only)', () => {
  beforeAll(async () => {
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Hub Org A', slug: `hub-a-${orgA}`, status: 'active', metadata: { timezone: 'Asia/Manila', aiShadowDraftsEnabled: true, aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } } },
      { _id: orgB, name: 'Hub Org B', slug: `hub-b-${orgB}`, status: 'active', metadata: {} },
    ] as any[]);
    const base = (id: any, org: any, role: string) => ({ _id: id, organizationId: org, fullName: `Hub ${role}`, username: `hub-${id}`, email: `hub-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      base(users.employee, orgA, 'employee'),
      base(users.manager, orgA, 'manager'),
      base(users.admin, orgA, 'admin'),
      base(users.otherAdmin, orgB, 'admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));

    ids.lead = new mongoose.Types.ObjectId();
    ids.leadB = new mongoose.Types.ObjectId();
    await Lead.collection.insertMany([
      { _id: ids.lead, organizationId: orgA, createdBy: users.admin, firstName: 'Jordan', lastName: 'Hub', phone: '+18015550411', email: 'jordan.hub@example.com', vehicle: { year: '2022', make: 'Toyota', model: 'Camry' }, status: 'New', source: 'Inbound SMS', comments: 'Email inquiry about the Camry', createdAt: new Date(), updatedAt: new Date() },
      { _id: ids.leadB, organizationId: orgB, createdBy: users.otherAdmin, firstName: 'Other', lastName: 'Org', phone: '+18015550412', status: 'New', comments: 'Org B private inquiry', createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);

    ids.conversation = new mongoose.Types.ObjectId();
    ids.conversationB = new mongoose.Types.ObjectId();
    await Conversation.collection.insertMany([
      { _id: ids.conversation, orgId: orgA, customerPhone: '+18015550411', leadId: ids.lead },
      { _id: ids.conversationB, orgId: orgB, customerPhone: '+18015550412', leadId: ids.leadB },
    ] as any[]);
    const t0 = Date.now() - 60_000;
    ids.earlier = new mongoose.Types.ObjectId();
    ids.source = new mongoose.Types.ObjectId();
    ids.later = new mongoose.Types.ObjectId();
    ids.sourceB = new mongoose.Types.ObjectId();
    await CommunicationMessage.collection.insertMany([
      { _id: ids.earlier, orgId: orgA, conversationId: ids.conversation, direction: 'outbound', body: 'Earlier staff note to customer', sentBy: { userId: 'u1', name: 'Rep Ray' }, from: 'a', to: 'b', createdAt: new Date(t0) },
      { _id: ids.source, orgId: orgA, conversationId: ids.conversation, direction: 'inbound', body: 'Is the Camry still available?', from: 'b', to: 'a', createdAt: new Date(t0 + 1000) },
      { _id: ids.later, orgId: orgA, conversationId: ids.conversation, direction: 'inbound', body: 'Message that arrived after the draft', from: 'b', to: 'a', createdAt: new Date(t0 + 5000) },
      { _id: ids.sourceB, orgId: orgB, conversationId: ids.conversationB, direction: 'inbound', body: 'Org B secret message', from: 'c', to: 'd', createdAt: new Date(t0) },
    ] as any[]);

    ids.session = new mongoose.Types.ObjectId();
    ids.webSource = new mongoose.Types.ObjectId();
    await WebChatSession.collection.insertOne({ _id: ids.session, organizationId: String(orgA), leadId: ids.lead, tokenHash: 'x', visitorName: 'Jordan' } as any);
    await WebChatMessage.collection.insertMany([
      { _id: ids.webSource, organizationId: String(orgA), sessionId: ids.session, leadId: ids.lead, direction: 'inbound', body: 'Do you have SUVs?', createdAt: new Date(t0) },
      { organizationId: String(orgA), sessionId: ids.session, leadId: ids.lead, direction: 'outbound', body: 'Thanks for reaching out to Hub Org A!', sentBy: { userId: 'webchat-ack', name: 'Hub Org A' }, createdAt: new Date(t0 + 2000) },
    ] as any[]);

    ids.smsDraft = new mongoose.Types.ObjectId();
    ids.webDraft = new mongoose.Types.ObjectId();
    ids.emailDraft = new mongoose.Types.ObjectId();
    ids.stale = new mongoose.Types.ObjectId();
    ids.running = new mongoose.Types.ObjectId();
    ids.crossRef = new mongoose.Types.ObjectId();
    ids.otherOrgDraft = new mongoose.Types.ObjectId();
    const drafts: any[] = [
      draftDoc(orgA, { _id: ids.smsDraft, leadId: ids.lead, conversationId: ids.conversation, sourceMessageId: String(ids.source), leaseId: 'secret-lease', createdAt: new Date(Date.now() - 1000) }),
      draftDoc(orgA, { _id: ids.webDraft, channel: 'webchat', sourceMessageModel: 'WebChatMessage', leadId: ids.lead, sessionId: ids.session, sourceMessageId: String(ids.webSource), status: 'needs_human', handoffReason: 'Location question' }),
      draftDoc(orgA, { _id: ids.emailDraft, channel: 'email', sourceMessageModel: 'Lead', leadId: ids.lead, sourceMessageId: String(ids.lead), status: 'blocked_safety', classifierVerdict: 'UNSAFE', totalTokens: undefined, promptTokens: undefined, completionTokens: undefined }),
      draftDoc(orgA, { _id: ids.stale, status: 'generating', leaseId: 'stale-lease', leaseExpiresAt: new Date(Date.now() - 60_000), draftText: undefined }),
      draftDoc(orgA, { _id: ids.running, status: 'generating', leaseId: 'live-lease', leaseExpiresAt: new Date(Date.now() + 600_000), draftText: undefined }),
      draftDoc(orgA, { _id: ids.crossRef, leadId: ids.leadB, conversationId: ids.conversationB, sourceMessageId: String(ids.sourceB) }),
      draftDoc(orgB, { _id: ids.otherOrgDraft, leadId: ids.leadB, conversationId: ids.conversationB, sourceMessageId: String(ids.sourceB) }),
    ];
    for (let i = 0; i < 30; i++) drafts.push(draftDoc(orgA, { channel: 'webchat', sourceMessageModel: 'WebChatMessage', status: 'failed', failureReason: 'mock', createdAt: new Date(Date.now() - (i + 10) * 60_000) }));
    await AiAgentDraft.collection.insertMany(drafts);

    await AiUsageCounter.collection.insertMany([
      { organizationId: String(orgA), day: shadowDraftUsageDay('Asia/Manila'), kind: 'shadow_draft', count: 37 },
      { organizationId: String(orgA), day: shadowDraftUsageDay('Asia/Manila'), kind: 'attention_screen', count: 99 },
      { organizationId: String(orgB), day: shadowDraftUsageDay('America/Denver'), kind: 'shadow_draft', count: 5 },
    ] as any[]);
    await AiModeChangeLog.collection.insertMany([
      { organizationId: String(orgA), channel: 'sms', fromMode: 'live', toMode: 'training', fromSource: 'configured', changedByName: 'Hub admin', reason: 'Podium stays live', createdAt: new Date(Date.now() - 3000) },
      { organizationId: String(orgA), channel: 'shadow_drafts', fromMode: 'off', toMode: 'on', fromSource: 'configured', changedByName: 'Hub admin', createdAt: new Date(Date.now() - 2000) },
      { organizationId: String(orgB), channel: 'sms', fromMode: 'off', toMode: 'live', fromSource: 'configured', changedByName: 'Other admin', reason: 'Org B secret reason', createdAt: new Date() },
    ] as any[]);
  });

  afterAll(async () => {
    const both = [orgA, orgB, String(orgA), String(orgB)];
    await AiAgentDraft.collection.deleteMany({ organizationId: { $in: both } });
    await AiUsageCounter.collection.deleteMany({ organizationId: { $in: both } });
    await AiModeChangeLog.collection.deleteMany({ organizationId: { $in: both } });
    await CrmUser.collection.deleteMany({ organizationId: { $in: both } });
    await Lead.collection.deleteMany({ organizationId: { $in: both } });
    await Conversation.collection.deleteMany({ orgId: { $in: both } });
    await CommunicationMessage.collection.deleteMany({ orgId: { $in: both } });
    await WebChatSession.collection.deleteMany({ organizationId: { $in: both } });
    await WebChatMessage.collection.deleteMany({ organizationId: { $in: both } });
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
  });

  describe('access control', () => {
    it('rejects requests without a CRM session', async () => {
      for (const path of ['/api/crm/ai-shadow-drafts', '/api/crm/ai-shadow-drafts/usage', `/api/crm/ai-shadow-drafts/${ids.smsDraft}`, '/api/crm/ai-modes/history']) {
        expect((await request(app).get(path)).status).toBe(401);
      }
    });

    it('employees cannot read drafts, usage, or history', async () => {
      for (const path of ['/api/crm/ai-shadow-drafts', '/api/crm/ai-shadow-drafts/usage', `/api/crm/ai-shadow-drafts/${ids.smsDraft}`, '/api/crm/ai-modes/history']) {
        expect((await get(path, 'employee')).status).toBe(403);
      }
    });

    it('employees get only the mode fields the Leads pill and Vehicle Re-engagement use', async () => {
      const res = await get('/api/crm/ai-modes', 'employee').expect(200);
      expect(res.body.data).toEqual({
        modes: { sms: 'training', email: 'training', webchat: 'training' },
        effective: expect.any(Object),
        source: 'configured',
        masterSwitchOn: expect.any(Boolean),
        configuredAt: null,
        usageToday: {},
        canEdit: false,
        recentChanges: [],
      });
      expect(JSON.stringify(res.body)).not.toContain('Podium stays live');
    });

    it('managers can read everything but cannot change modes or Shadow Training', async () => {
      for (const path of ['/api/crm/ai-shadow-drafts', '/api/crm/ai-shadow-drafts/usage', `/api/crm/ai-shadow-drafts/${ids.smsDraft}`, '/api/crm/ai-modes/history']) {
        expect((await get(path, 'manager')).status).toBe(200);
      }
      const modes = await get('/api/crm/ai-modes', 'manager').expect(200);
      expect(modes.body.data.shadowDrafts).toMatchObject({ orgEnabled: true, usedToday: 37, dailyLimit: 100, timezone: 'Asia/Manila' });
      expect(modes.body.data.canEdit).toBe(false);
      const before = await snapshot();
      expect((await request(app).patch('/api/crm/ai-modes/shadow-drafts').set(auth('manager')).send({ enabled: false })).status).toBe(403);
      expect((await request(app).patch('/api/crm/ai-modes').set(auth('manager')).send({ modes: { sms: 'off' } })).status).toBe(403);
      expect(await snapshot()).toBe(before);
    });
  });

  describe('organization isolation', () => {
    it('never lists or returns another organization\'s drafts', async () => {
      const list = await get('/api/crm/ai-shadow-drafts?limit=100', 'otherAdmin').expect(200);
      expect(list.body.data.drafts.map((row: any) => row.id)).toEqual([String(ids.otherOrgDraft)]);
      expect((await get(`/api/crm/ai-shadow-drafts/${ids.smsDraft}`, 'otherAdmin')).status).toBe(404);
      const own = await get('/api/crm/ai-shadow-drafts?limit=100').expect(200);
      expect(own.body.data.drafts.some((row: any) => row.id === String(ids.otherOrgDraft))).toBe(false);
    });

    it('a draft that points at another organization\'s lead or message reveals none of it', async () => {
      const res = await get(`/api/crm/ai-shadow-drafts/${ids.crossRef}`).expect(200);
      expect(res.body.data.inquiry).toEqual({ available: false });
      expect(res.body.data.lead).toEqual({ id: String(ids.leadB), name: 'Unknown customer' });
      expect(JSON.stringify(res.body)).not.toMatch(/Org B secret|Org B private|Other/);
    });

    it('usage and history only count this organization', async () => {
      const usage = await get('/api/crm/ai-shadow-drafts/usage', 'otherAdmin').expect(200);
      expect(usage.body.data).toMatchObject({ timezone: 'America/Denver', today: { used: 5, limit: 100 } });
      const history = await get('/api/crm/ai-modes/history').expect(200);
      expect(JSON.stringify(history.body)).not.toContain('Org B secret reason');
      expect(history.body.data.total).toBe(2);
    });
  });

  describe('list', () => {
    it('serializes safely: no lease, org, source ids, prompts, or customer contact details', async () => {
      const res = await get('/api/crm/ai-shadow-drafts?limit=100').expect(200);
      const text = JSON.stringify(res.body);
      for (const forbidden of ['leaseId', 'leaseExpiresAt', 'organizationId', 'sourceMessageId', 'secret-lease', 'jordan.hub@example.com', '+18015550411']) {
        expect(text).not.toContain(forbidden);
      }
      const row = res.body.data.drafts.find((item: any) => item.id === String(ids.smsDraft));
      expect(row).toMatchObject({ channel: 'sms', status: 'ready', lead: { id: String(ids.lead), name: 'Jordan Hub' }, aiModel: 'gemini-test-model', totalTokens: 15 });
      expect(row.preview.length).toBeLessThanOrEqual(160);
    });

    it('shows an expired in-progress lease as Interrupted without changing the stored row', async () => {
      const res = await get('/api/crm/ai-shadow-drafts?limit=100').expect(200);
      const byId = new Map(res.body.data.drafts.map((row: any) => [row.id, row.status]));
      expect(byId.get(String(ids.stale))).toBe('interrupted');
      expect(byId.get(String(ids.running))).toBe('generating');
      const interrupted = await get('/api/crm/ai-shadow-drafts?status=interrupted').expect(200);
      expect(interrupted.body.data.drafts.map((row: any) => row.id)).toEqual([String(ids.stale)]);
      const generating = await get('/api/crm/ai-shadow-drafts?status=generating').expect(200);
      expect(generating.body.data.drafts.map((row: any) => row.id)).toEqual([String(ids.running)]);
      const stored: any = await AiAgentDraft.collection.findOne({ _id: ids.stale });
      expect(stored.status).toBe('generating');
      expect(stored.leaseId).toBe('stale-lease');
    });

    it('filters by status and channel, pages within bounds, and sorts both ways', async () => {
      const failed = await get('/api/crm/ai-shadow-drafts?status=failed&channel=webchat').expect(200);
      expect(failed.body.data).toMatchObject({ total: 30, page: 1, limit: 25, totalPages: 2 });
      expect(failed.body.data.drafts).toHaveLength(25);
      const page2 = await get('/api/crm/ai-shadow-drafts?status=failed&channel=webchat&page=2').expect(200);
      expect(page2.body.data.drafts).toHaveLength(5);
      const newest = failed.body.data.drafts.map((row: any) => new Date(row.createdAt).getTime());
      expect([...newest].sort((a, b) => b - a)).toEqual(newest);
      const oldest = await get('/api/crm/ai-shadow-drafts?status=failed&sort=oldest&limit=5').expect(200);
      const times = oldest.body.data.drafts.map((row: any) => new Date(row.createdAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const sms = await get('/api/crm/ai-shadow-drafts?channel=sms&limit=100').expect(200);
      expect(sms.body.data.drafts.every((row: any) => row.channel === 'sms')).toBe(true);
      const byLead = await get(`/api/crm/ai-shadow-drafts?leadId=${ids.lead}`).expect(200);
      expect(byLead.body.data.total).toBe(3);
    });

    it('rejects invalid filters', async () => {
      for (const query of ['status=bogus', 'channel=fax', 'limit=101', 'limit=0', 'page=0', 'page=1001', 'sort=random', 'leadId=nope', 'from=notadate', `from=${new Date().toISOString()}&to=${new Date(Date.now() - DAY).toISOString()}`]) {
        expect((await get(`/api/crm/ai-shadow-drafts?${query}`)).status).toBe(400);
      }
      expect((await get('/api/crm/ai-shadow-drafts/not-an-id')).status).toBe(404);
      expect((await get(`/api/crm/ai-shadow-drafts/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });
  });

  describe('detail', () => {
    it('SMS: reads the inquiry on demand, only up to the source message, and stores nothing', async () => {
      const before = await snapshot();
      const res = await get(`/api/crm/ai-shadow-drafts/${ids.smsDraft}`).expect(200);
      const data = res.body.data;
      expect(data.draftText).toContain('Thanks for reaching out');
      expect(data.lead).toEqual({ id: String(ids.lead), name: 'Jordan Hub', vehicle: '2022 Toyota Camry', status: 'New', source: 'Inbound SMS' });
      expect(data.inquiry.available).toBe(true);
      expect(data.inquiry.messages.map((m: any) => m.body)).toEqual(['Earlier staff note to customer', 'Is the Camry still available?']);
      expect(data.inquiry.messages[1]).toMatchObject({ from: 'customer', isSource: true });
      expect(data.inquiry.messages[0]).toMatchObject({ from: 'staff', staffName: 'Rep Ray', isSource: false });
      expect(JSON.stringify(data)).not.toMatch(/leaseId|secret-lease|organizationId|jordan\.hub@example\.com|\+18015550411/);
      expect(await snapshot()).toBe(before);
      const stored: any = await AiAgentDraft.collection.findOne({ _id: ids.smsDraft });
      expect(Object.keys(stored)).not.toContain('inquiry');
    });

    it('webchat: shows the visitor message and excludes the later acknowledgment', async () => {
      const res = await get(`/api/crm/ai-shadow-drafts/${ids.webDraft}`).expect(200);
      expect(res.body.data.inquiry.messages.map((m: any) => m.body)).toEqual(['Do you have SUVs?']);
      expect(res.body.data).toMatchObject({ status: 'needs_human', handoffReason: 'Location question' });
    });

    it('email: shows the lead inquiry text and reports missing tokens as absent', async () => {
      const res = await get(`/api/crm/ai-shadow-drafts/${ids.emailDraft}`).expect(200);
      expect(res.body.data.inquiry).toMatchObject({ available: true, messages: [{ from: 'customer', body: 'Email inquiry about the Camry', isSource: true }] });
      expect(res.body.data.totalTokens).toBeUndefined();
      expect(res.body.data.classifierVerdict).toBe('UNSAFE');
    });
  });

  describe('usage and history', () => {
    it('reports the organization-timezone day, the 100 limit, statuses, latency, and tokens', async () => {
      const res = await get('/api/crm/ai-shadow-drafts/usage?days=7').expect(200);
      const data = res.body.data;
      expect(data).toMatchObject({ timezone: 'Asia/Manila', dailyLimit: 100, today: { day: shadowDraftUsageDay('Asia/Manila'), used: 37, limit: 100 } });
      expect(data.days).toHaveLength(7);
      expect(new Set(data.days.map((d: any) => d.day)).size).toBe(7);
      const totals = data.days.reduce((acc: any, d: any) => {
        for (const [status, count] of Object.entries(d.statuses)) acc[status] = (acc[status] || 0) + (count as number);
        return acc;
      }, {});
      expect(totals).toMatchObject({ ready: 2, needs_human: 1, blocked_safety: 1, interrupted: 1, generating: 1, failed: 30 });
      const today = data.days[0];
      expect(today.attempts).toBe(37);
      expect(today.averageLatencyMs).toBe(400);
      expect(today.tokensReported).toBeGreaterThan(0);
      expect((await get('/api/crm/ai-shadow-drafts/usage?days=31')).status).toBe(400);
    });

    it('pages the full audit history and filters by channel', async () => {
      const all = await get('/api/crm/ai-modes/history?limit=1').expect(200);
      expect(all.body.data).toMatchObject({ total: 2, totalPages: 2, page: 1 });
      expect(all.body.data.changes[0]).toMatchObject({ channel: 'shadow_drafts', toMode: 'on', changedByName: 'Hub admin' });
      const sms = await get('/api/crm/ai-modes/history?channel=sms').expect(200);
      expect(sms.body.data.changes.map((c: any) => c.reason)).toEqual(['Podium stays live']);
      expect((await get('/api/crm/ai-modes/history?channel=fax')).status).toBe(400);
      expect((await get('/api/crm/ai-modes/history?limit=500')).status).toBe(400);
    });

    it('every read endpoint leaves the database untouched', async () => {
      const before = await snapshot();
      for (const who of ['manager', 'admin']) {
        await get('/api/crm/ai-shadow-drafts?limit=100', who).expect(200);
        await get('/api/crm/ai-shadow-drafts?status=interrupted', who).expect(200);
        await get('/api/crm/ai-shadow-drafts/usage?days=30', who).expect(200);
        for (const id of [ids.smsDraft, ids.webDraft, ids.emailDraft, ids.stale, ids.crossRef]) await get(`/api/crm/ai-shadow-drafts/${id}`, who).expect(200);
        await get('/api/crm/ai-modes/history', who).expect(200);
        await get('/api/crm/ai-modes', who).expect(200);
      }
      await get('/api/crm/ai-modes', 'employee').expect(200);
      expect(await snapshot()).toBe(before);
    });
  });
});
