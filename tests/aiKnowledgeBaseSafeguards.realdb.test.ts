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
import AiKnowledgeVerifiedDetail, { AiKnowledgeVerifiedDetailRevision } from '../src/models/AiKnowledgeVerifiedDetail.model';
import AiTrainingImportBatch from '../src/models/AiTrainingImportBatch.model';
import AiTrainingImportItem from '../src/models/AiTrainingImportItem.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { buildImportSourceLink, createKnowledgeEntry, isRuntimeEligible } from '../src/services/aiKnowledgeBase.service';
import { setLocationArchived } from '../src/services/crmLocation.service';
import aiKnowledgeBaseRoute from '../src/routes/aiKnowledgeBase.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/knowledge-base', aiKnowledgeBaseRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const BASE = '/api/crm/knowledge-base';
const orgId = new mongoose.Types.ObjectId();
const offOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OFF = String(offOrgId);
const users: Record<string, { id: mongoose.Types.ObjectId; org: mongoose.Types.ObjectId; role: string }> = {
  rep: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'employee' },
  manager: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'manager' },
  manager2: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'manager' },
  admin: { id: new mongoose.Types.ObjectId(), org: orgId, role: 'admin' },
  offAdmin: { id: new mongoose.Types.ObjectId(), org: offOrgId, role: 'admin' },
  offManager: { id: new mongoose.Types.ObjectId(), org: offOrgId, role: 'manager' },
};
const tokens: Record<string, string> = {};
const loc: Record<string, mongoose.Types.ObjectId> = {};
for (const name of ['orem', 'lehi', 'spare', 'spare2', 'gone']) loc[name] = new mongoose.Types.ObjectId();

