jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), generateAuthUrl: jest.fn(), getToken: jest.fn() })) },
    calendar: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: jest.fn(),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import Vehicle from '../src/models/Vehicle.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const ORG_A = String(orgA);
const ORG_B = String(orgB);
const ids = { owner: new mongoose.Types.ObjectId(), employee: new mongoose.Types.ObjectId(), other: new mongoose.Types.ObjectId() };
const tokens: Record<string, string> = {};
const v: Record<string, mongoose.Types.ObjectId> = {};

const VIN = {
  accord: '1HGCM82633A004352',
  tacomaOne: '3TMCZ5AN1MM000001',
  tacomaTwo: '3TMCZ5AN1MM000002',
  f150: '1FTEW1EP5KF000004',
  dupOne: '1GCUYDED5MZ000005',
  dupTwo: '1GCUYDED5MZ000006',
  deleted: '1N4BL4BV5LC000007',
  outback: '4S4BTAPC5L3000008',
  tesla: '5YJ3E1EA7KF000009',
};

const preview = (leadId: unknown, who = 'employee') =>
  request(app).get(`/api/leads/${leadId}/vehicle-preview`).set({ Authorization: `Bearer ${tokens[who]}` });

async function makeLead(fields: Record<string, unknown>, organizationId = orgA) {
  return Lead.create({
    organizationId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: '+18015550199',
    source: 'Third-Party Lead', channel: 'adf', status: 'New', ...fields,
  });
}

async function addVehicle(key: string, doc: Record<string, unknown>) {
  const result = await Vehicle.collection.insertOne({
    organizationId: ORG_A, status: 'Ready for Sale', isDeleted: false, isArchived: false, images: [], createdAt: new Date(), updatedAt: new Date(), ...doc,
  } as any);
  v[key] = result.insertedId as any;
}

