import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import AiDraftEvaluation from '../src/models/AiDraftEvaluation.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { getRelevantAiCoaching } from '../src/services/aiAgentCoaching.service';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import aiAgentCoachingRoute from '../src/routes/aiAgentCoaching.routes';
import aiTrainingRoute from '../src/routes/aiTraining.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/ai-coaching', aiAgentCoachingRoute);
app.use('/api/crm/ai-training', aiTrainingRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const users: Record<string, mongoose.Types.ObjectId> = {
  rep: new mongoose.Types.ObjectId(),
  rep2: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  manager2: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const ids: Record<string, any> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(path).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(path).set(auth(who)).send(body);

let serial = 0;
async function aiMessage(org = orgA) {
  const _id = new mongoose.Types.ObjectId();
  await CommunicationMessage.collection.insertOne({
    _id, orgId: String(org), conversationId: org === orgA ? ids.conversation : ids.conversationB, leadId: org === orgA ? ids.lead : ids.leadB,
    direction: 'outbound', body: `Alex reply ${++serial}: what time works best for a visit?`, from: '+18015550999', to: '+18015550411',
    status: 'sent', sentBy: { userId: 'ai-agent', name: 'Alex' }, createdAt: new Date(),
  } as any);
  return _id;
}

const coach = (who: string, messageId: any, instruction = 'Ask for the preferred appointment time first.') =>
  post('/api/crm/ai-coaching', who, { leadId: String(ids.lead), messageId: String(messageId), channel: 'sms', instruction });

const coachingIds = async () => (await getRelevantAiCoaching({ organizationId: String(orgA), channel: 'sms' })).ids.slice().sort();

async function setTraining(enabled: boolean, globalEnabled = true) {
  if (globalEnabled) process.env.AI_TRAINING_ENABLED = 'true';
  else delete process.env.AI_TRAINING_ENABLED;
  await Organization.updateOne({ _id: orgA }, { $set: { 'metadata.aiTrainingEnabled': enabled } });
}

async function snapshot() {
  const out: Record<string, any> = {};
  for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiDraftEvaluation, AiAgentCoachingRule, Organization] as any[]) {
    out[model.modelName] = await model.collection.find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(out);
}

describe('Real-DB proof: Phase 3A training foundation (local dev MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    await AiTrainingPolicyVersion.init();
    await AiDraftEvaluation.init();
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Training Org A', slug: `training-a-${orgA}`, status: 'active', metadata: {} },
      { _id: orgB, name: 'Training Org B', slug: `training-b-${orgB}`, status: 'active', metadata: { aiTrainingEnabled: true } },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `tr-${id}`, email: `tr-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.rep, orgA, 'employee', 'Rep One'),
      crm(users.rep2, orgA, 'employee', 'Rep Two'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.manager2, orgA, 'manager', 'Manager Two'),
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    ids.lead = new mongoose.Types.ObjectId();
    ids.leadB = new mongoose.Types.ObjectId();
    await Lead.collection.insertMany([
      { _id: ids.lead, organizationId: orgA, createdBy: users.admin, firstName: 'Taylor', lastName: 'Train', phone: '+18015550411', status: 'New', createdAt: new Date(), updatedAt: new Date() },
      { _id: ids.leadB, organizationId: orgB, createdBy: users.otherAdmin, firstName: 'Other', lastName: 'Org', phone: '+18015550412', status: 'New', createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    ids.conversation = new mongoose.Types.ObjectId();
    ids.conversationB = new mongoose.Types.ObjectId();
    await Conversation.collection.insertMany([
      { _id: ids.conversation, orgId: String(orgA), customerPhone: '+18015550411', leadId: ids.lead },
      { _id: ids.conversationB, orgId: String(orgB), customerPhone: '+18015550412', leadId: ids.leadB },
    ] as any[]);
    ids.existingRule = new mongoose.Types.ObjectId();
    await AiAgentCoachingRule.collection.insertOne({
      _id: ids.existingRule, organizationId: String(orgA), scope: 'organization', channel: 'all', status: 'active',
      instruction: 'Existing live rule: always mention Saturday hours.', sourceLeadId: ids.lead, sourceMessageId: new mongoose.Types.ObjectId(),
      sourceMessageModel: 'CommunicationMessage', originalAiMessageSnapshot: 'x', usageCount: 7, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    ids.draft = new mongoose.Types.ObjectId();
    ids.draftB = new mongoose.Types.ObjectId();
    await AiAgentDraft.collection.insertMany([
      { _id: ids.draft, organizationId: String(orgA), channel: 'sms', sourceMessageId: 'tr-1', sourceMessageModel: 'CommunicationMessage', status: 'ready', draftText: 'Draft A', expiresAt: new Date(Date.now() + 86400000), createdAt: new Date() },
      { _id: ids.draftB, organizationId: String(orgB), channel: 'sms', sourceMessageId: 'tr-2', sourceMessageModel: 'CommunicationMessage', status: 'ready', draftText: 'Draft B', expiresAt: new Date(Date.now() + 86400000), createdAt: new Date() },
    ] as any[]);
  });

  afterAll(async () => {
    const both = [orgA, orgB, String(orgA), String(orgB)];
    for (const model of [AiTrainingPolicy, AiTrainingPolicyVersion, AiTrainingAuditLog, AiDraftEvaluation, AiAgentCoachingRule, AiAgentDraft, CrmUser, Lead] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: both } });
    }
    await Conversation.collection.deleteMany({ orgId: { $in: both } });
    await CommunicationMessage.collection.deleteMany({ orgId: { $in: both } });
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
    process.env = env;
  });

  beforeEach(async () => {
    delete process.env.AI_TRAINING_ENABLED;
    await Organization.updateOne({ _id: orgA }, { $unset: { 'metadata.aiTrainingEnabled': '' } });
  });

  describe('coaching submissions', () => {
    it('a rep can no longer create active coaching: it becomes a pending proposal even with training off', async () => {
      const before = await coachingIds();
      const rulesBefore = await AiAgentCoachingRule.countDocuments({ organizationId: String(orgA) });
      const messageId = await aiMessage();
      const res = await coach('rep', messageId);
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ pending: true, created: true, status: 'in_review' });
      expect(await AiAgentCoachingRule.countDocuments({ organizationId: String(orgA) })).toBe(rulesBefore);
      expect(await coachingIds()).toEqual(before);

      const policy: any = await AiTrainingPolicy.findById(res.body.data.proposalId).lean();
      expect(policy).toMatchObject({ organizationId: String(orgA), status: 'in_review', source: 'coaching_submission', currentVersion: 1, channels: ['sms'] });
      expect(policy.createdBy).toMatchObject({ userId: String(users.rep), name: 'Rep One', role: 'rep' });
      expect(String(policy.sourceRef.messageId)).toBe(String(messageId));
      const version: any = await AiTrainingPolicyVersion.findOne({ policyId: policy._id }).lean();
      expect(version.spec.instruction).toBe('Ask for the preferred appointment time first.');
      expect(version.originalAiMessageSnapshot).toMatch(/what time works best/);
      expect(await AiTrainingAuditLog.countDocuments({ policyId: policy._id, action: 'proposal_submitted' })).toBe(1);
    });

    it('resubmitting the same message returns the same pending proposal', async () => {
      const messageId = await aiMessage();
      const first = await coach('rep', messageId);
      const second = await coach('rep', messageId, 'A reworded version');
      expect(second.status).toBe(202);
      expect(second.body.data).toMatchObject({ proposalId: first.body.data.proposalId, created: false });
      expect(await AiTrainingPolicy.countDocuments({ 'sourceRef.messageId': String(messageId) })).toBe(1);
    });

    it('rep submissions still require a verified Alex message', async () => {
      const res = await post('/api/crm/ai-coaching', 'rep', { leadId: String(ids.lead), messageId: String(new mongoose.Types.ObjectId()), channel: 'sms', instruction: 'x' });
      expect(res.status).toBe(404);
      const bad = await post('/api/crm/ai-coaching', 'rep', { leadId: String(ids.lead), messageId: String(await aiMessage()), channel: 'sms', instruction: '' });
      expect(bad.status).toBe(400);
    });

    it('managers and admins keep the existing direct coaching path unchanged', async () => {
      const before = await coachingIds();
      const res = await coach('manager', await aiMessage(), 'Manager rule: confirm the visit time.');
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'active', channel: 'all', instruction: 'Manager rule: confirm the visit time.' });
      expect(await coachingIds()).toEqual([...before, res.body.data.id].sort());
      expect(await AiTrainingAuditLog.countDocuments({ legacyCoachingRuleId: res.body.data.id, action: 'legacy_coaching_created' })).toBe(1);
      await AiAgentCoachingRule.collection.deleteOne({ _id: new mongoose.Types.ObjectId(res.body.data.id) });
    });

    it('existing active coaching rules are untouched and still feed Alex', async () => {
      const rule: any = await AiAgentCoachingRule.findById(ids.existingRule).lean();
      expect(rule).toMatchObject({ status: 'active', usageCount: 7, instruction: 'Existing live rule: always mention Saturday hours.' });
      expect(await coachingIds()).toContain(String(ids.existingRule));
      expect((await get('/api/crm/ai-coaching', 'rep')).body.data.data.some((r: any) => r.id === String(ids.existingRule))).toBe(true);
    });

    it('reps still cannot disable or delete coaching', async () => {
      expect((await request(app).patch(`/api/crm/ai-coaching/${ids.existingRule}`).set(auth('rep')).send({ status: 'disabled' })).status).toBe(403);
      expect((await request(app).delete(`/api/crm/ai-coaching/${ids.existingRule}`).set(auth('rep'))).status).toBe(403);
    });
  });

  describe('feature flags', () => {
    it('everything except status and settings is refused while training is off', async () => {
      for (const path of ['/api/crm/ai-training/proposals', `/api/crm/ai-training/evaluations?draftId=${ids.draft}`, '/api/crm/ai-training/audit']) {
        expect((await get(path, 'manager')).status).toBe(409);
      }
      const status = await get('/api/crm/ai-training/status', 'manager').expect(200);
      expect(status.body.data).toMatchObject({ enabled: false, globalEnabled: false, orgEnabled: false, role: 'manager', canReview: true, canManageSettings: false });
      expect(status.body.data.pendingReviewCount).toBeGreaterThan(0);
      const repStatus = await get('/api/crm/ai-training/status', 'rep').expect(200);
      expect(repStatus.body.data.pendingReviewCount).toBeUndefined();
    });

    it('only admins can turn training on, it is audited, and the server flag still gates it', async () => {
      expect((await request(app).patch('/api/crm/ai-training/settings').set(auth('manager')).send({ enabled: true })).status).toBe(403);
      expect((await request(app).patch('/api/crm/ai-training/settings').set(auth('admin')).send({ enabled: 'yes' })).status).toBe(400);
      const res = await request(app).patch('/api/crm/ai-training/settings').set(auth('admin')).send({ enabled: true, reason: 'Start 3A' }).expect(200);
      expect(res.body.data).toMatchObject({ orgEnabled: true, globalEnabled: false, enabled: false, changed: true });
      expect(await AiTrainingAuditLog.countDocuments({ organizationId: String(orgA), action: 'training_enabled', note: 'Start 3A' })).toBe(1);
      expect((await get('/api/crm/ai-training/proposals', 'admin')).status).toBe(409);
      process.env.AI_TRAINING_ENABLED = 'true';
      expect((await get('/api/crm/ai-training/proposals', 'admin')).status).toBe(200);
    });
  });

  describe('lifecycle and permissions (training on)', () => {
    beforeEach(() => setTraining(true));

    it('reps see only their own proposals; managers see all; other orgs see none', async () => {
      await coach('rep2', await aiMessage(), 'Rep two idea');
      const repList = await get('/api/crm/ai-training/proposals?limit=100', 'rep').expect(200);
      expect(repList.body.data.proposals.every((p: any) => p.isMine)).toBe(true);
      const mgrList = await get('/api/crm/ai-training/proposals?limit=100', 'manager').expect(200);
      expect(mgrList.body.data.proposals.some((p: any) => !p.isMine && p.createdBy.name === 'Rep Two')).toBe(true);
      const rep2Proposal = mgrList.body.data.proposals.find((p: any) => p.createdBy.name === 'Rep Two');
      expect((await get(`/api/crm/ai-training/proposals/${rep2Proposal.id}`, 'rep')).status).toBe(404);
      expect((await get(`/api/crm/ai-training/proposals/${rep2Proposal.id}`, 'otherAdmin')).status).toBe(404);
      const otherList = await get('/api/crm/ai-training/proposals', 'otherAdmin').expect(200);
      expect(otherList.body.data.total).toBe(0);
      expect(JSON.stringify(mgrList.body)).not.toMatch(/organizationId|"userId"/);
    });

    it('request changes → revise → approve by a different manager; approval never creates coaching', async () => {
      const before = await coachingIds();
      const { body } = await coach('rep', await aiMessage(), 'First wording');
      const id = body.data.proposalId;
      expect((await post(`/api/crm/ai-training/proposals/${id}/request-changes`, 'rep', { note: 'x' })).status).toBe(403);
      expect((await post(`/api/crm/ai-training/proposals/${id}/request-changes`, 'manager', {})).status).toBe(400);
      const changes = await post(`/api/crm/ai-training/proposals/${id}/request-changes`, 'manager', { note: 'Please mention the test drive.' }).expect(200);
      expect(changes.body.data).toMatchObject({ status: 'changes_requested', lastReview: { action: 'request_changes', note: 'Please mention the test drive.' } });
      expect((await post(`/api/crm/ai-training/proposals/${id}/revise`, 'rep2', { instruction: 'not mine' })).status).toBe(404);
      expect((await post(`/api/crm/ai-training/proposals/${id}/revise`, 'manager', { instruction: 'not mine' })).status).toBe(403);
      const revised = await post(`/api/crm/ai-training/proposals/${id}/revise`, 'rep', { instruction: 'Second wording with a test drive offer', changeNote: 'Added test drive' }).expect(200);
      expect(revised.body.data).toMatchObject({ status: 'in_review', currentVersion: 2 });
      expect(revised.body.data.versions.map((v: any) => v.version)).toEqual([2, 1]);
      expect(revised.body.data.versions[1].spec.instruction).toBe('First wording');
      const approved = await post(`/api/crm/ai-training/proposals/${id}/approve`, 'manager2', { note: 'Looks good' }).expect(200);
      expect(approved.body.data).toMatchObject({ status: 'approved', approvedByName: 'Manager Two' });
      expect(approved.body.data.audit.map((a: any) => a.action)).toEqual(['proposal_submitted', 'proposal_changes_requested', 'proposal_revised', 'proposal_approved']);
      expect(await coachingIds()).toEqual(before);
      expect(await AiAgentCoachingRule.countDocuments({ organizationId: String(orgA), instruction: /wording/ })).toBe(0);
    });

    it('nobody can approve their own proposal', async () => {
      const policyId = new mongoose.Types.ObjectId();
      await AiTrainingPolicy.create({ _id: policyId, organizationId: String(orgA), title: 'Manager idea', status: 'in_review', source: 'manual', createdBy: { userId: String(users.manager), name: 'Manager One', role: 'manager' } });
      await AiTrainingPolicyVersion.create({ organizationId: String(orgA), policyId, version: 1, spec: { instruction: 'Manager idea' }, createdBy: { userId: String(users.manager), name: 'Manager One', role: 'manager' } });
      const res = await post(`/api/crm/ai-training/proposals/${policyId}/approve`, 'manager');
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/cannot approve your own/);
      expect((await post(`/api/crm/ai-training/proposals/${policyId}/approve`, 'admin')).status).toBe(200);
    });

    it('reject needs a note, withdraw works for the author, and closed proposals cannot move', async () => {
      const a = (await coach('rep', await aiMessage(), 'Reject me')).body.data.proposalId;
      expect((await post(`/api/crm/ai-training/proposals/${a}/reject`, 'manager', {})).status).toBe(400);
      await post(`/api/crm/ai-training/proposals/${a}/reject`, 'manager', { note: 'Conflicts with policy' }).expect(200);
      expect((await post(`/api/crm/ai-training/proposals/${a}/approve`, 'manager2')).status).toBe(409);
      const b = (await coach('rep', await aiMessage(), 'Withdraw me')).body.data.proposalId;
      expect((await post(`/api/crm/ai-training/proposals/${b}/withdraw`, 'rep2')).status).toBe(404);
      const w = await post(`/api/crm/ai-training/proposals/${b}/withdraw`, 'rep').expect(200);
      expect(w.body.data.status).toBe('withdrawn');
    });

    it('two simultaneous approvals: exactly one wins', async () => {
      const id = (await coach('rep', await aiMessage(), 'Race me')).body.data.proposalId;
      const results = await Promise.all([post(`/api/crm/ai-training/proposals/${id}/approve`, 'manager'), post(`/api/crm/ai-training/proposals/${id}/approve`, 'manager2')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await AiTrainingAuditLog.countDocuments({ policyId: id, action: 'proposal_approved' })).toBe(1);
    });

    it('versions and audit records are append-only', async () => {
      const version: any = await AiTrainingPolicyVersion.findOne({ organizationId: String(orgA) });
      await expect(AiTrainingPolicyVersion.updateOne({ _id: version._id }, { $set: { 'spec.instruction': 'tampered' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingPolicyVersion.deleteOne({ _id: version._id })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      version.changeNote = 'tampered';
      await expect(version.save()).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingAuditLog.findOneAndUpdate({ organizationId: String(orgA) }, { $set: { note: 'x' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(AiTrainingAuditLog.deleteMany({ organizationId: String(orgA) })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      expect((await AiTrainingPolicyVersion.findById(version._id).lean() as any).changeNote).not.toBe('tampered');
    });

    it('audit history is for managers and admins only', async () => {
      expect((await get('/api/crm/ai-training/audit', 'rep')).status).toBe(403);
      const res = await get('/api/crm/ai-training/audit?limit=5', 'admin').expect(200);
      expect(res.body.data.entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/"userId"|organizationId/);
    });
  });

  describe('draft evaluation', () => {
    beforeEach(() => setTraining(true));

    it('managers rate org drafts with a corrected reply; reps and other orgs cannot', async () => {
      const path = `/api/crm/ai-training/evaluations/${ids.draft}`;
      expect((await request(app).put(path).set(auth('rep')).send({ rating: 'good' })).status).toBe(403);
      expect((await request(app).put(path).set(auth('manager')).send({ rating: 'meh' })).status).toBe(400);
      expect((await request(app).put(path).set(auth('manager')).send({ rating: 'good', reasonTags: ['bogus'] })).status).toBe(400);
      expect((await request(app).put(`/api/crm/ai-training/evaluations/${ids.draftB}`).set(auth('manager')).send({ rating: 'good' })).status).toBe(404);
      const first = await request(app).put(path).set(auth('manager')).send({ rating: 'needs_edit', correctedReply: 'Better reply text', reasonTags: ['missed_question'], note: 'Ask for time' }).expect(200);
      expect(first.body.data).toMatchObject({ rating: 'needs_edit', correctedReply: 'Better reply text', reasonTags: ['missed_question'], isMine: true, evaluatorName: 'Manager One' });
      const days = (new Date(first.body.data.expiresAt).getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(364);
      const second = await request(app).put(path).set(auth('manager')).send({ rating: 'good' }).expect(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      await request(app).put(path).set(auth('admin')).send({ rating: 'wrong' }).expect(200);
      const list = await get(`/api/crm/ai-training/evaluations?draftId=${ids.draft}`, 'manager2').expect(200);
      expect(list.body.data.evaluations.map((e: any) => e.rating).sort()).toEqual(['good', 'wrong']);
      expect((await get(`/api/crm/ai-training/evaluations?draftId=${ids.draft}`, 'rep')).status).toBe(403);
      expect(await AiTrainingAuditLog.countDocuments({ draftId: ids.draft, action: 'draft_evaluated' })).toBe(3);
      const otherOrg = await get(`/api/crm/ai-training/evaluations?draftId=${ids.draft}`, 'otherAdmin').expect(200);
      expect(otherOrg.body.data.evaluations).toEqual([]);
    });
  });

  it('read endpoints never change data', async () => {
    await setTraining(true);
    const before = await snapshot();
    for (const who of ['rep', 'manager', 'admin', 'otherAdmin']) {
      await get('/api/crm/ai-training/status', who).expect(200);
      await get('/api/crm/ai-training/proposals?limit=100', who).expect(200);
      if (who !== 'rep') {
        await get('/api/crm/ai-training/audit', who).expect(200);
        await get(`/api/crm/ai-training/evaluations?draftId=${ids.draft}`, who).expect(200);
      }
    }
    await get('/api/crm/ai-coaching', 'rep').expect(200);
    expect(await snapshot()).toBe(before);
  });
});
