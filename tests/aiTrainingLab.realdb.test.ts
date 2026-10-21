import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockCreate = jest.fn();
const mockOpenAi = jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } }));
jest.mock('openai', () => mockOpenAi);
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import AiTrainingScenario from '../src/models/AiTrainingScenario.model';
import AiTrainingScenarioRevision from '../src/models/AiTrainingScenarioRevision.model';
import AiTrainingTestRun from '../src/models/AiTrainingTestRun.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import { getRelevantAiCoaching } from '../src/services/aiAgentCoaching.service';
import { LAB_ENGINE_VERSION } from '../src/services/aiTrainingLabEvaluator';
import aiTrainingRoute from '../src/routes/aiTraining.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/ai-training', aiTrainingRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const users: Record<string, mongoose.Types.ObjectId> = {
  rep: new mongoose.Types.ObjectId(),
  rep2: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
  limited: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const BASE = '/api/crm/ai-training';
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(`${BASE}${path}`).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(`${BASE}${path}`).set(auth(who)).send(body);
const put = (path: string, who: string, body: any = {}) => request(app).put(`${BASE}${path}`).set(auth(who)).send(body);

const rule = (overrides: Record<string, unknown> = {}) => ({
  title: 'Sedan versus SUV questions',
  category: 'scenario_response',
  channels: ['sms', 'webchat'],
  intent: 'is deciding between a sedan and an SUV',
  triggers: ['asks whether a sedan or SUV fits their family'],
  handling: 'ask_clarifying',
  instruction: 'Ask about family size and typical driving before suggesting a body style.',
  requiredQuestions: ['How many people usually ride with you?'],
  examples: [{ customerMessage: 'Sedan or SUV for five?', idealReply: 'Great question! How many people usually ride with you?' }],
  ...overrides,
});

const scenario = (overrides: Record<string, unknown> = {}) => ({
  title: 'Family of five',
  channel: 'sms',
  customerName: 'Riley Example',
  message: 'Should I get a sedan or an SUV for my family of five?',
  expectation: { handling: 'ask_clarifying' },
  ...overrides,
});

const GOOD_REPLY = 'Great question! How many people usually ride with you? Happy to line up a test drive too.';

const rawScenario = () => {
  const actor = { userId: String(users.admin), name: 'Admin One', role: 'admin' };
  return {
    organizationId: String(orgA), channel: 'sms', message: 'filler', turns: [], flags: {}, tags: [],
    expectation: { handling: 'ai_handles', mustAsk: [], mustInclude: [], mustAvoid: [] }, revision: 1, adoptedRevisions: [1],
    createdBy: actor, lastEditedBy: actor, scenarioType: 'behavior', source: 'manual', createdAt: new Date(), updatedAt: new Date(),
  };
};
let repPolicy: string;
let managerPolicy: string;
let otherOrgPolicy: string;

async function otherCollectionsSnapshot() {
  const names = ['leads', 'conversations', 'communicationmessages', 'webchatmessages', 'webchatsessions', 'notifications', 'aiagenttasks', 'aiagentlogs',
    'aiagentcoachingrules', 'aiusagecounters', 'smsoptouts', 'emailoptouts', 'customers', 'vehicles', 'appointments', 'aiagentdrafts'];
  const db = mongoose.connection.db!;
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = await db.collection(name).countDocuments({});
  const policies = await AiTrainingPolicy.collection.find({ organizationId: { $in: [String(orgA), String(orgB)] } }).sort({ _id: 1 }).toArray();
  const versions = await AiTrainingPolicyVersion.collection.countDocuments({ organizationId: { $in: [String(orgA), String(orgB)] } });
  const audits = await AiTrainingAuditLog.collection.countDocuments({ organizationId: { $in: [String(orgA), String(orgB)] } });
  return JSON.stringify({ counts, policies, versions, audits });
}

describe('Real-DB proof: Phase 3C.1 Testing Lab (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await Promise.all([AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingScenario, AiTrainingScenarioRevision, AiTrainingTestRun].map((model: any) => model.init()));
    process.env.AI_TRAINING_ENABLED = 'true';
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Lab Org A', slug: `lab-a-${orgA}`, status: 'active', metadata: { aiTrainingEnabled: true } },
      { _id: orgB, name: 'Lab Org B', slug: `lab-b-${orgB}`, status: 'active', metadata: { aiTrainingEnabled: true } },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `lab-${id}`, email: `lab-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, orgA, 'employee', 'Rep One'),
      crm(users.rep2, orgA, 'employee', 'Rep Two'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
      crm(users.limited, orgA, 'employee', 'Rate Limited'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    repPolicy = (await post('/proposals', 'rep', { rule: rule(), submit: true }).expect(201)).body.data.id;
    managerPolicy = (await post('/proposals', 'manager', { rule: rule({ title: 'Manager rule', handling: 'ai_handles', requiredQuestions: [] }) }).expect(201)).body.data.id;
    otherOrgPolicy = (await post('/proposals', 'otherAdmin', { rule: rule({ title: 'Other org rule' }) }).expect(201)).body.data.id;
  });

  afterAll(async () => {
    const both = [orgA, orgB, String(orgA), String(orgB)];
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingScenario, AiTrainingScenarioRevision, AiTrainingTestRun, CrmUser] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: both } });
    }
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_TRAINING_ENABLED = 'true';
    process.env.SKIP_RATE_LIMIT = 'true';
    mockCreate.mockClear();
    mockOpenAi.mockClear();
  });

  describe('scenario library', () => {
    it('is shared in the organization; authors and managers can edit; others cannot; every change is a revision', async () => {
      const created = await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(201);
      const id = created.body.data.scenario.id;
      expect(created.body.data.scenario).toMatchObject({ revision: 1, isMine: true, canManage: true });

      const asRep2 = (await get(`/lab/scenarios/${id}`, 'rep2').expect(200)).body.data.scenario;
      expect(asRep2).toMatchObject({ isMine: false, canManage: false });
      await put(`/lab/scenarios/${id}`, 'rep2', { scenario: scenario({ title: 'Hijack' }), expectedRevision: 1 }).expect(403);
      await post(`/lab/scenarios/${id}/archive`, 'rep2', { expectedRevision: 1 }).expect(403);

      await put(`/lab/scenarios/${id}`, 'rep', { scenario: scenario({ title: 'Family of five v2' }), expectedRevision: 1, changeNote: 'Renamed' }).expect(200);
      await put(`/lab/scenarios/${id}`, 'rep', { scenario: scenario(), expectedRevision: 1 }).expect(409);
      await put(`/lab/scenarios/${id}`, 'manager', { scenario: scenario({ title: 'Manager edit' }), expectedRevision: 2 }).expect(200);
      await post(`/lab/scenarios/${id}/archive`, 'rep', { expectedRevision: 3 }).expect(200);
      await put(`/lab/scenarios/${id}`, 'rep', { scenario: scenario(), expectedRevision: 4 }).expect(409);
      await post(`/lab/scenarios/${id}/restore`, 'manager', { expectedRevision: 4 }).expect(200);

      const detail = (await get(`/lab/scenarios/${id}`, 'rep').expect(200)).body.data;
      expect(detail.scenario).toMatchObject({ revision: 5, title: 'Manager edit', archived: false });
      expect(detail.revisions.map((r: any) => [r.revision, r.action, r.createdByName])).toEqual([
        [5, 'restored', 'Manager One'], [4, 'archived', 'Rep One'], [3, 'edited', 'Manager One'], [2, 'edited', 'Rep One'], [1, 'created', 'Rep One'],
      ]);
      expect(detail.revisions[3].content.title).toBe('Family of five v2');
    });

    it('rejects real-looking customer data on the server and warns about addresses', async () => {
      for (const [field, value, code] of [
        ['message', 'Text me at 801-555-1234', 'real_phone'],
        ['customerName', 'riley@gmail.com', 'real_email'],
        ['vehicleInterest', 'VIN 1HGCM82633A004352', 'vin'],
        ['message', 'Lead 507f1f77bcf86cd799439011 again', 'record_id'],
        ['message', 'Look at https://www.realdealer.com/inventory', 'real_link'],
      ] as const) {
        const res = await post('/lab/scenarios', 'rep', { scenario: scenario({ [field]: value }) }).expect(400);
        expect(res.body.errors.map((e: any) => e.code)).toContain(code);
      }
      const ok = await post('/lab/scenarios', 'rep', { scenario: scenario({ message: 'Call me at 801-555-0142, I live at 1200 Main Street', expectation: { handling: 'ai_handles' } }) }).expect(201);
      expect(ok.body.data.warnings.map((w: any) => w.code)).toEqual(['street_address']);
      const checked = await post('/lab/scenarios/check', 'rep', { scenario: scenario({ message: 'riley@gmail.com' }) }).expect(200);
      expect(checked.body.data.errors.map((e: any) => e.code)).toContain('real_email');
    });

    it('rejects malformed scenarios', async () => {
      for (const body of [{}, { scenario: 'text' }, { scenario: scenario({ channel: 'fax' }) }, { scenario: scenario({ expectation: { handling: 'maybe' } }) },
        { scenario: scenario({ turns: [{ from: 'robot', body: 'x' }] }) }, { scenario: scenario({ title: 'x'.repeat(200) }) }]) {
        const res = await post('/lab/scenarios', 'rep', body).expect(400);
        expect(Array.isArray(res.body.errors)).toBe(true);
      }
    });

    it('enforces the active scenario limit per organization', async () => {
      const actor = { userId: String(users.admin), name: 'Admin One', role: 'admin' };
      const existing = await AiTrainingScenario.countDocuments({ organizationId: String(orgA), archived: false });
      const filler = Array.from({ length: 500 - existing }, (_, i) => ({
        organizationId: String(orgA), title: `Filler ${i}`, channel: 'sms', message: 'filler', turns: [], flags: {}, tags: [],
        expectation: { handling: 'ai_handles', mustAsk: [], mustInclude: [], mustAvoid: [] }, archived: false, revision: 1, adoptedRevisions: [1],
        createdBy: actor, lastEditedBy: actor, scenarioType: 'behavior', source: 'manual', createdAt: new Date(), updatedAt: new Date(),
      }));
      await AiTrainingScenario.collection.insertMany(filler as any[]);
      const res = await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(409);
      expect(res.body.message).toContain('500 active scenarios');
      await AiTrainingScenario.collection.deleteMany({ organizationId: String(orgA), title: /^Filler / });
    });

    it('archived scenarios never block new ones; only the 500 active limit applies', async () => {
      const base = rawScenario();
      await AiTrainingScenario.collection.insertMany(Array.from({ length: 1200 }, (_, i) => ({ ...base, title: `Archived filler ${i}`, archived: true, archivedAt: new Date() })) as any[]);
      try {
        expect((await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'After many archived' }) }).expect(201)).body.data.scenario.revision).toBe(1);
        const status = (await get('/lab/status', 'rep').expect(200)).body.data.scenarios;
        expect(status.total).toBeGreaterThan(1200);
        expect(status).toMatchObject({ activeLimit: 500 });
        expect(status).not.toHaveProperty('totalLimit');
        const restoreId = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Restore me' }) }).expect(201)).body.data.scenario.id;
        await post(`/lab/scenarios/${restoreId}/archive`, 'rep', { expectedRevision: 1 }).expect(200);
        const active = await AiTrainingScenario.countDocuments({ organizationId: String(orgA), archived: false });
        await AiTrainingScenario.collection.insertMany(Array.from({ length: 500 - active }, (_, i) => ({ ...base, title: `Active filler ${i}`, archived: false })) as any[]);
        expect((await post(`/lab/scenarios/${restoreId}/restore`, 'rep', { expectedRevision: 2 }).expect(409)).body.message).toContain('500 active scenarios');
        expect((await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(409)).body.message).toContain('500 active scenarios');
        const history = (await get(`/lab/scenarios/${restoreId}`, 'rep').expect(200)).body.data.revisions.map((r: any) => r.action);
        expect(history).toEqual(['archived', 'created']);
      } finally {
        await AiTrainingScenario.collection.deleteMany({ organizationId: String(orgA), title: /^(Archived|Active) filler / });
      }
    });

    it('other organizations cannot see or change the library', async () => {
      const id = (await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(201)).body.data.scenario.id;
      await get(`/lab/scenarios/${id}`, 'otherAdmin').expect(404);
      await put(`/lab/scenarios/${id}`, 'otherAdmin', { scenario: scenario(), expectedRevision: 1 }).expect(404);
      await post(`/lab/scenarios/${id}/archive`, 'otherAdmin', { expectedRevision: 1 }).expect(404);
      const list = (await get('/lab/scenarios?limit=100', 'otherAdmin').expect(200)).body.data.scenarios;
      expect(list.some((s: any) => s.id === id)).toBe(false);
    });
  });

  describe('running tests', () => {
    let scenarioId: string;
    beforeAll(async () => {
      scenarioId = (await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(201)).body.data.scenario.id;
    });

    it('a rules-only run is stored as incomplete, never as a pass, with the exact versions and engine', async () => {
      const run = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201)).body.data;
      expect(run).toMatchObject({ policyVersion: 1, scenarioRevision: 1, mode: 'rules_only', engineVersion: LAB_ENGINE_VERSION, verdict: 'incomplete', policyStatusAtRun: 'in_review' });
      expect(run.counts.notEvaluated).toBeGreaterThan(0);
      const stored: any = await AiTrainingTestRun.findById(run.id).lean();
      expect(stored.policySpecHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.scenarioSnapshot.title).toBe('Family of five');
    });

    it('a good sample reply passes the checks but is flagged as including approximate matching', async () => {
      const run = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'sample_reply', reply: { source: 'written', text: GOOD_REPLY } }).expect(201)).body.data;
      expect(run).toMatchObject({ verdict: 'checks_passed', includesApproximate: true });
      const methods = new Set(run.checks.map((c: any) => c.method));
      expect([...methods]).toEqual(expect.arrayContaining(['keyword_rule', 'local_mock_screening', 'approximate', 'existing_safety_filter', 'deterministic']));
    });

    it('a reply the existing safety filter would block fails; the rule example can be used as the reply', async () => {
      const blocked = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'sample_reply', reply: { source: 'written', text: 'It is $24,999! How many people usually ride with you?' } }).expect(201)).body.data;
      expect(blocked.verdict).toBe('failed');
      const example = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'sample_reply', reply: { source: 'rule_example', exampleIndex: 0 } }).expect(201)).body.data;
      expect(example.reply).toMatchObject({ source: 'rule_example', exampleIndex: 0, text: 'Great question! How many people usually ride with you?' });
      await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'sample_reply', reply: { source: 'rule_example', exampleIndex: 5 } }).expect(400);
      const realPhone = await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'sample_reply', reply: { source: 'written', text: 'Call us at 801-555-2222?' } }).expect(400);
      expect(realPhone.body.errors.map((e: any) => e.code)).toContain('real_phone');
    });

    it('reps test only their own proposals; managers and admins test any proposal in the organization', async () => {
      await post('/lab/runs', 'rep', { policyId: managerPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(404);
      await post('/lab/runs', 'rep2', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(404);
      await post('/lab/runs', 'manager', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201);
      await post('/lab/runs', 'admin', { policyId: managerPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201);
    });

    it('reps see only results for their own proposals; other organizations see nothing', async () => {
      const managerRun = (await post('/lab/runs', 'manager', { policyId: managerPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201)).body.data;
      const repList = (await get('/lab/runs?limit=100', 'rep').expect(200)).body.data.runs;
      expect(repList.length).toBeGreaterThan(0);
      expect(repList.every((r: any) => r.policyId === repPolicy)).toBe(true);
      await get(`/lab/runs/${managerRun.id}`, 'rep').expect(404);
      await get(`/lab/runs/${managerRun.id}`, 'manager').expect(200);
      expect((await get('/lab/runs?limit=100', 'rep2').expect(200)).body.data.runs).toEqual([]);
      await get(`/lab/runs/${managerRun.id}`, 'otherAdmin').expect(404);
      expect((await get('/lab/runs?limit=100', 'otherAdmin').expect(200)).body.data.runs).toEqual([]);
    });

    it('cross-organization proposals and scenarios cannot be combined', async () => {
      await post('/lab/runs', 'otherAdmin', { policyId: otherOrgPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(404);
      await post('/lab/runs', 'admin', { policyId: otherOrgPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(404);
    });

    it('rejects bad versions, archived scenarios and malformed runs', async () => {
      await post('/lab/runs', 'rep', { policyId: repPolicy, version: 9, scenarioId, mode: 'rules_only' }).expect(404);
      await post('/lab/runs', 'rep', { policyId: repPolicy, version: 'abc', scenarioId, mode: 'rules_only' }).expect(400);
      await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'ai' }).expect(400);
      await post('/lab/runs', 'rep', { policyId: 'nope', version: 1, scenarioId, mode: 'rules_only' }).expect(404);
      const archived = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Archived one' }) }).expect(201)).body.data.scenario.id;
      await post(`/lab/scenarios/${archived}/archive`, 'rep', { expectedRevision: 1 }).expect(200);
      await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId: archived, mode: 'rules_only' }).expect(409);
    });

    it('a batch tests up to 20 scenarios against one exact version, all or nothing', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await post('/lab/scenarios', 'rep', { scenario: scenario({ title: `Batch ${i}` }) }).expect(201)).body.data.scenario.id);
      const before = await AiTrainingTestRun.countDocuments({ organizationId: String(orgA) });
      const batch = (await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: ids, mode: 'sample_reply', reply: { source: 'rule_example', exampleIndex: 0 } }).expect(201)).body.data.runs;
      expect(batch.map((run: any) => run.scenarioId)).toEqual(ids);
      expect(batch.every((run: any) => run.policyVersion === 1 && run.engineVersion === LAB_ENGINE_VERSION && run.reply.source === 'rule_example')).toBe(true);
      expect(await AiTrainingTestRun.countDocuments({ organizationId: String(orgA) })).toBe(before + 3);

      const tooMany = Array.from({ length: 21 }, () => String(new mongoose.Types.ObjectId()));
      expect((await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: tooMany, mode: 'rules_only' }).expect(400)).body.message).toContain('at most 20');
      await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: [], mode: 'rules_only' }).expect(400);
      await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: [ids[0], ids[0]], mode: 'rules_only' }).expect(400);

      const otherOrgScenario = (await post('/lab/scenarios', 'otherAdmin', { scenario: scenario({ title: 'Other org batch' }) }).expect(201)).body.data.scenario.id;
      await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: [ids[0], otherOrgScenario], mode: 'rules_only' }).expect(404);
      await post(`/lab/scenarios/${ids[2]}/archive`, 'rep', { expectedRevision: 1 }).expect(200);
      await post('/lab/runs/batch', 'rep', { policyId: repPolicy, version: 1, scenarioIds: ids, mode: 'rules_only' }).expect(409);
      await post('/lab/runs/batch', 'rep', { policyId: managerPolicy, version: 1, scenarioIds: [ids[0]], mode: 'rules_only' }).expect(404);
      expect(await AiTrainingTestRun.countDocuments({ organizationId: String(orgA) })).toBe(before + 3);
    });
  });

  describe('picker search and paging', () => {
    const rawPolicy = (org: mongoose.Types.ObjectId, who: string, title: string) => ({
      organizationId: String(org), title, category: 'scenario_response', channels: ['sms'], status: 'in_review', source: 'manual',
      currentVersion: 1, adoptedVersions: [1], ruleFormat: 'structured_v1',
      createdBy: { userId: String(users[who]), name: who, role: who === 'rep' ? 'rep' : 'admin' }, createdAt: new Date(), updatedAt: new Date(),
    });

    it('finds any active scenario by title on the server, beyond the first 100, within the organization only', async () => {
      const base = rawScenario();
      await AiTrainingScenario.collection.insertMany(Array.from({ length: 130 }, (_, i) => ({ ...base, title: `Picker scenario ${String(i).padStart(3, '0')}`, archived: false })) as any[]);
      await AiTrainingScenario.collection.insertOne({ ...base, title: 'Picker scenario archived', archived: true } as any);
      try {
        const hit = (await get('/lab/scenarios?q=Picker%20scenario%20127', 'rep').expect(200)).body.data;
        expect(hit.scenarios.map((s: any) => s.title)).toEqual(['Picker scenario 127']);
        const first = (await get('/lab/scenarios?q=picker%20SCENARIO&limit=10', 'rep').expect(200)).body.data;
        expect(first).toMatchObject({ total: 130, totalPages: 13 });
        const seen = new Set<string>();
        for (let page = 1; page <= 13; page++) {
          for (const row of (await get(`/lab/scenarios?q=picker%20scenario&limit=10&page=${page}`, 'rep').expect(200)).body.data.scenarios) seen.add(row.title);
        }
        expect(seen.size).toBe(130);
        expect(seen.has('Picker scenario archived')).toBe(false);
        expect((await get('/lab/scenarios?q=Picker%20scenario', 'otherAdmin').expect(200)).body.data.total).toBe(0);
        expect((await get('/lab/scenarios?q=Picker%20scenario&archived=true', 'rep').expect(200)).body.data.total).toBe(1);
      } finally {
        await AiTrainingScenario.collection.deleteMany({ organizationId: String(orgA), title: /^Picker scenario / });
      }
    });

    it('finds any proposal the user may test, beyond the first 100, with role and organization filtering', async () => {
      await AiTrainingPolicy.collection.insertMany([
        ...Array.from({ length: 105 }, (_, i) => rawPolicy(orgA, 'rep', `Picker proposal ${String(i).padStart(3, '0')}`)),
        ...Array.from({ length: 3 }, (_, i) => rawPolicy(orgA, 'manager', `Picker proposal manager ${i}`)),
        ...Array.from({ length: 2 }, (_, i) => rawPolicy(orgB, 'otherAdmin', `Picker proposal other ${i}`)),
      ] as any[]);
      try {
        expect((await get('/proposals?q=Picker%20proposal%20104', 'rep').expect(200)).body.data.proposals.map((p: any) => p.title)).toEqual(['Picker proposal 104']);
        const repAll = (await get('/proposals?q=picker%20proposal&limit=10', 'rep').expect(200)).body.data;
        expect(repAll).toMatchObject({ total: 105, totalPages: 11 });
        const lastPage = (await get('/proposals?q=picker%20proposal&limit=10&page=11', 'rep').expect(200)).body.data.proposals;
        expect(lastPage).toHaveLength(5);
        expect(lastPage.every((p: any) => p.isMine)).toBe(true);
        expect((await get('/proposals?q=Picker%20proposal&limit=10', 'manager').expect(200)).body.data.total).toBe(108);
        expect((await get('/proposals?q=Picker%20proposal%20manager', 'rep').expect(200)).body.data.total).toBe(0);
        expect((await get('/proposals?q=Picker%20proposal', 'rep2').expect(200)).body.data.total).toBe(0);
        expect((await get('/proposals?q=Picker%20proposal', 'otherAdmin').expect(200)).body.data.total).toBe(2);
      } finally {
        await AiTrainingPolicy.collection.deleteMany({ organizationId: { $in: [String(orgA), String(orgB)] }, title: /^Picker proposal / });
      }
    });

    it('search text is matched literally and validated', async () => {
      for (const path of ['/lab/scenarios', '/proposals']) {
        expect((await get(`${path}?q=${encodeURIComponent('(.*')}`, 'manager').expect(200)).body.data.total).toBe(0);
        expect((await get(`${path}?q=${encodeURIComponent('[a-z]+')}`, 'manager').expect(200)).body.data.total).toBe(0);
        await get(`${path}?q=${'x'.repeat(101)}`, 'manager').expect(400);
        await get(`${path}?q=a&q=b`, 'manager').expect(400);
      }
    });
  });

  describe('immutable history and retention', () => {
    it('results and scenario revisions cannot be edited or deleted through the app', async () => {
      const scenarioId = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Immutable' }) }).expect(201)).body.data.scenario.id;
      const run = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201)).body.data;
      await expect(AiTrainingTestRun.updateOne({ _id: run.id }, { $set: { verdict: 'checks_passed' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingTestRun.findByIdAndDelete(run.id)).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingTestRun.bulkWrite([{ deleteOne: { filter: { _id: run.id } } }])).rejects.toBeInstanceOf(AppendOnlyViolationError);
      const revision: any = await AiTrainingScenarioRevision.findOne({ scenarioId });
      await expect(revision.updateOne({ $set: { changeNote: 'x' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingScenarioRevision.deleteMany({ scenarioId })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      expect((await AiTrainingTestRun.findById(run.id).lean() as any).verdict).toBe('incomplete');
    });

    it('editing a scenario or proposal later never changes an old result', async () => {
      const scenarioId = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Before edit' }) }).expect(201)).body.data.scenario.id;
      const run = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201)).body.data;
      await put(`/lab/scenarios/${scenarioId}`, 'rep', { scenario: scenario({ title: 'After edit', message: 'STOP' }), expectedRevision: 1 }).expect(200);
      const again = (await get(`/lab/runs/${run.id}`, 'rep').expect(200)).body.data;
      expect(again).toMatchObject({ scenarioRevision: 1, scenarioTitle: 'Before edit', checks: run.checks, verdict: run.verdict });
    });

    it('results are shown exactly as stored, even when made by an older engine version', async () => {
      const scenarioId = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Old engine' }) }).expect(201)).body.data.scenario.id;
      const stored = await AiTrainingTestRun.create({
        organizationId: String(orgA), policyId: repPolicy, policyVersion: 1, policyStatusAtRun: 'in_review', policyTitle: 'Sedan versus SUV questions',
        policyAuthorId: String(users.rep), policySpecHash: 'a'.repeat(64), ruleFormat: 'structured_v1', scenarioId, scenarioRevision: 1,
        scenarioSnapshot: { ...scenario(), turns: [], flags: { hasUpcomingAppointment: false, previouslyOptedOut: false }, expectation: { handling: 'ask_clarifying', mustAsk: [], mustInclude: [], mustAvoid: [] }, tags: [], archived: false },
        channel: 'sms', mode: 'rules_only', engineVersion: 'training-lab-0.9.0',
        checks: [{ id: 'legacy.check', group: 'rule', label: 'Legacy check', status: 'warning', method: 'approximate', message: 'Stored by an older engine' }],
        counts: { pass: 0, fail: 0, warning: 1, notEvaluated: 0 }, verdict: 'needs_review', includesApproximate: true,
        runBy: { userId: String(users.rep), name: 'Rep One', role: 'rep' }, expiresAt: new Date(Date.now() + 365 * 86400000),
      });
      const shown = (await get(`/lab/runs/${stored._id}`, 'rep').expect(200)).body.data;
      expect(shown).toMatchObject({ engineVersion: 'training-lab-0.9.0', verdict: 'needs_review', checks: [{ id: 'legacy.check', message: 'Stored by an older engine' }] });
    });

    it('results expire 365 days after they are created, through a database retention index', async () => {
      const scenarioId = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Retention' }) }).expect(201)).body.data.scenario.id;
      const run = (await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId, mode: 'rules_only' }).expect(201)).body.data;
      const days = (new Date(run.expiresAt).getTime() - new Date(run.createdAt).getTime()) / 86400000;
      expect(days).toBeCloseTo(365, 3);
      const indexes = await AiTrainingTestRun.collection.indexes();
      expect(indexes.find((index: any) => index.name === 'ai_training_run_retention')).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
      expect((await get('/lab/runs?limit=1', 'rep').expect(200)).body.data.retentionDays).toBe(365);
    });
  });

  describe('no outside effects', () => {
    it('a full lab session writes nothing outside the lab, never calls Gemini, and never changes proposals', async () => {
      const before = await otherCollectionsSnapshot();
      const id = (await post('/lab/scenarios', 'rep', { scenario: scenario({ title: 'Side effects' }) }).expect(201)).body.data.scenario.id;
      await put(`/lab/scenarios/${id}`, 'rep', { scenario: scenario({ title: 'Side effects 2' }), expectedRevision: 1 }).expect(200);
      await post('/lab/scenarios/check', 'rep', { scenario: scenario() }).expect(200);
      for (const mode of ['rules_only', 'sample_reply']) {
        await post('/lab/runs', 'rep', { policyId: repPolicy, version: 1, scenarioId: id, mode, reply: { source: 'written', text: GOOD_REPLY } }).expect(201);
      }
      await post('/lab/runs', 'manager', { policyId: managerPolicy, version: 1, scenarioId: id, mode: 'rules_only' }).expect(201);
      await get('/lab/runs', 'manager').expect(200);
      await get('/lab/status', 'rep').expect(200);
      expect(await otherCollectionsSnapshot()).toEqual(before);
      expect(mockOpenAi).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(JSON.stringify(await getRelevantAiCoaching({ organizationId: String(orgA), channel: 'sms' }))).not.toContain('Sedan versus SUV');
    });

    it('everything is refused while training is off', async () => {
      await Organization.updateOne({ _id: orgA }, { $set: { 'metadata.aiTrainingEnabled': false } });
      try {
        await get('/lab/status', 'rep').expect(409);
        await post('/lab/scenarios', 'rep', { scenario: scenario() }).expect(409);
        await get('/lab/runs', 'manager').expect(409);
      } finally {
        await Organization.updateOne({ _id: orgA }, { $set: { 'metadata.aiTrainingEnabled': true } });
      }
    });

    it('the real lab routes are rate limited per user', async () => {
      delete process.env.SKIP_RATE_LIMIT;
      const writes: number[] = [];
      for (let i = 0; i < 32; i++) writes.push((await post('/lab/runs', 'limited', { mode: 'not-a-mode' })).status);
      expect(writes.slice(0, 30).every((status) => status === 400)).toBe(true);
      expect(writes.slice(30)).toEqual([429, 429]);
      await post('/lab/runs', 'rep2', { mode: 'not-a-mode' }).expect(400);
      const checks: number[] = [];
      for (let i = 0; i < 40; i++) checks.push((await post('/lab/scenarios/check', 'limited', { scenario: scenario() })).status);
      expect(checks.every((status) => status === 200)).toBe(true);
    });
  });
});
