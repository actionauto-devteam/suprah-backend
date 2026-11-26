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
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import Vehicle from '../src/models/Vehicle.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import UserActivity from '../src/models/UserActivity.model';
import { updateLeadDetails } from '../src/controllers/lead.controller';
import { searchLeadVehiclesHandler } from '../src/controllers/leadVehiclePick.controller';
import { searchInventoryForLead } from '../src/services/leadVehiclePick.service';
import { getLeadVehiclePreview } from '../src/services/leadVehiclePreview.service';

const orgId = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const staff = { _id: new mongoose.Types.ObjectId(), name: 'Staff', email: 'staff@example.com', role: 'admin' };
const ids = {
  camry: new mongoose.Types.ObjectId(),
  civic: new mongoose.Types.ObjectId(),
  deleted: new mongoose.Types.ObjectId(),
  archived: new mongoose.Types.ObjectId(),
  foreign: new mongoose.Types.ObjectId(),
};

function car(id: mongoose.Types.ObjectId, org: mongoose.Types.ObjectId, fields: Record<string, unknown>) {
  return { _id: id, organizationId: String(org), isDeleted: false, isArchived: false, status: 'Ready for Sale', createdAt: new Date(), updatedAt: new Date(), ...fields };
}

function response() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function saveDetails(leadId: unknown, body: Record<string, unknown>) {
  const res = response();
  await updateLeadDetails({ orgId: ORG, params: { id: String(leadId) }, body, user: staff, ip: '127.0.0.1' } as any, res);
  return res;
}

async function newLead(vehicle: Record<string, string>) {
  return Lead.create({
    organizationId: orgId,
    createdBy: staff._id,
    firstName: 'Vera',
    lastName: 'Picker',
    phone: '+18015550177',
    source: 'SMS',
    channel: 'sms',
    status: 'Contacted',
    comments: '',
    vehicle,
  } as any);
}

