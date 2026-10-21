import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import { checkPolicyIntegrity, resetTrainingTransactionProbe, runTrainingWrite } from '../src/services/aiTraining.service';
import { applyIntegrityRepair, scanTrainingPolicyIntegrity } from '../src/services/aiTrainingIntegrity.service';
import { getRelevantAiCoaching } from '../src/services/aiAgentCoaching.service';
import aiTrainingRoute from '../src/routes/aiTraining.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/ai-training', aiTrainingRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const users: Record<string, mongoose.Types.ObjectId> = {
  rep: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  manager2: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const BASE = '/api/crm/ai-training';
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(`${BASE}${path}`).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(`${BASE}${path}`).set(auth(who)).send(body);
const put = (path: string, who: string, body: any = {}) => request(app).put(`${BASE}${path}`).set(auth(who)).send(body);
let transactional = false;

const rule = (overrides: Record<string, unknown> = {}) => ({
  title: 'Integrity rule',
  category: 'scenario_response',
  channels: ['sms'],
  intent: 'is deciding between a sedan and an SUV',
  triggers: ['asks which body style fits a family'],
  handling: 'ask_clarifying',
  instruction: 'Ask about family size and driving before suggesting a body style.',
  requiredQuestions: ['How many people usually ride with you?'],
  ...overrides,
});

const versionNumbers = async (policyId: any) =>
  (await AiTrainingPolicyVersion.find({ policyId }).select('version').lean()).map((row: any) => row.version).sort((a: number, b: number) => a - b);

async function seedLegacyPolicy(fields: Record<string, unknown>, versions: number[]) {
  const policyId = new mongoose.Types.ObjectId();
  const actor = { userId: String(users.rep), name: 'Rep One', role: 'rep' };
  await AiTrainingPolicy.collection.insertOne({
    _id: policyId, organizationId: String(orgId), title: 'Legacy proposal', category: 'behavior', channels: ['sms'],
    source: 'coaching_submission', createdBy: actor, createdAt: new Date(), updatedAt: new Date(), ...fields,
  } as any);
  for (const version of versions) {
    await AiTrainingPolicyVersion.collection.insertOne({
      organizationId: String(orgId), policyId, version, spec: { instruction: `Legacy instruction v${version}` }, createdBy: actor, createdAt: new Date(),
    } as any);
  }
  return policyId;
}

describe('Real-DB proof: training proposal data integrity (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    transactional = Boolean(hello.setName);
    await AiTrainingPolicy.init();
    await AiTrainingPolicyVersion.init();
    await AiTrainingAuditLog.init();
    await Organization.collection.insertOne({ _id: orgId, name: 'Integrity Org', slug: `integrity-${orgId}`, status: 'active', metadata: { aiTrainingEnabled: true } } as any);
    const crm = (id: any, role: string, name: string) => ({ _id: id, organizationId: orgId, fullName: name, username: `integ-${id}`, email: `integ-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, 'employee', 'Rep One'),
      crm(users.manager, 'manager', 'Manager One'),
      crm(users.manager2, 'manager', 'Manager Two'),
      crm(users.admin, 'admin', 'Admin One'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
  });

  afterAll(async () => {
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, CrmUser] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: [orgId, String(orgId)] } });
    }
    await AiTrainingPolicyVersion.collection.deleteMany({ organizationId: String(orgId) });
    await Organization.collection.deleteOne({ _id: orgId });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_TRAINING_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    delete process.env.AI_TRAINING_REQUIRE_TRANSACTIONS;
    resetTrainingTransactionProbe();
    jest.restoreAllMocks();
  });

  describe('transaction availability', () => {
    it('reports the mode this database runs in', () => {
      expect(typeof transactional).toBe('boolean');
    });

    it('production refuses non-transactional training writes and writes nothing', async () => {
      process.env.NODE_ENV = 'production';
      const before = await AiTrainingPolicy.countDocuments({ organizationId: String(orgId) });
      const res = await post('/proposals', 'rep', { rule: rule({ title: 'Production write' }) });
      if (transactional) {
        expect(res.status).toBe(201);
      } else {
        expect(res.status).toBe(503);
        expect(res.body.message).toContain('need database transactions');
        expect(await AiTrainingPolicy.countDocuments({ organizationId: String(orgId) })).toBe(before);
        expect(await AiTrainingPolicyVersion.countDocuments({ organizationId: String(orgId), 'spec.title': 'Production write' })).toBe(0);
      }
    });

    it('AI_TRAINING_REQUIRE_TRANSACTIONS forces the same refusal outside production', async () => {
      process.env.AI_TRAINING_REQUIRE_TRANSACTIONS = 'true';
      const result = await runTrainingWrite(async (session) => {
        await AiTrainingPolicy.findOne({ organizationId: String(orgId) }).session(session).lean();
        return 'ran';
      }).catch((err) => err);
      if (transactional) expect(result).toBe('ran');
      else expect(result).toMatchObject({ statusCode: 503 });
    });
  });

  describe('failure injection on writes', () => {
    it('a failed version write leaves the proposal, its versions and its audit unchanged', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule() }).expect(201)).body.data.id;
      jest.spyOn(AiTrainingPolicyVersion, 'create').mockRejectedValueOnce(new Error('local version failure') as never);
      await put(`/proposals/${id}`, 'rep', { rule: rule({ title: 'Never written' }), expectedVersion: 1 }).expect(500);
      const policy: any = await AiTrainingPolicy.findById(id).lean();
      expect(policy).toMatchObject({ currentVersion: 1, title: 'Integrity rule', adoptedVersions: [1] });
      expect(policy.pendingAudit || []).toEqual([]);
      expect(await versionNumbers(id)).toEqual([1]);
      expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'draft_saved' })).toBe(0);
      expect((await checkPolicyIntegrity(String(orgId), policy)).ok).toBe(true);
    });

    it('a failed pointer update after the version write never leaves the proposal pointing at a missing version', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule() }).expect(201)).body.data.id;
      jest.spyOn(AiTrainingPolicy, 'findOneAndUpdate').mockRejectedValueOnce(new Error('local pointer failure') as never);
      await put(`/proposals/${id}`, 'rep', { rule: rule({ title: 'Lost update' }), expectedVersion: 1 }).expect(500);
      const policy: any = await AiTrainingPolicy.findById(id).lean();
      expect(policy).toMatchObject({ currentVersion: 1, title: 'Integrity rule' });
      expect(policy.pendingAudit || []).toEqual([]);
      expect(await versionNumbers(id)).toEqual(transactional ? [1] : [1, 2]);
      const detail = (await get(`/proposals/${id}`, 'rep').expect(200)).body.data;
      expect(detail.versions.map((v: any) => v.version)).toEqual([1]);
      expect(detail.integrity.ok).toBe(true);

      const next = (await put(`/proposals/${id}`, 'rep', { rule: rule({ title: 'Second try' }), expectedVersion: 1 }).expect(200)).body.data;
      const expected = transactional ? 2 : 3;
      expect(next.currentVersion).toBe(expected);
      expect(next.versions.map((v: any) => v.version)).toEqual([expected, 1]);
      expect(next.integrity.ok).toBe(true);
      if (!transactional) expect(next.integrity.issues.map((i: any) => i.code)).toEqual(['unadopted_versions']);
      await post(`/proposals/${id}/submit`, 'rep', { expectedVersion: expected }).expect(200);
      await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: expected }).expect(200);
    });

    it('a failed proposal create leaves no proposal behind', async () => {
      const before = await AiTrainingPolicy.countDocuments({ organizationId: String(orgId) });
      const versionsBefore = await AiTrainingPolicyVersion.countDocuments({ organizationId: String(orgId) });
      jest.spyOn(AiTrainingPolicy, 'create').mockRejectedValueOnce(new Error('local create failure') as never);
      await post('/proposals', 'rep', { rule: rule({ title: 'Never created' }) }).expect(500);
      expect(await AiTrainingPolicy.countDocuments({ organizationId: String(orgId) })).toBe(before);
      expect(await AiTrainingPolicyVersion.countDocuments({ organizationId: String(orgId) })).toBe(transactional ? versionsBefore : versionsBefore + 1);
      const orphan: any = await AiTrainingPolicyVersion.findOne({ organizationId: String(orgId), 'spec.title': 'Never created' }).lean();
      if (orphan) expect(await AiTrainingPolicy.exists({ _id: orphan.policyId })).toBeNull();
    });

    it('a failed approval writes neither the status change nor its audit record', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule(), submit: true }).expect(201)).body.data.id;
      const auditBefore = await AiTrainingAuditLog.countDocuments({ policyId: id });
      jest.spyOn(AiTrainingPolicy, 'findOneAndUpdate').mockRejectedValueOnce(new Error('local approval failure') as never);
      await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 1 }).expect(500);
      expect((await AiTrainingPolicy.findById(id).lean() as any).status).toBe('in_review');
      expect(await AiTrainingAuditLog.countDocuments({ policyId: id })).toBe(auditBefore);
    });
  });

  describe('concurrent writes', () => {
    it('six simultaneous saves of one version: one wins, history stays consistent', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule() }).expect(201)).body.data.id;
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        put(`/proposals/${id}`, 'rep', { rule: rule({ title: `Concurrent ${i}` }), expectedVersion: 1 })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
      const policy: any = await AiTrainingPolicy.findById(id).lean();
      expect(policy.adoptedVersions).toEqual([1, policy.currentVersion]);
      const detail = (await get(`/proposals/${id}`, 'rep').expect(200)).body.data;
      expect(detail.versions).toHaveLength(2);
      expect(detail.integrity.ok).toBe(true);
      expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'draft_saved' })).toBe(1);
    });

    it('a reviewer edit racing two approvals: exactly one change lands and the approval matches the reviewed version', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule(), submit: true }).expect(201)).body.data.id;
      const results = await Promise.all([
        put(`/proposals/${id}`, 'manager', { rule: rule({ title: 'Reviewer race' }), expectedVersion: 1, changeNote: 'race' }),
        post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 1 }),
        post(`/proposals/${id}/approve`, 'admin', { expectedVersion: 1 }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const policy: any = await AiTrainingPolicy.findById(id).lean();
      if (policy.status === 'approved') {
        expect(policy.currentVersion).toBe(1);
        expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'proposal_approved' })).toBe(1);
      } else {
        expect(policy.status).toBe('in_review');
        expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'proposal_approved' })).toBe(0);
      }
      expect((await checkPolicyIntegrity(String(orgId), policy)).ok).toBe(true);
    });
  });

  describe('existing inconsistent data: detection and repair', () => {
    it('a proposal pointing at a missing version cannot be approved; the repair sends it back for a complete review', async () => {
      const id = await seedLegacyPolicy({ status: 'in_review', currentVersion: 3, submittedVersion: 3, submittedAt: new Date() }, [1, 2]);
      const detail = (await get(`/proposals/${id}`, 'manager').expect(200)).body.data;
      expect(detail.integrity.ok).toBe(false);
      expect(detail.integrity.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['missing_current_version', 'missing_submitted_version']));
      const blocked = await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 3 }).expect(409);
      expect(blocked.body.message).toContain('data problem');
      expect((await AiTrainingPolicy.findById(id).lean() as any).status).toBe('in_review');

      const rows = await scanTrainingPolicyIntegrity({ organizationId: String(orgId) });
      const row = rows.find((candidate) => candidate.policyId === String(id))!;
      expect(row.plan).toMatchObject({ toStatus: 'changes_requested', set: { currentVersion: 2, adoptedVersions: [1, 2], status: 'changes_requested' }, unset: ['submittedVersion'] });
      expect((await AiTrainingPolicy.findById(id).lean() as any).currentVersion).toBe(3);

      expect(await applyIntegrityRepair(row)).toBe('repaired');
      const repaired: any = await AiTrainingPolicy.findById(id).lean();
      expect(repaired).toMatchObject({ status: 'changes_requested', currentVersion: 2, adoptedVersions: [1, 2] });
      expect(repaired.submittedVersion).toBeUndefined();
      const repairAudit: any = await AiTrainingAuditLog.findOne({ policyId: id, action: 'integrity_repaired' }).lean();
      expect(repairAudit).toMatchObject({ fromStatus: 'in_review', toStatus: 'changes_requested', actor: { userId: 'system', role: 'system' } });
      expect((await checkPolicyIntegrity(String(orgId), repaired)).ok).toBe(true);
      expect(await versionNumbers(id)).toEqual([1, 2]);

      await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 2 }).expect(409);
      const revised = await post(`/proposals/${id}/revise`, 'rep', { instruction: 'Ask about family size first, then budget.' }).expect(200);
      expect(revised.body.data).toMatchObject({ status: 'in_review', currentVersion: 3, submittedVersion: 3 });
      await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 3 }).expect(200);
    });

    it('an approval with no audit record is detected and sent back to review instead of staying approved', async () => {
      const id = await seedLegacyPolicy({ status: 'approved', currentVersion: 1, submittedVersion: 1, approvedAt: new Date(),
        approvedBy: { userId: String(users.manager), name: 'Manager One', role: 'manager' } }, [1]);
      const row = (await scanTrainingPolicyIntegrity({ organizationId: String(orgId) })).find((candidate) => candidate.policyId === String(id))!;
      expect(row.integrity.issues.map((i) => i.code)).toContain('missing_approval_audit');
      expect(row.plan?.toStatus).toBe('in_review');
      await applyIntegrityRepair(row);
      const repaired: any = await AiTrainingPolicy.findById(id).lean();
      expect(repaired.status).toBe('in_review');
      expect(repaired.approvedBy).toBeUndefined();
      await post(`/proposals/${id}/approve`, 'manager2', { expectedVersion: 1 }).expect(200);
      expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'proposal_approved' })).toBe(1);
    });

    it('a proposal with no usable version at all is withdrawn, never approvable', async () => {
      const id = await seedLegacyPolicy({ status: 'in_review', currentVersion: 1 }, []);
      const row = (await scanTrainingPolicyIntegrity({ organizationId: String(orgId) })).find((candidate) => candidate.policyId === String(id))!;
      expect(row.plan?.toStatus).toBe('withdrawn');
      await applyIntegrityRepair(row);
      expect((await AiTrainingPolicy.findById(id).lean() as any).status).toBe('withdrawn');
    });

    it('stale waiting audit entries are copied to the log once', async () => {
      const entryId = new mongoose.Types.ObjectId();
      const id = await seedLegacyPolicy({ status: 'in_review', currentVersion: 1, adoptedVersions: [1], pendingAudit: [{
        _id: entryId, action: 'proposal_submitted', actor: { userId: String(users.rep), name: 'Rep One', role: 'rep' }, version: 1, toStatus: 'in_review',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }] }, [1]);
      const row = (await scanTrainingPolicyIntegrity({ organizationId: String(orgId) })).find((candidate) => candidate.policyId === String(id))!;
      expect(row.integrity.ok).toBe(true);
      expect(row.plan?.flushAudit).toBe(true);
      await applyIntegrityRepair(row);
      await applyIntegrityRepair(row);
      expect(await AiTrainingAuditLog.countDocuments({ _id: entryId })).toBe(1);
      expect((await AiTrainingPolicy.findById(id).lean() as any).pendingAudit).toEqual([]);
    });

    it('a repair is skipped if the proposal changed after the scan', async () => {
      const id = await seedLegacyPolicy({ status: 'in_review', currentVersion: 3 }, [1, 2]);
      const row = (await scanTrainingPolicyIntegrity({ organizationId: String(orgId) })).find((candidate) => candidate.policyId === String(id))!;
      await AiTrainingPolicy.updateOne({ _id: id }, { $set: { status: 'withdrawn' } });
      expect(await applyIntegrityRepair(row)).toBe('changed_since_scan');
      expect((await AiTrainingPolicy.findById(id).lean() as any)).toMatchObject({ status: 'withdrawn', currentVersion: 3 });
    });

    it('scanning is read-only', async () => {
      await seedLegacyPolicy({ status: 'in_review', currentVersion: 4 }, [1]);
      const snapshot = async () => JSON.stringify(await Promise.all([AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog].map((model: any) =>
        model.collection.find({ organizationId: String(orgId) }).sort({ _id: 1 }).toArray())));
      const before = await snapshot();
      await scanTrainingPolicyIntegrity({ organizationId: String(orgId) });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('append-only guarantees and inactivity', () => {
    it('versions and audit rows reject every model-level update, delete and bulk change', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule() }).expect(201)).body.data.id;
      const version: any = await AiTrainingPolicyVersion.findOne({ policyId: id });
      const audit: any = await AiTrainingAuditLog.findOne({ policyId: id });
      await expect(AiTrainingPolicyVersion.bulkWrite([{ updateOne: { filter: { _id: version._id }, update: { $set: { changeNote: 'x' } } } }])).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingAuditLog.bulkWrite([{ deleteOne: { filter: { _id: audit._id } } }])).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(version.updateOne({ $set: { changeNote: 'x' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(audit.deleteOne()).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingAuditLog.findByIdAndUpdate(audit._id, { $set: { note: 'x' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingPolicyVersion.findByIdAndDelete(version._id)).rejects.toBeInstanceOf(AppendOnlyViolationError);
      expect((await AiTrainingPolicyVersion.findById(version._id).lean() as any).changeNote).toBe('Created in Training Rules');
      expect(await AiTrainingAuditLog.exists({ _id: audit._id })).toBeTruthy();
    });

    it('approved rules stay inactive: nothing reaches the coaching runtime', async () => {
      const id = (await post('/proposals', 'rep', { rule: rule({ title: 'INACTIVE-MARKER-INTEGRITY' }), submit: true }).expect(201)).body.data.id;
      await post(`/proposals/${id}/approve`, 'manager', { expectedVersion: 1 }).expect(200);
      expect(JSON.stringify(await getRelevantAiCoaching({ organizationId: String(orgId), channel: 'sms' }))).not.toContain('INACTIVE-MARKER-INTEGRITY');
    });
  });
});
