import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockOpenAiConstructed = jest.fn();
const mockSendSms = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => {
  mockOpenAiConstructed();
  return { chat: { completions: { create: jest.fn() } } };
}));
jest.mock('../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550999', sendSms: mockSendSms }));
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLocation from '../src/models/CrmLocation.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import AiTrainingImportBatch from '../src/models/AiTrainingImportBatch.model';
import AiTrainingImportItem from '../src/models/AiTrainingImportItem.model';
import AiTrainingImportContent from '../src/models/AiTrainingImportContent.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { getRelevantAiCoaching } from '../src/services/aiAgentCoaching.service';
import { resetTrainingTransactionProbe, submitCoachingAsProposal } from '../src/services/aiTraining.service';
import { IMPORT_COLUMNS } from '../src/services/aiTrainingImportParser';
import aiTrainingRoute from '../src/routes/aiTraining.routes';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use('/api/crm/ai-training', aiTrainingRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const A = String(orgA);
const B = String(orgB);
const users: Record<string, mongoose.Types.ObjectId> = {
  rep: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  manager2: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const oremId = new mongoose.Types.ObjectId();
const tokens: Record<string, string> = {};
const BASE = '/api/crm/ai-training';
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(`${BASE}${path}`).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(`${BASE}${path}`).set(auth(who)).send(body);
const put = (path: string, who: string, body: any = {}) => request(app).put(`${BASE}${path}`).set(auth(who)).send(body);
const BLOCKED = 'ZEBRA';
let transactional = false;

const ruleBody = (overrides: Record<string, unknown> = {}) => ({
  title: 'Gate rule',
  category: 'scenario_response',
  channels: ['sms', 'webchat'],
  intent: 'asks what the price is',
  triggers: ['asks what the price is'],
  handling: 'ask_clarifying',
  instruction: 'Never quote prices. Say a sales manager will confirm pricing and offer to set up a visit.',
  requiredQuestions: ['Which vehicle are you looking at?'],
  mustAvoid: ['Quoting a price or payment'],
  ...overrides,
});

type Row = Record<string, string>;
const escapeCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const toCsv = (rows: Row[]) => [IMPORT_COLUMNS.map((c) => c.column).join(','), ...rows.map((row) => IMPORT_COLUMNS.map((c) => escapeCell(row[c.column] || '')).join(','))].join('\r\n');
const importRow = (title: string, overrides: Row = {}): Row => ({
  type: 'rule', title, location: 'Orem', channels: 'sms|webchat',
  trigger_or_question: `asks about ${title.toLowerCase()}`,
  answer_or_instruction: 'Never quote prices. Say a sales manager will confirm pricing and offer to set up a visit.',
  handling: 'ask_clarifying', required_questions: 'Which vehicle are you looking at?', must_avoid: 'Quoting a price or payment',
  source_ref: `Podium AI > ${title}`, source_status: 'on', ...overrides,
});

async function importRules(who: string, rows: Row[]) {
  const body = { source: { format: 'csv', content: toCsv(rows) }, options: {} };
  const preview = await post('/imports/preview', who, body).expect(200);
  await post('/imports', who, { ...body, previewHash: preview.body.data.previewHash, attestation: true }).expect(201);
}

async function importedId(title: string): Promise<string> {
  const policy: any = await AiTrainingPolicy.findOne({ organizationId: A, title, source: 'podium_import' }).sort({ createdAt: -1 }).lean();
  return String(policy._id);
}

const codes = (res: any) => (res.body.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
const statusOf = async (id: string) => ((await AiTrainingPolicy.findById(id).lean()) as any).status;

describe('Real-DB proof: P1d strict safety gate for imported training (local MongoDB only)', () => {
  const env = { ...process.env };
  let orgSnapshot = '';
  let coachingSnapshot = '';

  beforeAll(async () => {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    transactional = Boolean(hello.setName);
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation] as any[]) await model.init();
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Gate Org A', slug: `gate-a-${orgA}`, status: 'active', metadata: { aiTrainingEnabled: true, aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: orgB, name: 'Gate Org B', slug: `gate-b-${orgB}`, status: 'active', metadata: { aiTrainingEnabled: true } },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `gate-${id}`, email: `gate-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, orgA, 'employee', 'Rep One'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.manager2, orgA, 'manager', 'Manager Two'),
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const actor = { userId: String(users.admin), name: 'Admin One', role: 'admin' };
    await CrmLocation.collection.insertOne({ _id: oremId, organizationId: A, code: 'orem', name: 'Orem', aliases: [], aliasKeys: ['orem'], status: 'active', revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date() } as any);
    await AiAgentCoachingRule.collection.insertOne({
      organizationId: A, scope: 'organization', channel: 'all', instruction: 'Keep replies short and friendly.', status: 'active',
      sourceLeadId: new mongoose.Types.ObjectId(), sourceMessageId: new mongoose.Types.ObjectId(), sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: 'Hello', usageCount: 0, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    orgSnapshot = JSON.stringify(await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray());
    coachingSnapshot = JSON.stringify(await AiAgentCoachingRule.collection.find({ organizationId: { $in: [A, B] } }).toArray());
  });

  afterAll(async () => {
    const both = [orgA, orgB, A, B];
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation, CrmUser, AiAgentCoachingRule] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: both } });
    }
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_TRAINING_ENABLED = 'true';
    process.env.AI_TRAINING_IMPORT_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    resetTrainingTransactionProbe();
    jest.restoreAllMocks();
  });

  it('an unchanged imported draft passes on submit and approve, and stays inactive after approval', async () => {
    await importRules('manager', [importRow('Clean rule')]);
    const id = await importedId('Clean rule');
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 1 }).expect(403);
    await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 1 }).expect(200);
    expect(await statusOf(id)).toBe('approved');
    for (const channel of ['sms', 'webchat'] as const) {
      expect((await getRelevantAiCoaching({ organizationId: A, channel })).notes).toEqual(['Keep replies short and friendly.']);
    }
    expect(JSON.stringify(await AiAgentCoachingRule.collection.find({ organizationId: { $in: [A, B] } }).toArray())).toBe(coachingSnapshot);
    expect(JSON.stringify(await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray())).toBe(orgSnapshot);
    expect(mockOpenAiConstructed).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('an edited imported draft is checked on the exact version being submitted', async () => {
    await importRules('manager', [importRow('Edited rule')]);
    const id = await importedId('Edited rule');
    const saved = await put(`/proposals/${id}`, 'manager', { rule: ruleBody({ title: 'Edited rule', instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck this week.` }), expectedVersion: 1 }).expect(200);
    expect(saved.body.data.evaluation.readyToSubmit).toBe(false);
    expect(saved.body.data.reviewBlockers.map((issue: any) => `${issue.field}:${issue.code}`)).toContain('instruction:guardrail_figure');
    const refused = await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 2 }).expect(400);
    expect(codes(refused)).toContain('instruction:guardrail_figure');
    expect(JSON.stringify(refused.body)).not.toContain('ZEBRA');
    expect(await statusOf(id)).toBe('draft');
    await put(`/proposals/${id}`, 'manager', { rule: ruleBody({ title: 'Edited rule' }), expectedVersion: 2 }).expect(200);
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 3 }).expect(200);
  });

  it('reports each prohibited field of an imported draft by its field path', async () => {
    await importRules('manager', [importRow('Field rule')]);
    const id = await importedId('Field rule');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: '0% APR special' }, 'title:guardrail_figure'],
      [{ intent: 'asks about the $500 deposit' }, 'intent:guardrail_figure'],
      [{ triggers: ['asks about the 72 month loan'] }, 'triggers.0:guardrail_figure'],
      [{ instruction: 'Tell them financing is available for everyone.' }, 'instruction:guardrail_topic'],
      [{ requiredQuestions: ['Will you be financing or paying cash?'] }, 'requiredQuestions.0:guardrail_topic'],
      [{ mustInclude: ['Mention our current rebate'] }, 'mustInclude.0:guardrail_topic'],
      [{ mustAvoid: ['Refusing to quote prices'] }, 'mustAvoid.0:must_avoid_contradiction'],
      [{ mustAvoid: ['Escalating to a manager'] }, 'mustAvoid.0:must_avoid_safety'],
      [{ handling: 'escalate', escalation: { when: 'They want the 0% offer', handoffReason: 'Offer question' } }, 'escalation.when:guardrail_figure'],
      [{ handling: 'escalate', escalation: { when: 'The customer is upset', handoffReason: 'Promised them $500 off' } }, 'escalation.handoffReason:guardrail_figure'],
      [{ examples: [{ customerMessage: 'Best price?', idealReply: 'A team member will confirm the price with you.' }] }, 'examples.0.idealReply:guardrail_reply'],
    ];
    let version = 1;
    for (const [overrides, expected] of cases) {
      await put(`/proposals/${id}`, 'manager', { rule: ruleBody({ title: 'Field rule', ...overrides }), expectedVersion: version }).expect(200);
      version += 1;
      const res = await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: version }).expect(400);
      expect({ expected, got: codes(res) }).toEqual({ expected, got: expect.arrayContaining([expected]) });
    }
    expect(await statusOf(id)).toBe('draft');
  });

  it('reviewer edits during review are checked again at approval', async () => {
    await importRules('manager', [importRow('Review rule')]);
    const id = await importedId('Review rule');
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    await put(`/proposals/${id}`, 'admin', { rule: ruleBody({ title: 'Review rule', mustInclude: ['Mention the $500 rebate'] }), expectedVersion: 1, changeNote: 'Reviewer tweak' }).expect(200);
    const blocked = await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 2 }).expect(400);
    expect(codes(blocked)).toContain('mustInclude.0:guardrail_figure');
    await post(`/proposals/${id}/approve`, 'admin', { expectedVersion: 2 }).expect(403);
    expect(await statusOf(id)).toBe('in_review');
    const detail = (await get(`/proposals/${id}`, 'manager2').expect(200)).body.data;
    expect(detail.reviewBlockers.map((issue: any) => `${issue.field}:${issue.code}`)).toContain('mustInclude.0:guardrail_figure');
    expect(JSON.stringify(detail.reviewBlockers)).not.toContain('$500');
    await post(`/proposals/${id}/request-changes`, 'manager2', { note: 'Remove the amount', expectedVersion: 2 }).expect(200);
    expect(await statusOf(id)).toBe('changes_requested');
  });

  it('linked replacement drafts and their later versions follow the same gate', async () => {
    await importRules('manager', [importRow('Linked rule')]);
    const originalId = await importedId('Linked rule');
    await post(`/proposals/${originalId}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    await importRules('manager', [importRow('Linked rule', { answer_or_instruction: 'Never quote prices. A sales manager will confirm pricing in person.' })]);
    const linked: any = await AiTrainingPolicy.findOne({ organizationId: A, 'sourceRef.previousPolicyId': originalId }).lean();
    expect(linked).toMatchObject({ status: 'draft', source: 'podium_import' });
    const linkedId = String(linked._id);
    await put(`/proposals/${linkedId}`, 'manager', { rule: ruleBody({ title: 'Linked rule', instruction: 'Explain our trade-in program and say approval is easy.' }), expectedVersion: 1 }).expect(200);
    expect(codes(await post(`/proposals/${linkedId}/submit`, 'manager', { expectedVersion: 2 }).expect(400))).toContain('instruction:guardrail_topic');
    await put(`/proposals/${linkedId}`, 'manager', { rule: ruleBody({ title: 'Linked rule' }), expectedVersion: 2 }).expect(200);
    await post(`/proposals/${linkedId}/submit`, 'manager', { expectedVersion: 3 }).expect(200);
    await post(`/proposals/${linkedId}/approve`, 'manager2', { expectedVersion: 3 }).expect(200);
    expect(await statusOf(originalId)).toBe('in_review');
  });

  it('the revise endpoint cannot submit structured or imported rules', async () => {
    await importRules('manager', [importRow('Revise rule')]);
    const importedRule = await importedId('Revise rule');
    const imported = await post(`/proposals/${importedRule}/revise`, 'manager', { instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck.` }).expect(409);
    expect(imported.body.message).toContain('rule editor');
    const manual = (await post('/proposals', 'manager', { rule: ruleBody({ title: 'Manual revise rule' }) }).expect(201)).body.data.id;
    await post(`/proposals/${manual}/revise`, 'manager', { instruction: 'Anything at all for the instruction.' }).expect(409);
    expect(await statusOf(importedRule)).toBe('draft');
    expect(await statusOf(manual)).toBe('draft');
  });

  it('copying blocked content into a new proposal or a coaching note does not get around the gate', async () => {
    const before = await AiTrainingPolicy.countDocuments({ organizationId: A });
    const created = await post('/proposals', 'manager', { rule: ruleBody({ title: 'Copied rule', instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck.` }), submit: true }).expect(400);
    expect(codes(created)).toContain('instruction:guardrail_figure');
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A })).toBe(before);
    const draft = (await post('/proposals', 'manager', { rule: ruleBody({ title: 'Copied draft', instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck.` }) }).expect(201)).body.data.id;
    await post(`/proposals/${draft}/submit`, 'manager', { expectedVersion: 1 }).expect(400);

    const rep = await CrmUser.findById(users.rep).lean();
    const unsafe = await submitCoachingAsProposal({
      organizationId: A, user: rep, instruction: 'Tell customers we have 0% financing.', channel: 'sms',
      leadId: String(new mongoose.Types.ObjectId()), messageId: `gate-msg-${Date.now()}`, messageModel: 'CommunicationMessage',
    });
    expect(unsafe.policy.status).toBe('in_review');
    const blocked = await post(`/proposals/${unsafe.policy._id}/approve`, 'manager', { expectedVersion: 1 }).expect(400);
    expect(codes(blocked)).toContain('instruction:guardrail_figure');
    const safe = await submitCoachingAsProposal({
      organizationId: A, user: rep, instruction: 'Keep replies short and ask which vehicle they want.', channel: 'sms',
      leadId: String(new mongoose.Types.ObjectId()), messageId: `gate-msg-safe-${Date.now()}`, messageModel: 'CommunicationMessage',
    });
    await post(`/proposals/${safe.policy._id}/approve`, 'manager', { expectedVersion: 1 }).expect(200);
  });

  it('changing source metadata or the stored format does not change the outcome', async () => {
    await importRules('manager', [importRow('Tamper rule')]);
    const id = await importedId('Tamper rule');
    await put(`/proposals/${id}`, 'manager', { rule: ruleBody({ title: 'Tamper rule', instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck.` }), expectedVersion: 1 }).expect(200);
    await AiTrainingPolicy.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { source: 'manual' }, $unset: { sourceRef: '' } });
    expect(codes(await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 2 }).expect(400))).toContain('instruction:guardrail_figure');
    await AiTrainingPolicy.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { source: 'coaching_submission' } });
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 2 }).expect(400);

    const actor = { userId: String(users.rep), name: 'Rep One', role: 'rep' };
    const seed = async (ruleFormat: string, spec: Record<string, unknown>) => {
      const policyId = new mongoose.Types.ObjectId();
      await AiTrainingPolicyVersion.collection.insertOne({ organizationId: A, policyId, version: 1, spec, createdBy: actor, createdAt: new Date() } as any);
      await AiTrainingPolicy.collection.insertOne({
        _id: policyId, organizationId: A, title: 'Seeded', category: 'scenario_response', channels: ['sms'], status: 'in_review', source: 'manual',
        currentVersion: 1, adoptedVersions: [1], submittedVersion: 1, ruleFormat, createdBy: actor, createdAt: new Date(), updatedAt: new Date(),
      } as any);
      await AiTrainingAuditLog.collection.insertOne({ organizationId: A, policyId, action: 'proposal_submitted', actor, version: 1, toStatus: 'in_review', createdAt: new Date() } as any);
      return String(policyId);
    };
    const plain = await seed('instruction', { instruction: 'Quote the $199 oil change special to everyone.' });
    expect(codes(await post(`/proposals/${plain}/approve`, 'manager', { expectedVersion: 1 }).expect(400))).toContain('instruction:guardrail_figure');
    const relabeled = await seed('structured_v1', { format: 'instruction', ...ruleBody({ instruction: 'Quote the $199 oil change special to everyone.' }) });
    expect(codes(await post(`/proposals/${relabeled}/approve`, 'manager', { expectedVersion: 1 }).expect(400))).toContain('instruction:guardrail_figure');
  });

  it('stale versions and racing approvals cannot approve an unchecked version', async () => {
    await importRules('manager', [importRow('Race rule')]);
    const id = await importedId('Race rule');
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 99 }).expect(409);
    const results = await Promise.all([
      post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 1 }),
      put(`/proposals/${id}`, 'admin', { rule: ruleBody({ title: 'Race rule', instruction: `Tell them the price is $25,999 on the ${BLOCKED} truck.` }), expectedVersion: 1, changeNote: 'Racing edit' }),
    ]);
    const policy: any = await AiTrainingPolicy.findById(id).lean();
    if (policy.status === 'approved') {
      expect(policy.currentVersion).toBe(1);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(409);
    } else {
      expect(policy).toMatchObject({ status: 'in_review', currentVersion: 2 });
      expect([409, 400]).toContain(results[0].status);
      await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 2 }).expect(400);
    }
    await importRules('manager', [importRow('Double approve rule')]);
    const other = await importedId('Double approve rule');
    await post(`/proposals/${other}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    const approvals = await Promise.all(['manager2', 'admin'].map((who) => post(`/proposals/${other}/approve`, who, { expectedVersion: 1 })));
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await AiTrainingAuditLog.countDocuments({ organizationId: A, policyId: other, action: 'proposal_approved' })).toBe(1);
  });

  it('other organizations cannot submit, approve or read the gate details', async () => {
    await importRules('manager', [importRow('Isolated rule')]);
    const id = await importedId('Isolated rule');
    await post(`/proposals/${id}/submit`, 'otherAdmin', { expectedVersion: 1 }).expect(404);
    await post(`/proposals/${id}/submit`, 'manager', { expectedVersion: 1 }).expect(200);
    await post(`/proposals/${id}/approve`, 'otherAdmin', { expectedVersion: 1 }).expect(404);
    await get(`/proposals/${id}`, 'otherAdmin').expect(404);
    expect(await statusOf(id)).toBe('in_review');
  });

  it('existing safe manual rules work exactly as before', async () => {
    const id = (await post('/proposals', 'manager', { rule: ruleBody({ title: 'Plain manual rule' }), submit: true }).expect(201)).body.data.id;
    await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 1 }).expect(200);
  });

  it('the importer holds "Never include" items that invert their meaning or block safety', async () => {
    const body = { source: { format: 'csv', content: toCsv([
      importRow('Inverted avoid', { must_avoid: 'Refusing to quote prices' }),
      importRow('Safety avoid', { must_avoid: 'Escalating to a manager' }),
      importRow('Plain avoid', { must_avoid: "Don't quote prices" }),
    ]) }, options: {} };
    const preview = (await post('/imports/preview', 'manager', body).expect(200)).body.data;
    expect(preview.rows.map((row: any) => row.status)).toEqual(['blocked_guardrail', 'blocked_safety_bypass', 'ready_with_warnings']);
  });
});
