/**
 * Condition report photos linked to damaged parts (optional), through the real
 * endpoints: the driver can say which part a photo shows, Dispatch sees it,
 * and a photo without a part works exactly as before.
 *
 * Data safety (same as load-flow): every record is created under this suite's
 * own organization and users and removed afterwards; file storage is stubbed.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Load from '../src/models/Load.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';
import { invalidateActiveOrganizations } from '../src/services/activeOrganizations.service';

const TEST_ORG_SLUG = 'condition-photo-parts-test-org';
const TEST_EMAIL_DOMAIN = '@condition-photo-parts-test.com';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let org: any;
let loadId: string;
let driverToken: string;
let dispatcherToken: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const photo = (vehicle: number, area?: string) => {
  const req = request(app)
    .post(`/api/driver-tracking/loads/${loadId}/condition/pickup/${vehicle}/photos`)
    .set(auth(driverToken));
  if (area !== undefined) req.field('area', area);
  return req.attach('proof', PNG, 'photo.png');
};

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  let n = 0;
  jest.spyOn(storageService, 'upload').mockImplementation(async () => `condition-report/parts-${n++}.png`);
  jest.spyOn(storageService, 'getSignedUrl').mockResolvedValue('https://signed.example/part.png');
  jest.spyOn(storageService, 'delete').mockResolvedValue(undefined as any);

  await Organization.deleteMany({ slug: TEST_ORG_SLUG });
  await User.deleteMany({ email: { $regex: /@condition-photo-parts-test\.com$/ } });
  org = await Organization.create({ name: 'Condition Photo Parts Test Org', slug: TEST_ORG_SLUG, status: 'active' });
  invalidateActiveOrganizations();
  const dispatcher = await User.create({ email: `dispatcher${TEST_EMAIL_DOMAIN}`, name: 'Dispatcher', role: 'admin', organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true });
  const driver = await User.create({ email: `driver${TEST_EMAIL_DOMAIN}`, name: 'Parts Driver', role: 'driver', emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true });
  await DriverProfile.create({ userId: driver._id, operationalStatus: 'active', verificationStatus: 'verified', trailerType: 'open_2car', maxVehicleCapacity: 2 });
  dispatcherToken = tokenService.generateAccessToken(dispatcher as any);
  driverToken = tokenService.generateAccessToken(driver as any);
  const load = await Load.create({
    organizationId: org._id,
    createdBy: dispatcher._id,
    dispatchOwnerId: dispatcher._id,
    postType: 'assign-carrier',
    status: 'Accepted',
    assignedDriverId: driver._id,
    pickupLocation: { address: '1 A St', city: 'Ogden', state: 'UT', zip: '84401' },
    deliveryLocation: { address: '2 B St', city: 'Boise', state: 'ID', zip: '83702' },
    vehicles: [
      { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
      { year: 2019, make: 'Honda', model: 'Civic', condition: 'Operable' },
    ],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'private' },
  });
  loadId = String(load._id);
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await Load.deleteMany({ organizationId: org?._id });
  const users = await User.find({ email: { $regex: /@condition-photo-parts-test\.com$/ } }).select('_id');
  await DriverProfile.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await Organization.deleteMany({ _id: org?._id });
  await mongoose.disconnect();
});

describe('Condition photos of damaged parts', () => {
  it('saves which part a photo shows, and photos without a part work as before', async () => {
    const general = await photo(0).expect(200);
    expect(general.body.data.photos[0]).toMatchObject({ area: null });

    const hood = await photo(0, 'hood').expect(200);
    expect(hood.body.data.photos.map((p: any) => p.area)).toEqual([null, 'hood']);

    // Saving the damage marks keeps the part photos.
    const saved = await request(app)
      .put(`/api/driver-tracking/loads/${loadId}/condition/pickup/0`)
      .set(auth(driverToken))
      .send({ damageAreas: ['hood'], damageTypes: ['dent'], note: '' })
      .expect(200);
    expect(saved.body.data.photos.map((p: any) => p.area)).toEqual([null, 'hood']);
  });

  it('refuses a part that is not on the outline, in plain words', async () => {
    const res = await photo(1, 'spaceship').expect(400);
    expect(res.body.message).toBe('Choose which part of the vehicle this photo shows from the list, or leave it blank.');
    const stored: any = await Load.findById(loadId).lean();
    expect((stored.conditionReports ?? []).filter((r: any) => r.vehicleIndex === 1)).toHaveLength(0);
  });

  it('Dispatch sees which part each photo shows', async () => {
    const res = await request(app).get(`/api/loads/${loadId}`).set(auth(dispatcherToken)).expect(200);
    const load = res.body.data.load ?? res.body.data;
    const report = (load.conditionReports ?? []).find((r: any) => r.stop === 'pickup' && r.vehicleIndex === 0);
    expect(report.photos.map((p: any) => p.area)).toEqual([null, 'hood']);
    expect(JSON.stringify(report)).not.toMatch(/"key"/);
  });
});
