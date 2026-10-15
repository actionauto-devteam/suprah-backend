/**
 * Driver & dispatch improvements — integration checks through the real endpoints:
 *   - account approval: unapproved drivers can't be given loads; a super admin
 *     approves an application right away without documents
 *   - one pending application per driver, even from two devices at once
 *   - "I've arrived", the optional vehicle condition report and the customer
 *     signature across the whole load lifecycle
 *   - what Dispatch, load lists and the driver each get back
 *   - Needs attention, the driver's "expires soon" notice
 *   - inspection photo keys on edit, and photo clean-up when a load is deleted
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
import DriverRequest from '../src/models/DriverRequest.model';
import DriverReviewEvent from '../src/models/DriverReviewEvent.model';
import DriverLocation from '../src/models/DriverLocation.model';
import Notification from '../src/models/Notification.model';
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';
import { setLifecycleOutboxRequestFlushMode } from '../src/services/loadLifecycleOutbox.service';
import * as socketEmitter from '../src/utils/socketEmitter';

const TEST_ORG_SLUG = 'dispatch-improvements-test-org';
const TEST_EMAIL_DOMAIN = '@dispatch-improvements-test.com';

// Smallest valid PNG, so upload content validation (magic bytes) passes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const signatureFor = (signerName: string) => ({ agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName });

let org: any;
let dispatcher: any;
let dispatcherToken: string;
let superAdmin: any;
let superAdminToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const reload = (id: unknown) => Load.findById(id);
const currentVersion = async (id: unknown) =>
  ((await Load.findById(id).select('updatedAt').lean()) as any).updatedAt.toISOString();

async function createDriver(label: string, approved = true) {
  const user = await User.create({
    email: `${label}${TEST_EMAIL_DOMAIN}`,
    name: `Driver ${label}`,
    role: 'driver',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: approved,
  });
  await DriverProfile.create({
    userId: user._id,
    maxVehicleCapacity: 5,
    operationalStatus: 'active',
    verificationStatus: approved ? 'verified' : 'in_progress',
  });
  return { user, token: tokenService.generateAccessToken(user as any) };
}

// Someone applying to drive (the application endpoint is for accounts that
// aren't drivers yet; drivers who sign up get theirs created automatically).
async function createApplicant(label: string) {
  const user = await User.create({
    email: `${label}${TEST_EMAIL_DOMAIN}`,
    name: `Applicant ${label}`,
    role: 'customer',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  await DriverProfile.create({ userId: user._id, operationalStatus: 'active', verificationStatus: 'in_progress' });
  return { user, token: tokenService.generateAccessToken(user as any) };
}

async function seedLoad(overrides: Record<string, unknown> = {}) {
  return Load.create({
    organizationId: org._id,
    createdBy: dispatcher._id,
    postType: 'assign-carrier',
    status: 'Posted',
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [
      { year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' },
      { year: 2019, make: 'Honda', model: 'Civic', condition: 'Operable' },
    ],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'private' },
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
    contract: { agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName: 'Dispatcher' },
    ...overrides,
  });
}

const assign = (loadId: unknown, driverId: unknown) =>
  request(app)
    .post('/api/driver-tracking/assign-load')
    .set(auth(dispatcherToken))
    .send({ loadId: String(loadId), driverId: String(driverId), overrideAvailability: true, overrideCapacity: true });

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  setLifecycleOutboxRequestFlushMode('inline');

  const oldOrgs = await Organization.find({ slug: TEST_ORG_SLUG }).select('_id');
  await Load.deleteMany({ organizationId: { $in: oldOrgs.map((o) => o._id) } });
  const oldUsers = await User.find({ email: { $regex: /@dispatch-improvements-test\.com$/ } }).select('_id');
  await DriverRequest.deleteMany({ driverUserId: { $in: oldUsers.map((u) => u._id) } });
  await DriverProfile.deleteMany({ userId: { $in: oldUsers.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: oldUsers.map((u) => u._id) } });
  await Organization.deleteMany({ _id: { $in: oldOrgs.map((o) => o._id) } });

  org = await Organization.create({ name: 'Dispatch Improvements Test Org', slug: TEST_ORG_SLUG, status: 'active' });
  dispatcher = await User.create({
    email: `dispatcher${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher',
    role: 'admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  superAdmin = await User.create({
    email: `superadmin${TEST_EMAIL_DOMAIN}`,
    name: 'Suprah Super Admin',
    role: 'super_admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherToken = tokenService.generateAccessToken(dispatcher);
  superAdminToken = tokenService.generateAccessToken(superAdmin);
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@dispatch-improvements-test\.com$/ } }).select('_id');
  const userIds = users.map((u) => u._id);
  await Load.deleteMany({ organizationId: org?._id });
  await Notification.deleteMany({ userId: { $in: userIds } });
  await DriverReviewEvent.deleteMany({ driverId: { $in: userIds } });
  await DriverLocation.deleteMany({ userId: { $in: userIds } });
  await DriverRequest.deleteMany({ driverUserId: { $in: userIds } });
  await DriverProfile.deleteMany({ userId: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Organization.deleteMany({ _id: org?._id });
  await mongoose.disconnect();
});

// ─── Driver account creation and approval ───────────────────────────────────

describe('Driver account approval', () => {
  it("an unapproved driver can't be given a load, and the driver list says why", async () => {
    const applicant = await createDriver('applicant', false);
    const load = await seedLoad();
    const res = await assign(load._id, applicant.user._id).expect(409);
    expect(res.body.message).toMatch(/hasn't been approved yet/);
    expect((await reload(load._id))!.status).toBe('Posted');

    const assignable = await request(app)
      .get('/api/driver-tracking/org-drivers')
      .query({ scope: 'assignable' })
      .set(auth(dispatcherToken))
      .expect(200);
    expect(assignable.body.data.drivers.some((d: any) => d.id === String(applicant.user._id))).toBe(false);

    const shown = await request(app)
      .get('/api/driver-tracking/org-drivers')
      .query({ scope: 'ids', ids: String(applicant.user._id) })
      .set(auth(dispatcherToken))
      .expect(200);
    expect(shown.body.data.drivers[0]).toMatchObject({ accountApproved: false, assignable: false });
  });

  it('a driver has one pending application; a repeat is refused', async () => {
    const applicant = await createApplicant('one-application');
    await request(app).post('/api/driver-requests').set(auth(applicant.token)).send({}).expect(201);
    const again = await request(app).post('/api/driver-requests').set(auth(applicant.token)).send({}).expect(400);
    expect(again.body.message).toMatch(/already have a pending driver request/);
    expect(await DriverRequest.countDocuments({ driverUserId: applicant.user._id, status: 'pending' })).toBe(1);
  });

  it('two devices submitting at the same moment still make one application (with the database rule)', async () => {
    await mongoose.connection
      .collection('driverrequests')
      .createIndex({ driverUserId: 1 }, { unique: true, name: 'driverUserId_1_one_pending', partialFilterExpression: { status: 'pending' } });
    const applicant = await createApplicant('two-devices');
    const [first, second] = await Promise.all([
      request(app).post('/api/driver-requests').set(auth(applicant.token)).send({}),
      request(app).post('/api/driver-requests').set(auth(applicant.token)).send({}),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(await DriverRequest.countDocuments({ driverUserId: applicant.user._id, status: 'pending' })).toBe(1);
  });

  it('a super admin approves an application right away, without documents, and Dispatch can then assign', async () => {
    const applicant = await createApplicant('approve-now');
    await request(app).post('/api/driver-requests').set(auth(applicant.token)).send({}).expect(201);
    const pending: any = await DriverRequest.findOne({ driverUserId: applicant.user._id, status: 'pending' });
    const poolChange = jest.spyOn(socketEmitter, 'emitDriverPoolChange');

    // Only a super admin can approve.
    await request(app).patch(`/api/driver-requests/${pending._id}/approve`).set(auth(dispatcherToken)).expect(403);
    await request(app).patch(`/api/driver-requests/${pending._id}/approve`).set(auth(superAdminToken)).expect(200);

    const user: any = await User.findById(applicant.user._id);
    expect(user.role).toBe('driver');
    expect(user.isApproved).toBe(true);
    expect((await DriverRequest.findById(pending._id))!.status).toBe('approved');
    // Document verification is untouched: still its own review.
    expect((await DriverProfile.findOne({ userId: applicant.user._id }))!.verificationStatus).toBe('in_progress');
    // Open Dispatch screens are told right away.
    expect(poolChange).toHaveBeenCalledWith(String(applicant.user._id));

    // Signing in again as the approved driver.
    const driverToken = tokenService.generateAccessToken(user);
    const status = await request(app).get('/api/driver-requests/my-status').set(auth(driverToken)).expect(200);
    expect(status.body.data.status).toBe('approved');

    const load = await seedLoad();
    await assign(load._id, applicant.user._id).expect(200);
  });
});

// ─── Load lifecycle with the new driver features ────────────────────────────

describe('Lifecycle with "I\'ve arrived", the optional condition report and signature', () => {
  let driver: { user: any; token: string };
  let load: any;
  const driverCall = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app)[method](`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(driver.token));

  beforeAll(async () => {
    driver = await createDriver('lifecycle');
    load = await seedLoad();
    await assign(load._id, driver.user._id).expect(200);
  });

  it("can't arrive or report condition before accepting", async () => {
    await driverCall('post', 'arrive').send({ stop: 'pickup' }).expect(400);
    await driverCall('post', 'condition/pickup/0/photos').attach('proof', PNG, 'front.png').expect(400);
  });

  it('accept, then "I\'ve arrived at pickup" records the time once and tells the dispatcher', async () => {
    await driverCall('post', 'accept').send(signatureFor('Lifecycle Driver')).expect(200);
    await driverCall('post', 'arrive').send({ stop: 'delivery' }).expect(400);
    await driverCall('post', 'arrive').send({ stop: 'somewhere' }).expect(400);

    await driverCall('post', 'arrive').send({ stop: 'pickup' }).expect(200);
    const first: any = await reload(load._id);
    expect(String(first.arrivals.pickup.driverId)).toBe(String(driver.user._id));
    const again = await driverCall('post', 'arrive').send({ stop: 'pickup' }).expect(200);
    expect(again.body.message).toMatch(/already recorded/);
    expect((await reload(load._id) as any).arrivals.pickup.at.getTime()).toBe(first.arrivals.pickup.at.getTime());
    // The load is still Accepted: arriving changes no status.
    expect((await reload(load._id))!.status).toBe('Accepted');

    const notices = await Notification.find({ userId: dispatcher._id, type: 'shipment_arrived_at_pickup', 'metadata.loadId': String(load._id) });
    expect(notices).toHaveLength(1);
  });

  it('pickup condition report: photos, damage and notes, keeping only known damage', async () => {
    const opened = await driverCall('get', 'condition').expect(200);
    expect(opened.body.data.editableStops).toEqual(['pickup']);
    expect(opened.body.data.vehicles).toHaveLength(2);

    await driverCall('post', 'condition/pickup/0/photos').attach('proof', PNG, 'front.png').expect(200);
    const second = await driverCall('post', 'condition/pickup/0/photos').attach('proof', PNG, 'back.png').expect(200);
    expect(second.body.data.photos).toHaveLength(2);
    expect(second.body.data.photos[0].url).toMatch(/^https:/);
    expect(JSON.stringify(second.body.data)).not.toMatch(/"key"/);

    const saved = await driverCall('put', 'condition/pickup/0')
      .send({ damageAreas: ['hood', 'spaceship'], damageTypes: ['dent'], note: 'Small dent on hood' })
      .expect(200);
    expect(saved.body.data).toMatchObject({ damageAreas: ['hood'], damageTypes: ['dent'], note: 'Small dent on hood' });

    // A vehicle that isn't on the load.
    await driverCall('post', 'condition/pickup/5/photos').attach('proof', PNG, 'x.png').expect(404);

    const deleteSpy = storageService.delete as jest.Mock;
    deleteSpy.mockClear();
    await driverCall('delete', `condition/pickup/0/photos/${second.body.data.photos[0].id}`).expect(200);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('the condition report is optional: pickup and route work as before', async () => {
    await driverCall('post', 'submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await driverCall('post', 'pickup').expect(200);
    await driverCall('post', 'start-route').expect(200);
    expect((await reload(load._id))!.status).toBe('In-Transit');
  });

  it('delivery: arrival, condition photo and the customer signature', async () => {
    await driverCall('post', 'arrive').send({ stop: 'delivery' }).expect(200);
    const opened = await driverCall('get', 'condition').expect(200);
    expect(opened.body.data.editableStops).toEqual(['delivery']);
    // The pickup report is closed once the route has started.
    await driverCall('post', 'condition/pickup/1/photos').attach('proof', PNG, 'late.png').expect(400);
    await driverCall('post', 'condition/delivery/1/photos').attach('proof', PNG, 'side.png').expect(200);

    await driverCall('put', 'condition/signature').send({ signerName: '', signatureDataUrl: PNG_DATA_URL }).expect(400);
    await driverCall('put', 'condition/signature').send({ signerName: 'Pat', signatureDataUrl: 'javascript:alert(1)' }).expect(400);
    await driverCall('put', 'condition/signature').send({ signerName: 'Pat Customer', signatureDataUrl: PNG_DATA_URL }).expect(200);
  });

  it('Needs attention lists the delivery photo until Dispatch confirms it', async () => {
    await driverCall('post', 'submit-proof').attach('proof', PNG, 'pod.png').expect(200);
    await driverCall('post', 'deliver').expect(200);
    expect((await reload(load._id))!.status).toBe('Delivered');

    const before = await request(app).get('/api/loads/attention').set(auth(dispatcherToken)).expect(200);
    expect(before.body.data.items.some((i: any) => i.kind === 'proof_waiting' && i.loadId === String(load._id))).toBe(true);

    await request(app).post(`/api/loads/${load._id}/confirm-delivery`).set(auth(dispatcherToken)).expect(200);
    const after = await request(app).get('/api/loads/attention').set(auth(dispatcherToken)).expect(200);
    expect(after.body.data.items.some((i: any) => i.kind === 'proof_waiting' && i.loadId === String(load._id))).toBe(false);
  });

  it('once delivered, the report is locked', async () => {
    await driverCall('post', 'condition/delivery/0/photos').attach('proof', PNG, 'after.png').expect(400);
    await driverCall('put', 'condition/signature').send({ signerName: 'Someone', signatureDataUrl: PNG_DATA_URL }).expect(400);
  });

  it('Dispatch sees reports, signature and arrivals; lists stay light; the driver sees only their own', async () => {
    const detail = await request(app).get(`/api/loads/${load._id}`).set(auth(dispatcherToken)).expect(200);
    const data = detail.body.data;
    expect(data.conditionReports).toHaveLength(2);
    expect(JSON.stringify(data.conditionReports)).not.toMatch(/"key"/);
    expect(data.deliverySignature).toMatchObject({ signerName: 'Pat Customer', signatureDataUrl: PNG_DATA_URL });
    expect(data.arrivals.pickup.at).toBeDefined();
    expect(data.arrivals.delivery.at).toBeDefined();
    expect(data.contract.signatureDataUrl).toBe(PNG_DATA_URL);

    const list = await request(app).get('/api/loads').query({ q: load.loadNumber }).set(auth(dispatcherToken)).expect(200);
    const listed = list.body.data.loads.find((l: any) => l._id === String(load._id));
    expect(listed).toBeDefined();
    expect(listed.conditionReports).toBeUndefined();
    expect(listed.contract.signatureDataUrl).toBeUndefined();
    expect(listed.driverContract.signatureDataUrl).toBeUndefined();
    expect(listed.deliverySignature.signatureDataUrl).toBeUndefined();
    expect(listed.deliverySignature.signerName).toBe('Pat Customer');

    const mine = await request(app).get(`/api/driver-tracking/loads/${load._id}`).set(auth(driver.token)).expect(200);
    expect(mine.body.data.conditionReports).toBeUndefined();
    expect(mine.body.data.deliverySignature).toBeUndefined();
    expect(mine.body.data.arrivals.pickup.at).toBeDefined();
    expect(mine.body.data.arrivals.pickup.driverId).toBeUndefined();
  });
});

describe('A load without any of the optional steps still completes', () => {
  it('assign → accept → pickup → route → deliver, with no arrival or condition report', async () => {
    const driver = await createDriver('no-extras');
    const load = await seedLoad();
    await assign(load._id, driver.user._id).expect(200);
    const call = (path: string) => request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(driver.token));
    await call('accept').send(signatureFor('No Extras')).expect(200);
    await call('submit-pickup-proof').attach('proof', PNG, 'p.png').expect(200);
    await call('pickup').expect(200);
    await call('start-route').expect(200);
    await call('submit-proof').attach('proof', PNG, 'd.png').expect(200);
    await call('deliver').expect(200);
    const done: any = await reload(load._id);
    expect(done.status).toBe('Delivered');
    expect(done.conditionReports ?? []).toHaveLength(0);
  });
});

describe('Reassignment: a new driver starts fresh', () => {
  it("an earlier driver's arrival doesn't count for the new driver", async () => {
    const first = await createDriver('reassign-first');
    const second = await createDriver('reassign-second');
    const load = await seedLoad();
    await assign(load._id, first.user._id).expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/accept`).set(auth(first.token)).send(signatureFor('First')).expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/arrive`).set(auth(first.token)).send({ stop: 'pickup' }).expect(200);

    await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(second.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const view = await request(app).get(`/api/driver-tracking/loads/${load._id}`).set(auth(second.token)).expect(200);
    expect(view.body.data.arrivals).toBeUndefined();
  });
});

// ─── Load creation and editing ──────────────────────────────────────────────

describe('Inspection photos keep their storage key when a load is edited', () => {
  it('a signed link sent back by the edit form is stored as the key', async () => {
    const load = await seedLoad({
      vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable', inspectionPhotoUrl: 'load-inspection/edit.png' }],
    });
    const signedLink = 'https://account.r2.cloudflarestorage.com/load-inspection/edit.png?X-Amz-Expires=3600&X-Amz-Signature=abc';
    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({
        vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable', inspectionPhotoUrl: signedLink }],
        expectedUpdatedAt: await currentVersion(load._id),
      })
      .expect(200);
    expect(((await reload(load._id)) as any).vehicles[0].inspectionPhotoUrl).toBe('load-inspection/edit.png');
  });
});

describe('Deleting a load removes its photos', () => {
  it('removes its photos but keeps one another load still uses', async () => {
    await seedLoad({
      vehicles: [{ year: 2018, make: 'Ford', model: 'F-150', condition: 'Operable', inspectionPhotoUrl: 'load-inspection/shared.png' }],
    });
    const doomed = await seedLoad({
      status: 'Cancelled',
      vehicles: [{ year: 2018, make: 'Ford', model: 'F-150', condition: 'Operable', inspectionPhotoUrl: 'load-inspection/shared.png' }],
      proofOfPickup: { imageUrl: 'proof-of-pickup/doomed.png', submittedAt: new Date() },
    });
    const deleteSpy = storageService.delete as jest.Mock;
    deleteSpy.mockClear();
    await request(app).delete(`/api/loads/${doomed._id}`).set(auth(dispatcherToken)).expect(200);
    expect(await Load.exists({ _id: doomed._id })).toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith('proof-of-pickup/doomed.png', 'private');
    expect(deleteSpy).not.toHaveBeenCalledWith('load-inspection/shared.png', expect.anything());
  });
});

// ─── Driver dashboard ───────────────────────────────────────────────────────

describe('Driver dashboard "expires soon" notice', () => {
  it('includes an uploaded document expiring in 10 days, even when the profile date is later', async () => {
    const driver = await createDriver('expiring');
    const inTenDays = new Date(Date.now() + 10 * 86_400_000);
    const day = new Date(`${inTenDays.toISOString().slice(0, 10)}T00:00:00Z`);
    await DriverProfile.updateOne(
      { userId: driver.user._id },
      {
        $set: {
          licenseExpirationDate: new Date('2030-07-19T00:00:00Z'),
          documents: [
            { type: 'drivers_license', label: 'CDL', fileUrl: 'driver-docs/cdl.png', expiresAt: day, verified: false, reviewStatus: 'pending' },
          ],
        },
      },
    );
    const res = await request(app).get('/api/driver-tracking/dashboard-stats').set(auth(driver.token)).expect(200);
    const items = res.body.data.complianceExpiringItems;
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('CDL');
    expect(items[0].daysLeft).toBeGreaterThanOrEqual(9);
    expect(items[0].daysLeft).toBeLessThanOrEqual(11);
  });
});
