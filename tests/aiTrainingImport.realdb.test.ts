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
import AiTrainingScenario from '../src/models/AiTrainingScenario.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import AiTrainingImportBatch from '../src/models/AiTrainingImportBatch.model';
import AiTrainingImportItem from '../src/models/AiTrainingImportItem.model';
import AiTrainingImportContent, { ImportContentImmutableError } from '../src/models/AiTrainingImportContent.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import { getRelevantAiCoaching } from '../src/services/aiAgentCoaching.service';
import { resetTrainingTransactionProbe } from '../src/services/aiTraining.service';
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
const locations: Record<string, mongoose.Types.ObjectId> = {
  orem: new mongoose.Types.ObjectId(),
  lehi: new mongoose.Types.ObjectId(),
  provo: new mongoose.Types.ObjectId(),
  other: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const MARKER = 'ZEBRAPRIVACYMARKER';
const BASE = '/api/crm/ai-training';
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(`${BASE}${path}`).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(`${BASE}${path}`).set(auth(who)).send(body);
let transactional = false;

type Row = Record<string, string>;
const escapeCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const toCsv = (rows: Row[]) => [IMPORT_COLUMNS.map((c) => c.column).join(','), ...rows.map((row) => IMPORT_COLUMNS.map((c) => escapeCell(row[c.column] || '')).join(','))].join('\r\n');
const csvBody = (rows: Row[], options: Record<string, unknown> = {}) => ({ source: { format: 'csv', fileName: 'podium-export.csv', content: toCsv(rows) }, options });
const ALL_SCOPE = { sourceLabel: '', locationId: null };
const ORG_WIDE = (extra: Record<string, unknown> = {}) => ({ locationMappings: [ALL_SCOPE], ...extra });
const LEHI_MAPPING = () => ({ locationMappings: [ALL_SCOPE, { sourceLabel: 'Lehi Store', locationId: String(locations.lehi) }] });

async function previewOf(who: string, body: any) {
  const res = await post('/imports/preview', who, body);
  if (res.status !== 200) throw new Error(`preview ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function commitOf(who: string, body: any) {
  const preview = await previewOf(who, body);
  return post('/imports', who, { ...body, previewHash: preview.previewHash, attestation: true });
}

const RULE: Row = {
  type: 'rule', title: 'Price questions', location: 'Orem', channels: 'sms|webchat',
  trigger_or_question: 'asks what the price is|asks for the best price',
  answer_or_instruction: 'Never quote prices. Say a sales manager will confirm pricing and offer to set up a visit.',
  handling: 'ask_clarifying', required_questions: 'Which vehicle are you looking at?', must_avoid: 'Quoting a price or payment',
  example_customer: "What's your best price on the Camry?", example_reply: 'Happy to help! Which vehicle are you looking at, and when could you come by?',
  source_ref: 'Podium AI > Pricing', source_status: 'on', notes: 'Fictional example',
};
const FAQ: Row = { type: 'faq', title: 'Saturday hours', trigger_or_question: 'Are you open on Saturday?', answer_or_instruction: 'Yes. Sales is open Saturday from 9 to 6.', topic: 'hours', source_ref: 'Podium FAQ 12', source_status: 'off' };
const TEMPLATE: Row = { type: 'template', title: 'Appointment reminder', location: 'Orem UT', answer_or_instruction: 'Just a reminder about your visit tomorrow. Reply here if anything changes.', source_ref: 'Podium template 3' };
const AUTOMATION: Row = { type: 'automation', title: 'New lead auto-reply', trigger_or_question: 'New website lead', answer_or_instruction: 'Send a welcome text within one minute.', source_ref: 'Podium automation 7' };
const PRIVATE: Row = {
  type: 'rule', title: 'Callback request', location: 'Orem', trigger_or_question: 'asks for a call back',
  answer_or_instruction: `Call ${MARKER} back at 801-726-4419 right away.`, handling: 'escalate', escalation_when: 'Always', handoff_reason: 'Callback', source_ref: `Podium ${MARKER}`,
  notes: `${MARKER} note`,
};
const PRICED: Row = { type: 'rule', title: 'Truck price', location: 'Orem', trigger_or_question: 'asks about the truck', answer_or_instruction: 'Tell them the price is $25,999 this week.', handling: 'ai_handles', source_ref: 'Podium AI > Truck' };
const ESCALATION: Row = {
  type: 'escalation', title: 'Upset customer', location: 'Lehi Store', trigger_or_question: 'is upset about service',
  answer_or_instruction: 'Apologize briefly and let them know a manager will reach out.', handling: 'escalate',
  escalation_when: 'The customer is upset or angry', handoff_reason: 'Upset customer needs a manager', source_ref: 'Podium AI > Upset',
};
const UNSUPPORTED: Row = { type: 'review_request', title: 'Ask for a review', answer_or_instruction: 'Send the review link after a sale.', source_ref: 'Podium reviews' };
const NAMED: Row = { type: 'example', title: 'Greeting example', location: 'Orem', example_customer: 'Is the Camry still there?', example_reply: 'Hi Zebulon, thanks for asking! Let me check with the team.', source_ref: 'Podium example 1' };
const ALL_ROWS = [RULE, FAQ, TEMPLATE, AUTOMATION, PRIVATE, PRICED, ESCALATION, UNSUPPORTED, NAMED];

async function dbFingerprint() {
  const db = mongoose.connection.db!;
  const hash = await db.command({ dbHash: 1 });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: any) => c.name).sort();
  return { md5: hash.md5, collections: hash.collections, names };
}

async function scanForMarker(marker: string): Promise<string[]> {
  const db = mongoose.connection.db!;
  const hits: string[] = [];
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray() as any[]) {
    if (name.startsWith('system.')) continue;
    const cursor = db.collection(name).find({});
    for await (const doc of cursor) {
      if (JSON.stringify(doc).includes(marker)) {
        hits.push(name);
        break;
      }
    }
  }
  return hits;
}

const statusOf = (preview: any, title: string) => preview.rows.find((row: any) => row.title === title || row.snippet.includes(title))?.status;

describe('Real-DB proof: P1b Podium import backend (local MongoDB only)', () => {
  const env = { ...process.env };
  let orgSnapshot = '';
  let coachingSnapshot = '';
  let locationSnapshot = '';
  let firstBatchId = '';
  let rulePolicyId = '';

  beforeAll(async () => {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    transactional = Boolean(hello.setName);
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation, AiUsageCounter] as any[]) await model.init();
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Import Org A', slug: `import-a-${orgA}`, status: 'active', metadata: { aiTrainingEnabled: true, aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: orgB, name: 'Import Org B', slug: `import-b-${orgB}`, status: 'active', metadata: { aiTrainingEnabled: true } },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `imp-${id}`, email: `imp-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, orgA, 'employee', 'Rep One'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.manager2, orgA, 'manager', 'Manager Two'),
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const actor = { userId: String(users.admin), name: 'Admin One', role: 'admin' };
    const location = (id: any, org: string, code: string, name: string, aliasKeys: string[], status = 'active') => ({
      _id: id, organizationId: org, code, name, aliases: [], aliasKeys, status, revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    });
    await CrmLocation.collection.insertMany([
      location(locations.orem, A, 'orem', 'Orem', ['orem', 'orem ut']),
      location(locations.lehi, A, 'lehi', 'Lehi', ['lehi']),
      location(locations.provo, A, 'provo', 'Provo', ['provo'], 'archived'),
      location(locations.other, B, 'b-store', 'B Store', ['b store']),
    ] as any[]);
    await AiAgentCoachingRule.collection.insertOne({
      organizationId: A, scope: 'organization', channel: 'all', instruction: 'Keep replies short and friendly.', status: 'active',
      sourceLeadId: new mongoose.Types.ObjectId(), sourceMessageId: new mongoose.Types.ObjectId(), sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: 'Hello', usageCount: 0, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    orgSnapshot = JSON.stringify(await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray());
    coachingSnapshot = JSON.stringify(await AiAgentCoachingRule.collection.find({ organizationId: { $in: [A, B] } }).toArray());
    locationSnapshot = JSON.stringify(await CrmLocation.collection.find({ organizationId: { $in: [A, B] } }).sort({ _id: 1 }).toArray());
  });

  afterAll(async () => {
    const both = [orgA, orgB, A, B];
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent, CrmLocation, CrmUser, AiAgentCoachingRule, AiUsageCounter] as any[]) {
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

  it('import stays off until both the import flag and AI training are on', async () => {
    delete process.env.AI_TRAINING_IMPORT_ENABLED;
    expect((await post('/imports/preview', 'manager', csvBody([FAQ])).expect(409)).body.message).toBe('Podium import is turned off on this server');
    await get('/imports', 'manager').expect(409);
    process.env.AI_TRAINING_IMPORT_ENABLED = 'true';
    delete process.env.AI_TRAINING_ENABLED;
    expect((await post('/imports/preview', 'manager', csvBody([FAQ])).expect(409)).body.message).toContain('AI training is turned off');
    process.env.AI_TRAINING_ENABLED = 'true';
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiTrainingEnabled': false } });
    await post('/imports/preview', 'manager', csvBody([FAQ])).expect(409);
    await Organization.collection.updateOne({ _id: orgA }, { $set: { 'metadata.aiTrainingEnabled': true } });
    await post('/imports/preview', 'manager', csvBody([FAQ])).expect(200);
  });

  it('only managers and admins can use import', async () => {
    await get('/imports/template?format=csv', 'rep').expect(403);
    await post('/imports/preview', 'rep', csvBody([FAQ])).expect(403);
    await post('/imports', 'rep', { ...csvBody([FAQ]), previewHash: 'a'.repeat(64), attestation: true }).expect(403);
    await get('/imports', 'rep').expect(403);
    await get(`/imports/${new mongoose.Types.ObjectId()}`, 'rep').expect(403);
    await post(`/imports/${new mongoose.Types.ObjectId()}/purge-content`, 'rep', { confirmation: 'x' }).expect(403);
    const template = (await get('/imports/template?format=json', 'manager').expect(200)).body.data;
    expect(template.fileName).toBe('podium-import-template.json');
    await get('/imports/template?format=xml', 'manager').expect(400);
  });

  it('preview saves nothing: database hash, collections, audit and usage records are unchanged', async () => {
    const before = await dbFingerprint();
    const auditBefore = await AiTrainingAuditLog.countDocuments({});
    const usageBefore = await AiUsageCounter.countDocuments({});
    const preview = await previewOf('manager', csvBody(ALL_ROWS));
    await previewOf('manager', { source: { format: 'json', content: JSON.stringify({ version: 'suprah-import-v1', items: [FAQ, RULE] }) } });
    await previewOf('manager', { source: { format: 'paste', content: 'Q: Do you deliver?\nA: Ask the team about delivery options.\nTopic: delivery_shipping' } });
    await previewOf('admin', { source: { format: 'manual', items: [ESCALATION] }, options: LEHI_MAPPING() });
    await post('/imports/preview', 'manager', { source: { format: 'csv', content: 'title\nno type column' } }).expect(400);
    const after = await dbFingerprint();
    expect(after.names).toEqual(before.names);
    expect(after.collections).toEqual(before.collections);
    expect(after.md5).toBe(before.md5);
    expect(await AiTrainingAuditLog.countDocuments({})).toBe(auditBefore);
    expect(await AiUsageCounter.countDocuments({})).toBe(usageBefore);
    expect(mockOpenAiConstructed).not.toHaveBeenCalled();

    expect(preview.canCommit).toBe(false);
    expect(preview.unmappedLabels).toEqual(['', 'Lehi Store']);
    const statuses = Object.fromEntries(preview.rows.map((row: any) => [row.rowNumber, row.status]));
    expect(statuses).toEqual({
      1: 'ready_with_warnings', 2: 'needs_location', 3: 'reference_only', 4: 'needs_location', 5: 'blocked_privacy',
      6: 'blocked_guardrail', 7: 'needs_location', 8: 'needs_location', 9: 'blocked_privacy',
    });
    const mappedPreview = await previewOf('manager', csvBody(ALL_ROWS, LEHI_MAPPING()));
    expect(Object.fromEntries(mappedPreview.rows.map((row: any) => [row.rowNumber, row.status]))).toMatchObject({ 2: 'parked_knowledge', 4: 'reference_only', 7: 'ready', 8: 'unsupported' });
    expect(mappedPreview.rows[1]).toMatchObject({ sourceStatus: 'off', location: { scope: 'all', via: 'mapping' } });
    expect(mappedPreview.rows[1].issues.map((i: any) => i.code)).toContain('source_turned_off');
    const privateRow = preview.rows[4];
    expect(privateRow.title).toBeUndefined();
    expect(privateRow.snippet).not.toContain('4419');
    expect(privateRow.mapped).toBeUndefined();
    expect(preview.rows[0].issues.map((i: any) => i.code)).toContain('guardrail_negative_instruction');
    expect(preview.rows[0].mapped.spec).toMatchObject({ format: 'structured_v1', handling: 'ask_clarifying', triggers: ['asks what the price is', 'asks for the best price'] });
    expect(preview.rows[2].location).toMatchObject({ scope: 'location', via: 'alias', locationCode: 'orem' });
    expect(preview.rows[8].needsNameReview).toBe(true);
  });

  it('commit refuses without the attestation, without a preview, with unmapped labels, or after anything changed', async () => {
    const body = csvBody(ALL_ROWS);
    const preview = await previewOf('manager', body);
    await post('/imports', 'manager', { ...body, previewHash: preview.previewHash }).expect(400);
    await post('/imports', 'manager', { ...body, attestation: true }).expect(400);
    const unmapped = await post('/imports', 'manager', { ...body, previewHash: preview.previewHash, attestation: true }).expect(409);
    expect(unmapped.body.errors[0].code).toBe('needs_location');
    const mapped = csvBody(ALL_ROWS, LEHI_MAPPING());
    const mappedPreview = await previewOf('manager', mapped);
    expect(mappedPreview.canCommit).toBe(true);
    const changed = csvBody([...ALL_ROWS.slice(0, -1), { ...NAMED, title: 'Edited after preview' }], LEHI_MAPPING());
    const stale = await post('/imports', 'manager', { ...changed, previewHash: mappedPreview.previewHash, attestation: true }).expect(409);
    expect(stale.body.errors[0].code).toBe('preview_stale');
    const otherOrg = await post('/imports/preview', 'manager', csvBody([ESCALATION], { locationMappings: [{ sourceLabel: 'Lehi Store', locationId: String(locations.other) }] })).expect(400);
    expect(otherOrg.body.errors[0].code).toBe('location_not_found');
    const archived = await post('/imports/preview', 'manager', csvBody([ESCALATION], { locationMappings: [{ sourceLabel: 'Lehi Store', locationId: String(locations.provo) }] })).expect(400);
    expect(archived.body.errors[0].code).toBe('location_archived');
    expect(await AiTrainingImportBatch.countDocuments({ organizationId: A })).toBe(0);
  });

  it('rows with no Podium location are never treated as all locations without an explicit confirmation', async () => {
    const onlyLehi = csvBody([FAQ, ESCALATION], { locationMappings: [{ sourceLabel: 'Lehi Store', locationId: String(locations.lehi) }] });
    const preview = await previewOf('manager', onlyLehi);
    expect(preview.rows[0]).toMatchObject({ status: 'needs_location', location: { scope: 'none', via: 'unmapped' } });
    expect(preview.unmappedLabels).toEqual(['']);
    const blocked = await post('/imports', 'manager', { ...onlyLehi, previewHash: preview.previewHash, attestation: true }).expect(409);
    expect(blocked.body.errors[0].code).toBe('needs_location');
    const toOrem = await previewOf('manager', csvBody([FAQ], { locationMappings: [{ sourceLabel: '', locationId: String(locations.orem) }] }));
    expect(toOrem.rows[0]).toMatchObject({ status: 'parked_knowledge', location: { scope: 'location', locationCode: 'orem', via: 'mapping' } });
    const orgWide = await previewOf('manager', csvBody([FAQ], ORG_WIDE()));
    expect(orgWide.rows[0]).toMatchObject({ status: 'parked_knowledge', location: { scope: 'all', via: 'mapping' } });
    expect(await AiTrainingImportBatch.countDocuments({ organizationId: A })).toBe(0);
  });

  it('a location change after preview requires a new preview', async () => {
    const body = csvBody([ESCALATION], LEHI_MAPPING());
    const preview = await previewOf('manager', body);
    await CrmLocation.collection.updateOne({ _id: locations.lehi }, { $set: { revision: 2 } });
    const res = await post('/imports', 'manager', { ...body, previewHash: preview.previewHash, attestation: true }).expect(409);
    expect(res.body.errors[0].code).toBe('preview_stale');
    await CrmLocation.collection.updateOne({ _id: locations.lehi }, { $set: { revision: 1 } });
  });

  it('commit saves inactive drafts, parked knowledge and references with the right retention, and stores nothing personal', async () => {
    const res = await commitOf('manager', csvBody(ALL_ROWS, LEHI_MAPPING()));
    expect(res.status).toBe(201);
    const detail = res.body.data;
    firstBatchId = detail.batch.id;
    expect(detail.batch).toMatchObject({ batchNumber: 1, rowCount: 9, proposalsCreated: 2, proposalsUpdated: 0, format: 'csv', fileName: 'podium-export.csv', storedOriginals: 7 });
    expect(detail.batch.attestation).toMatchObject({ version: 'v1', byName: 'Manager One' });

    const policies: any[] = await AiTrainingPolicy.find({ organizationId: A, source: 'podium_import' }).lean();
    expect(policies.map((p) => p.title).sort()).toEqual(['Price questions', 'Upset customer']);
    for (const policy of policies) {
      expect(policy).toMatchObject({ status: 'draft', ruleFormat: 'structured_v1', currentVersion: 1, createdBy: { name: 'Manager One', role: 'manager' } });
      expect(policy.submittedVersion).toBeUndefined();
      expect(policy.approvedBy).toBeUndefined();
      expect(String(policy.sourceRef.importBatchId)).toBe(firstBatchId);
      expect(policy.sourceRef.sourceSystem).toBe('podium');
      expect(policy.pendingAudit || []).toEqual([]);
    }
    rulePolicyId = String(policies.find((p) => p.title === 'Price questions')._id);
    const version: any = await AiTrainingPolicyVersion.findOne({ policyId: rulePolicyId }).lean();
    expect(version.spec).toMatchObject({ format: 'structured_v1', category: 'scenario_response', handling: 'ask_clarifying', mustAvoid: ['Quoting a price or payment'] });
    expect(version.changeNote).toBe('Imported from Podium, batch #1');
    expect(await AiTrainingAuditLog.countDocuments({ organizationId: A, action: 'import_committed', importBatchId: firstBatchId })).toBe(1);
    expect(await AiTrainingAuditLog.countDocuments({ organizationId: A, action: 'proposal_drafted', policyId: { $in: policies.map((p) => p._id) } })).toBe(2);

    const items: any[] = await AiTrainingImportItem.find({ batchId: firstBatchId }).sort({ rowNumber: 1 }).lean();
    expect(items).toHaveLength(9);
    const privateItem = items[4];
    expect(privateItem).toMatchObject({ status: 'blocked_privacy', contentRetained: false, locationScope: { kind: 'none' }, target: { kind: 'none' } });
    expect(privateItem.title).toBeUndefined();
    expect(privateItem.sourceRef).toBeUndefined();
    expect(privateItem.sourceKey).toBeUndefined();
    expect(privateItem.issueCodes).toContain('real_phone');
    expect(items[8]).toMatchObject({ status: 'blocked_privacy', contentRetained: false });
    expect(items[0]).toMatchObject({ status: 'ready_with_warnings', keyRevision: 1, target: { kind: 'proposal_created', version: 1 }, retentionClass: 'converted', locationScope: { kind: 'location', locationCode: 'orem' } });
    expect(items[6]).toMatchObject({ status: 'ready', target: { kind: 'proposal_created' }, locationScope: { kind: 'location', locationCode: 'lehi' } });
    expect(items[1]).toMatchObject({ status: 'parked_knowledge', target: { kind: 'parked_knowledge' }, retentionClass: 'parked', locationScope: { kind: 'all' }, sourceStatus: 'off' });
    expect(items[5]).toMatchObject({ status: 'blocked_guardrail', retentionClass: 'rejected', title: 'Truck price' });
    expect(items[5].keyRevision).toBeUndefined();

    const contents: any[] = await AiTrainingImportContent.find({ batchId: firstBatchId }).lean();
    expect(contents).toHaveLength(7);
    const days = (content: any) => Math.round((new Date(content.expiresAt).getTime() - new Date(content.createdAt).getTime()) / 86400000);
    const byItem = new Map(contents.map((c) => [String(c.itemId), c]));
    expect(days(byItem.get(String(items[0]._id)))).toBe(180);
    expect(days(byItem.get(String(items[1]._id)))).toBe(365);
    expect(days(byItem.get(String(items[2]._id)))).toBe(365);
    expect(days(byItem.get(String(items[7]._id)))).toBe(365);
    expect(days(byItem.get(String(items[5]._id)))).toBe(30);
    expect(byItem.get(String(items[1]._id)).mappedPayload).toMatchObject({
      target: 'knowledge_entry', kind: 'faq', topic: 'hours', content: { question: 'Are you open on Saturday?' },
      source: { system: 'podium', ref: 'Podium FAQ 12', status: 'off', question: 'Are you open on Saturday?', answer: 'Yes. Sales is open Saturday from 9 to 6.' },
    });
    expect(byItem.get(String(items[1]._id)).fields).toMatchObject({ sourceStatus: 'off', triggerOrQuestion: 'Are you open on Saturday?' });
    expect(byItem.get(String(items[0]._id)).mappedPayload).toMatchObject({ target: 'training_proposal', source: { status: 'on', location: 'Orem', ref: 'Podium AI > Pricing' } });
    expect(items[0].sourceStatus).toBe('on');
    expect(items[1].sourceStatus).toBe('off');
    expect(policies.every((policy) => policy.status === 'draft')).toBe(true);
    expect(byItem.get(String(items[2]._id)).mappedPayload).toMatchObject({ target: 'reference', kind: 'canned_reply_candidate' });
    expect(byItem.get(String(items[5]._id)).mappedPayload).toBeUndefined();
    expect(byItem.has(String(items[4]._id))).toBe(false);

    expect(await scanForMarker(MARKER)).toEqual([]);
    expect(await scanForMarker('7264419')).toEqual([]);
    expect(await scanForMarker('Zebulon')).toEqual([]);
    expect(JSON.stringify(await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray())).toBe(orgSnapshot);
    expect(JSON.stringify(await AiAgentCoachingRule.collection.find({ organizationId: { $in: [A, B] } }).toArray())).toBe(coachingSnapshot);
    expect(JSON.stringify(await CrmLocation.collection.find({ organizationId: { $in: [A, B] } }).sort({ _id: 1 }).toArray())).toBe(locationSnapshot);
    expect(await AiTrainingScenario.countDocuments({ organizationId: A })).toBe(0);
    expect(mockOpenAiConstructed).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('history, item detail and the proposal source filter show traceable origins', async () => {
    const list = (await get('/imports', 'manager').expect(200)).body.data;
    expect(list.batches.map((b: any) => b.batchNumber)).toEqual([1]);
    expect(list.batches[0].canPurge).toBe(false);
    expect((await get('/imports', 'admin').expect(200)).body.data.batches[0].canPurge).toBe(true);
    const parked = (await get(`/imports/${firstBatchId}?status=parked_knowledge`, 'manager').expect(200)).body.data;
    expect(parked.items.map((i: any) => i.title)).toEqual(['Saturday hours']);
    await get(`/imports/${firstBatchId}?status=bogus`, 'manager').expect(400);
    const all = (await get(`/imports/${firstBatchId}`, 'manager').expect(200)).body.data.items;
    const ruleItem = all.find((i: any) => i.title === 'Price questions');
    const ruleDetail = (await get(`/imports/${firstBatchId}/items/${ruleItem.id}`, 'manager').expect(200)).body.data;
    expect(ruleDetail.item.contentStatus).toBe('stored');
    expect(ruleDetail.original.fields).toMatchObject({ itemType: 'rule', notes: 'Fictional example', sourceRef: 'Podium AI > Pricing' });
    expect(ruleDetail.linkedProposal).toMatchObject({ id: rulePolicyId, status: 'draft' });
    const privateDetail = (await get(`/imports/${firstBatchId}/items/${all[4].id}`, 'manager').expect(200)).body.data;
    expect(privateDetail.item.contentStatus).toBe('not_stored');
    expect(privateDetail.original).toBeUndefined();
    const proposals = (await get('/proposals?source=podium_import', 'manager').expect(200)).body.data.proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals[0].importOrigin).toMatchObject({ sourceSystem: 'podium', batchId: firstBatchId });
    await get('/proposals?source=nope', 'manager').expect(400);
  });

  it('name warnings block until reviewed against the exact previewed content', async () => {
    const body = csvBody([NAMED]);
    const preview = await previewOf('manager', body);
    expect(preview.rows[0]).toMatchObject({ status: 'blocked_privacy', needsNameReview: true });
    const wrongAck = await previewOf('manager', csvBody([NAMED], { nameAcknowledgements: [{ rowNumber: 1, fingerprint: 'f'.repeat(64) }] }));
    expect(wrongAck.rows[0].status).toBe('blocked_privacy');
    const reviewed = csvBody([NAMED], { nameAcknowledgements: [{ rowNumber: 1, fingerprint: preview.rows[0].fingerprint }] });
    const res = await commitOf('manager', reviewed);
    expect(res.status).toBe(201);
    const item: any = await AiTrainingImportItem.findOne({ batchId: res.body.data.batch.id }).lean();
    expect(item).toMatchObject({ status: 'reference_only', contentRetained: true, nameReview: { by: { name: 'Manager One' } } });
  });

  it('re-importing the same file creates nothing new', async () => {
    const policiesBefore = await AiTrainingPolicy.countDocuments({ organizationId: A });
    const res = await commitOf('admin', csvBody(ALL_ROWS, LEHI_MAPPING()));
    expect(res.status).toBe(201);
    const batch = res.body.data.batch;
    expect(batch).toMatchObject({ proposalsCreated: 0, proposalsUpdated: 0 });
    expect(batch.statusCounts.unchanged).toBe(6);
    expect(batch.statusCounts.blocked_privacy).toBe(2);
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A })).toBe(policiesBefore);
    const items: any[] = await AiTrainingImportItem.find({ batchId: batch.id, status: 'unchanged' }).lean();
    expect(items.every((item) => item.keyRevision === undefined && item.contentRetained === false && item.target.previousItemId)).toBe(true);
    expect(await AiTrainingImportContent.countDocuments({ batchId: batch.id })).toBe(1);
  });

  it('a changed row adds a version to its draft; once the draft is in review, a linked new draft is created instead', async () => {
    const changed = { ...RULE, answer_or_instruction: 'Never quote prices or payments. Say a sales manager will confirm pricing.' };
    const first = await commitOf('manager', csvBody([changed]));
    expect(first.status).toBe(201);
    let policy: any = await AiTrainingPolicy.findById(rulePolicyId).lean();
    expect(policy).toMatchObject({ status: 'draft', currentVersion: 2 });
    const v2: any = await AiTrainingPolicyVersion.findOne({ policyId: rulePolicyId, version: 2 }).lean();
    expect(v2.changeNote).toMatch(/^Updated from Podium import, batch #\d+$/);
    expect(v2.spec.instruction).toBe(changed.answer_or_instruction);
    const item: any = await AiTrainingImportItem.findOne({ batchId: first.body.data.batch.id }).lean();
    expect(item).toMatchObject({ status: 'changed', keyRevision: 2, target: { kind: 'proposal_version', version: 2 } });
    expect(String(policy.sourceRef.importItemId)).toBe(String(item._id));

    await post(`/proposals/${rulePolicyId}/submit`, 'manager', { expectedVersion: 2 }).expect(200);
    const again = { ...changed, answer_or_instruction: 'Never quote prices. A sales manager will confirm pricing in person.' };
    const preview = await previewOf('manager', csvBody([again]));
    expect(preview.rows[0]).toMatchObject({ status: 'changed', target: { kind: 'proposal_linked', previousPolicyId: rulePolicyId, policyStatus: 'in_review' } });
    expect(preview.rows[0].issues.map((i: any) => i.code)).toContain('previous_not_editable');
    const second = await commitOf('manager', csvBody([again]));
    expect(second.status).toBe(201);
    policy = await AiTrainingPolicy.findById(rulePolicyId).lean();
    expect(policy).toMatchObject({ status: 'in_review', currentVersion: 2 });
    const linked: any = await AiTrainingPolicy.findOne({ organizationId: A, 'sourceRef.previousPolicyId': rulePolicyId }).lean();
    expect(linked).toMatchObject({ status: 'draft', title: 'Price questions', currentVersion: 1 });
  });

  it('a full snapshot lists items missing from the latest file and deletes nothing', async () => {
    const itemsBefore = await AiTrainingImportItem.countDocuments({ organizationId: A });
    const policiesBefore = await AiTrainingPolicy.countDocuments({ organizationId: A });
    const preview = await previewOf('manager', csvBody([FAQ], ORG_WIDE({ fullSnapshot: true })));
    expect(preview.missingFromSnapshot.map((m: any) => m.title).sort()).toEqual(['Ask for a review', 'New lead auto-reply']);
    const res = await commitOf('manager', csvBody([FAQ], ORG_WIDE({ fullSnapshot: true })));
    expect(res.body.data.batch.missingFromSnapshotCount).toBe(2);
    expect(res.body.data.missingFromSnapshot).toHaveLength(2);
    expect(await AiTrainingImportItem.countDocuments({ organizationId: A })).toBe(itemsBefore + 1);
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A })).toBe(policiesBefore);
  });

  it('other organizations are fully isolated', async () => {
    const otherPreview = await previewOf('otherAdmin', csvBody([FAQ], ORG_WIDE()));
    expect(otherPreview.rows[0].status).toBe('parked_knowledge');
    await get(`/imports/${firstBatchId}`, 'otherAdmin').expect(404);
    const anyItem: any = await AiTrainingImportItem.findOne({ batchId: firstBatchId }).lean();
    await get(`/imports/${firstBatchId}/items/${anyItem._id}`, 'otherAdmin').expect(404);
    await post(`/imports/${firstBatchId}/purge-content`, 'otherAdmin', { confirmation: 'PURGE BATCH 1' }).expect(404);
    expect((await get('/imports', 'otherAdmin').expect(200)).body.data.batches).toEqual([]);
    await get('/imports/not-an-id', 'manager').expect(404);
  });

  it('two simultaneous commits of the same preview save exactly one import', async () => {
    const row = { ...RULE, title: 'Concurrent rule', source_ref: 'Podium AI > Concurrent', trigger_or_question: 'asks about the concurrent offer' };
    const body = csvBody([row]);
    const preview = await previewOf('manager', body);
    const results = await Promise.all([1, 2].map(() => post('/imports', 'manager', { ...body, previewHash: preview.previewHash, attestation: true })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(['preview_stale', 'import_race']).toContain(results.find((r) => r.status === 409)!.body.errors[0].code);
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A, title: 'Concurrent rule' })).toBe(1);
    const claimed: any[] = await AiTrainingImportItem.find({ organizationId: A, title: 'Concurrent rule', keyRevision: { $exists: true } }).lean();
    const committed = await AiTrainingImportBatch.find({ _id: { $in: claimed.map((i) => i.batchId) } }).countDocuments();
    expect(committed).toBe(1);
  });

  it('a failed commit leaves no visible import behind, and the next attempt works', async () => {
    const row = { ...RULE, title: 'Rollback rule', source_ref: 'Podium AI > Rollback', trigger_or_question: 'asks about rollback' };
    const body = csvBody([row, { ...FAQ, title: 'Rollback hours', source_ref: 'Podium FAQ rollback' }], ORG_WIDE());
    const batchesBefore = await AiTrainingImportBatch.countDocuments({ organizationId: A });
    const contentsBefore = await AiTrainingImportContent.countDocuments({ organizationId: A });
    const itemsBefore = await AiTrainingImportItem.countDocuments({ organizationId: A });
    for (const spy of [
      () => jest.spyOn(AiTrainingImportBatch, 'create').mockRejectedValueOnce(new Error('local batch failure') as never),
      () => jest.spyOn(AiTrainingImportContent, 'insertMany').mockRejectedValueOnce(new Error('local content failure') as never),
    ]) {
      const preview = await previewOf('manager', body);
      spy();
      await post('/imports', 'manager', { ...body, previewHash: preview.previewHash, attestation: true }).expect(500);
      jest.restoreAllMocks();
      expect(await AiTrainingImportBatch.countDocuments({ organizationId: A })).toBe(batchesBefore);
      expect(await AiTrainingImportContent.countDocuments({ organizationId: A })).toBe(contentsBefore);
      expect(await AiTrainingPolicy.countDocuments({ organizationId: A, title: 'Rollback rule' })).toBe(0);
      if (transactional) expect(await AiTrainingImportItem.countDocuments({ organizationId: A })).toBe(itemsBefore);
      expect((await get('/imports', 'manager').expect(200)).body.data.total).toBe(batchesBefore);
    }
    const retry = await commitOf('manager', body);
    expect(retry.status).toBe(201);
    expect(retry.body.data.batch.proposalsCreated).toBe(1);
    expect(await AiTrainingPolicy.countDocuments({ organizationId: A, title: 'Rollback rule' })).toBe(1);
  });

  it('production refuses import commits on a database without transactions and writes nothing', async () => {
    const row = { ...FAQ, title: 'Production hours', source_ref: 'Podium FAQ production' };
    const body = csvBody([row], ORG_WIDE());
    const preview = await previewOf('manager', body);
    const counts = async () => Promise.all([AiTrainingImportBatch, AiTrainingImportItem, AiTrainingImportContent].map((model: any) => model.countDocuments({ organizationId: A })));
    const before = await counts();
    process.env.NODE_ENV = 'production';
    const res = await post('/imports', 'manager', { ...body, previewHash: preview.previewHash, attestation: true });
    process.env.NODE_ENV = 'test';
    if (transactional) {
      expect(res.status).toBe(201);
    } else {
      expect(res.status).toBe(503);
      expect(res.body.message).toContain('need database transactions');
      expect(await counts()).toEqual(before);
    }
  });

  it('stored originals expire on schedule and only admins can purge them early', async () => {
    const indexes = await AiTrainingImportContent.collection.indexes();
    expect(indexes.find((index: any) => index.name === 'ai_import_content_ttl')).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    const content: any = await AiTrainingImportContent.findOne({ batchId: firstBatchId }).lean();
    await expect(AiTrainingImportContent.updateOne({ _id: content._id }, { $set: { 'fields.title': 'x' } })).rejects.toBeInstanceOf(ImportContentImmutableError);
    await expect(AiTrainingImportItem.updateOne({ batchId: firstBatchId }, { $set: { status: 'ready' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(AiTrainingImportBatch.deleteOne({ _id: firstBatchId })).rejects.toBeInstanceOf(AppendOnlyViolationError);

    await post(`/imports/${firstBatchId}/purge-content`, 'manager', { confirmation: 'PURGE BATCH 1' }).expect(403);
    await post(`/imports/${firstBatchId}/purge-content`, 'admin', { confirmation: 'purge' }).expect(400);
    const stored = await AiTrainingImportContent.countDocuments({ batchId: firstBatchId });
    const res = (await post(`/imports/${firstBatchId}/purge-content`, 'admin', { confirmation: 'PURGE BATCH 1' }).expect(200)).body.data;
    expect(res).toEqual({ purged: stored, batchNumber: 1 });
    expect(await AiTrainingImportContent.countDocuments({ batchId: firstBatchId })).toBe(0);
    expect(await AiTrainingImportItem.countDocuments({ batchId: firstBatchId })).toBe(9);
    expect(await AiTrainingImportBatch.countDocuments({ _id: firstBatchId })).toBe(1);
    const audit: any = await AiTrainingAuditLog.findOne({ organizationId: A, action: 'import_content_purged', importBatchId: firstBatchId }).lean();
    expect(audit).toMatchObject({ actor: { name: 'Admin One', role: 'admin' }, note: `Removed ${stored} stored originals from import batch #1` });
    const ruleItem: any = await AiTrainingImportItem.findOne({ batchId: firstBatchId, rowNumber: 1 }).lean();
    const detail = (await get(`/imports/${firstBatchId}/items/${ruleItem._id}`, 'admin').expect(200)).body.data;
    expect(detail.item.contentStatus).toBe('purged');
    expect(detail.original).toBeUndefined();
    expect(detail.linkedProposal.id).toBe(rulePolicyId);
    expect((await post(`/imports/${firstBatchId}/purge-content`, 'admin', { confirmation: 'PURGE BATCH 1' }).expect(200)).body.data.purged).toBe(0);
    expect(await AiTrainingAuditLog.countDocuments({ organizationId: A, action: 'import_content_purged', importBatchId: firstBatchId })).toBe(1);
  });

  it('imported proposals stay inactive even after approval', async () => {
    await post(`/proposals/${rulePolicyId}/approve`, 'manager', { expectedVersion: 2 }).expect(403);
    await post(`/proposals/${rulePolicyId}/approve`, 'manager2', { expectedVersion: 2 }).expect(200);
    expect((await AiTrainingPolicy.findById(rulePolicyId).lean() as any).status).toBe('approved');
    for (const channel of ['sms', 'webchat'] as const) {
      const coaching = await getRelevantAiCoaching({ organizationId: A, channel });
      expect(coaching.notes).toEqual(['Keep replies short and friendly.']);
    }
    expect(JSON.stringify(await AiAgentCoachingRule.collection.find({ organizationId: { $in: [A, B] } }).toArray())).toBe(coachingSnapshot);
    expect(JSON.stringify(await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray())).toBe(orgSnapshot);
    expect(mockOpenAiConstructed).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('JSON, pasted text and single manual items commit through the same pipeline', async () => {
    const json = await commitOf('manager', { source: { format: 'json', content: JSON.stringify({ version: 'suprah-import-v1', items: [{ type: 'tone', title: 'Warm tone', answer_or_instruction: 'Keep replies warm and short.', source_ref: 'Podium tone 1' }] }) }, options: ORG_WIDE() });
    expect(json.status).toBe(201);
    const paste = await commitOf('manager', { source: { format: 'paste', content: 'Topic: delivery_shipping\nRef: Podium FAQ 40\nQ: Do you deliver cars?\nA: Ask the team about delivery options for your area.' }, options: ORG_WIDE() });
    expect(paste.status).toBe(201);
    expect(paste.body.data.items[0]).toMatchObject({ status: 'parked_knowledge', type: 'faq', sourceRef: 'Podium FAQ 40' });
    const manual = await commitOf('admin', { source: { format: 'manual', items: [{ type: 'escalation', title: 'Legal question', trigger_or_question: 'asks a legal question', answer_or_instruction: 'Say a manager will follow up and hand off.', handling: 'escalate', escalation_when: 'Any legal question', handoff_reason: 'Legal question' }] }, options: ORG_WIDE() });
    expect(manual.status).toBe(201);
    expect(manual.body.data.batch.proposalsCreated).toBe(1);
  });
});