describe('Real-DB: picking the lead vehicle from inventory (local MongoDB only)', () => {
  beforeAll(async () => {
    await Vehicle.collection.insertMany([
      car(ids.camry, orgId, { year: 2022, make: 'Toyota', modelName: 'Camry', trim: 'SE', vin: '4T1G11AK5NU000001', stockNumber: 'P78T2', price: 24995, mileage: 31000 }),
      car(ids.civic, orgId, { year: 2023, make: 'Honda', modelName: 'Civic', trim: 'Sport', vin: '2HGFE2F59PH000002', stockNumber: 'H2301', price: 23500, mileage: 12000, status: 'In Recon' }),
      car(ids.deleted, orgId, { year: 2022, make: 'Toyota', modelName: 'Camry', vin: '4T1G11AK5NU000003', stockNumber: 'DEL1', isDeleted: true }),
      car(ids.archived, orgId, { year: 2022, make: 'Toyota', modelName: 'Camry', vin: '4T1G11AK5NU000004', stockNumber: 'ARC1', isArchived: true }),
      car(ids.foreign, otherOrg, { year: 2022, make: 'Toyota', modelName: 'Camry', vin: '4T1G11AK5NU000005', stockNumber: 'P78T9' }),
    ] as any[]);
  });

  it('finds vehicles by stock, VIN, or year and model, only in this dealership\'s current inventory', async () => {
    const byStock = await searchInventoryForLead(ORG, 'p78t');
    expect(byStock.map((v) => v.id)).toEqual([String(ids.camry)]);
    expect(byStock[0]).toMatchObject({ year: 2022, make: 'Toyota', model: 'Camry', trim: 'SE', stockNumber: 'P78T2', price: 24995, status: 'Ready for Sale', availability: 'listed' });
    expect((await searchInventoryForLead(ORG, '000002')).map((v) => v.id)).toEqual([String(ids.civic)]);
    expect((await searchInventoryForLead(ORG, '2022 camry')).map((v) => v.id)).toEqual([String(ids.camry)]);
    expect((await searchInventoryForLead(ORG, 'honda   sport')).map((v) => v.id)).toEqual([String(ids.civic)]);
  });

  it('needs at least 2 characters and treats symbols as plain text', async () => {
    expect(await searchInventoryForLead(ORG, 'c')).toEqual([]);
    expect(await searchInventoryForLead(ORG, '   ')).toEqual([]);
    expect(await searchInventoryForLead(ORG, 'P78.*')).toEqual([]);
    expect(await searchInventoryForLead('not-an-id', 'camry')).toEqual([]);
  });

  it('answers through the lead screen search handler for signed-in staff only', async () => {
    const res = response();
    const next = jest.fn();
    searchLeadVehiclesHandler({ orgId: ORG, user: staff, query: { q: 'civic' } } as any, res, next);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(next).not.toHaveBeenCalled();
    expect(res.body.data.map((v: any) => v.id)).toEqual([String(ids.civic)]);

    const blocked = jest.fn();
    searchLeadVehiclesHandler({ orgId: ORG, query: { q: 'civic' } } as any, response(), blocked);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blocked.mock.calls[0][0].statusCode).toBe(401);
  });

  it('copies the picked vehicle from inventory, links it, and keeps the earlier inquiry vehicle under Also asked about', async () => {
    const lead = await newLead({ year: '2023', make: 'Honda', model: 'Civic' });
    await LeadInquiry.collection.insertOne({
      organizationId: orgId,
      kind: 'provider_inquiry',
      receivedAt: new Date(Date.now() - 60_000),
      vehicle: { year: '2023', make: 'Honda', model: 'Civic' },
      association: { leadId: lead._id, state: 'associated' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res = await saveDetails(lead._id, { vehicleId: String(ids.camry) });
    expect(res.statusCode).toBe(200);

    const saved: any = await Lead.findById(lead._id).lean();
    expect(String(saved.vehicleId)).toBe(String(ids.camry));
    expect(saved.vehicle).toMatchObject({ year: '2022', make: 'Toyota', model: 'Camry', trim: 'SE', vin: '4T1G11AK5NU000001', stock: 'P78T2', price: '24995', odometer: '31000' });

    const preview = await getLeadVehiclePreview(ORG, lead._id);
    expect(preview.primary).toMatchObject({ state: 'matched', match: 'linked' });
    expect(preview.primary?.vehicle?.id).toBe(String(ids.camry));
    expect(preview.others.map((entry) => entry.label)).toContain('2023 Honda Civic');

    const activity: any = await UserActivity.findOne({ 'metadata.leadId': String(lead._id), 'metadata.activityKind': 'lead_details_update' }).lean();
    expect(activity.metadata.vehicleChange).toEqual({ from: '2023 Honda Civic', to: '2022 Toyota Camry #P78T2', vehicleId: String(ids.camry) });
  });

  it('uses the inventory details even if other vehicle text is sent with the pick', async () => {
    const lead = await newLead({ year: '2020', make: 'Ford', model: 'F-150' });
    const res = await saveDetails(lead._id, { vehicleId: String(ids.civic), vehicle: { year: '1999', make: 'Fake', model: 'Car' } });
    expect(res.statusCode).toBe(200);
    const saved: any = await Lead.findById(lead._id).lean();
    expect(saved.vehicle).toMatchObject({ year: '2023', make: 'Honda', model: 'Civic', stock: 'H2301' });
  });

  it('refuses a vehicle from another dealership, a deleted vehicle or a bad id, and leaves the lead as it was', async () => {
    const lead = await newLead({ year: '2021', make: 'Kia', model: 'Soul' });
    for (const vehicleId of [String(ids.foreign), String(ids.deleted), 'nope', '']) {
      const res = await saveDetails(lead._id, { vehicleId });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('That vehicle is not in your inventory. Search again and pick it from the list.');
    }
    const saved: any = await Lead.findById(lead._id).lean();
    expect(saved.vehicleId ?? null).toBeNull();
    expect(saved.vehicle).toMatchObject({ year: '2021', make: 'Kia', model: 'Soul' });
  });
});
