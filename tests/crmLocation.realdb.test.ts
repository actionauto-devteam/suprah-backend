import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLocation from '../src/models/CrmLocation.model';
import CrmLocationAudit from '../src/models/CrmLocationAudit.model';
import Lead from '../src/models/lead.model';
import Vehicle from '../src/models/Vehicle.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { AppendOnlyViolationError } from '../src/utils/appendOnlySchema';
import crmLocationRoute from '../src/routes/crmLocation.routes';

const app = express();
app.use(express.json());
app.use('/api/crm/locations', crmLocationRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const users: Record<string, mongoose.Types.ObjectId> = {
  admin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const BASE = '/api/crm/locations';
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const get = (path: string, who: string) => request(app).get(`${BASE}${path}`).set(auth(who));
const post = (path: string, who: string, body: any = {}) => request(app).post(`${BASE}${path}`).set(auth(who)).send(body);
const patch = (path: string, who: string, body: any = {}) => request(app).patch(`${BASE}${path}`).set(auth(who)).send(body);
const create = (who: string, location: Record<string, unknown>) => post('', who, { location });

async function outsideSnapshot() {
  const leads = await Lead.collection.find({ organizationId: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray();
  const vehicles = await Vehicle.collection.find({ organizationId: { $in: [String(orgA), String(orgB)] } }).sort({ _id: 1 }).toArray();
  const orgs = await Organization.collection.find({ _id: { $in: [orgA, orgB] } }).sort({ _id: 1 }).toArray();
  return JSON.stringify({ leads, vehicles, orgs });
}

describe('Real-DB proof: P1a organization locations (local MongoDB only)', () => {
  beforeAll(async () => {
    await Promise.all([CrmLocation.init(), CrmLocationAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Loc Org A', slug: `loc-a-${orgA}`, status: 'active', metadata: { reviewLinks: [{ location: 'American Fork', url: 'https://example.com/review-af' }] } },
      { _id: orgB, name: 'Loc Org B', slug: `loc-b-${orgB}`, status: 'active', metadata: {} },
    ] as any[]);
    const crm = (id: any, org: any, role: string, name: string) => ({ _id: id, organizationId: org, fullName: name, username: `loc-${id}`, email: `loc-${id}@example.com`, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(users.admin, orgA, 'admin', 'Admin One'),
      crm(users.manager, orgA, 'manager', 'Manager One'),
      crm(users.employee, orgA, 'employee', 'Employee One'),
      crm(users.otherAdmin, orgB, 'admin', 'Other Admin'),
    ] as any[]);
    for (const [who, id] of Object.entries(users)) tokens[who] = generateCrmToken(String(id));
    const lead = (org: any, location: string, i: number) => ({ organizationId: org, firstName: 'Fictional', lastName: `Lead${i}`, email: `lead${i}-${org}@example.com`, location, status: 'New', createdAt: new Date(), updatedAt: new Date() });
    await Lead.collection.insertMany([
      lead(orgA, 'Orem', 1), lead(orgA, 'Orem', 2), lead(orgA, 'OREM', 3), lead(orgA, 'Lehi', 4), lead(orgB, 'Provo', 5),
    ] as any[]);
    const vehicle = (org: any, city: string, i: number) => ({ organizationId: String(org), vin: `LOCTEST${String(i).padStart(10, '0')}`, make: 'Test', model: 'Car', year: 2020, dealerCity: city, isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date() });
    await Vehicle.collection.insertMany([
      vehicle(orgA, 'Orem', 1), vehicle(orgA, 'Orem, UT', 2), vehicle(orgA, 'Spanish Fork', 3), vehicle(orgB, 'Provo', 4),
    ] as any[]);
  });

  afterAll(async () => {
    const both = [orgA, orgB, String(orgA), String(orgB)];
    await CrmLocation.collection.deleteMany({ organizationId: { $in: both } });
    await CrmLocationAudit.collection.deleteMany({ organizationId: { $in: both } });
    await CrmUser.collection.deleteMany({ organizationId: { $in: both } });
    await Lead.collection.deleteMany({ organizationId: { $in: both } });
    await Vehicle.collection.deleteMany({ organizationId: { $in: both } });
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
  });

  describe('permissions and organization isolation', () => {
    it('admins manage, managers only read, employees cannot see locations', async () => {
      await get('', 'employee').expect(403);
      await get('/suggestions', 'employee').expect(403);
      await create('manager', { code: 'mgr', name: 'Manager Try' }).expect(403);
      const created = (await create('admin', { code: 'perm-test', name: 'Permission Test' }).expect(201)).body.data.location;
      await patch(`/${created.id}`, 'manager', { location: { name: 'Changed' }, expectedRevision: 1 }).expect(403);
      await post(`/${created.id}/archive`, 'manager', { expectedRevision: 1 }).expect(403);
      await post(`/${created.id}/restore`, 'employee', { expectedRevision: 1 }).expect(403);
      const managerView = (await get('', 'manager').expect(200)).body.data;
      expect(managerView.canManage).toBe(false);
      expect(managerView.locations.some((loc: any) => loc.id === created.id)).toBe(true);
      expect((await get(`/${created.id}`, 'manager').expect(200)).body.data.location.name).toBe('Permission Test');
      expect((await get('', 'admin').expect(200)).body.data.canManage).toBe(true);
    });

    it('other organizations cannot see, change or collide with these locations', async () => {
      const own = (await create('admin', { code: 'shared-code', name: 'Shared Name' }).expect(201)).body.data.location;
      await get(`/${own.id}`, 'otherAdmin').expect(404);
      await patch(`/${own.id}`, 'otherAdmin', { location: { name: 'Hijack' }, expectedRevision: 1 }).expect(404);
      await post(`/${own.id}/archive`, 'otherAdmin', { expectedRevision: 1 }).expect(404);
      expect((await get('?status=all', 'otherAdmin').expect(200)).body.data.locations.some((loc: any) => loc.id === own.id)).toBe(false);
      await create('otherAdmin', { code: 'shared-code', name: 'Shared Name' }).expect(201);
      await get('/not-an-id', 'admin').expect(404);
    });
  });

  describe('codes and aliases', () => {
    it('location codes are unique per organization, case-insensitive and cannot be changed', async () => {
      const first = (await create('admin', { code: 'orem', name: 'Orem', aliases: ['Orem UT'] }).expect(201)).body.data.location;
      expect(first).toMatchObject({ code: 'orem', name: 'Orem', aliases: ['Orem UT'], status: 'active', revision: 1 });
      expect((await create('admin', { code: 'OREM', name: 'Orem Two' }).expect(409)).body.errors[0].code).toBe('code_taken');
      const res = await patch(`/${first.id}`, 'admin', { location: { code: 'orem-new' }, expectedRevision: 1 }).expect(400);
      expect(res.body.errors.map((e: any) => e.code)).toContain('code_immutable');
      for (const bad of ['-x', 'has space', 'a', 'x'.repeat(41)]) await create('admin', { code: bad, name: 'Bad Code' }).expect(400);
    });

    it('names and aliases cannot be shared between locations, including archived ones and spelling variants', async () => {
      const taken = await create('admin', { code: 'orem-2', name: 'Second', aliases: ['orem, ut'] }).expect(409);
      expect(taken.body.errors[0].code).toBe('alias_taken');
      await create('admin', { code: 'second', name: 'OREM' }).expect(409);
      const lehi = (await create('admin', { code: 'lehi', name: 'Lehi' }).expect(201)).body.data.location;
      await post(`/${lehi.id}/archive`, 'admin', { expectedRevision: 1 }).expect(200);
      await create('admin', { code: 'lehi-2', name: 'Lehi Store', aliases: ['LEHI'] }).expect(409);
      const af = (await create('admin', { code: 'af', name: 'American Fork' }).expect(201)).body.data.location;
      await patch(`/${af.id}`, 'admin', { location: { aliases: ['Orem UT'] }, expectedRevision: 1 }).expect(409);
    });

    it('only one of two simultaneous creates with the same code succeeds', async () => {
      const results = await Promise.all([
        create('admin', { code: 'race', name: 'Race One' }),
        create('admin', { code: 'race', name: 'Race Two' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await CrmLocation.countDocuments({ organizationId: String(orgA), code: 'race' })).toBe(1);
    });

    it('rejects contact details and record references in names and aliases', async () => {
      for (const location of [
        { code: 'c1', name: 'Orem 801-555-1234' },
        { code: 'c2', name: 'Store', aliases: ['sales@dealer.com'] },
        { code: 'c3', name: 'Store', aliases: ['www.dealer.com'] },
        { code: 'c4', name: '1HGCM82633A004352' },
      ]) {
        await create('admin', location).expect(400);
      }
    });

    it('database indexes enforce code and alias uniqueness', async () => {
      const indexes = await CrmLocation.collection.indexes();
      expect(indexes.find((i: any) => i.name === 'crm_location_org_code')).toMatchObject({ key: { organizationId: 1, code: 1 }, unique: true });
      expect(indexes.find((i: any) => i.name === 'crm_location_org_alias')).toMatchObject({ key: { organizationId: 1, aliasKeys: 1 }, unique: true });
      const actor = { userId: 'x', name: 'x', role: 'admin' };
      await expect(CrmLocation.collection.insertOne({ organizationId: String(orgA), code: 'raw-dup', name: 'Raw', aliases: [], aliasKeys: ['orem'], status: 'active', revision: 1, createdBy: actor, updatedBy: actor } as any))
        .rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('changes, history and limits', () => {
    it('edits need the current revision, are recorded in an append-only history and skip no-op saves', async () => {
      const loc = (await create('admin', { code: 'hist', name: 'History Store' }).expect(201)).body.data.location;
      await patch(`/${loc.id}`, 'admin', { location: { name: 'History Store' } }).expect(400);
      const same = (await patch(`/${loc.id}`, 'admin', { location: { name: 'History Store' }, expectedRevision: 1 }).expect(200)).body.data;
      expect(same).toMatchObject({ changed: false, location: { revision: 1 } });
      const edited = (await patch(`/${loc.id}`, 'admin', { location: { name: 'History Store North', aliases: ['HSN'] }, expectedRevision: 1 }).expect(200)).body.data;
      expect(edited).toMatchObject({ changed: true, location: { name: 'History Store North', aliases: ['HSN'], revision: 2 } });
      await patch(`/${loc.id}`, 'admin', { location: { name: 'Stale Edit' }, expectedRevision: 1 }).expect(409);
      await post(`/${loc.id}/archive`, 'admin', { expectedRevision: 2 }).expect(200);
      await patch(`/${loc.id}`, 'admin', { location: { name: 'While Archived' }, expectedRevision: 3 }).expect(409);
      await post(`/${loc.id}/archive`, 'admin', { expectedRevision: 3 }).expect(409);
      await post(`/${loc.id}/restore`, 'admin', { expectedRevision: 3 }).expect(200);
      const detail = (await get(`/${loc.id}`, 'manager').expect(200)).body.data;
      expect(detail.location).toMatchObject({ status: 'active', revision: 4 });
      expect(detail.history.map((h: any) => [h.revision, h.action, h.actorName])).toEqual([
        [4, 'restored', 'Admin One'], [3, 'archived', 'Admin One'], [2, 'updated', 'Admin One'], [1, 'created', 'Admin One'],
      ]);
      expect(detail.history[2]).toMatchObject({ before: { name: 'History Store', aliases: [] }, after: { name: 'History Store North', aliases: ['HSN'] } });
      const row: any = await CrmLocationAudit.findOne({ locationId: loc.id });
      await expect(row.updateOne({ $set: { action: 'created' } })).rejects.toBeInstanceOf(AppendOnlyViolationError);
      await expect(CrmLocationAudit.deleteMany({ locationId: loc.id })).rejects.toBeInstanceOf(AppendOnlyViolationError);
    });

    it('archived locations are listed separately', async () => {
      const list = (await get('?status=archived', 'admin').expect(200)).body.data;
      expect(list.locations.every((loc: any) => loc.status === 'archived')).toBe(true);
      expect(list.counts.archived).toBeGreaterThan(0);
      await get('?status=deleted', 'admin').expect(400);
    });

    it('limits each organization to 100 locations', async () => {
      const existing = await CrmLocation.countDocuments({ organizationId: String(orgB) });
      const actor = { userId: 'x', name: 'x', role: 'admin' };
      await CrmLocation.collection.insertMany(Array.from({ length: 100 - existing }, (_, i) => ({
        organizationId: String(orgB), code: `fill-${i}`, name: `Fill ${i}`, aliases: [], aliasKeys: [`fill ${i}`], status: 'active', revision: 1, createdBy: actor, updatedBy: actor,
      })) as any[]);
      expect((await create('otherAdmin', { code: 'one-more', name: 'One More' }).expect(409)).body.message).toContain('100 locations');
      await CrmLocation.collection.deleteMany({ organizationId: String(orgB), code: /^fill-/ });
    });
  });

  describe('suggestions and existing data', () => {
    it('suggests labels already used in this organization and shows which are mapped', async () => {
      const suggestions = (await get('/suggestions', 'manager').expect(200)).body.data.suggestions;
      const byKey = Object.fromEntries(suggestions.map((s: any) => [s.key, s]));
      expect(byKey.orem).toMatchObject({ leadCount: 3, vehicleCount: 1, mapped: { code: 'orem' } });
      expect(byKey['orem ut']).toMatchObject({ vehicleCount: 1, mapped: { code: 'orem' } });
      expect(byKey.lehi).toMatchObject({ leadCount: 1, mapped: { code: 'lehi', status: 'archived' } });
      expect(byKey['spanish fork']).toMatchObject({ vehicleCount: 1, mapped: null, usable: true });
      expect(byKey['american fork']).toMatchObject({ inReviewLinks: true, mapped: { code: 'af' } });
      expect(byKey.provo).toBeUndefined();
      const firstMapped = suggestions.findIndex((s: any) => s.mapped);
      expect(suggestions.slice(0, firstMapped).every((s: any) => !s.mapped)).toBe(true);
    });

    it('a full location session never writes to leads, vehicles or organization settings', async () => {
      const before = await outsideSnapshot();
      const loc = (await create('admin', { code: 'side', name: 'Side Effects', aliases: ['Spanish Fork'] }).expect(201)).body.data.location;
      await patch(`/${loc.id}`, 'admin', { location: { aliases: ['Spanish Fork', 'SF'] }, expectedRevision: 1 }).expect(200);
      await post(`/${loc.id}/archive`, 'admin', { expectedRevision: 2 }).expect(200);
      await post(`/${loc.id}/restore`, 'admin', { expectedRevision: 3 }).expect(200);
      await get('/suggestions', 'admin').expect(200);
      expect(await outsideSnapshot()).toBe(before);
    });
  });
});