async function addInquiry(leadId: unknown, vehicle: Record<string, unknown>, state = 'associated', receivedAt = new Date()) {
  await LeadInquiry.collection.insertOne({
    organizationId: orgA, kind: 'inquiry', receivedAt, vehicle, sourceIds: {}, association: { state, leadId },
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
}

describe('Real-DB: vehicle of interest preview (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Summit Motors', slug: `vp-${orgA}`, status: 'active', metadata: {} },
      { _id: orgB, name: 'Other Motors', slug: `vp-${orgB}`, status: 'active', metadata: {} },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.employee, organizationId: orgA, fullName: 'Erin Employee', username: `vp-${ids.employee}`, email: `vp-emp-${orgA}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.other, organizationId: orgB, fullName: 'Other Person', username: `vp-${ids.other}`, email: `vp-other-${orgA}@example.com`, role: 'admin', isActive: true, password: 'x' },
    ] as any[]);
    tokens.employee = generateCrmToken(String(ids.employee));
    tokens.other = generateCrmToken(String(ids.other));

    await addVehicle('accord', { vin: VIN.accord, year: 2021, make: 'Honda', modelName: 'Accord', trim: 'EX', stockNumber: 'A100', price: 23995, mileage: 15210, exteriorColor: 'Blue', images: ['https://img.example.com/accord-1.jpg', 'https://img.example.com/accord-2.jpg'], cost: 19000 });
    await addVehicle('tacomaOne', { vin: VIN.tacomaOne, year: 2021, make: 'Toyota', modelName: 'Tacoma', stockNumber: 'T200' });
    await addVehicle('tacomaTwo', { vin: VIN.tacomaTwo, year: 2021, make: 'Toyota', modelName: 'Tacoma', stockNumber: 'T201', price: 31995 });
    await addVehicle('f150', { vin: VIN.f150, year: 2019, make: 'Ford', modelName: 'F-150', stockNumber: 'F400', price: 27995, status: 'Sold', isArchived: true, archivedAt: new Date('2026-10-20T15:00:00Z') });
    await addVehicle('dupOne', { vin: VIN.dupOne, year: 2021, make: 'Chevrolet', modelName: 'Silverado', stockNumber: 'DUP1' });
    await addVehicle('dupTwo', { vin: VIN.dupTwo, year: 2022, make: 'Chevrolet', modelName: 'Colorado', stockNumber: 'dup1' });
    await addVehicle('deleted', { vin: VIN.deleted, year: 2020, make: 'Nissan', modelName: 'Altima', stockNumber: 'DEL7', isDeleted: true });
    await addVehicle('outback', { vin: VIN.outback, year: 2020, make: 'Subaru', modelName: 'Outback', stockNumber: 'S800', status: 'In Recon' });
    const tesla = await Vehicle.collection.insertOne({ organizationId: ORG_B, vin: VIN.tesla, year: 2019, make: 'Tesla', modelName: 'Model 3', stockNumber: 'A100', price: 29995, status: 'Ready for Sale', isDeleted: false, isArchived: false, images: ['https://img.example.com/tesla.jpg'] } as any);
    v.tesla = tesla.insertedId as any;
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('shows the linked vehicle from a direct vehicle page, even when similar units exist', async () => {
    const lead = await makeLead({ source: 'Website Booking', channel: 'web', vehicleId: v.tacomaOne, vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' } });
    const res = await preview(lead._id);
    expect(res.status).toBe(200);
    expect(res.body.data.primary).toMatchObject({ state: 'matched', match: 'linked', vehicle: { id: String(v.tacomaOne), stockNumber: 'T200' } });
  });

  it('matches by VIN and returns the trusted inventory fields only', async () => {
    const lead = await makeLead({ vehicle: { year: '2021', make: 'Honda', model: 'Accord', vin: VIN.accord.toLowerCase() } });
    const res = await preview(lead._id);
    const { primary } = res.body.data;
    expect(primary).toMatchObject({ state: 'matched', match: 'vin', label: '2021 Honda Accord' });
    expect(primary.vehicle).toEqual({
      id: String(v.accord), year: 2021, make: 'Honda', model: 'Accord', trim: 'EX', vin: VIN.accord, stockNumber: 'A100',
      mileage: 15210, price: 23995, exteriorColor: 'Blue', photoUrl: 'https://img.example.com/accord-1.jpg', status: 'Ready for Sale',
      availability: 'listed', archivedAt: null, inventoryPath: `/inventory?search=${VIN.accord}`,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/19000|cost/);
  });

  it('matches by stock number and leaves missing photo and price empty', async () => {
    const lead = await makeLead({ vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma', stock: 't200' } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'matched', match: 'stock', vehicle: { id: String(v.tacomaOne), photoUrl: null, price: null, mileage: null } });
  });

  it('returns nothing for a lead with no vehicle information', async () => {
    const lead = await makeLead({});
    const res = await preview(lead._id);
    expect(res.body.data).toEqual({ leadId: String(lead._id), primary: null, others: [] });
  });

  it('never guesses from year, make and model when several units fit', async () => {
    const lead = await makeLead({ vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'unconfirmed', reason: 'no_identifier', similarCount: 2, vehicle: null, searchPath: '/inventory?make=Toyota&model=Tacoma&year=2021' });
  });

  it('does not treat a guessed inventory link as confirmed when several units fit', async () => {
    const lead = await makeLead({ vehicleId: v.tacomaTwo, vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'unconfirmed', reason: 'not_verified', similarCount: 2, vehicle: null });
    expect(JSON.stringify(res.body)).not.toMatch(/31995|T201/);
  });

  it('accepts a link that is the only unit fitting the lead', async () => {
    const lead = await makeLead({ vehicleId: v.outback, vehicle: { year: '2020', make: 'Subaru', model: 'Outback' } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'matched', match: 'linked', vehicle: { availability: 'recon', status: 'In Recon' } });
  });

  it('treats a duplicate stock number as unconfirmed', async () => {
    const lead = await makeLead({ vehicle: { make: 'Chevrolet', stock: 'DUP1' } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'unconfirmed', reason: 'duplicate_stock', vehicle: null });
  });

  it('lets the lead VIN win over a conflicting link', async () => {
    const lead = await makeLead({ vehicleId: v.accord, vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma', vin: VIN.tacomaOne } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'matched', match: 'vin', vehicle: { id: String(v.tacomaOne) } });
  });

  it('reflects a sold or archived vehicle without hiding it', async () => {
    const lead = await makeLead({ status: 'Sold', vehicle: { year: '2019', make: 'Ford', model: 'F-150', vin: VIN.f150 } });
    const res = await preview(lead._id);
    expect(res.body.data.primary.vehicle).toMatchObject({ availability: 'archived', status: 'Sold', archivedAt: '2026-10-20T15:00:00.000Z', inventoryPath: `/inventory?search=${VIN.f150}&view=archived` });
  });

  it('treats a deleted vehicle as not in inventory', async () => {
    const lead = await makeLead({ vehicle: { year: '2020', make: 'Nissan', model: 'Altima', vin: VIN.deleted } });
    const res = await preview(lead._id);
    expect(res.body.data.primary).toMatchObject({ state: 'not_found', reason: 'vin', vehicle: null });
  });

  it('never returns another organization’s vehicle by VIN, stock or link', async () => {
    const byVin = await makeLead({ vehicle: { year: '2019', make: 'Tesla', model: 'Model 3', vin: VIN.tesla } });
    const byLink = await makeLead({ vehicleId: v.tesla, vehicle: { year: '2019', make: 'Tesla', model: 'Model 3' } });
    const byStock = await makeLead({ vehicle: { stock: 'A100' } });
    const vinRes = await preview(byVin._id);
    const linkRes = await preview(byLink._id);
    const stockRes = await preview(byStock._id);
    expect(vinRes.body.data.primary).toMatchObject({ state: 'not_found', reason: 'vin', vehicle: null });
    expect(linkRes.body.data.primary).toMatchObject({ state: 'not_found', reason: 'linked', vehicle: null });
    expect(stockRes.body.data.primary.vehicle.id).toBe(String(v.accord));
    for (const res of [vinRes, linkRes, stockRes]) expect(JSON.stringify(res.body)).not.toMatch(/29995|tesla\.jpg/);
  });

  it('keeps every vehicle the customer asked about, without duplicates or other leads', async () => {
    const lead = await makeLead({ vehicle: { year: '2021', make: 'Honda', model: 'Accord', vin: VIN.accord } });
    const otherLead = await makeLead({ vehicle: { year: '2020', make: 'Subaru', model: 'Outback' } });
    await addInquiry(lead._id, { year: '2021', make: 'Honda', model: 'Accord', vin: VIN.accord }, 'associated', new Date('2026-10-01T10:00:00Z'));
    await addInquiry(lead._id, { year: '2019', make: 'Ford', model: 'F-150', stock: 'F400' }, 'associated', new Date('2026-10-02T10:00:00Z'));
    await addInquiry(lead._id, { year: '2020', make: 'Subaru', model: 'Outback' }, 'associated', new Date('2026-10-03T10:00:00Z'));
    await addInquiry(lead._id, { year: '2022', make: 'Kia', model: 'Telluride' }, 'pending_review', new Date('2026-10-04T10:00:00Z'));
    await addInquiry(otherLead._id, { year: '2021', make: 'Toyota', model: 'Tacoma', vin: VIN.tacomaTwo });
    const res = await preview(lead._id);
    const { primary, others } = res.body.data;
    expect(primary).toMatchObject({ state: 'matched', match: 'vin', vehicle: { id: String(v.accord) } });
    expect(others.map((entry: any) => entry.label)).toEqual(['2019 Ford F-150', '2020 Subaru Outback']);
    expect(others[0]).toMatchObject({ origin: 'inquiry', state: 'matched', match: 'stock', vehicle: { availability: 'archived' }, receivedAt: '2026-10-02T10:00:00.000Z' });
    expect(others[1]).toMatchObject({ state: 'unconfirmed', reason: 'no_identifier', similarCount: 1, vehicle: null });
    expect(JSON.stringify(res.body)).not.toMatch(/Telluride|T201/);
  });

  it('is read-only', async () => {
    const lead = await makeLead({ vehicleId: v.tacomaTwo, vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma', vin: VIN.accord } });
    const leadBefore: any = await Lead.findById(lead._id).lean();
    const vehiclesBefore = await Vehicle.find({}).sort({ _id: 1 }).lean();
    await preview(lead._id);
    const leadAfter: any = await Lead.findById(lead._id).lean();
    expect(leadAfter.updatedAt.toISOString()).toBe(leadBefore.updatedAt.toISOString());
    expect(String(leadAfter.vehicleId)).toBe(String(v.tacomaTwo));
    expect(leadAfter.vehicle).toEqual(leadBefore.vehicle);
    expect(await Vehicle.find({}).sort({ _id: 1 }).lean()).toEqual(vehiclesBefore);
  });

  it('requires sign-in and keeps leads inside their organization', async () => {
    const lead = await makeLead({ vehicle: { vin: VIN.accord } });
    expect((await request(app).get(`/api/leads/${lead._id}/vehicle-preview`)).status).toBe(401);
    expect((await preview(lead._id, 'other')).status).toBe(404);
    expect((await preview('not-an-id')).status).toBe(404);
    const otherOrgLead = await makeLead({ vehicle: { vin: VIN.tesla } }, orgB);
    expect((await preview(otherOrgLead._id)).status).toBe(404);
    const own = await preview(otherOrgLead._id, 'other');
    expect(own.status).toBe(200);
    expect(own.body.data.primary.vehicle.id).toBe(String(v.tesla));
    expect(ORG_B).not.toBe(ORG_A);
  });
});