type Method = 'get' | 'post' | 'put' | 'patch';
function call(method: Method, path: string, who: string, body?: unknown) {
  const url = `${BASE}${path}`;
  const req = method === 'get' ? request(app).get(url) : method === 'post' ? request(app).post(url) : method === 'put' ? request(app).put(url) : request(app).patch(url);
  req.set({ Authorization: `Bearer ${tokens[who]}` });
  return body === undefined ? req : req.send(body as object);
}
const codes = (res: any) => (res.body.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
const entryDoc = (id: string) => AiKnowledgeEntry.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
const detailDoc = (id: string) => AiKnowledgeVerifiedDetail.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
let counter = 0;
const q = (base: string) => `${base} item ${++counter}?`;
const scope = (...names: string[]) => (names.length ? { scope: 'locations', locationIds: names.map((name) => String(loc[name])) } : { scope: 'all' });
const faq = (answer: string, locations: unknown = { scope: 'all' }, overrides: Record<string, unknown> = {}) => ({ kind: 'faq', topic: 'contact', question: q('How do I reach you'), answer, locations, ...overrides });

let phoneCounter = 1000;
const phone = () => `801-867-${String(++phoneCounter)}`;

async function ok(pending: Promise<any>, status = 200) {
  const res = await pending;
  expect(res.status).toBe(status);
  return res;
}
async function entry(who: string, body: Record<string, unknown>): Promise<string> {
  const res = await call('post', '/entries', who, body);
  expect(res.status).toBe(201);
  return res.body.data.entry.id;
}
async function submit(who: string, id: string) {
  const current = (await entryDoc(id)).currentVersion;
  return call('post', `/entries/${id}/submit`, who, { expectedVersion: current });
}
async function approve(who: string, id: string) {
  const current = (await entryDoc(id)).currentVersion;
  return call('post', `/entries/${id}/approve`, who, { expectedVersion: current });
}
async function approvedEntry(body: Record<string, unknown>, author = 'rep', approver = 'manager'): Promise<string> {
  const id = await entry(author, body);
  await ok(submit(author, id), 200);
  await ok(approve(approver, id), 200);
  return id;
}
async function detail(who: string, body: Record<string, unknown>): Promise<string> {
  const res = await call('post', '/verified-details', who, body);
  expect(res.status).toBe(201);
  return res.body.data.id;
}
const detailAct = async (who: string, id: string, action: string, extra: Record<string, unknown> = {}) =>
  call('post', `/verified-details/${id}/${action}`, who, { expectedRevision: (await detailDoc(id)).revision, ...extra });
async function approvedDetail(body: Record<string, unknown>, proposer = 'manager', approver = 'manager2'): Promise<string> {
  const id = await detail(proposer, body);
  await ok(detailAct(approver, id, 'approve'), 200);
  return id;
}
async function adminDoc() {
  return CrmUser.findById(users.admin.id).lean();
}
async function setArchived(name: string, archived: boolean) {
  const location: any = await CrmLocation.findById(loc[name]).lean();
  await setLocationArchived({ organizationId: ORG, user: await adminDoc(), id: String(loc[name]), archived, expectedRevision: location.revision });
}

describe('Real-DB proof: P2a.1 Knowledge Base safeguards (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision] as any[]) await model.init();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Fictional Safeguard Motors', slug: `kbs-${orgId}`, status: 'active', metadata: { aiKnowledgeBaseEnabled: true, aiAgentEnabled: false } },
      { _id: offOrgId, name: 'Fictional Off Motors', slug: `kbs-${offOrgId}`, status: 'active', metadata: { aiAgentEnabled: false, aiTrainingEnabled: true } },
    ] as any[]);
    await CrmUser.collection.insertMany(Object.entries(users).map(([who, u]) => ({
      _id: u.id, organizationId: u.org, fullName: `Fictional ${who}`, username: `kbs-${u.id}`, email: `kbs-${u.id}@example.com`, role: u.role, isActive: true, password: 'x',
    })) as any[]);
    for (const [who, u] of Object.entries(users)) tokens[who] = generateCrmToken(String(u.id));
    const actor = { userId: String(users.admin.id), name: 'Fictional admin', role: 'admin' };
    await CrmLocation.collection.insertMany(Object.entries(loc).map(([name, id]) => ({
      _id: id, organizationId: ORG, code: `${name}-${orgId}`.slice(0, 40), name: `${name} store`, aliases: [], aliasKeys: [`${name} ${orgId}`], status: 'active', revision: 1,
      createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    })) as any[]);
  });

  afterAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision, AiTrainingImportBatch, AiTrainingImportItem, CrmLocation] as any[]) {
      await model.collection.deleteMany({ organizationId: { $in: [ORG, OFF] } });
    }
    await mongoose.connection.db!.collection('crmlocationaudits').deleteMany({ organizationId: ORG });
    await CrmUser.collection.deleteMany({ _id: { $in: Object.values(users).map((u) => u.id) } });
    await Organization.collection.deleteMany({ _id: { $in: [orgId, offOrgId] } });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
  });

  describe('organization switch', () => {
    it('both the server flag and the organization preference must allow management, and only admins can change the preference', async () => {
      const status = await call('get', '/status', 'offAdmin');
      expect(status.body.data).toMatchObject({ serverEnabled: true, orgEnabled: false, enabled: false, canManageSettings: true, affectsAlex: false });
      for (const res of await Promise.all([
        call('get', '/entries', 'offAdmin'),
        call('post', '/entries', 'offAdmin', faq('Call us during business hours.')),
        call('get', '/verified-details', 'offAdmin'),
        call('post', '/verified-details', 'offAdmin', { kind: 'phone', value: phone(), locations: { scope: 'all' } }),
        call('get', '/audit', 'offAdmin'),
      ])) {
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/turned off for this organization/);
      }
      expect((await call('patch', '/settings', 'offManager', { enabled: true })).status).toBe(403);
      expect((await call('patch', '/settings', 'offAdmin', { enabled: 'yes' })).status).toBe(400);
      const before: any = (await Organization.collection.findOne({ _id: offOrgId }))!.metadata;
      const on = await call('patch', '/settings', 'offAdmin', { enabled: true, reason: 'Starting the Knowledge Base' });
      expect(on.status).toBe(200);
      expect(on.body.data).toMatchObject({ enabled: true, orgEnabled: true });
      const after: any = (await Organization.collection.findOne({ _id: offOrgId }))!.metadata;
      expect(after).toEqual({ ...before, aiKnowledgeBaseEnabled: true });
      expect(await AiKnowledgeAuditLog.countDocuments({ organizationId: OFF, action: 'knowledge_base_enabled', note: 'Starting the Knowledge Base' })).toBe(1);
      const created = await call('post', '/entries', 'offManager', faq('Call us during business hours.'));
      expect(created.status).toBe(201);
      await call('patch', '/settings', 'offAdmin', { enabled: false }).expect(200);
      expect((await call('get', `/entries/${created.body.data.entry.id}`, 'offManager')).status).toBe(409);
      expect(await AiKnowledgeEntry.countDocuments({ organizationId: OFF })).toBe(1);

      delete process.env.AI_KNOWLEDGE_BASE_ENABLED;
      expect((await call('patch', '/settings', 'offAdmin', { enabled: true })).status).toBe(404);
      expect((await call('get', '/status', 'offAdmin')).body.data).toMatchObject({ serverEnabled: false, enabled: false });
      expect((await call('get', '/entries', 'manager')).status).toBe(404);
    });
  });

  describe('approved business contacts', () => {
    it('needs a second manager or admin to approve, rejects duplicates and bad locations, and keeps every revision', async () => {
      expect((await call('post', '/verified-details', 'rep', { kind: 'phone', value: phone(), locations: { scope: 'all' } })).status).toBe(403);
      const number = phone();
      const id = await detail('manager', { kind: 'phone', value: number, label: 'Orem sales line', locations: scope('orem') });
      const self = await detailAct('manager', id, 'approve');
      expect(self.status).toBe(403);
      expect(self.body.message).toMatch(/another manager or admin/);
      const dup = await call('post', '/verified-details', 'admin', { kind: 'phone', value: `(${number.slice(0, 3)}) ${number.slice(4)}`, locations: scope('lehi') });
      expect(dup.status).toBe(409);
      expect(codes(dup)).toEqual(['value:already_listed']);
      const other = await call('post', '/verified-details', 'admin', { kind: 'phone', value: phone(), locations: { scope: 'locations', locationIds: [String(new mongoose.Types.ObjectId())] } });
      expect(codes(other)).toEqual(['locations.locationIds.0:location_not_found']);
      expect((await call('post', `/verified-details/${id}/approve`, 'manager2', { expectedRevision: 9 })).status).toBe(409);
      await ok(detailAct('manager2', id, 'approve'), 200);
      expect(await detailDoc(id)).toMatchObject({ status: 'approved', revision: 1 });

      expect((await call('get', '/verified-details', 'rep')).body.data.map((row: any) => row.status)).toEqual(expect.not.arrayContaining(['pending']));
      const changed = await call('put', `/verified-details/${id}`, 'admin', { expectedRevision: 1, kind: 'phone', value: number, label: 'Orem main line', locations: scope('orem') });
      expect(changed.body.data).toMatchObject({ status: 'pending', revision: 2, proposedBy: { name: 'Fictional admin' } });
      expect((await detailAct('admin', id, 'approve')).status).toBe(403);
      await ok(detailAct('manager', id, 'approve'), 200);
      expect((await call('get', `/verified-details/${id}`, 'rep')).status).toBe(200);
      const view = (await call('get', `/verified-details/${id}`, 'manager')).body.data;
      expect(view.revisions.map((row: any) => [row.revision, row.label])).toEqual([[2, 'Orem main line'], [1, 'Orem sales line']]);
      expect(view.history.map((row: any) => row.action)).toEqual(['detail_approved', 'detail_updated', 'detail_approved', 'detail_proposed']);
      const revision: any = await AiKnowledgeVerifiedDetailRevision.findOne({ detailId: id, revision: 1 });
      await expect(AiKnowledgeVerifiedDetailRevision.updateOne({ _id: revision._id }, { $set: { value: 'x' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      expect((await detailAct('manager', id, 'revoke')).status).toBe(400);
    });

    it('drafts may use a pending contact, but only approved contacts covering every entry location pass review', async () => {
      expect(codes(await call('post', '/entries', 'rep', faq(`Call our Orem team at ${phone()}.`, scope('orem'))))).toEqual(['answer:real_phone']);
      const number = phone();
      const id = await detail('manager', { kind: 'phone', value: number, locations: scope('orem') });
      const oremEntry = await entry('rep', faq(`Call our Orem team at ${number}.`, scope('orem')));
      const pending = await submit('rep', oremEntry);
      expect(pending.status).toBe(400);
      expect(codes(pending)).toEqual(['answer:real_phone']);
      expect(pending.body.errors[0].message).toMatch(/approved business contacts for these locations/);
      expect(JSON.stringify(pending.body)).not.toContain(number);
      await ok(detailAct('manager2', id, 'approve'), 200);
      await ok(submit('rep', oremEntry), 200);
      await ok(approve('manager', oremEntry), 200);
      expect((await entryDoc(oremEntry)).approvedDependencies.map((dep: any) => [String(dep.detailId), dep.revision])).toEqual([[id, 1]]);

      const wider = await entry('rep', faq(`Call us at ${number}.`, { scope: 'all' }));
      expect(codes(await submit('rep', wider))).toEqual(['answer:real_phone']);
      const two = await entry('rep', faq(`Call us at ${number}.`, scope('orem', 'lehi')));
      expect(codes(await submit('rep', two))).toEqual(['answer:real_phone']);

      const site = await approvedDetail({ kind: 'website', value: 'https://www.fictional-safeguard-motors.com', locations: { scope: 'all' } });
      const domainOnly = await call('post', '/entries', 'rep', faq('Email sales@fictional-safeguard-motors.com or visit fictional-safeguard-motors.com.', scope('lehi')));
      expect(codes(domainOnly)).toEqual(['answer:real_email']);
      const email = await approvedDetail({ kind: 'email', value: 'sales@fictional-safeguard-motors.com', locations: { scope: 'all' } });
      const web = await approvedEntry(faq('Email sales@fictional-safeguard-motors.com or visit fictional-safeguard-motors.com.', scope('lehi')));
      expect((await entryDoc(web)).approvedDependencies.map((dep: any) => String(dep.detailId)).sort()).toEqual([site, email].sort());
    });
  });

  describe('invalidation and re-approval', () => {
    it('revoking, changing or archiving an approved contact invalidates answers that depend on it', async () => {
      const number = phone();
      const contact = await approvedDetail({ kind: 'phone', value: number, locations: { scope: 'all' } });
      const answer = await approvedEntry(faq(`Call us at ${number}.`));
      const unrelated = await approvedEntry(faq('Visit us during business hours.'));
      expect(isRuntimeEligible(await entryDoc(answer))).toBe(true);
      await ok(detailAct('admin', contact, 'revoke', { note: 'Number was reassigned' }), 200);
      const invalid = await entryDoc(answer);
      expect(invalid.approvalInvalidation).toMatchObject({ reason: 'detail_revoked', detailId: new mongoose.Types.ObjectId(contact) });
      expect(isRuntimeEligible(invalid)).toBe(false);
      expect(isRuntimeEligible(await entryDoc(unrelated))).toBe(true);
      const history = (await call('get', `/entries/${answer}/audit`, 'manager')).body.data;
      expect(history[0]).toMatchObject({ action: 'approval_invalidated', detailId: contact, note: 'detail_revoked' });
      const view = (await call('get', `/entries/${answer}`, 'rep')).body.data;
      expect(view.entry.approval).toMatchObject({ valid: false, needsReapproval: true, invalidation: { reason: 'detail_revoked' } });
      expect(view.permissions.canSubmit).toBe(true);
      expect(codes(await submit('rep', answer))).toEqual(['answer:real_phone']);
      const question = view.entry.question;
      await call('put', `/entries/${answer}`, 'rep', faq('Call our main line during business hours.', { scope: 'all' }, { question, expectedVersion: invalid.currentVersion })).expect(200);
      await ok(submit('rep', answer), 200);
      await ok(approve('manager2', answer), 200);
      const fixed = await entryDoc(answer);
      expect(fixed.approvalInvalidation).toBeUndefined();
      expect(fixed.approvedVersion).toBe(2);
      expect(isRuntimeEligible(fixed)).toBe(true);

      const site = await approvedDetail({ kind: 'website', value: 'fictional-change-motors.com', locations: { scope: 'all' } });
      const siteAnswer = await approvedEntry(faq('See fictional-change-motors.com for hours.'));
      await call('put', `/verified-details/${site}`, 'manager', { expectedRevision: 1, kind: 'website', value: 'fictional-change-motors.com', label: 'Main site', locations: { scope: 'all' } }).expect(200);
      expect((await entryDoc(siteAnswer)).approvalInvalidation).toMatchObject({ reason: 'detail_changed' });
      await ok(detailAct('admin', site, 'approve'), 200);
      await ok(submit('rep', siteAnswer), 200);
      const reapproved = await approve('admin', siteAnswer);
      expect(reapproved.status).toBe(200);
      expect((await entryDoc(siteAnswer)).approvedDependencies).toEqual([{ detailId: new mongoose.Types.ObjectId(site), revision: 2 }]);

      const email = await approvedDetail({ kind: 'email', value: 'service@fictional-archive-motors.com', locations: { scope: 'all' } });
      const emailAnswer = await approvedEntry(faq('Email service@fictional-archive-motors.com.'));
      await ok(detailAct('manager', email, 'archive'), 200);
      expect((await entryDoc(emailAnswer)).approvalInvalidation).toMatchObject({ reason: 'detail_archived' });
      const dependents = (await call('get', `/verified-details/${email}`, 'manager')).body.data.dependentEntries;
      expect(dependents).toEqual([expect.objectContaining({ id: emailAnswer, invalidated: true })]);
    });

    it('an approval and a revocation racing each other never leave an answer approved on a revoked contact', async () => {
      for (let round = 0; round < 5; round += 1) {
        const number = phone();
        const contact = await approvedDetail({ kind: 'phone', value: number, locations: { scope: 'all' } });
        const id = await entry('rep', faq(`Call us at ${number}.`));
        await ok(submit('rep', id), 200);
        const [approval, revoke] = await Promise.all([
          approve('manager', id),
          detailAct('admin', contact, 'revoke', { note: 'Race test' }),
        ]);
        expect([200, 400, 409]).toContain(approval.status);
        expect([200, 409]).toContain(revoke.status);
        const state = await entryDoc(id);
        const contactState = await detailDoc(contact);
        if (contactState.status === 'revoked' && state.status === 'approved') {
          expect(state.approvalInvalidation).toMatchObject({ reason: 'detail_revoked' });
          expect(isRuntimeEligible(state)).toBe(false);
        }
      }
      const number = phone();
      const results = await Promise.all([
        call('post', '/verified-details', 'manager', { kind: 'phone', value: number, locations: { scope: 'all' } }),
        call('post', '/verified-details', 'admin', { kind: 'phone', value: number, locations: { scope: 'all' } }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      const pending = results.find((res) => res.status === 201)!.body.data.id;
      const approvals = await Promise.all([detailAct('manager2', pending, 'approve'), detailAct('manager2', pending, 'approve')]);
      expect(approvals.map((res) => res.status).sort()).toEqual([200, 409]);
    });
  });

  describe('location archive and restore', () => {
    it('suspends only the archived location, keeps it suspended after restore, and requires re-approval', async () => {
      const multi = await approvedEntry(faq('Our service desk opens at 7am.', scope('spare', 'lehi')));
      const single = await approvedEntry(faq('Our parts counter opens at 8am.', scope('spare')));
      const everywhere = await approvedEntry(faq('We are closed on major holidays.'));
      await setArchived('spare', true);
      const multiDoc = await entryDoc(multi);
      expect(multiDoc.approvalSuspendedLocationIds.map(String)).toEqual([String(loc.spare)]);
      expect(isRuntimeEligible(multiDoc)).toBe(true);
      expect(isRuntimeEligible(await entryDoc(single))).toBe(false);
      expect(isRuntimeEligible(await entryDoc(everywhere))).toBe(true);
      expect((await entryDoc(everywhere)).approvalSuspendedLocationIds.map(String)).toEqual([String(loc.spare)]);

      await setArchived('spare', false);
      expect((await entryDoc(multi)).approvalSuspendedLocationIds.map(String)).toEqual([String(loc.spare)]);
      expect(isRuntimeEligible(await entryDoc(single))).toBe(false);
      expect(await AiKnowledgeAuditLog.countDocuments({ entryId: { $in: [new mongoose.Types.ObjectId(multi), new mongoose.Types.ObjectId(single)] }, action: 'location_suspended' })).toBe(2);
      const view = (await call('get', `/entries/${multi}`, 'rep')).body.data.entry.approval;
      expect(view).toMatchObject({ valid: true, needsReapproval: true, suspendedLocationIds: [String(loc.spare)] });

      await ok(submit('rep', multi), 200);
      await ok(approve('manager2', multi), 200);
      const reapproved = await entryDoc(multi);
      expect(reapproved.approvalSuspendedLocationIds).toEqual([]);
      expect(reapproved.approvedVersion).toBe(1);
      const approvals = await AiKnowledgeAuditLog.countDocuments({ entryId: reapproved._id, action: 'entry_approved' });
      expect(approvals).toBe(2);
    });

    it('a suspended location does not block a new entry there, and the old entry then conflicts on re-approval', async () => {
      const question = q('Do you open early on Saturdays');
      const old = await approvedEntry({ kind: 'faq', topic: 'hours', question, answer: 'Yes, from 7am.', locations: scope('spare2') });
      await setArchived('spare2', true);
      await setArchived('spare2', false);
      const replacement = await approvedEntry({ kind: 'faq', topic: 'hours', question, answer: 'Yes, from 8am.', locations: scope('spare2') }, 'rep', 'manager2');
      expect(isRuntimeEligible(await entryDoc(replacement))).toBe(true);
      await ok(submit('rep', old), 200);
      const clash = await approve('admin', old);
      expect(clash.status).toBe(409);
      expect(clash.body.errors[0]).toMatchObject({ code: 'knowledge_conflict', entryIds: [replacement] });
    });

    it('restoring a location that was archived before this safeguard existed still suspends its approvals', async () => {
      const legacy = await approvedEntry(faq('Our detail shop is next door.', scope('gone')));
      await CrmLocation.collection.updateOne({ _id: loc.gone }, { $set: { status: 'archived' }, $inc: { revision: 1 } });
      await setArchived('gone', false);
      expect((await entryDoc(legacy)).approvalSuspendedLocationIds.map(String)).toEqual([String(loc.gone)]);
      expect(isRuntimeEligible(await entryDoc(legacy))).toBe(false);
    });
  });

  describe('archived entry restoration and rep permissions', () => {
    it('managers restore archived entries into fresh review and the old approval never reactivates', async () => {
      const id = await approvedEntry(faq('Our showroom has free coffee.'));
      await call('post', `/entries/${id}/archive`, 'manager', { note: 'Seasonal' }).expect(200);
      expect((await call('post', `/entries/${id}/restore`, 'rep')).status).toBe(403);
      const restored = await call('post', `/entries/${id}/restore`, 'manager', { note: 'Back for winter' });
      expect(restored.status).toBe(200);
      expect(restored.body.data.entry).toMatchObject({ lifecycle: 'active', status: 'approved', approvedVersion: 1, approval: { valid: false, needsReapproval: true, invalidation: { reason: 'entry_restored' } } });
      expect(isRuntimeEligible(await entryDoc(id))).toBe(false);
      expect((await call('post', `/entries/${id}/restore`, 'manager')).status).toBe(409);
      await ok(submit('rep', id), 200);
      expect((await approve('rep', id)).status).toBe(403);
      await ok(approve('manager2', id), 200);
      expect(isRuntimeEligible(await entryDoc(id))).toBe(true);
      const actions = (await call('get', `/entries/${id}/audit`, 'manager')).body.data.map((row: any) => row.action);
      expect(actions).toEqual(['entry_approved', 'entry_submitted', 'entry_restored', 'entry_archived', 'entry_approved', 'entry_submitted', 'entry_created']);
      expect(await AiKnowledgeEntryVersion.countDocuments({ entryId: new mongoose.Types.ObjectId(id) })).toBe(1);

      const reviewing = await entry('rep', faq('Ask the front desk for a loaner.'));
      await ok(submit('rep', reviewing), 200);
      await call('post', `/entries/${reviewing}/archive`, 'admin').expect(200);
      const back = await call('post', `/entries/${reviewing}/restore`, 'admin');
      expect(back.body.data.entry).toMatchObject({ status: 'draft', lifecycle: 'active' });
      expect(back.body.data.entry.submittedVersion).toBeUndefined();
    });

    it('reps create, edit and submit their own drafts but cannot approve, disable, enable, archive or restore', async () => {
      const id = await entry('rep', faq('Ask the front desk for help.'));
      const question = (await entryDoc(id)).question;
      await call('put', `/entries/${id}`, 'rep', faq('Ask the front desk for directions.', { scope: 'all' }, { question, expectedVersion: 1 })).expect(200);
      await ok(submit('rep', id), 200);
      for (const action of ['approve', 'disable', 'enable', 'archive', 'restore', 'reject', 'request-changes']) {
        expect((await call('post', `/entries/${id}/${action}`, 'rep', { expectedVersion: 2, note: 'x' })).status).toBe(403);
      }
      expect((await call('put', `/entries/${id}`, 'rep', faq('Changed', { scope: 'all' }, { question, expectedVersion: 2 }))).status).toBe(409);
    });
  });

  describe('verified discount programs', () => {
    it('allows describing an approved program but never amounts, guaranteed eligibility, pricing or payment promises', async () => {
      const programId = await approvedDetail({ kind: 'program', value: 'Fictional Heroes Appreciation Program', programType: 'military', locations: { scope: 'all' } });
      const text = 'Our Fictional Heroes Appreciation Program offers a discount for active-duty and retired service members. Our team can confirm eligibility.';
      const programEntry = await approvedEntry({ kind: 'faq', topic: 'general', question: q('Do you have a military discount'), answer: text, locations: scope('orem') });
      expect((await entryDoc(programEntry)).approvedDependencies.map((dep: any) => String(dep.detailId))).toEqual([programId]);
      for (const [answer, code] of [
        ['All veterans qualify for our Fictional Heroes Appreciation Program discount.', 'answer:knowledge_program_terms'],
        ['Our Fictional Heroes Appreciation Program takes $500 off.', 'answer:guardrail_figure'],
        ['Our Fictional Heroes Appreciation Program discount gets you the final price.', 'answer:knowledge_price_claims'],
        ['Our Fictional Heroes Appreciation Program includes low monthly payments.', 'answer:knowledge_payment_terms'],
        ['Our Unlisted Savings Program offers a discount for nurses.', 'answer:knowledge_discount_offer'],
      ]) {
        const id = await entry('rep', { kind: 'faq', topic: 'general', question: q('Tell me about discounts'), answer, locations: scope('orem') });
        expect(codes(await submit('rep', id))).toContain(code);
      }
      const localProgram = await approvedDetail({ kind: 'program', value: 'Fictional Orem Teacher Program', programType: 'educator', locations: scope('orem') });
      const wide = await entry('rep', { kind: 'faq', topic: 'general', question: q('Teacher discount'), answer: 'Our Fictional Orem Teacher Program offers a discount for teachers.', locations: { scope: 'all' } });
      expect(codes(await submit('rep', wide))).toEqual(['answer:knowledge_discount_offer']);
      expect(localProgram).toBeTruthy();
      await ok(detailAct('admin', programId, 'revoke', { note: 'Program ended' }), 200);
      expect((await entryDoc(programEntry)).approvalInvalidation).toMatchObject({ reason: 'detail_revoked' });
    });
  });

  describe('Podium import compatibility and runtime isolation', () => {
    it('never trusts contact details from a Podium import, even ones listed as business contacts on the batch', async () => {
      const batchId = new mongoose.Types.ObjectId();
      const itemId = new mongoose.Types.ObjectId();
      const number = phone();
      await AiTrainingImportBatch.collection.insertOne({ _id: batchId, organizationId: ORG, batchNumber: 3, sourceSystem: 'podium', businessContacts: [{ kind: 'phone', value: number.replace(/\D/g, '') }], createdAt: new Date() } as any);
      await AiTrainingImportItem.collection.insertOne({
        _id: itemId, organizationId: ORG, batchId, batchNumber: 3, rowNumber: 1, type: 'faq', status: 'parked_knowledge', issueCodes: [], fingerprint: crypto.randomBytes(32).toString('hex'),
        sourceKey: crypto.randomBytes(32).toString('hex'), keyRevision: 1, sourceStatus: 'on', locationScope: { kind: 'all' }, target: { kind: 'parked_knowledge' }, contentRetained: true, createdAt: new Date(),
      } as any);
      const link = await buildImportSourceLink(ORG, String(itemId));
      await expect(createKnowledgeEntry({ organizationId: ORG, user: await adminDoc(), importLink: link, body: faq(`Call us at ${number}.`) }))
        .rejects.toMatchObject({ statusCode: 400, errors: [expect.objectContaining({ code: 'real_phone' })] });
      expect(await AiKnowledgeEntry.countDocuments({ organizationId: ORG, 'source.importItemId': itemId })).toBe(0);
    });

    it('nothing in the Knowledge Base creates training rules, coaching or anything Alex reads', async () => {
      expect(await AiTrainingPolicy.countDocuments({ organizationId: { $in: [ORG, OFF] } })).toBe(0);
      expect(await AiAgentCoachingRule.countDocuments({ organizationId: { $in: [ORG, OFF] } })).toBe(0);
      const metadata: any = (await Organization.collection.findOne({ _id: orgId }))!.metadata;
      expect(metadata).toEqual({ aiKnowledgeBaseEnabled: true, aiAgentEnabled: false });
    });
  });
});
