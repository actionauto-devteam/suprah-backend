import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLocation from '../src/models/CrmLocation.model';
import AiKnowledgeEntry from '../src/models/AiKnowledgeEntry.model';
import AiKnowledgeEntryVersion from '../src/models/AiKnowledgeEntryVersion.model';
import AiKnowledgeAuditLog from '../src/models/AiKnowledgeAuditLog.model';
import AiKnowledgeKeyLock from '../src/models/AiKnowledgeKeyLock.model';
import AiTrainingImportBatch from '../src/models/AiTrainingImportBatch.model';
import AiTrainingImportItem from '../src/models/AiTrainingImportItem.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { buildImportSourceLink, createKnowledgeEntry, isRuntimeEligible } from '../src/services/aiKnowledgeBase.service';
import aiKnowledgeBaseRoute from '../src/routes/aiKnowledgeBase.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/knowledge-base', aiKnowledgeBaseRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const BASE = '/api/crm/knowledge-base';
const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const users: Record<string, { id: mongoose.Types.ObjectId; org: mongoose.Types.ObjectId; role: string }> = {
  rep: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'employee' },
  rep2: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'employee' },
  manager: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'manager' },
  manager2: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'manager' },
  admin: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'admin' },
  otherManager: { id: new mongoose.Types.ObjectId(), org: otherOrgId, role: 'manager' },
};
const tokens: Record<string, string> = {};
const loc: Record<string, mongoose.Types.ObjectId> = {
  orem: new mongoose.Types.ObjectId(),
  lehi: new mongoose.Types.ObjectId(),
  temp: new mongoose.Types.ObjectId(),
  oldStore: new mongoose.Types.ObjectId(),
  provo: new mongoose.Types.ObjectId(),
};
const batchId = new mongoose.Types.ObjectId();
const otherBatchId = new mongoose.Types.ObjectId();
const items: Record<string, mongoose.Types.ObjectId> = {};

