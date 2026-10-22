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
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { isEligibleAt, isRuntimeEligible } from '../src/services/aiKnowledgeBase.service';
import { setLocationArchived } from '../src/services/crmLocation.service';
import aiKnowledgeBaseRoute from '../src/routes/aiKnowledgeBase.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/knowledge-base', aiKnowledgeBaseRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const BASE = '/api/crm/knowledge-base';
const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const users: Record<string, { id: mongoose.Types.ObjectId; role: string }> = {
  rep: { id: new mongoose.Types.ObjectId(), role: 'employee' },
  manager: { id: new mongoose.Types.ObjectId(), role: 'manager' },
  manager2: { id: new mongoose.Types.ObjectId(), role: 'manager' },
  admin: { id: new mongoose.Types.ObjectId(), role: 'admin' },
};
const tokens: Record<string, string> = {};
const loc: Record<string, mongoose.Types.ObjectId> = {};
for (const name of ['main', 'north', 'south', 'legacy', 'race', 'contact']) loc[name] = new mongoose.Types.ObjectId();

type Method = 'get' | 'post' | 'put';
function call(method: Method, path: string, who: string, body?: unknown) {
  const url = `${BASE}${path}`;
  const req = method === 'get' ? request(app).get(url) : method === 'post' ? request(app).post(url) : request(app).put(url);
  req.set({ Authorization: `Bearer ${tokens[who]}` });
  return body === undefined ? req : req.send(body as object);
}
async function ok(pending: Promise<any>, status = 200) {
  const res = await pending;
  expect(res.status).toBe(status);
  return res;
}
const codes = (res: any) => (res.body.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
const entryDoc = (id: string) => AiKnowledgeEntry.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
const detailDoc = (id: string) => AiKnowledgeVerifiedDetail.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
let counter = 0;
const q = (base: string) => `${base} case ${++counter}?`;
const scope = (...names: string[]) => (names.length ? { scope: 'locations', locationIds: names.map((name) => String(loc[name])) } : { scope: 'all' });
const faq = (answer: string, locations: unknown = { scope: 'all' }, topic = 'general') => ({ kind: 'faq', topic, question: q('What should I know'), answer, locations });
let phoneCounter = 2000;
const phone = () => `385-867-${String(++phoneCounter)}`;

async function entry(who: string, body: Record<string, unknown>): Promise<string> {
  return (await ok(call('post', '/entries', who, body), 201)).body.data.entry.id;
}
const submit = async (who: string, id: string) => call('post', `/entries/${id}/submit`, who, { expectedVersion: (await entryDoc(id)).currentVersion });
const approve = async (who: string, id: string) => call('post', `/entries/${id}/approve`, who, { expectedVersion: (await entryDoc(id)).currentVersion });
async function approvedEntry(body: Record<string, unknown>, approver = 'manager'): Promise<string> {
  const id = await entry('rep', body);
  await ok(submit('rep', id));
  await ok(approve(approver, id));
  return id;
}
const detailAct = async (who: string, id: string, action: string, extra: Record<string, unknown> = {}) =>
  call('post', `/verified-details/${id}/${action}`, who, { expectedRevision: (await detailDoc(id)).revision, ...extra });
async function approvedDetail(body: Record<string, unknown>, proposer = 'manager', approver = 'manager2'): Promise<string> {
  const id = (await ok(call('post', '/verified-details', proposer, body), 201)).body.data.id;
  await ok(detailAct(approver, id, 'approve'));
  return id;
}
async function setArchived(name: string, archived: boolean) {
  const location: any = await CrmLocation.findById(loc[name]).lean();
  const admin = await CrmUser.findById(users.admin.id).lean();
  return setLocationArchived({ organizationId: ORG, user: admin, id: String(loc[name]), archived, expectedRevision: location.revision });
}

describe('Real-DB proof: P2b backend corrections for locations, contacts and emails (local MongoDB only)', () => {
  const env = { ...process.env };

  beforeAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision] as any[]) await model.init();
    await Organization.collection.insertOne({ _id: orgId, name: 'Fictional Location Motors', slug: `kbl-${orgId}`, status: 'active', metadata: { aiKnowledgeBaseEnabled: true } } as any);
    await CrmUser.collection.insertMany(Object.entries(users).map(([who, u]) => ({
      _id: u.id, organizationId: orgId, fullName: `Fictional ${who}`, username: `kbl-${u.id}`, email: `kbl-${u.id}@example.com`, role: u.role, isActive: true, password: 'x',
    })) as any[]);
    for (const [who, u] of Object.entries(users)) tokens[who] = generateCrmToken(String(u.id));
    const actor = { userId: String(users.admin.id), name: 'Fictional admin', role: 'admin' };
    await CrmLocation.collection.insertMany(Object.entries(loc).map(([name, id]) => ({
      _id: id, organizationId: ORG, code: `${name}-${orgId}`.slice(0, 40), name: `${name} store`, aliases: [], aliasKeys: [`${name} ${orgId}`], status: 'active', revision: 1,
      createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    })) as any[]);
  });

  afterAll(async () => {
    for (const model of [AiKnowledgeEntry, AiKnowledgeEntryVersion, AiKnowledgeAuditLog, AiKnowledgeKeyLock, AiKnowledgeVerifiedDetail, AiKnowledgeVerifiedDetailRevision, CrmLocation] as any[]) {
      await model.collection.deleteMany({ organizationId: ORG });
    }
    await mongoose.connection.db!.collection('crmlocationaudits').deleteMany({ organizationId: ORG });
    await CrmUser.collection.deleteMany({ _id: { $in: Object.values(users).map((u) => u.id) } });
    await Organization.collection.deleteOne({ _id: orgId });
    process.env = env;
  });

  beforeEach(() => {
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
  });

  it('an All Locations approval is suspended only at the archived location and needs fresh review there after restore', async () => {
    const all = await approvedEntry(faq('Coffee is free in every showroom.'));
    await setArchived('north', true);
    let doc = await entryDoc(all);
    expect(doc.approvalSuspendedLocationIds.map(String)).toEqual([String(loc.north)]);
    expect(isEligibleAt(doc, loc.north)).toBe(false);
    expect(isEligibleAt(doc, loc.main)).toBe(true);
    expect((await call('get', `/entries/${all}`, 'rep')).body.data.entry.approval).toMatchObject({ state: 'valid', needsReapproval: false, activeSuspendedLocationIds: [] });

    await setArchived('north', false);
    doc = await entryDoc(all);
    expect(isEligibleAt(doc, loc.north)).toBe(false);
    expect(isEligibleAt(doc, loc.main)).toBe(true);
    const view = (await call('get', `/entries/${all}`, 'rep')).body.data.entry.approval;
    expect(view).toMatchObject({ state: 'partial', needsReapproval: true, activeSuspendedLocationIds: [String(loc.north)] });
    const queue = (await call('get', '/entries?needsReapproval=true&limit=100', 'manager')).body.data.items.map((item: any) => item.id);
    expect(queue).toContain(all);

    await ok(submit('rep', all));
    expect((await entryDoc(all)).status).toBe('in_review');
    expect(isEligibleAt(await entryDoc(all), loc.main)).toBe(true);
    await ok(approve('manager2', all));
    doc = await entryDoc(all);
    expect(isEligibleAt(doc, loc.north)).toBe(true);
    expect((await call('get', `/entries/${all}`, 'rep')).body.data.entry.approval).toMatchObject({ state: 'valid', needsReapproval: false });
    expect(await AiKnowledgeEntryVersion.countDocuments({ entryId: doc._id })).toBe(1);
    expect(await AiKnowledgeAuditLog.countDocuments({ entryId: doc._id, action: 'entry_approved' })).toBe(2);
  });

  it('entries approved before the suspension mechanism are suspended when their location is restored', async () => {
    const all = await approvedEntry(faq('Every store has a kids corner.'));
    const specific = await approvedEntry(faq('Our legacy store has a car wash.', scope('legacy', 'main')));
    await CrmLocation.collection.updateOne({ _id: loc.legacy }, { $set: { status: 'archived' }, $inc: { revision: 1 } });
    expect((await entryDoc(all)).approvalSuspendedLocationIds).toEqual([]);
    await setArchived('legacy', false);
    for (const id of [all, specific]) {
      const doc = await entryDoc(id);
      expect(doc.approvalSuspendedLocationIds.map(String)).toEqual([String(loc.legacy)]);
      expect(isEligibleAt(doc, loc.legacy)).toBe(false);
      expect(isEligibleAt(doc, loc.main)).toBe(true);
    }
  });

  it('a stale approval cannot cover a location archived after submission, and a restore always needs fresh review', async () => {
    const specific = await entry('rep', faq('South store opens late on Fridays.', scope('south')));
    const all = await entry('rep', faq('All stores close early on Christmas Eve.'));
    await ok(submit('rep', specific));
    await ok(submit('rep', all));
    await setArchived('south', true);
    const blocked = await approve('manager', specific);
    expect(blocked.status).toBe(400);
    expect(codes(blocked)).toEqual(['locations.locationIds.0:location_archived']);
    await ok(approve('manager', all));
    await setArchived('south', false);
    expect(isEligibleAt(await entryDoc(all), loc.south)).toBe(false);
    expect(isEligibleAt(await entryDoc(all), loc.main)).toBe(true);
    await ok(approve('manager', specific));
    expect(isEligibleAt(await entryDoc(specific), loc.south)).toBe(true);
  });

  it('location archiving and approvals racing each other never make content eligible at a restored location without review', async () => {
    for (let round = 0; round < 4; round += 1) {
      const all = await entry('rep', faq(`Race round ${round}: all stores have loaner umbrellas.`));
      const specific = await entry('rep', faq(`Race round ${round}: the race store has a lounge.`, scope('race', 'main')));
      await ok(submit('rep', all));
      await ok(submit('rep', specific));
      const results = await Promise.all([approve('manager', all), approve('admin', specific), setArchived('race', true).then(() => ({ status: 200 })).catch((err) => ({ status: err.statusCode || 500 }))]);
      for (const res of results) expect([200, 400, 409]).toContain(res.status);
      if ((await CrmLocation.findById(loc.race).lean() as any).status === 'archived') await setArchived('race', false);
      for (const id of [all, specific]) {
        const doc = await entryDoc(id);
        expect(isEligibleAt(doc, loc.race)).toBe(false);
        if (doc.status === 'approved') expect(isEligibleAt(doc, loc.main)).toBe(true);
      }
    }
  });

  it('contacts and programs scoped to an archived location stop counting there until a reviewer re-approves them', async () => {
    const orgPhone = phone();
    const localPhone = phone();
    const everywherePhone = await approvedDetail({ kind: 'phone', value: orgPhone, locations: { scope: 'all' } });
    const localOnly = await approvedDetail({ kind: 'phone', value: localPhone, locations: scope('contact') });
    const program = await approvedDetail({ kind: 'program', value: 'Fictional Contact Store Teacher Program', programType: 'educator', locations: scope('contact') });
    const allEntry = await approvedEntry(faq(`Call us at ${orgPhone}.`, { scope: 'all' }, 'contact'));
    const localEntry = await approvedEntry(faq(`Call the contact store at ${localPhone}.`, scope('contact'), 'contact'));
    const otherEntry = await approvedEntry(faq(`Call the main store at ${orgPhone}.`, scope('main'), 'contact'));
    const programEntry = await approvedEntry(faq('Our Fictional Contact Store Teacher Program offers a discount for teachers.', scope('contact')));

    await setArchived('contact', true);
    for (const id of [everywherePhone, localOnly, program]) expect((await detailDoc(id)).suspendedLocationIds.map(String)).toEqual([String(loc.contact)]);
    await setArchived('contact', false);
    const listed = (await call('get', '/verified-details', 'manager')).body.data;
    for (const id of [everywherePhone, localOnly, program]) {
      expect(listed.find((row: any) => row.id === id)).toMatchObject({ status: 'approved', needsReapproval: true, suspendedLocationIds: [String(loc.contact)] });
    }
    expect(await AiKnowledgeAuditLog.countDocuments({ detailId: { $in: [everywherePhone, localOnly, program].map((id) => new mongoose.Types.ObjectId(id)) }, action: 'detail_location_suspended' })).toBe(3);
    expect(isEligibleAt(await entryDoc(allEntry), loc.contact)).toBe(false);
    expect(isEligibleAt(await entryDoc(allEntry), loc.main)).toBe(true);
    expect(isRuntimeEligible(await entryDoc(localEntry))).toBe(false);
    expect(isRuntimeEligible(await entryDoc(programEntry))).toBe(false);
    expect(isEligibleAt(await entryDoc(otherEntry), loc.main)).toBe(true);

    const newMain = await entry('rep', faq(`Main store line: ${orgPhone}.`, scope('main'), 'contact'));
    await ok(submit('rep', newMain));
    expect(codes(await submit('rep', allEntry))).toEqual(['answer:real_phone']);
    expect(codes(await submit('rep', localEntry))).toEqual(['answer:real_phone']);
    expect(codes(await submit('rep', programEntry))).toEqual(['answer:knowledge_discount_offer']);

    expect((await detailAct('manager', everywherePhone, 'reapprove')).status).toBe(403);
    expect((await detailAct('rep', everywherePhone, 'reapprove')).status).toBe(403);
    const reapproved = await ok(detailAct('admin', everywherePhone, 'reapprove'));
    expect(reapproved.body.data).toMatchObject({ needsReapproval: false, suspendedLocationIds: [] });
    expect((await detailAct('admin', everywherePhone, 'reapprove')).status).toBe(409);
    expect(isEligibleAt(await entryDoc(allEntry), loc.contact)).toBe(false);
    await ok(submit('rep', allEntry));
    await ok(approve('manager2', allEntry));
    expect(isEligibleAt(await entryDoc(allEntry), loc.contact)).toBe(true);

    await ok(detailAct('admin', localOnly, 'reapprove'));
    await ok(detailAct('admin', program, 'reapprove'));
    await ok(submit('rep', localEntry));
    await ok(approve('admin', localEntry));
    await ok(submit('rep', programEntry));
    await ok(approve('admin', programEntry));
    expect(isEligibleAt(await entryDoc(localEntry), loc.contact)).toBe(true);
    expect(isEligibleAt(await entryDoc(programEntry), loc.contact)).toBe(true);
    expect(await AiKnowledgeAuditLog.countDocuments({ detailId: new mongoose.Types.ObjectId(everywherePhone), action: 'detail_reapproved', locationId: loc.contact })).toBe(1);

    await setArchived('contact', true);
    expect((await detailAct('admin', localOnly, 'reapprove')).status).toBe(409);
    await setArchived('contact', false);
  });

  it('every email address must be approved on its own, even on an approved website domain', async () => {
    await approvedDetail({ kind: 'website', value: 'fictional-location-motors.com', locations: { scope: 'all' } });
    const refused = await call('post', '/entries', 'rep', faq('Email help@fictional-location-motors.com any time.', { scope: 'all' }, 'contact'));
    expect(refused.status).toBe(400);
    expect(codes(refused)).toEqual(['answer:real_email']);
    const pendingEmail = (await ok(call('post', '/verified-details', 'manager', { kind: 'email', value: 'help@fictional-location-motors.com', locations: { scope: 'all' } }), 201)).body.data.id;
    const draft = await entry('rep', faq('Email help@fictional-location-motors.com any time.', { scope: 'all' }, 'contact'));
    expect(codes(await submit('rep', draft))).toEqual(['answer:real_email']);
    await ok(detailAct('admin', pendingEmail, 'approve'));
    await ok(submit('rep', draft));
    await ok(approve('manager2', draft));
    expect((await entryDoc(draft)).approvedDependencies.map((dep: any) => String(dep.detailId))).toEqual([pendingEmail]);
    const other = await call('post', '/entries', 'rep', faq('Email sales@fictional-location-motors.com any time.', { scope: 'all' }, 'contact'));
    expect(codes(other)).toEqual(['answer:real_email']);
  });

  it('lists only the locations of this organization, with their status, to reps and reviewers', async () => {
    const otherOrg = new mongoose.Types.ObjectId();
    const outsiderId = new mongoose.Types.ObjectId();
    const actor = { userId: String(users.admin.id), name: 'Fictional admin', role: 'admin' };
    await CrmLocation.collection.insertOne({
      _id: outsiderId, organizationId: String(otherOrg), code: `outsider-${otherOrg}`.slice(0, 40), name: 'Outsider store', aliases: [], aliasKeys: [`outsider ${otherOrg}`], status: 'active', revision: 1,
      createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    try {
      await setArchived('south', true);
      const repView = (await ok(call('get', '/locations', 'rep'))).body.data;
      const ids = repView.map((row: any) => row.id);
      expect(ids.sort()).toEqual(Object.values(loc).map(String).sort());
      expect(ids).not.toContain(String(outsiderId));
      expect(repView.find((row: any) => row.id === String(loc.south))).toMatchObject({ name: 'south store', status: 'archived' });
      expect(repView.find((row: any) => row.id === String(loc.main))).toMatchObject({ name: 'main store', status: 'active' });
      expect(Object.keys(repView[0]).sort()).toEqual(['code', 'id', 'name', 'status']);
      expect((await ok(call('get', '/locations', 'manager'))).body.data).toHaveLength(Object.keys(loc).length);

      await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeBaseEnabled': false } });
      expect((await call('get', '/locations', 'rep')).status).toBe(409);
      await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
      process.env.AI_KNOWLEDGE_BASE_ENABLED = 'false';
      expect((await call('get', '/locations', 'rep')).status).toBe(404);
      process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
      expect((await request(app).get(`${BASE}/locations`)).status).toBe(401);
    } finally {
      await Organization.collection.updateOne({ _id: orgId }, { $set: { 'metadata.aiKnowledgeBaseEnabled': true } });
      process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
      await setArchived('south', false);
      await CrmLocation.collection.deleteOne({ _id: outsiderId });
    }
  });
});