type Method = 'get' | 'post' | 'put';
function call(method: Method, path: string, who: string, body?: unknown) {
  const url = `${BASE}${path}`;
  const req = method === 'get' ? request(app).get(url) : method === 'post' ? request(app).post(url) : request(app).put(url);
  req.set({ Authorization: `Bearer ${tokens[who]}` });
  return body === undefined ? req : req.send(body as object);
}
const create = (who: string, body: unknown) => call('post', '/entries', who, body);
const put = (who: string, id: string, body: unknown) => call('put', `/entries/${id}`, who, body);
const act = (who: string, id: string, action: string, body: Record<string, unknown> = {}) => call('post', `/entries/${id}/${action}`, who, body);
const detail = async (who: string, id: string) => (await call('get', `/entries/${id}`, who)).body.data;
const stored = (id: string) => AiKnowledgeEntry.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
const codes = (res: any) => (res.body.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
let counter = 0;
const q = (base: string) => `${base} number ${++counter}?`;
const faq = (overrides: Record<string, unknown> = {}) => ({
  kind: 'faq', topic: 'hours', question: q('What are your Saturday hours'), answer: 'We are open Saturday from 9am to 5pm.', locations: { scope: 'all' }, ...overrides,
});

async function newEntry(who: string, body: Record<string, unknown> = faq()): Promise<string> {
  const res = await create(who, body);
  expect(res.status).toBe(201);
  return res.body.data.entry.id;
}

async function approved(author: string, approver: string, body: Record<string, unknown> = faq()): Promise<string> {
  const id = await newEntry(author, body);
  await act(author, id, 'submit', { expectedVersion: 1 }).expect(200);
  await act(approver, id, 'approve', { expectedVersion: 1 }).expect(200);
  return id;
}

async function seedImport() {
  const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  await AiTrainingImportBatch.collection.insertMany([
    { _id: batchId, organizationId: ORG, batchNumber: 7, sourceSystem: 'podium', createdAt: new Date() },
    { _id: otherBatchId, organizationId: OTHER, batchNumber: 1, sourceSystem: 'podium', createdAt: new Date() },
  ] as any[]);
  const item = (key: string, organizationId: string, batch: mongoose.Types.ObjectId, fields: Record<string, unknown>) => {
    items[key] = new mongoose.Types.ObjectId();
    return {
      _id: items[key], organizationId, batchId: batch, batchNumber: 7, rowNumber: Object.keys(items).length, fingerprint: sha(`fp-${key}`),
      sourceKey: sha(`key-${key}`), keyRevision: 1, issueCodes: [], target: { kind: 'parked_knowledge' }, contentRetained: true, createdAt: new Date(), ...fields,
    };
  };
  await AiTrainingImportItem.collection.insertMany([
    item('faqOff', ORG, batchId, { type: 'faq', status: 'parked_knowledge', sourceRef: 'Podium > Saturday hours', sourceLocationLabel: 'Orem', sourceStatus: 'off', locationScope: { kind: 'location', locationId: loc.orem, locationCode: 'orem' } }),
    item('faqOn', ORG, batchId, { type: 'faq', status: 'parked_knowledge', sourceRef: 'Podium > Deposits', sourceStatus: 'on', locationScope: { kind: 'all' } }),
    item('info', ORG, batchId, { type: 'business_info', status: 'parked_knowledge', sourceRef: 'Podium > Address', sourceStatus: 'on', locationScope: { kind: 'all' } }),
    item('rule', ORG, batchId, { type: 'rule', status: 'ready', target: { kind: 'proposal_created' }, locationScope: { kind: 'all' } }),
    item('foreign', OTHER, otherBatchId, { type: 'faq', status: 'parked_knowledge', sourceStatus: 'on', locationScope: { kind: 'all' } }),
  ] as any[]);
}

describe('Real-DB proof: P2a Knowledge Base backend (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock] as any[]) await model.init();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Fictional KB Motors', slug: `kb-${orgId}`, status: 'active', metadata: { aiKnowledgeBaseEnabled: true } },
      { _id: otherOrgId, name: 'Fictional Other Motors', slug: `kb-${otherOrgId}`, status: 'active', metadata: { aiKnowledgeBaseEnabled: true } },
    ] as any[]);
    await CrmUser.collection.insertMany(Object.entries(users).map(([who, u]) => ({
      _id: u.id, organizationId: u.org, fullName: `Fictional ${who}`, username: `kb-${u.id}`, email: `kb-${u.id}@example.com`, role: u.role, isActive: true, password: 'x',
    })) as any[]);
    for (const [who, u] of Object.entries(users)) tokens[who] = generateCrmToken(String(u.id));
    const actor = { userId: String(users.admin.id), name: 'Fictional admin', role: 'admin' };
    const location = (id: mongoose.Types.ObjectId, organizationId: string, code: string, status = 'active') => ({
      _id: id, organizationId, code, name: code, aliases: [], aliasKeys: [code], status, revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    });
    await CrmLocation.collection.insertMany([
      location(loc.orem, ORG, `orem-${orgId}`), location(loc.lehi, ORG, `lehi-${orgId}`), location(loc.temp, ORG, `temp-${orgId}`),
      location(loc.oldStore, ORG, `old-${orgId}`, 'archived'), location(loc.provo, OTHER, `provo-${otherOrgId}`),
    ] as any[]);
    await seedImport();
  });

  afterAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiTrainingImportBatch, AiTrainingImportItem, CrmLocation] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: [ORG, OTHER] } });
    }
    await CrmUser.collection.deleteMany({ _id: { $in: Object.values(users).map((u) => u.id) } });
    await Organization.collection.deleteMany({ _id: { $in: [orgId, otherOrgId] } });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
  });

  describe('feature flag', () => {
    it('keeps every Knowledge Base API unavailable while the flag is off, except the status check', async () => {
      delete process.env.AI_KNOWLEDGE_BASE_ENABLED;
      process.env.AI_AGENT_ENABLED = 'true';
      process.env.AI_TRAINING_ENABLED = 'true';
      const status = await call('get', '/status', 'manager');
      expect(status.status).toBe(200);
      expect(status.body.data).toEqual({ serverEnabled: false, orgEnabled: true, enabled: false, canCreate: true, canReview: true, canManageSettings: false, affectsAlex: false });
      const id = String(new mongoose.Types.ObjectId());
      const attempts = [
        call('get', '/entries', 'manager'),
        create('manager', faq()),
        call('get', `/entries/${id}`, 'manager'),
        put('manager', id, faq({ expectedVersion: 1 })),
        call('get', `/entries/${id}/versions`, 'manager'),
        call('get', `/entries/${id}/versions/1`, 'manager'),
        call('get', `/entries/${id}/audit`, 'manager'),
        call('get', '/audit', 'manager'),
        ...['submit', 'request-changes', 'approve', 'reject', 'disable', 'enable', 'archive'].map((action) => act('manager', id, action, { expectedVersion: 1, note: 'x' })),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('The Knowledge Base is not available.');
      }
      expect(await AiKnowledgeEntry.countDocuments({ organizationId: ORG })).toBe(0);
      await call('get', '/status', 'rep').expect(200);
      expect((await call('get', '/status', 'rep')).body.data.canReview).toBe(false);
    });
  });

  describe('locations', () => {
    it('requires an explicit choice, only accepts active locations of the same organization, and stores nothing on refusal', async () => {
      expect(codes(await create('rep', faq({ locations: undefined })))).toEqual(['locations:location_required']);
      expect(codes(await create('rep', faq({ locations: { scope: 'all', locationIds: [String(loc.orem)] } })))).toEqual(['locations.locationIds:ambiguous_scope']);
      const refused = await create('rep', faq({ locations: { scope: 'locations', locationIds: [String(loc.orem), String(loc.oldStore), String(loc.provo), String(new mongoose.Types.ObjectId())] } }));
      expect(refused.status).toBe(400);
      expect(codes(refused)).toEqual([
        'locations.locationIds.1:location_archived', 'locations.locationIds.2:location_not_found', 'locations.locationIds.3:location_not_found',
      ]);
      expect(await AiKnowledgeEntry.countDocuments({ organizationId: ORG })).toBe(0);

      const ok = await create('rep', faq({ locations: { scope: 'locations', locationIds: [String(loc.orem), String(loc.lehi)] } }));
      expect(ok.status).toBe(201);
      expect(ok.body.data.entry.locationScope).toEqual({ scope: 'locations', locationIds: [String(loc.orem), String(loc.lehi)] });
      expect((await create('rep', faq())).body.data.entry.locationScope).toEqual({ scope: 'all', locationIds: [] });
    });

    it('a location archived after drafting blocks submission and approval instead of silently staying assigned', async () => {
      const id = await newEntry('rep', faq({ locations: { scope: 'locations', locationIds: [String(loc.temp)] } }));
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'archived' } });
      const submit = await act('rep', id, 'submit', { expectedVersion: 1 });
      expect(submit.status).toBe(400);
      expect(codes(submit)).toEqual(['locations.locationIds.0:location_archived']);
      expect((await detail('rep', id)).check.errors.map((issue: any) => issue.code)).toContain('location_archived');
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'active' } });
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'archived' } });
      const approve = await act('manager', id, 'approve', { expectedVersion: 1 });
      expect(approve.status).toBe(400);
      expect(codes(approve)).toEqual(['locations.locationIds.0:location_archived']);
      expect(await stored(id)).toMatchObject({ status: 'in_review' });
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'active' } });
    });
  });

  describe('safety', () => {
    it('refuses to store personal or contact details at all', async () => {
      const before = await AiKnowledgeEntryVersion.countDocuments({ organizationId: ORG });
      const res = await create('rep', faq({ answer: 'Call Jordan on his cell at 801-867-5309.' }));
      expect(res.status).toBe(400);
      expect(codes(res)).toEqual(['answer:real_phone']);
      expect(JSON.stringify(res.body)).not.toContain('867-5309');
      expect(await AiKnowledgeEntryVersion.countDocuments({ organizationId: ORG })).toBe(before);
    });

    it('saves an unsafe draft so it can be fixed, but blocks submission with field-specific errors that do not repeat the text', async () => {
      const answer = 'Leave a refundable deposit and we will hold the car. We pay top dollar for every trade.';
      const id = await newEntry('rep', faq({ answer }));
      const view = await detail('rep', id);
      expect(view.check.errors.map((issue: any) => `${issue.field}:${issue.code}`)).toEqual(['answer:knowledge_deposit_terms', 'answer:knowledge_trade_in_value']);
      const submit = await act('rep', id, 'submit', { expectedVersion: 1 });
      expect(submit.status).toBe(400);
      expect(codes(submit)).toEqual(['answer:knowledge_deposit_terms', 'answer:knowledge_trade_in_value']);
      expect(JSON.stringify(submit.body)).not.toContain('refundable deposit');
      expect(await stored(id)).toMatchObject({ status: 'draft' });
      await put('rep', id, faq({ question: view.entry.question, answer: 'Our team can go over deposits and trade-in values with you.', expectedVersion: 1 })).expect(200);
      await act('rep', id, 'submit', { expectedVersion: 2 }).expect(200);
    });

    it('revalidates the exact stored version at approval, even if it was written around the API', async () => {
      const id = await newEntry('rep');
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      const entry = await stored(id);
      await AiKnowledgeEntryVersion.collection.insertOne({
        organizationId: ORG, entryId: entry._id, version: 2, createdBy: entry.createdBy, createdAt: new Date(),
        content: { kind: 'faq', topic: 'hours', title: entry.title, question: entry.question, answer: 'A $500 deposit holds any vehicle.', channels: ['sms'], locationScope: { scope: 'all', locationIds: [] } },
      } as any);
      await AiKnowledgeEntry.collection.updateOne({ _id: entry._id }, { $set: { currentVersion: 2, submittedVersion: 2 } });
      const approve = await act('manager', id, 'approve', { expectedVersion: 2 });
      expect(approve.status).toBe(400);
      expect(codes(approve)).toEqual(expect.arrayContaining(['answer:guardrail_figure', 'answer:knowledge_deposit_terms']));
      expect(await stored(id)).toMatchObject({ status: 'in_review' });
      expect((await stored(id)).approvedVersion).toBeUndefined();
    });
  });

  describe('workflow and permissions', () => {
    it('a rep drafts and submits, only reviewers can review, and approval stays inactive for Alex', async () => {
      const id = await newEntry('rep');
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      expect((await act('rep', id, 'approve', { expectedVersion: 1 })).status).toBe(403);
      expect((await act('rep', id, 'request-changes', { expectedVersion: 1, note: 'x' })).status).toBe(403);
      expect((await act('rep', id, 'reject', { expectedVersion: 1, note: 'x' })).status).toBe(403);
      expect((await act('rep', id, 'disable')).status).toBe(403);
      const approve = await act('manager', id, 'approve', { expectedVersion: 1, note: 'Looks right' });
      expect(approve.status).toBe(200);
      expect(approve.body.data.entry).toMatchObject({ status: 'approved', lifecycle: 'active', approvedVersion: 1, approvedBy: { name: 'Fictional manager', role: 'manager' } });
      expect(await AiTrainingPolicy.countDocuments({ organizationId: ORG })).toBe(0);
      expect(await AiAgentCoachingRule.countDocuments({ organizationId: ORG })).toBe(0);
    });

    it('nobody can approve their own entry or a version they edited', async () => {
      const own = await newEntry('manager');
      await act('manager', own, 'submit', { expectedVersion: 1 }).expect(200);
      const self = await act('manager', own, 'approve', { expectedVersion: 1 });
      expect(self.status).toBe(403);
      expect(self.body.message).toMatch(/your own entry/);
      await act('manager2', own, 'approve', { expectedVersion: 1 }).expect(200);

      const id = await newEntry('rep');
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      const view = await detail('manager2', id);
      expect((await put('rep', id, faq({ question: view.entry.question, expectedVersion: 1 }))).status).toBe(409);
      const reviewEdit = await put('manager2', id, faq({ question: view.entry.question, answer: 'We are open Saturday from 9am to 6pm.', expectedVersion: 1 }));
      expect(reviewEdit.status).toBe(200);
      expect(reviewEdit.body.data.entry).toMatchObject({ status: 'in_review', currentVersion: 2, submittedVersion: 2 });
      const edited = await act('manager2', id, 'approve', { expectedVersion: 2 });
      expect(edited.status).toBe(403);
      expect(edited.body.message).toMatch(/You edited this entry/);
      expect((await act('manager', id, 'approve', { expectedVersion: 1 })).status).toBe(409);
      await act('manager', id, 'approve', { expectedVersion: 2 }).expect(200);
    });

    it('request changes and reject need a note, and the author can then revise and resubmit', async () => {
      const id = await newEntry('rep');
      const question = (await detail('rep', id)).entry.question;
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      expect((await act('manager', id, 'request-changes', { expectedVersion: 1 })).status).toBe(400);
      const changes = await act('manager', id, 'request-changes', { expectedVersion: 1, note: 'Mention Sunday too.' });
      expect(changes.body.data.entry).toMatchObject({ status: 'changes_requested', lastReview: { action: 'request_changes', note: 'Mention Sunday too.' } });
      const revised = await put('rep', id, faq({ question, answer: 'Saturday 9am to 5pm. Closed Sunday.', expectedVersion: 1 }));
      expect(revised.body.data.entry).toMatchObject({ status: 'draft', currentVersion: 2 });
      expect(revised.body.data.entry.submittedVersion).toBeUndefined();
      await act('rep', id, 'submit', { expectedVersion: 2 }).expect(200);
      expect((await act('manager', id, 'reject', { expectedVersion: 2 })).status).toBe(400);
      await act('manager', id, 'reject', { expectedVersion: 2, note: 'We have a different entry for this.' }).expect(200);
      expect((await put('rep', id, faq({ question, expectedVersion: 2 }))).body.data.entry).toMatchObject({ status: 'draft', currentVersion: 3 });
    });

    it('reps only see their own entries; reviewers see everything in the organization', async () => {
      const id = await newEntry('rep', faq({ question: q('Do you offer loaner cars') }));
      expect((await call('get', `/entries/${id}`, 'rep2')).status).toBe(404);
      expect((await put('rep2', id, faq({ expectedVersion: 1 }))).status).toBe(404);
      expect((await act('rep2', id, 'archive')).status).toBe(403);
      const repList = (await call('get', '/entries?limit=100', 'rep2')).body.data.items;
      expect(repList.every((item: any) => item.isMine)).toBe(true);
      expect((await call('get', `/entries/${id}`, 'manager')).status).toBe(200);
    });
  });

  describe('approved versions', () => {
    it('editing an approved entry starts a revision without replacing the approved version, and history is immutable', async () => {
      const id = await approved('rep', 'manager');
      const first = await detail('rep', id);
      const revision = await put('rep', id, faq({ question: first.entry.question, answer: 'We are open Saturday from 10am to 4pm.', expectedVersion: 1 }));
      expect(revision.body.data.entry).toMatchObject({ status: 'draft', currentVersion: 2, approvedVersion: 1 });
      expect(revision.body.data.approved).toMatchObject({ version: 1, content: { answer: 'We are open Saturday from 9am to 5pm.' } });
      expect(revision.body.data.current).toMatchObject({ version: 2, content: { answer: 'We are open Saturday from 10am to 4pm.' } });
      expect(isRuntimeEligible(await stored(id))).toBe(true);
      const versions = (await call('get', `/entries/${id}/versions`, 'rep')).body.data;
      expect(versions.map((row: any) => [row.version, row.isCurrent, row.isApproved])).toEqual([[2, true, false], [1, false, true]]);
      expect((await call('get', `/entries/${id}/versions/1`, 'rep')).body.data.content.answer).toBe('We are open Saturday from 9am to 5pm.');
      expect((await call('get', `/entries/${id}/versions/9`, 'rep')).status).toBe(404);
      await act('rep', id, 'submit', { expectedVersion: 2 }).expect(200);
      await act('manager2', id, 'approve', { expectedVersion: 2 }).expect(200);
      expect(await stored(id)).toMatchObject({ approvedVersion: 2, status: 'approved' });

      const version: any = await AiKnowledgeEntryVersion.findOne({ entryId: id, version: 1 });
      await expect(AiKnowledgeEntryVersion.updateOne({ _id: version._id }, { $set: { 'content.answer': 'changed' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(version.deleteOne()).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiKnowledgeAuditLog.deleteMany({ entryId: id })).rejects.toBeInstanceOf(AppendOnlyViolationError);
    });
  });

  describe('duplicates and conflicts', () => {
    it('flags possible duplicates, blocks conflicting approvals for overlapping locations, and allows separate locations', async () => {
      const question = q('Are you open on holidays');
      const all = await approved('rep', 'manager', faq({ question }));
      const orem = await newEntry('rep2', faq({ question: `  ${question.toUpperCase()}!! `, locations: { scope: 'locations', locationIds: [String(loc.orem)] } }));
      const view = await detail('manager', orem);
      expect(view.duplicates).toEqual([{ id: all, status: 'approved', lifecycle: 'active' }]);
      expect(view.conflicts).toEqual([all]);
      await act('rep2', orem, 'submit', { expectedVersion: 1 }).expect(200);
      const blocked = await act('manager', orem, 'approve', { expectedVersion: 1 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.errors).toEqual([expect.objectContaining({ field: 'question', code: 'knowledge_conflict', entryIds: [all] })]);

      await act('manager', all, 'disable', { note: 'Replaced by location entries' }).expect(200);
      await act('manager', orem, 'approve', { expectedVersion: 1 }).expect(200);
      const lehi = await approved('rep', 'manager2', faq({ question, locations: { scope: 'locations', locationIds: [String(loc.lehi)] } }));
      expect(await stored(lehi)).toMatchObject({ status: 'approved' });
      const enable = await act('manager', all, 'enable');
      expect(enable.status).toBe(409);
      expect(enable.body.errors[0].entryIds.sort()).toEqual([orem, lehi].sort());
      expect(await stored(all)).toMatchObject({ lifecycle: 'disabled' });
    });

    it('business information conflicts by topic and title', async () => {
      const title = `Showroom hours ${++counter}`;
      await approved('rep', 'manager', { kind: 'business_info', topic: 'hours', title, answer: 'Weekdays 9am to 7pm.', locations: { scope: 'all' } });
      const second = await newEntry('rep2', { kind: 'business_info', topic: 'hours', title: title.toLowerCase(), answer: 'Weekdays 8am to 6pm.', locations: { scope: 'locations', locationIds: [String(loc.orem)] } });
      await act('rep2', second, 'submit', { expectedVersion: 1 }).expect(200);
      const blocked = await act('manager', second, 'approve', { expectedVersion: 1 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.errors[0]).toMatchObject({ field: 'title', code: 'knowledge_conflict' });
    });
  });

  describe('concurrency', () => {
    it('concurrent edits from the same version save exactly one new version', async () => {
      const id = await newEntry('rep');
      const question = (await detail('rep', id)).entry.question;
      const results = await Promise.all([
        put('rep', id, faq({ question, answer: 'Saturday 9am to 5pm.', expectedVersion: 1 })),
        put('manager', id, faq({ question, answer: 'Saturday 9am to 4pm.', expectedVersion: 1 })),
        put('admin', id, faq({ question, answer: 'Saturday 10am to 4pm.', expectedVersion: 1 })),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409, 409]);
      expect(await stored(id)).toMatchObject({ currentVersion: 2 });
      const versions = await AiKnowledgeEntryVersion.find({ entryId: id }).lean();
      expect(versions.map((row: any) => row.version).sort()).toEqual([1, 2]);
    });

    it('two conflicting entries approved at the same time end with exactly one approved', async () => {
      const question = q('Can I schedule a test drive online');
      const first = await newEntry('rep', faq({ topic: 'test_drives', question }));
      const second = await newEntry('rep2', faq({ topic: 'test_drives', question }));
      await act('rep', first, 'submit', { expectedVersion: 1 }).expect(200);
      await act('rep2', second, 'submit', { expectedVersion: 1 }).expect(200);
      const results = await Promise.all([
        act('manager', first, 'approve', { expectedVersion: 1 }),
        act('admin', second, 'approve', { expectedVersion: 1 }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      const states = await AiKnowledgeEntry.find({ _id: { $in: [first, second] } }).select('status').lean();
      expect(states.map((row: any) => row.status).sort()).toEqual(['approved', 'in_review']);
    });

    it('a stale approval is refused after the entry was edited', async () => {
      const id = await newEntry('rep');
      const question = (await detail('rep', id)).entry.question;
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      await put('manager2', id, faq({ question, answer: 'We are open Saturday from 9am to 3pm.', expectedVersion: 1 })).expect(200);
      const stale = await act('manager', id, 'approve', { expectedVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(/newer version/);
      expect((await act('manager', id, 'approve', {})).status).toBe(400);
    });
  });

  describe('disable, enable and archive', () => {
    it('disabled entries cannot be edited, submitted or approved, and are never eligible', async () => {
      const id = await approved('rep', 'manager');
      const question = (await detail('rep', id)).entry.question;
      await act('manager', id, 'disable', { note: 'Seasonal hours' }).expect(200);
      expect(isRuntimeEligible(await stored(id))).toBe(false);
      expect((await put('rep', id, faq({ question, expectedVersion: 1 }))).status).toBe(409);
      expect((await act('rep', id, 'submit', { expectedVersion: 1 })).status).toBe(409);
      expect((await act('manager', id, 'disable')).status).toBe(409);
      await act('manager', id, 'enable').expect(200);
      expect(isRuntimeEligible(await stored(id))).toBe(true);
    });

    it('turning an entry back on revalidates its approved version and leaves it off if that fails', async () => {
      const id = await approved('rep', 'manager', faq({ locations: { scope: 'locations', locationIds: [String(loc.temp)] } }));
      await act('manager', id, 'disable').expect(200);
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'archived' } });
      const enable = await act('manager', id, 'enable');
      expect(enable.status).toBe(400);
      expect(codes(enable)).toEqual(['locations.locationIds.0:location_archived']);
      expect(enable.body.message).toMatch(/stays disabled/);
      expect(await stored(id)).toMatchObject({ lifecycle: 'disabled' });
      await CrmLocation.collection.updateOne({ _id: loc.temp }, { $set: { status: 'active' } });
      await act('manager', id, 'enable').expect(200);
      expect((await stored(id)).disabledAt).toBeUndefined();
    });

    it('only managers or admins can archive, and archived entries cannot be edited or turned back on', async () => {
      const draft = await newEntry('rep');
      expect((await act('rep', draft, 'archive', { note: 'Duplicate' })).status).toBe(403);
      await act('manager', draft, 'archive', { note: 'Duplicate' }).expect(200);
      const live = await approved('rep', 'manager');
      expect((await act('rep', live, 'archive')).status).toBe(403);
      await act('admin', live, 'archive').expect(200);
      expect((await act('admin', live, 'enable')).status).toBe(409);
      expect((await put('admin', live, faq({ expectedVersion: 1 }))).status).toBe(409);
      expect(isRuntimeEligible(await stored(live))).toBe(false);
      const listed = (await call('get', '/entries?limit=100', 'manager')).body.data.items.map((item: any) => item.id);
      expect(listed).not.toContain(live);
      expect((await call('get', '/entries?lifecycle=archived&limit=100', 'manager')).body.data.items.map((item: any) => item.id)).toEqual(expect.arrayContaining([draft, live]));
    });
  });

  describe('organization isolation', () => {
    it('another organization cannot read, change, review or reference anything', async () => {
      const id = await newEntry('rep');
      await act('rep', id, 'submit', { expectedVersion: 1 }).expect(200);
      for (const res of await Promise.all([
        call('get', `/entries/${id}`, 'otherManager'),
        call('get', `/entries/${id}/versions`, 'otherManager'),
        call('get', `/entries/${id}/audit`, 'otherManager'),
        put('otherManager', id, faq({ expectedVersion: 1 })),
        act('otherManager', id, 'approve', { expectedVersion: 1 }),
        act('otherManager', id, 'disable'),
        act('otherManager', id, 'archive'),
      ])) {
        expect(res.status).toBe(404);
      }
      expect((await call('get', '/entries?limit=100', 'otherManager')).body.data.items).toEqual([]);
      expect((await call('get', '/audit?limit=100', 'otherManager')).body.data.items).toEqual([]);
      expect(codes(await create('otherManager', faq({ locations: { scope: 'locations', locationIds: [String(loc.orem)] } })))).toEqual(['locations.locationIds.0:location_not_found']);
      expect(await stored(id)).toMatchObject({ status: 'in_review', organizationId: ORG });
    });
  });

  describe('list and search', () => {
    it('filters by status, type, topic, location and source, and searches safely', async () => {
      const marker = `zebracolor${++counter}`;
      const allLoc = await newEntry('manager', faq({ topic: 'service', question: `Do you service ${marker} cars (all brands)?` }));
      const oremOnly = await newEntry('manager', faq({ topic: 'service', question: `Do you rotate ${marker} tires?`, locations: { scope: 'locations', locationIds: [String(loc.orem)] } }));
      const lehiOnly = await newEntry('manager', faq({ topic: 'service', question: `Do you align ${marker} wheels?`, locations: { scope: 'locations', locationIds: [String(loc.lehi)] } }));
      const ids = (res: any) => res.body.data.items.map((item: any) => item.id).sort();
      expect(ids(await call('get', `/entries?q=${marker.toUpperCase()}&limit=100`, 'manager'))).toEqual([allLoc, oremOnly, lehiOnly].sort());
      expect(ids(await call('get', `/entries?q=${encodeURIComponent(`${marker} cars (all`)}`, 'manager'))).toEqual([allLoc]);
      expect(ids(await call('get', `/entries?q=${marker}&locationId=${loc.orem}`, 'manager'))).toEqual([allLoc, oremOnly].sort());
      expect(ids(await call('get', `/entries?q=${marker}&kind=business_info`, 'manager'))).toEqual([]);
      expect(ids(await call('get', `/entries?q=${marker}&topic=service&status=draft&source=manual`, 'manager'))).toEqual([allLoc, oremOnly, lehiOnly].sort());
      expect((await call('get', '/entries?status=published', 'manager')).status).toBe(400);
      expect((await call('get', '/entries?locationId=orem', 'manager')).status).toBe(400);
      expect((await call('get', `/entries?q=${'x'.repeat(101)}`, 'manager')).status).toBe(400);
      const summary = (await call('get', `/entries?q=${marker}`, 'manager')).body.data.items[0];
      expect(summary).not.toHaveProperty('answer');
      expect(JSON.stringify(summary)).not.toMatch(/userId/);
    });
  });

  describe('Podium import compatibility', () => {
    it('links a parked import item with full traceability, without trusting or activating it', async () => {
      const link = await buildImportSourceLink(ORG, String(items.faqOff));
      expect(link).toEqual({
        kind: 'faq',
        source: {
          system: 'podium_import', importBatchId: batchId, importBatchNumber: 7, importItemId: items.faqOff,
          sourceKey: expect.stringMatching(/^[a-f0-9]{64}$/), keyRevision: 1, sourceRef: 'Podium > Saturday hours', sourceLocationLabel: 'Orem', sourceStatus: 'off',
        },
      });
      const manager = await CrmUser.findById(users.manager.id).lean();
      const entry: any = await createKnowledgeEntry({
        organizationId: ORG, user: manager, importLink: link,
        body: faq({ question: q('What are your Saturday hours at Orem'), locations: { scope: 'locations', locationIds: [String(loc.orem)] } }),
      });
      expect(entry).toMatchObject({ status: 'draft', lifecycle: 'active', source: { system: 'podium_import', importBatchNumber: 7, sourceStatus: 'off' } });
      expect(entry.approvedVersion).toBeUndefined();
      expect(isRuntimeEligible(entry)).toBe(false);
      const view = await detail('manager', String(entry._id));
      expect(view.entry.source).toMatchObject({ system: 'podium_import', importBatchId: String(batchId), importItemId: String(items.faqOff), importBatchNumber: 7, sourceRef: 'Podium > Saturday hours', sourceStatus: 'off' });
      expect(view.entry.source).not.toHaveProperty('sourceKey');

      await expect(createKnowledgeEntry({ organizationId: ORG, user: manager, importLink: link, body: faq() })).rejects.toMatchObject({ statusCode: 409, message: 'This import item is already linked to a Knowledge Base entry.' });
      await expect(createKnowledgeEntry({ organizationId: ORG, user: manager, importLink: { ...link, source: { ...link.source, importItemId: new mongoose.Types.ObjectId() } }, body: faq() })).rejects.toMatchObject({ statusCode: 409 });
      await expect(createKnowledgeEntry({ organizationId: ORG, user: manager, importLink: await buildImportSourceLink(ORG, String(items.info)), body: faq() })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('an imported answer marked On in Podium still gets the full safety check and review', async () => {
      const manager = await CrmUser.findById(users.manager.id).lean();
      const link = await buildImportSourceLink(ORG, String(items.faqOn));
      expect(link.source.sourceStatus).toBe('on');
      const entry: any = await createKnowledgeEntry({ organizationId: ORG, user: manager, importLink: link, body: faq({ topic: 'general', question: q('Do you take deposits'), answer: 'A $500 deposit holds any vehicle for 48 hours.' }) });
      expect(entry.status).toBe('draft');
      const submit = await act('manager', String(entry._id), 'submit', { expectedVersion: 1 });
      expect(submit.status).toBe(400);
      expect(codes(submit)).toEqual(expect.arrayContaining(['answer:guardrail_figure', 'answer:knowledge_deposit_terms']));
    });

    it('only parked FAQ and business information items of the same organization can be linked, and the form cannot claim a source', async () => {
      await expect(buildImportSourceLink(ORG, String(items.rule))).rejects.toMatchObject({ statusCode: 409 });
      await expect(buildImportSourceLink(ORG, String(items.foreign))).rejects.toMatchObject({ statusCode: 404 });
      await expect(buildImportSourceLink(ORG, 'not-an-id')).rejects.toMatchObject({ statusCode: 404 });
      const claimed = await create('manager', { ...faq(), source: { system: 'podium_import', importItemId: String(items.info) } });
      expect(claimed.status).toBe(400);
      expect(codes(claimed)).toEqual(['source:source_not_allowed']);
      expect(await AiTrainingImportItem.countDocuments({ organizationId: ORG })).toBe(4);
      expect(await AiKnowledgeEntry.countDocuments({ organizationId: ORG, 'source.importItemId': items.info })).toBe(0);
    });
  });

  describe('audit history', () => {
    it('records every change without content or user ids, and the organization history is reviewer-only', async () => {
      const answer = 'We are open Saturday from 9am to 5pm sharp.';
      const id = await approved('rep', 'manager', faq({ answer, changeNote: 'From the front desk' }));
      await act('manager', id, 'disable', { note: 'Pausing for review' }).expect(200);
      const history = (await call('get', `/entries/${id}/audit`, 'rep')).body.data;
      expect(history.map((row: any) => [row.action, row.toStatus || row.toLifecycle])).toEqual([
        ['entry_disabled', 'disabled'], ['entry_approved', 'approved'], ['entry_submitted', 'in_review'], ['entry_created', 'draft'],
      ]);
      expect(history[0]).toMatchObject({ note: 'Pausing for review', actor: { name: 'Fictional manager', role: 'manager' }, fromLifecycle: 'active' });
      expect(JSON.stringify(history)).not.toContain(answer);
      expect(JSON.stringify(history)).not.toMatch(/userId/);
      expect((await stored(id)).pendingAudit).toEqual([]);
      expect((await call('get', '/audit', 'rep')).status).toBe(403);
      const org = (await call('get', '/audit?limit=100', 'admin')).body.data;
      expect(org.total).toBeGreaterThanOrEqual(4);
      expect(org.items.every((row: any) => !JSON.stringify(row).includes(OTHER))).toBe(true);
    });
  });
});
