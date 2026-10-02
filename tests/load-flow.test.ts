/**
 * Load Flow — Integration Test Suite
 *
 * Exercises the Load lifecycle through the real HTTP endpoints:
 *   Posted → (request / approve | assign) → Assigned → Accepted
 *   → Picked Up → In-Transit → Delivered → staff confirmation
 *
 * plus the lifecycle guards on the generic /api/loads endpoints.
 *
 * Data safety:
 *   - Every record is created under this suite's own organizations/users.
 *   - afterAll deletes only those records (by organization / user id).
 *   - File storage is stubbed, so no object storage is touched.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Load from '../src/models/Load.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import Notification from '../src/models/Notification.model';
import DriverStatusChangeRequest from '../src/models/DriverStatusChangeRequest.model';
import DriverReviewEvent from '../src/models/DriverReviewEvent.model';
import DriverLocation from '../src/models/DriverLocation.model';
import DispatchChatMessage from '../src/models/DispatchChatMessage.model';
import DispatchChatThread from '../src/models/DispatchChatThread.model';
import LoadReleaseRequest from '../src/models/LoadReleaseRequest.model';
import Vehicle from '../src/models/Vehicle.model';
import { monitorDriverLocationSilence } from '../src/services/driverLocationMonitor.service';
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';
import { invalidateActiveOrganizations } from '../src/services/activeOrganizations.service';
import { setLifecycleOutboxRequestFlushMode } from '../src/services/loadLifecycleOutbox.service';
import { ingestDriverLocation } from '../src/services/driverLocationIngest.service';
import LoadTripPoint from '../src/models/LoadTripPoint.model';
import * as socketEmitter from '../src/utils/socketEmitter';
import { buildLoadMaterialChanges, getLoadAcceptanceMaterialVersion } from '../src/services/loadAcceptanceMaterial.service';

const TEST_ORG_SLUG_A = 'load-flow-test-org-a';
const TEST_ORG_SLUG_B = 'load-flow-test-org-b';
const TEST_EMAIL_DOMAIN = '@load-flow-test.com';

// Smallest valid PNG, so upload content validation (magic bytes) passes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const signatureFor = (signerName: string) => ({
  agreedToTerms: true,
  signatureDataUrl: `data:image/png;base64,${PNG.toString('base64')}#${encodeURIComponent(signerName)}`,
  signerName,
});

let orgA: any;
let orgB: any;
let dispatcher: any;
let dispatcherB: any;
let dispatcherToken: string;
let dispatcherBToken: string;
let uploadCounter = 0;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createDriver(label: string) {
  const user = await User.create({
    email: `${label}${TEST_EMAIL_DOMAIN}`,
    name: `Driver ${label}`,
    role: 'driver',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  // Capacity must be configured for a driver to self-request work.
  await DriverProfile.create({
    userId: user._id,
    maxVehicleCapacity: 5,
    operationalStatus: 'active',
  });
  return { user, token: tokenService.generateAccessToken(user as any) };
}

async function seedLoad(overrides: Record<string, unknown> = {}) {
  return Load.create({
    organizationId: orgA._id,
    createdBy: dispatcher._id,
    postType: 'load-board',
    status: 'Posted',
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'public' },
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
    ...overrides,
  });
}

const reload = (id: unknown) => Load.findById(id);
// The load version an edit starts from (PUT /api/loads/:id requires it).
const currentVersion = async (id: unknown) =>
  ((await Load.findById(id).select('updatedAt').lean()) as any).updatedAt.toISOString();

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }

  jest.spyOn(storageService, 'upload').mockImplementation(async () => `test/proof-${++uploadCounter}.png`);
  // Deliver each request's notices before it answers, so checks right after a call are exact.
  setLifecycleOutboxRequestFlushMode('inline');
  jest.spyOn(storageService, 'delete').mockResolvedValue(undefined);
  jest.spyOn(storageService, 'getSignedUrl').mockResolvedValue('https://signed.example/proof.png');

  // Clean up leftovers from an interrupted earlier run.
  const oldOrgs = await Organization.find({ slug: { $in: [TEST_ORG_SLUG_A, TEST_ORG_SLUG_B] } }).select('_id');
  await Load.deleteMany({ organizationId: { $in: oldOrgs.map((o) => o._id) } });
  const oldUsers = await User.find({ email: { $regex: /@load-flow-test\.com$/ } }).select('_id');
  await DriverProfile.deleteMany({ userId: { $in: oldUsers.map((u) => u._id) } });
  await User.deleteMany({ _id: { $in: oldUsers.map((u) => u._id) } });
  await Organization.deleteMany({ _id: { $in: oldOrgs.map((o) => o._id) } });

  orgA = await Organization.create({ name: 'Load Flow Test Org A', slug: TEST_ORG_SLUG_A, status: 'active' });
  orgB = await Organization.create({ name: 'Load Flow Test Org B', slug: TEST_ORG_SLUG_B, status: 'active' });

  dispatcher = await User.create({
    email: `dispatcher${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher A',
    role: 'admin',
    organizationId: orgA._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherB = await User.create({
    email: `dispatcher-b${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher B',
    role: 'admin',
    organizationId: orgB._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherToken = tokenService.generateAccessToken(dispatcher);
  dispatcherBToken = tokenService.generateAccessToken(dispatcherB);
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  // tests/setup.ts may already have closed the shared connection.
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  const users = await User.find({ email: { $regex: /@load-flow-test\.com$/ } }).select('_id');
  const userIds = users.map((u) => u._id);
  await Load.deleteMany({ organizationId: { $in: [orgA?._id, orgB?._id] } });
  await Notification.deleteMany({ userId: { $in: userIds } });
  await DriverStatusChangeRequest.deleteMany({ organizationId: { $in: [String(orgA?._id), String(orgB?._id)] } });
  await DriverReviewEvent.deleteMany({ driverId: { $in: userIds } });
  await DriverLocation.deleteMany({ userId: { $in: userIds } });
  await DispatchChatMessage.deleteMany({ organizationId: { $in: [String(orgA?._id), String(orgB?._id)] } });
  await DispatchChatThread.deleteMany({ organizationId: { $in: [String(orgA?._id), String(orgB?._id)] } });
  await LoadReleaseRequest.deleteMany({ organizationId: { $in: [String(orgA?._id), String(orgB?._id)] } });
  await Vehicle.deleteMany({ organizationId: { $in: [String(orgA?._id), String(orgB?._id)] } });
  await DriverProfile.deleteMany({ userId: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Organization.deleteMany({ _id: { $in: [orgA?._id, orgB?._id] } });
  await mongoose.disconnect();
});

// ─── Generic /api/loads endpoints ────────────────────────────────────────────

describe('Load CRUD and organization isolation', () => {
  it('POST /api/loads — dispatcher creates a Posted load with a per-org load number', async () => {
    const res = await request(app)
      .post('/api/loads')
      .set(auth(dispatcherToken))
      .send({
        postType: 'load-board',
        pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
        deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
        vehicles: [{ year: 2021, make: 'Honda', model: 'Civic', condition: 'Operable' }],
        trailerType: 'open_2car',
        additionalInfo: { visibility: 'public' },
      })
      .expect(201);

    const created = res.body.data.load;
    expect(created.status).toBe('Posted');
    expect(created.loadNumber).toMatch(/^LD-\d{8}-\d{3}$/);

    const stored = await reload(created._id);
    expect(String(stored!.organizationId)).toBe(String(orgA._id));
  });

  it('GET /api/loads — returns only loads of the caller\'s organization', async () => {
    const own = await seedLoad();
    const foreign = await seedLoad({ organizationId: orgB._id, createdBy: dispatcherB._id });

    const res = await request(app).get('/api/loads').set(auth(dispatcherToken)).expect(200);
    const ids = res.body.data.loads.map((l: any) => String(l._id));

    expect(ids).toContain(String(own._id));
    expect(ids).not.toContain(String(foreign._id));
  });

  it('GET /api/loads?q=<load number> — finds that exact load on any page', async () => {
    const target = await seedLoad({ loadNumber: 'LD-20200101-001' });
    await seedLoad({ loadNumber: 'LD-20200101-002' });
    await seedLoad({ loadNumber: 'LD-20200102-001' });

    const res = await request(app)
      .get('/api/loads')
      .query({ q: 'ld-20200101-001', page: 1, limit: 1 })
      .set(auth(dispatcherToken))
      .expect(200);
    expect(res.body.data.loads.map((l: any) => String(l._id))).toEqual([String(target._id)]);
  });

  it('GET /api/loads/:id — another organization\'s load is not found', async () => {
    const foreign = await seedLoad({ organizationId: orgB._id, createdBy: dispatcherB._id });
    await request(app).get(`/api/loads/${foreign._id}`).set(auth(dispatcherToken)).expect(404);
  });

  it('GET /api/loads/:id — a malformed id is a 400, not a 500', async () => {
    await request(app).get('/api/loads/not-an-id').set(auth(dispatcherToken)).expect(400);
  });

  it('Driver role cannot create a load', async () => {
    const { token } = await createDriver('crud-driver');
    await request(app).post('/api/loads').set(auth(token)).send({}).expect(403);
  });
});

describe('Generic endpoints cannot bypass the lifecycle', () => {
  it('PUT /api/loads/:id rejects a status change but accepts the current status', async () => {
    const load = await seedLoad();

    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ status: 'Delivered', expectedUpdatedAt: await currentVersion(load._id) })
      .expect(409);
    expect((await reload(load._id))!.status).toBe('Posted');

    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ status: 'Posted', additionalInfo: { visibility: 'public', notes: 'Gate 4' }, expectedUpdatedAt: await currentVersion(load._id) })
      .expect(200);
    expect((await reload(load._id))!.additionalInfo?.notes).toBe('Gate 4');
  });

  it('DELETE /api/loads/:id deletes an unassigned Posted load', async () => {
    const load = await seedLoad();
    await request(app).delete(`/api/loads/${load._id}`).set(auth(dispatcherToken)).expect(200);
    expect(await reload(load._id)).toBeNull();
  });

  it('DELETE /api/loads/:id refuses active loads with a driver', async () => {
    const { user } = await createDriver('delete-active');
    for (const status of ['Assigned', 'Accepted', 'Picked Up', 'In-Transit']) {
      const load = await seedLoad({ status, assignedDriverId: user._id, dispatchOwnerId: dispatcher._id });
      await request(app).delete(`/api/loads/${load._id}`).set(auth(dispatcherToken)).expect(409);
      expect(await reload(load._id)).not.toBeNull();
      await Load.deleteOne({ _id: load._id });
    }
  });

  it('DELETE /api/loads/:id allows cancelled loads, keeps delivered ones, and cannot reach another organization', async () => {
    const cancelled = await seedLoad({ status: 'Cancelled' });
    await request(app).delete(`/api/loads/${cancelled._id}`).set(auth(dispatcherToken)).expect(200);

    const delivered = await seedLoad({ status: 'Delivered' });
    const refused = await request(app).delete(`/api/loads/${delivered._id}`).set(auth(dispatcherToken)).expect(409);
    expect(refused.body.message).toMatch(/can't be deleted/);
    expect(await reload(delivered._id)).not.toBeNull();

    const foreign = await seedLoad({ organizationId: orgB._id, createdBy: dispatcherB._id });
    await request(app).delete(`/api/loads/${foreign._id}`).set(auth(dispatcherToken)).expect(404);
    expect(await reload(foreign._id)).not.toBeNull();
  });
});

// ─── Dispatcher assignment ───────────────────────────────────────────────────

describe('Assign / reassign / remove', () => {
  let driverOne: any;
  let driverTwo: any;

  beforeAll(async () => {
    driverOne = (await createDriver('assign-one')).user;
    driverTwo = (await createDriver('assign-two')).user;
  });

  it('assign-load assigns the driver and records the dispatch owner', async () => {
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driverOne._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const updated = await reload(load._id);
    expect(updated!.status).toBe('Assigned');
    expect(String(updated!.assignedDriverId)).toBe(String(driverOne._id));
    expect(String((updated as any).dispatchOwnerId)).toBe(String(dispatcher._id));
  });

  it('reassign-load refuses a load that was never assigned', async () => {
    const load = await seedLoad();
    const res = await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driverTwo._id), overrideAvailability: true, overrideCapacity: true })
      .expect(409);

    expect(res.body.message).toMatch(/Use Assign/);
    expect((await reload(load._id))!.status).toBe('Posted');
  });

  it('reassign-load moves an assigned load to another driver, and remove-load returns it to Posted', async () => {
    // Fresh drivers: a driver already committed to another active load is
    // (correctly) refused new work by the commitment check.
    const from = (await createDriver('reassign-from')).user;
    const to = (await createDriver('reassign-to')).user;
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(from._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(to._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    expect(String((await reload(load._id))!.assignedDriverId)).toBe(String(to._id));

    await request(app)
      .post('/api/driver-tracking/remove-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id) })
      .expect(200);
    const removed = await reload(load._id);
    expect(removed!.status).toBe('Posted');
    expect(removed!.assignedDriverId).toBeNull();
  });
});

// ─── Load board requests ─────────────────────────────────────────────────────

describe('Driver requests and approval', () => {
  let first: { user: any; token: string };
  let second: { user: any; token: string };
  let load: any;

  beforeAll(async () => {
    first = await createDriver('request-first');
    second = await createDriver('request-second');
    load = await seedLoad();
  });

  it('available-loads lists the Posted public load for a driver', async () => {
    const res = await request(app).get('/api/driver-tracking/available-loads').set(auth(first.token)).expect(200);
    const list = Array.isArray(res.body.data) ? res.body.data : res.body.data.loads;
    expect(list.map((l: any) => String(l._id))).toContain(String(load._id));
  });

  it('each request keeps its own signature and does not touch the load contract', async () => {
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/request`)
      .set(auth(first.token))
      .send(signatureFor('First Signer'))
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/request`)
      .set(auth(second.token))
      .send(signatureFor('Second Signer'))
      .expect(200);

    const stored: any = await Load.findById(load._id).select('+driverRequests.signature.signatureDataUrl');
    expect(stored.driverRequests).toHaveLength(2);
    expect(stored.driverContract?.agreedToTerms).not.toBe(true);
    const bySigner = stored.driverRequests.map((r: any) => r.signature?.signerName).sort();
    expect(bySigner).toEqual(['First Signer', 'Second Signer']);

    // The signature image is excluded from normal reads.
    const plain: any = await Load.findById(load._id).lean();
    expect(plain.driverRequests[0].signature?.signatureDataUrl).toBeUndefined();
  });

  it('a driver cannot request the same load twice (a repeat is treated as the same request)', async () => {
    const res = await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/request`)
      .set(auth(first.token))
      .send(signatureFor('First Signer'))
      .expect(200);
    expect(res.body.message).toMatch(/already requested/);
    const saved: any = await Load.findById(load._id).lean();
    expect(saved.driverRequests.filter((r: any) => String(r.driverId) === String(first.user._id))).toHaveLength(1);
  });

  it('approving one request assigns it, keeps that signature, and tells the other requester', async () => {
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/approve-request`)
      .set(auth(dispatcherToken))
      .send({ driverId: String(first.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const updated: any = await reload(load._id);
    expect(updated.status).toBe('Assigned');
    expect(String(updated.assignedDriverId)).toBe(String(first.user._id));
    expect(updated.driverRequests).toHaveLength(0);
    expect(updated.driverContract.signerName).toBe('First Signer');

    const notSelected = await Notification.find({
      userId: second.user._id,
      type: 'driver_request_rejected',
      'metadata.loadId': String(load._id),
    });
    expect(notSelected).toHaveLength(1);
  });
});

// ─── Full driver progression ─────────────────────────────────────────────────

describe('Full lifecycle with proof of pickup and delivery', () => {
  let driver: { user: any; token: string };
  let other: { user: any; token: string };
  let load: any;

  beforeAll(async () => {
    driver = await createDriver('lifecycle');
    other = await createDriver('lifecycle-other');
    load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
  });

  const driverPost = (path: string, token = driver.token) =>
    request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(token));

  it('only the assigned driver can accept', async () => {
    await driverPost('accept', other.token).send(signatureFor('Other')).expect(403);
  });

  it('accept → Accepted with the accepting driver\'s signature', async () => {
    await driverPost('accept').send(signatureFor('Lifecycle Driver')).expect(200);
    const updated: any = await reload(load._id);
    expect(updated.status).toBe('Accepted');
    expect(updated.driverContract.signerName).toBe('Lifecycle Driver');
  });

  it('pickup requires the driver\'s own pickup photo', async () => {
    await driverPost('pickup').expect(400);
    await driverPost('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await driverPost('pickup').expect(200);
    expect((await reload(load._id))!.status).toBe('Picked Up');
  });

  it('start-route → In-Transit', async () => {
    await driverPost('start-route').expect(200);
    expect((await reload(load._id))!.status).toBe('In-Transit');
  });

  it('deliver requires proof of delivery', async () => {
    await driverPost('deliver').expect(400);
  });

  it('only the assigned driver can submit proof of delivery', async () => {
    await driverPost('submit-proof', other.token).attach('proof', PNG, 'pod.png').expect(403);
  });

  it('staff cannot confirm before the driver completes delivery', async () => {
    await driverPost('submit-proof').attach('proof', PNG, 'pod.png').expect(200);
    const updated: any = await reload(load._id);
    expect(String(updated.proofOfDelivery.submittedBy)).toBe(String(driver.user._id));

    const res = await request(app)
      .post(`/api/loads/${load._id}/confirm-delivery`)
      .set(auth(dispatcherToken))
      .expect(409);
    expect(res.body.message).toMatch(/complete delivery/);
  });

  it('deliver → Delivered, then staff confirmation is recorded once', async () => {
    await driverPost('deliver').expect(200);
    const delivered: any = await reload(load._id);
    expect(delivered.status).toBe('Delivered');
    expect(delivered.deliveredAt).toBeDefined();

    await request(app).post(`/api/loads/${load._id}/confirm-delivery`).set(auth(dispatcherToken)).expect(200);
    const confirmed: any = await reload(load._id);
    expect(confirmed.proofOfDelivery.confirmedAt).toBeDefined();
    expect(String(confirmed.proofOfDelivery.confirmedBy)).toBe(String(dispatcher._id));
    // deliveredAt is the driver's completion time, not overwritten by confirmation.
    expect(confirmed.deliveredAt.getTime()).toBe(delivered.deliveredAt.getTime());

    const again = await request(app)
      .post(`/api/loads/${load._id}/confirm-delivery`)
      .set(auth(dispatcherToken))
      .expect(200);
    expect(again.body.message).toMatch(/already confirmed/);

    // The driver is told once, with a link they can actually open.
    const confirmedNotices = await Notification.find({
      userId: driver.user._id,
      type: 'load_delivered',
      title: 'Delivery Confirmed',
      'metadata.loadId': String(load._id),
    });
    expect(confirmedNotices).toHaveLength(1);
    expect(confirmedNotices[0].metadata?.route).toBe(`/driver/loads/${load._id}`);
  });

  it('confirmed proof can no longer be replaced', async () => {
    await driverPost('submit-proof').attach('proof', PNG, 'pod-2.png').expect(409);
  });
});

describe('Proof of delivery belongs to the driver who uploaded it', () => {
  it('a new driver cannot complete delivery with the previous driver\'s proof', async () => {
    const previous = await createDriver('pod-previous');
    const current = await createDriver('pod-current');
    const load = await seedLoad({
      status: 'In-Transit',
      assignedDriverId: current.user._id,
      dispatchOwnerId: dispatcher._id,
      proofOfDelivery: { imageUrl: 'test/previous.png', submittedAt: new Date(), submittedBy: previous.user._id },
    });

    const res = await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/deliver`)
      .set(auth(current.token))
      .expect(400);
    expect(res.body.message).toMatch(/your own proof/);
    expect((await reload(load._id))!.status).toBe('In-Transit');
  });
});

// ─── Driver-facing edits after assignment ────────────────────────────────────

describe('Editing an assigned load notifies the driver, creator and assigning dispatcher', () => {
  let assigner: any;
  let assignerToken: string;
  let editor: any;
  let editorToken: string;

  async function createStaff(label: string) {
    const user = await User.create({
      email: `${label}${TEST_EMAIL_DOMAIN}`,
      name: `Staff ${label}`,
      role: 'admin',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    return { user, token: tokenService.generateAccessToken(user as any) };
  }

  async function assignedLoad(driverId: unknown, token: string) {
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(token))
      .send({ loadId: String(load._id), driverId: String(driverId), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    return load;
  }

  const editNotes = async (loadId: unknown, token: string, notes: string) =>
    request(app)
      .put(`/api/loads/${loadId}`)
      .set(auth(token))
      .send({ additionalInfo: { visibility: 'public', notes }, expectedUpdatedAt: await currentVersion(loadId) })
      .expect(200);

  const noticesFor = (userId: unknown, type: string, loadId: unknown) =>
    Notification.find({ userId, type, 'metadata.loadId': String(loadId) });

  beforeAll(async () => {
    ({ user: assigner, token: assignerToken } = await createStaff('assigner'));
    ({ user: editor, token: editorToken } = await createStaff('editor'));
  });

  it('Assigned load: driver, creator and assigner are each notified once; the editor is not', async () => {
    const { user: driver } = await createDriver('edit-assigned');
    const load = await assignedLoad(driver._id, assignerToken);

    await editNotes(load._id, editorToken, 'Gate code changed');

    const driverNotices = await noticesFor(driver._id, 'load_amendment_required', load._id);
    expect(driverNotices).toHaveLength(1);
    expect(driverNotices[0].title).toBe('Load Updated by Dispatch');
    expect(driverNotices[0].metadata?.route).toBe(`/driver/loads/${load._id}`);

    const creatorNotices = await noticesFor(dispatcher._id, 'load_details_changed', load._id);
    const assignerNotices = await noticesFor(assigner._id, 'load_details_changed', load._id);
    expect(creatorNotices).toHaveLength(1);
    expect(assignerNotices).toHaveLength(1);
    expect(creatorNotices[0].metadata?.route).toBe(
      `/driver-tracker?driverId=${driver._id}&reviewLoadId=${load._id}`,
    );
    expect(creatorNotices[0].message).toMatch(/reconfirm the assignment/);
    expect(await noticesFor(editor._id, 'load_details_changed', load._id)).toHaveLength(0);
  });

  it('creator and assigner are the same person: exactly one reviewer notification', async () => {
    const { user: driver } = await createDriver('edit-same-reviewer');
    const load = await assignedLoad(driver._id, dispatcherToken);

    await editNotes(load._id, editorToken, 'New delivery window');

    expect(await noticesFor(dispatcher._id, 'load_details_changed', load._id)).toHaveLength(1);
    expect(await noticesFor(assigner._id, 'load_details_changed', load._id)).toHaveLength(0);
  });

  it('the editor is the creator: only the assigning dispatcher is notified', async () => {
    const { user: driver } = await createDriver('edit-by-creator');
    const load = await assignedLoad(driver._id, assignerToken);

    await editNotes(load._id, dispatcherToken, 'Creator changed the notes');

    expect(await noticesFor(dispatcher._id, 'load_details_changed', load._id)).toHaveLength(0);
    expect(await noticesFor(assigner._id, 'load_details_changed', load._id)).toHaveLength(1);
    expect(await noticesFor(driver._id, 'load_amendment_required', load._id)).toHaveLength(1);
  });

  it('Accepted load: the driver must acknowledge, reviewers are told so', async () => {
    const { user: driver, token: driverToken } = await createDriver('edit-accepted');
    const load = await assignedLoad(driver._id, assignerToken);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driverToken))
      .send(signatureFor('Accepted Driver'))
      .expect(200);

    await editNotes(load._id, editorToken, 'Changed after acceptance');

    const driverNotices = await noticesFor(driver._id, 'load_amendment_required', load._id);
    expect(driverNotices).toHaveLength(1);
    expect(driverNotices[0].metadata?.amendmentId).toBeDefined();
    const reviewerNotices = await noticesFor(assigner._id, 'load_details_changed', load._id);
    expect(reviewerNotices).toHaveLength(1);
    expect(reviewerNotices[0].message).toMatch(/must acknowledge/);
  });

  it('an unassigned load sends no change notifications', async () => {
    const load = await seedLoad();
    await editNotes(load._id, editorToken, 'Still on the board');
    expect(await Notification.countDocuments({ type: 'load_details_changed', 'metadata.loadId': String(load._id) })).toBe(0);
  });
});

// ─── Driver's change history on the Current Load card ────────────────────────

describe('Driver change history for the current load', () => {
  const myLoad = async (token: string, loadId: unknown) => {
    const res = await request(app).get('/api/driver-tracking/my-loads').set(auth(token)).expect(200);
    const list = Array.isArray(res.body.data) ? res.body.data : res.body.data.loads;
    return list.find((l: any) => String(l._id) === String(loadId));
  };

  it('records changes before acceptance as info, marks them seen, then adds acknowledgeable changes', async () => {
    const { user: driver, token: driverToken } = await createDriver('history');
    const other = await createDriver('history-other');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    // Change while Assigned: visible to the driver, never blocking.
    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'public', notes: 'Use the north gate' }, expectedUpdatedAt: await currentVersion(load._id) })
      .expect(200);

    let view = await myLoad(driverToken, load._id);
    expect(view.pendingDriverAmendments).toHaveLength(0);
    expect(view.driverLoadChanges).toHaveLength(1);
    expect(view.driverLoadChanges[0]).toMatchObject({ status: 'informational', loadStatusAtChange: 'Assigned', seenAt: null });
    expect(view.driverLoadChanges[0].changes[0].after).toMatch(/north gate/);

    // Opening the history marks it seen without changing the load revision.
    const before: any = await reload(load._id);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/changes/seen`).set(auth(other.token)).expect(404);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/changes/seen`).set(auth(driverToken)).expect(200);
    const after: any = await reload(load._id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    view = await myLoad(driverToken, load._id);
    expect(view.driverLoadChanges[0].seenAt).not.toBeNull();

    // Reconfirm, accept, then change again: now it needs acknowledgement.
    const review = await request(app)
      .get(`/api/driver-tracking/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/reconfirm-assignment`)
      .set(auth(dispatcherToken))
      .send({ reviewedMaterialVersion: review.body.data.acceptanceMaterialVersion })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driverToken))
      .send(signatureFor('History Driver'))
      .expect(200);
    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'public', notes: 'Call before arrival' }, expectedUpdatedAt: await currentVersion(load._id) })
      .expect(200);

    view = await myLoad(driverToken, load._id);
    expect(view.pendingDriverAmendments).toHaveLength(1);
    expect(view.driverLoadChanges).toHaveLength(2);
    expect(view.driverLoadChanges[0]).toMatchObject({ status: 'pending', loadStatusAtChange: 'Accepted' });
    expect(view.driverLoadChanges[1]).toMatchObject({ status: 'informational' });
  });
});

describe('Plain-English reasons when an edit is refused', () => {
  it('names the responsible dispatcher when a non-admin edits an accepted load', async () => {
    const employee = await User.create({
      email: `employee-editor${TEST_EMAIL_DOMAIN}`,
      name: 'Employee Editor',
      role: 'employee',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const employeeToken = tokenService.generateAccessToken(employee as any);
    const { user: driver, token: driverToken } = await createDriver('refused-edit');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driverToken))
      .send(signatureFor('Refused Edit Driver'))
      .expect(200);

    const res = await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(employeeToken))
      .send({ additionalInfo: { visibility: 'public', notes: 'Employee change' }, expectedUpdatedAt: await currentVersion(load._id) })
      .expect(403);
    expect(res.body.message).toMatch(/^You can't update load LD-/);
    expect(res.body.message).toMatch(/the driver has already accepted it/);
    expect(res.body.message).toMatch(/Dispatcher A \(the dispatcher responsible for this load\)/);
  });

  it('explains that delivered loads cannot be edited', async () => {
    const load = await seedLoad({ status: 'Delivered' });
    const res = await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ additionalInfo: { visibility: 'public', notes: 'Too late' }, expectedUpdatedAt: await currentVersion(load._id) })
      .expect(400);
    expect(res.body.message).toMatch(/because it is already Delivered/);
  });
});

describe('Map pins on load stops (Create Load "Pick on map")', () => {
  const pin = { lat: 40.760812, lng: -111.891047 };
  const pickup = { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' };
  const delivery = { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' };

  it('saves the exact pin, drops empty pin values, and removes the pin when an edit leaves it out', async () => {
    const res = await request(app)
      .post('/api/loads')
      .set(auth(dispatcherToken))
      .send({
        postType: 'load-board',
        pickupLocation: { ...pickup, coordinates: pin, placeId: 'simulated-place-id' },
        deliveryLocation: { ...delivery, coordinates: null, placeId: '' },
        vehicles: [{ year: 2021, make: 'Honda', model: 'Civic', condition: 'Operable' }],
        trailerType: 'open_2car',
        additionalInfo: { visibility: 'public' },
      })
      .expect(201);
    const id = res.body.data.load._id;

    let stored: any = await Load.findById(id).lean();
    expect(stored.pickupLocation.coordinates).toEqual(pin);
    expect(stored.pickupLocation.placeId).toBe('simulated-place-id');
    expect(stored.deliveryLocation.coordinates).toBeUndefined();
    expect(stored.deliveryLocation.placeId).toBeUndefined();

    // A position off the globe is refused.
    await request(app)
      .put(`/api/loads/${id}`)
      .set(auth(dispatcherToken))
      .send({ pickupLocation: { ...pickup, coordinates: { lat: 95, lng: 0 } }, expectedUpdatedAt: await currentVersion(id) })
      .expect(400);

    // Saving the stop without a pin removes it.
    await request(app)
      .put(`/api/loads/${id}`)
      .set(auth(dispatcherToken))
      .send({ pickupLocation: pickup, expectedUpdatedAt: await currentVersion(id) })
      .expect(200);
    stored = await Load.findById(id).lean();
    expect(stored.pickupLocation.coordinates).toBeUndefined();
    expect(stored.pickupLocation.placeId).toBeUndefined();
  });

  it('adding or moving only the pin never asks the driver to re-confirm the load', () => {
    const before = { postType: 'load-board', pickupLocation: pickup, deliveryLocation: delivery };
    const pinned = { ...before, pickupLocation: { ...pickup, coordinates: pin, placeId: 'simulated-place-id' } };
    const moved = { ...before, pickupLocation: { ...pickup, coordinates: { lat: 40.7611, lng: -111.8915 } } };

    expect(getLoadAcceptanceMaterialVersion(pinned)).toBe(getLoadAcceptanceMaterialVersion(before));
    expect(buildLoadMaterialChanges(before, pinned)).toHaveLength(0);
    expect(buildLoadMaterialChanges(pinned, moved)).toHaveLength(0);
    // A change the driver can see is still an amendment.
    expect(buildLoadMaterialChanges(pinned, { ...pinned, pickupLocation: { ...pinned.pickupLocation, address: '9 Other Rd' } })).toHaveLength(1);
  });
});

// ─── Batch 3/4: mid-trip changes, organizations, notifications ───────────────

describe('Mid-trip reassign keeps the previous driver\'s evidence', () => {
  let support: { user: any; token: string };

  beforeAll(async () => {
    const user = await User.create({
      email: `support${TEST_EMAIL_DOMAIN}`,
      name: 'Support Dispatcher',
      role: 'admin',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    support = { user, token: tokenService.generateAccessToken(user as any) };
  });

  async function pickedUpLoad(label: string) {
    const first = await createDriver(`${label}-first`);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(first.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    const post = (path: string) => request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(first.token));
    await post('accept').send(signatureFor('First Driver')).expect(200);
    await post('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await post('pickup').expect(200);
    return { load, first };
  }

  it('reassigning after pickup archives the photo, signature and times, and tells the involved dispatchers', async () => {
    const { load, first } = await pickedUpLoad('midtrip');
    const second = await createDriver('midtrip-second');

    await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(support.token))
      .send({ loadId: String(load._id), driverId: String(second.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const updated: any = await Load.findById(load._id).select('+assignmentHistory');
    expect(updated.status).toBe('Assigned');
    expect(String(updated.assignedDriverId)).toBe(String(second.user._id));
    expect(updated.proofOfPickup?.imageUrl).toBeUndefined();
    expect(updated.driverContract?.agreedToTerms).not.toBe(true);
    expect(updated.pickedUpAt).toBeUndefined();

    expect(updated.assignmentHistory).toHaveLength(1);
    const entry = updated.assignmentHistory[0];
    expect(String(entry.driverId)).toBe(String(first.user._id));
    expect(entry.endReason).toBe('reassigned');
    expect(entry.statusAtEnd).toBe('Picked Up');
    expect(entry.proofOfPickup.imageUrl).toMatch(/^test\/proof-/);
    expect(entry.driverContract.signerName).toBe('First Driver');
    expect(entry.pickedUpAt).toBeDefined();

    // The creator (not the actor) is told, with a link to the history.
    const notices = await Notification.find({ userId: dispatcher._id, title: 'Driver Changed Mid-Trip', 'metadata.loadId': String(load._id) });
    expect(notices).toHaveLength(1);
    expect(notices[0].metadata?.route).toBe(`/transportation/load/${load._id}?history=1`);
  });

  it('the history is readable by involved dispatchers and admins, not by other staff', async () => {
    const { load } = await pickedUpLoad('history-access');
    const second = await createDriver('history-access-second');
    await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(second.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const res = await request(app)
      .get(`/api/driver-tracking/loads/${load._id}/assignment-history`)
      .set(auth(dispatcherToken))
      .expect(200);
    expect(res.body.data.entries).toHaveLength(1);
    const entry = res.body.data.entries[0];
    expect(entry.driverName).toBe('Driver history-access-first');
    expect(entry.pickupPhoto.url).toBe('https://signed.example/proof.png');
    expect(entry.signature.signerName).toBe('First Driver');
    expect(JSON.stringify(res.body)).not.toMatch(/test\/proof-/); // no raw storage keys

    const outsider = await User.create({
      email: `outsider${TEST_EMAIL_DOMAIN}`,
      name: 'Outsider Employee',
      role: 'employee',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    await request(app)
      .get(`/api/driver-tracking/loads/${load._id}/assignment-history`)
      .set(auth(tokenService.generateAccessToken(outsider as any)))
      .expect(403);
  });

  it('Remove is blocked after pickup, and removing earlier keeps a history entry', async () => {
    const { load } = await pickedUpLoad('remove-blocked');
    const res = await request(app)
      .post('/api/driver-tracking/remove-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id) })
      .expect(409);
    expect(res.body.message).toMatch(/Use Reassign/);

    const { user: driver, token } = await createDriver('remove-accepted');
    const accepted = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(accepted._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app).post(`/api/driver-tracking/loads/${accepted._id}/accept`).set(auth(token)).send(signatureFor('Accepted Driver')).expect(200);
    await request(app)
      .post('/api/driver-tracking/remove-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(accepted._id) })
      .expect(200);
    const updated: any = await Load.findById(accepted._id).select('+assignmentHistory');
    expect(updated.status).toBe('Posted');
    expect(updated.assignmentHistory[0]).toMatchObject({ endReason: 'removed', statusAtEnd: 'Accepted' });
    expect(updated.assignmentHistory[0].driverContract.signerName).toBe('Accepted Driver');
  });
});

describe('Organizations that are deleted or suspended', () => {
  it('suspended organizations disappear from the load board and cannot be requested', async () => {
    const suspended = await Organization.create({ name: 'Load Flow Suspended Org', slug: 'load-flow-test-org-suspended', status: 'suspended' });
    try {
      const load = await seedLoad({ organizationId: suspended._id });
      const { token } = await createDriver('board-suspended');
      invalidateActiveOrganizations();

      const board = await request(app).get('/api/driver-tracking/available-loads').set(auth(token)).expect(200);
      const list = Array.isArray(board.body.data) ? board.body.data : board.body.data.loads;
      expect(list.map((l: any) => String(l._id))).not.toContain(String(load._id));

      const res = await request(app)
        .post(`/api/driver-tracking/loads/${load._id}/request`)
        .set(auth(token))
        .send(signatureFor('Board Driver'))
        .expect(409);
      expect(res.body.message).toMatch(/isn't active/);
    } finally {
      await Load.deleteMany({ organizationId: suspended._id });
      await Organization.deleteOne({ _id: suspended._id });
    }
  });

  it('deletion is blocked while a load has a driver, and removes unassigned board loads otherwise', async () => {
    const owner = await User.create({
      email: `org-owner${TEST_EMAIL_DOMAIN}`,
      name: 'Org Owner',
      role: 'super_admin',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const ownerToken = tokenService.generateAccessToken(owner as any);
    const doomed = await Organization.create({ name: 'Load Flow Doomed Org', slug: 'load-flow-test-org-doomed', status: 'active', ownerId: owner._id });
    await User.updateOne({ _id: owner._id }, { $set: { organizationId: doomed._id, organizationRole: 'admin' } });
    const { user: driver } = await createDriver('doomed-driver');
    const active = await seedLoad({ organizationId: doomed._id, createdBy: owner._id, status: 'Accepted', assignedDriverId: driver._id, dispatchOwnerId: owner._id });
    const posted = await seedLoad({ organizationId: doomed._id, createdBy: owner._id });

    try {
      const blocked = await request(app).delete(`/api/organizations/${doomed._id}`).set(auth(ownerToken)).expect(409);
      expect(blocked.body.message).toContain(String((active as any).loadNumber));
      expect(await Organization.exists({ _id: doomed._id })).toBeTruthy();

      await Load.updateOne({ _id: active._id }, { $set: { status: 'Delivered' } });
      await request(app).delete(`/api/organizations/${doomed._id}`).set(auth(ownerToken)).expect(200);
      expect(await Organization.exists({ _id: doomed._id })).toBeNull();
      expect(await Load.exists({ _id: posted._id })).toBeNull();
      expect(await Load.exists({ _id: active._id })).toBeTruthy(); // delivered history is kept
    } finally {
      await Load.deleteMany({ organizationId: doomed._id });
      await Organization.deleteOne({ _id: doomed._id });
    }
  });
});

describe('Driver notifications (DT-09 / DT-30)', () => {
  it('a driver can mark notifications from any organization as read and delete them', async () => {
    const { user: driver, token } = await createDriver('notifications');
    const fromOrgA = await Notification.create({ userId: driver._id, organizationId: String(orgA._id), type: 'driver_assigned', title: 'A', message: 'A' });
    const fromOrgB = await Notification.create({ userId: driver._id, organizationId: String(orgB._id), type: 'driver_assigned', title: 'B', message: 'B' });

    await request(app).patch(`/api/notifications/${fromOrgA._id}/read`).set(auth(token)).expect(200);
    expect((await Notification.findById(fromOrgA._id))!.isRead).toBe(true);

    await request(app).patch('/api/notifications/read-all').set(auth(token)).expect(200);
    expect((await Notification.findById(fromOrgB._id))!.isRead).toBe(true);

    await request(app).delete(`/api/notifications/${fromOrgB._id}`).set(auth(token)).expect(200);
    expect(await Notification.findById(fromOrgB._id)).toBeNull();
  });

  it('assignment notifications link the driver straight to the load', async () => {
    const { user: driver } = await createDriver('deep-link');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    const notice = await Notification.findOne({ userId: driver._id, type: 'driver_assigned', 'metadata.loadId': String(load._id) });
    expect(notice?.metadata?.route).toBe(`/driver/loads/${load._id}`);
  });
});

// ─── Batch 5: dispatcher access, dispatcher review, status-request privacy ───

describe('Dispatcher access (DT-11)', () => {
  let plainEmployee: any;
  let plainToken: string;
  let designated: any;
  let designatedToken: string;

  async function createEmployee(label: string, dispatcherForOrg: boolean) {
    const user = await User.create({
      email: `${label}${TEST_EMAIL_DOMAIN}`,
      name: `Employee ${label}`,
      role: 'employee',
      organizationId: orgA._id,
      ...(dispatcherForOrg ? { dispatcherOrganizationIds: [orgA._id] } : {}),
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    return { user, token: tokenService.generateAccessToken(user as any) };
  }

  beforeAll(async () => {
    ({ user: plainEmployee, token: plainToken } = await createEmployee('plain-employee', false));
    ({ user: designated, token: designatedToken } = await createEmployee('designated-dispatcher', true));
  });

  it('only designated dispatchers (and admins) can assign a load', async () => {
    const { user: driver } = await createDriver('dt11-assign');
    const load = await seedLoad();
    const refused = await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(plainToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(403);
    expect(refused.body.message).toMatch(/You need Dispatcher access for this organization/);

    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(designatedToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
  });

  it('any staff member can still reassign a load', async () => {
    const { user: first } = await createDriver('dt11-first');
    const { user: second } = await createDriver('dt11-second');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(designatedToken))
      .send({ loadId: String(load._id), driverId: String(first._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set(auth(plainToken))
      .send({ loadId: String(load._id), driverId: String(second._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    expect(String((await reload(load._id))!.assignedDriverId)).toBe(String(second._id));
  });

  it('a designated dispatcher can review and approve driver documents', async () => {
    const { user: driver } = await createDriver('dt11-documents');
    const uploadedAt = new Date('2026-09-01T12:00:00Z');
    const profile: any = await DriverProfile.findOneAndUpdate(
      { userId: driver._id },
      {
        $push: {
          documents: {
            type: 'drivers_license',
            label: 'CDL',
            fileUrl: 'https://files.example/cdl.png',
            fileKey: 'test/cdl.png',
            uploadedAt,
          },
        },
      },
      { new: true },
    );
    const documentId = String(profile.documents[0]._id);

    const view = await request(app)
      .get(`/api/driver-tracking/drivers/${driver._id}/profile`)
      .set(auth(designatedToken))
      .expect(200);
    expect(view.body.data.access.level).toBe('DISPATCH_REVIEW');
    expect(view.body.data.access.canReviewDocuments).toBe(true);
    expect(view.body.data.documents).toHaveLength(1);

    const refused = await request(app)
      .patch(`/api/driver-tracking/drivers/${driver._id}/documents/${documentId}/approve`)
      .set(auth(plainToken))
      .send({ expectedUploadedAt: uploadedAt.toISOString() })
      .expect(403);
    expect(refused.body.message).toMatch(/Only an admin or a dispatcher for this organization/);

    await request(app)
      .patch(`/api/driver-tracking/drivers/${driver._id}/documents/${documentId}/approve`)
      .set(auth(designatedToken))
      .send({ expectedUploadedAt: uploadedAt.toISOString() })
      .expect(200);
    const saved: any = await DriverProfile.findOne({ userId: driver._id });
    expect(saved.documents[0].reviewStatus).toBe('approved');
  });

  it('Work Availability notes are hidden from staff not handling the driver (DT-26)', async () => {
    const { user: driver } = await createDriver('dt26-status');
    const statusRequest = await DriverStatusChangeRequest.create({
      organizationId: String(orgA._id),
      driverId: driver._id,
      requestedStatus: 'on_leave',
      priority: 'standard',
      status: 'pending',
      reason: 'personal_leave',
      message: 'Family matter',
    });
    const path = `/api/driver-profile/status-requests/${statusRequest._id}`;

    const hidden = await request(app).get(path).set(auth(plainToken)).expect(200);
    expect(hidden.body.data.reason).toBeNull();
    expect(hidden.body.data.message).toBeNull();
    expect(hidden.body.data.notesHidden).toBe(true);

    const asAdmin = await request(app).get(path).set(auth(dispatcherToken)).expect(200);
    expect(asAdmin.body.data.message).toBe('Family matter');

    // The employee becomes responsible for an active load with this driver.
    await seedLoad({ status: 'Assigned', assignedDriverId: driver._id, dispatchOwnerId: plainEmployee._id });
    const asOwner = await request(app).get(path).set(auth(plainToken)).expect(200);
    expect(asOwner.body.data.message).toBe('Family matter');
    expect(asOwner.body.data.notesHidden).toBeUndefined();
  });
});

// ─── Batch 6: work availability lock, emergency GPS, GPS flags and ordering ──

describe('Driver status and GPS rules (batch 6)', () => {
  const freshFix = () => new Date(Date.now() - 5_000).toISOString();

  async function acceptedLoad(label: string) {
    const driver = await createDriver(label);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driver.token))
      .send(signatureFor(`Driver ${label}`))
      .expect(200);
    return { ...driver, load };
  }

  const sendFix = (token: string, measuredAt = freshFix()) =>
    request(app)
      .post('/api/driver-tracking/heartbeat')
      .set(auth(token))
      .send({ lat: 40.76, lng: -111.89, accuracy: 12, locationRecordedAt: measuredAt });

  it('DT-15: going On Leave waits for a Dispatch assignment in progress and saves nothing', async () => {
    const { user, token } = await createDriver('dt15-lock');
    await DriverProfile.updateOne(
      { userId: user._id },
      { $set: { serviceRadius: 100, commitmentLock: { token: 'dispatch', acquiredAt: new Date(), lockedUntil: new Date(Date.now() + 60_000) } } },
    );

    const res = await request(app)
      .patch('/api/driver-profile/logistics')
      .set(auth(token))
      .send({ operationalStatus: 'on_leave', serviceRadius: 250 })
      .expect(409);
    expect(res.body.message).toMatch(/Dispatch is updating your loads right now/);

    const profile: any = await DriverProfile.findOne({ userId: user._id });
    expect(profile.operationalStatus).toBe('active');
    expect(profile.serviceRadius).toBe(100);
  });

  it('DT-15: a refused status change does not half-save the service area', async () => {
    const { user, token } = await acceptedLoad('dt15-active-load');
    await DriverProfile.updateOne({ userId: user._id }, { $set: { serviceRadius: 100 } });

    await request(app)
      .patch('/api/driver-profile/logistics')
      .set(auth(token))
      .send({ operationalStatus: 'on_leave', serviceRadius: 250 })
      .expect(409);
    const profile: any = await DriverProfile.findOne({ userId: user._id });
    expect(profile.operationalStatus).toBe('active');
    expect(profile.serviceRadius).toBe(100);

    // A plain service-area change still works.
    await request(app)
      .patch('/api/driver-profile/logistics')
      .set(auth(token))
      .send({ serviceRadius: 300 })
      .expect(200);
    expect((await DriverProfile.findOne({ userId: user._id }) as any).serviceRadius).toBe(300);
  });

  it('DT-19: pickup without recent GPS goes through but is flagged to the dispatcher', async () => {
    const { user, token, load } = await acceptedLoad('dt19-no-gps');
    await request(app).post(`/api/driver-tracking/loads/${load._id}/submit-pickup-proof`).set(auth(token)).attach('proof', PNG, 'pickup.png').expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/pickup`).set(auth(token)).expect(200);

    const updated: any = await reload(load._id);
    expect(updated.status).toBe('Picked Up');
    expect(updated.gpsGapEvents).toHaveLength(1);
    expect(updated.gpsGapEvents[0].step).toBe('picked_up');

    const notice = await Notification.findOne({ userId: dispatcher._id, 'metadata.loadId': String(load._id), 'metadata.gpsMissing': true });
    expect(notice?.title).toBe('Picked Up without recent GPS');
    expect(notice?.message).toMatch(new RegExp(`${user.name} marked load ${updated.loadNumber} as Picked Up`));
  });

  it('DT-19: pickup with recent GPS is not flagged', async () => {
    const { token, load } = await acceptedLoad('dt19-with-gps');
    await sendFix(token).expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/submit-pickup-proof`).set(auth(token)).attach('proof', PNG, 'pickup.png').expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/pickup`).set(auth(token)).expect(200);
    expect((await reload(load._id) as any).gpsGapEvents).toHaveLength(0);
  });

  it('DT-21: a GPS sample must say when it was measured', async () => {
    const { token } = await acceptedLoad('dt21-no-time');
    await request(app)
      .post('/api/driver-tracking/heartbeat')
      .set(auth(token))
      .send({ lat: 40.76, lng: -111.89 })
      .expect(400);
  });

  it('DT-21: a sample still on its way when GPS was turned off cannot turn sharing back on', async () => {
    const { user, token } = await acceptedLoad('dt21-offline-fence');
    await sendFix(token).expect(200);
    await request(app).post('/api/driver-tracking/location-offline').set(auth(token)).expect(200);
    const stopped: any = await DriverLocation.findOne({ userId: user._id });
    expect(stopped.isSharing).toBe(false);

    // Simulate the in-flight sample: GPS was turned off after the server received it.
    await DriverLocation.updateOne({ userId: user._id }, { $set: { sharingStoppedAt: new Date(Date.now() + 60_000) } });
    const late = await sendFix(token).expect(200);
    expect(late.body.data.locationAccepted).toBe(false);
    expect((await DriverLocation.findOne({ userId: user._id }) as any).isSharing).toBe(false);

    // Turning GPS back on later works normally.
    await DriverLocation.updateOne({ userId: user._id }, { $set: { sharingStoppedAt: new Date(Date.now() - 60_000) } });
    const back = await sendFix(token).expect(200);
    expect(back.body.data.locationAccepted).toBe(true);
  });

  it('DT-21: starting the route does not make an old position look fresh', async () => {
    const { user, token, load } = await acceptedLoad('dt21-start-route');
    await sendFix(token).expect(200);
    const oldSeen = new Date(Date.now() - 30 * 60_000);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/submit-pickup-proof`).set(auth(token)).attach('proof', PNG, 'pickup.png').expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/pickup`).set(auth(token)).expect(200);
    await DriverLocation.updateOne({ userId: user._id }, { $set: { lastSeenAt: oldSeen, locationRecordedAt: oldSeen } });

    await request(app).post(`/api/driver-tracking/loads/${load._id}/start-route`).set(auth(token)).expect(200);
    const location: any = await DriverLocation.findOne({ userId: user._id });
    expect(location.status).toBe('on-route');
    expect(location.lastSeenAt.getTime()).toBe(oldSeen.getTime());
    // Started the route 30 minutes after the last GPS: flagged.
    expect((await reload(load._id) as any).gpsGapEvents.map((g: any) => g.step)).toContain('in_transit');
  });

  it('DT-18: during an emergency, turning GPS off keeps the last position for vehicles on board', async () => {
    const { user, token, load } = await acceptedLoad('dt18-emergency');
    await sendFix(token).expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/submit-pickup-proof`).set(auth(token)).attach('proof', PNG, 'pickup.png').expect(200);
    await request(app).post(`/api/driver-tracking/loads/${load._id}/pickup`).set(auth(token)).expect(200);
    await DriverStatusChangeRequest.create({
      organizationId: String(orgA._id),
      driverId: user._id,
      requestedStatus: 'on_leave',
      priority: 'emergency',
      status: 'approved_awaiting_reassignment',
      affectedLoadIds: [load._id],
    });

    const res = await request(app).post('/api/driver-tracking/location-offline').set(auth(token)).expect(200);
    expect(res.body.data.required).toBe(false); // the driver is not blocked
    const location: any = await DriverLocation.findOne({ userId: user._id });
    expect(location).not.toBeNull(); // Dispatch keeps the last known position
    expect(location.isSharing).toBe(false);
  });
});

// ─── Account changes by a super admin apply on the next request ──────────────

describe('Role and suspension changes apply immediately', () => {
  let superAdminToken: string;

  async function createStaff(label: string) {
    const user = await User.create({
      email: `${label}${TEST_EMAIL_DOMAIN}`,
      name: `Staff ${label}`,
      role: 'admin',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    return { user, token: tokenService.generateAccessToken(user as any) };
  }

  beforeAll(async () => {
    const superAdmin = await User.create({
      email: `super-admin${TEST_EMAIL_DOMAIN}`,
      name: 'Super Admin',
      role: 'super_admin',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    superAdminToken = tokenService.generateAccessToken(superAdmin as any);
  });

  it('an admin changed to driver loses Dispatch access on the very next request', async () => {
    const { user, token } = await createStaff('demoted-admin');
    // First request caches the signed-in user.
    await request(app).get('/api/driver-tracking/load-requests').set(auth(token)).expect(200);

    await request(app)
      .put(`/api/admin/users/${user._id}/role`)
      .set(auth(superAdminToken))
      .send({ role: 'driver' })
      .expect(200);

    await request(app).get('/api/driver-tracking/load-requests').set(auth(token)).expect(403);
  });

  it('a suspended user is refused on the very next request', async () => {
    const { user, token } = await createStaff('suspended-admin');
    await request(app).get('/api/driver-tracking/load-requests').set(auth(token)).expect(200);

    await request(app).post(`/api/admin/users/${user._id}/suspend`).set(auth(superAdminToken)).expect(200);

    const refused = await request(app).get('/api/driver-tracking/load-requests').set(auth(token)).expect(403);
    expect(refused.body.message).toMatch(/suspended/);
  });
});

// ─── DT-18: "Driver Offline" alerts during an emergency request ──────────────

describe('Emergency request GPS alerts (DT-18)', () => {
  async function driverWithLoad(label: string, pickUp: boolean) {
    const driver = await createDriver(label);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driver.token))
      .send(signatureFor(`Driver ${label}`))
      .expect(200);
    await request(app)
      .post('/api/driver-tracking/heartbeat')
      .set(auth(driver.token))
      .send({ lat: 40.76, lng: -111.89, accuracy: 12, locationRecordedAt: new Date(Date.now() - 5_000).toISOString() })
      .expect(200);
    if (pickUp) {
      await request(app).post(`/api/driver-tracking/loads/${load._id}/submit-pickup-proof`).set(auth(driver.token)).attach('proof', PNG, 'pickup.png').expect(200);
      await request(app).post(`/api/driver-tracking/loads/${load._id}/pickup`).set(auth(driver.token)).expect(200);
    }
    // Emergency request, then the driver turns GPS off.
    await DriverStatusChangeRequest.create({
      organizationId: String(orgA._id),
      driverId: driver.user._id,
      requestedStatus: 'on_leave',
      priority: 'emergency',
      status: 'approved_awaiting_reassignment',
      affectedLoadIds: [load._id],
    });
    await request(app).post('/api/driver-tracking/location-offline').set(auth(driver.token)).expect(200);
    // 15 minutes pass without GPS.
    const lastFix = new Date(Date.now() - 15 * 60_000);
    await DriverLocation.updateOne(
      { userId: driver.user._id },
      { $set: { lastSeenAt: lastFix, locationRecordedAt: lastFix, offlineAlertSentAt: null } },
    );
    return { ...driver, load };
  }

  const offlineAlertsFor = (driverId: unknown) =>
    Notification.find({ userId: dispatcher._id, type: 'driver_tracker_offline_alert', 'metadata.driverId': String(driverId) });

  it('still alerts the responsible dispatcher for a Picked Up load', async () => {
    const { user, load } = await driverWithLoad('dt18-picked-up', true);
    await monitorDriverLocationSilence();
    const alerts = await offlineAlertsFor(user._id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].metadata?.loadIds).toContain(String(load._id));
  });

  it('stays quiet for a load that has not been picked up yet', async () => {
    const { user } = await driverWithLoad('dt18-accepted-only', false);
    await monitorDriverLocationSilence();
    expect(await offlineAlertsFor(user._id)).toHaveLength(0);
  });
});

// ─── DT-26: Dispatch Chat shows only the dispatcher's own loads ──────────────

describe('Dispatch Chat load list (DT-26)', () => {
  it('a dispatcher sees only the loads they are responsible for; an admin sees all', async () => {
    const { user: driver } = await createDriver('dt26-chat');
    const employee = await User.create({
      email: `dt26-chat-dispatcher${TEST_EMAIL_DOMAIN}`,
      name: 'Chat Dispatcher',
      role: 'employee',
      organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id],
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const employeeToken = tokenService.generateAccessToken(employee as any);

    const theirs = await seedLoad({ status: 'Assigned', assignedDriverId: driver._id, dispatchOwnerId: employee._id });
    const someoneElses = await seedLoad({ status: 'Assigned', assignedDriverId: driver._id, dispatchOwnerId: dispatcher._id });

    const asDispatcher = await request(app)
      .get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
      .set(auth(employeeToken))
      .expect(200);
    const dispatcherLoadIds = asDispatcher.body.data.context.loads.map((load: any) => load.id);
    expect(dispatcherLoadIds).toEqual([String(theirs._id)]);

    const asAdmin = await request(app)
      .get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
      .set(auth(dispatcherToken))
      .expect(200);
    const adminLoadIds = asAdmin.body.data.context.loads.map((load: any) => load.id);
    expect(adminLoadIds).toEqual(expect.arrayContaining([String(theirs._id), String(someoneElses._id)]));
  });
});

// ─── Driver Tracker speed: lighter requests, same results ───────────────────

describe('Lighter Driver Tracker and Driver Portal requests', () => {
  it('one unread-count request matches the per-driver counts', async () => {
    const { user: driver, token: driverToken } = await createDriver('unread-batch');
    const employee = await User.create({
      email: `unread-batch-dispatcher${TEST_EMAIL_DOMAIN}`,
      name: 'Unread Dispatcher',
      role: 'employee',
      organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id],
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const employeeToken = tokenService.generateAccessToken(employee as any);

    // The dispatcher opens the chat, and the driver replies twice.
    const opened = await request(app)
      .get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
      .set(auth(employeeToken))
      .expect(200);
    const threadId = opened.body.data.thread.id;
    for (const text of ['On my way', 'Running 10 minutes late']) {
      await request(app)
        .post(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
        .set(auth(driverToken))
        .send({ threadId, content: text })
        .expect((res) => { if (res.status >= 300) throw new Error(`send failed ${res.status}: ${res.body?.message}`); });
    }

    const single = await request(app)
      .get(`/api/driver-tracking/dispatch-chat/${driver._id}/unread`)
      .set(auth(employeeToken))
      .expect(200);
    const batch = await request(app)
      .get('/api/driver-tracking/dispatch-chat/unread-by-driver')
      .set(auth(employeeToken))
      .expect(200);

    expect(single.body.data.unreadCount).toBe(2);
    expect(batch.body.data.counts[String(driver._id)]).toBe(2);

    // Drivers can't use the staff-wide count.
    await request(app).get('/api/driver-tracking/dispatch-chat/unread-by-driver').set(auth(driverToken)).expect(403);
  });

  it('my-loads?view=active returns only current loads, and history skips compatibility', async () => {
    const { user: driver, token } = await createDriver('my-loads-view');
    const delivered = await seedLoad({ status: 'Delivered', assignedDriverId: driver._id, dispatchOwnerId: dispatcher._id });
    const current = await seedLoad({ status: 'Assigned', assignedDriverId: driver._id, dispatchOwnerId: dispatcher._id });

    const active = await request(app).get('/api/driver-tracking/my-loads?view=active').set(auth(token)).expect(200);
    expect(active.body.data.map((load: any) => String(load._id))).toEqual([String(current._id)]);

    const all = await request(app).get('/api/driver-tracking/my-loads').set(auth(token)).expect(200);
    const byId = new Map(all.body.data.map((load: any) => [String(load._id), load]));
    expect(byId.size).toBe(2);
    expect((byId.get(String(delivered._id)) as any).compatibility).toBeNull();
    expect((byId.get(String(current._id)) as any).compatibility).toBeTruthy();
  });

  it('the driver directory still returns the profile details it shows', async () => {
    const { user: driver } = await createDriver('directory-fields');
    await DriverProfile.updateOne(
      { userId: driver._id },
      { $set: { trailerType: 'open_2car', serviceRadius: 250, preferredRoutes: ['UT-CO'], availableDays: ['monday'], 'homeBase.city': 'Provo', 'homeBase.state': 'UT' } },
    );
    const res = await request(app).get('/api/driver-tracking/org-drivers').set(auth(dispatcherToken)).expect(200);
    const entry = res.body.data.drivers.find((item: any) => item.id === String(driver._id));
    expect(entry.equipment.trailerType).toBe('open_2car');
    expect(entry.equipment.maxVehicleCapacity).toBe(5);
    expect(entry.logistics.serviceRadiusMiles).toBe(250);
    expect(entry.logistics.preferredRoutes).toEqual(['UT-CO']);
    expect(entry.availability.availableDays).toEqual(['monday']);
    expect(entry.logistics.homeBase).toMatchObject({ city: 'Provo', state: 'UT' });
  });
});

// ─── Driver Tracker directory paging and chat unread consistency ────────────

describe('Driver Tracker directory paging', () => {
  const directory = (params: Record<string, string | number>) =>
    request(app)
      .get('/api/driver-tracking/org-drivers')
      .query(params)
      .set(auth(dispatcherToken))
      .expect(200);

  it('the working set holds every driver with activity here, and platform totals', async () => {
    const { user: busy } = await createDriver('paging-busy');
    const { user: idle } = await createDriver('paging-idle');
    await seedLoad({ status: 'Assigned', assignedDriverId: busy._id, dispatchOwnerId: dispatcher._id });

    const res = await directory({ scope: 'working' });
    const ids = res.body.data.drivers.map((driver: any) => driver.id);
    expect(ids).toContain(String(busy._id));
    expect(ids).not.toContain(String(idle._id));
    const busyEntry = res.body.data.drivers.find((driver: any) => driver.id === String(busy._id));
    expect(busyEntry.shipments.length).toBeGreaterThan(0);
    expect(res.body.data.summary.totalDrivers).toBeGreaterThanOrEqual(2);
  });

  it('the directory is paged and searchable, with profile data only', async () => {
    const { user: found } = await createDriver('paging-zzsearchable');
    await seedLoad({ status: 'Assigned', assignedDriverId: found._id, dispatchOwnerId: dispatcher._id });

    const searched = await directory({ scope: 'directory', search: 'zzsearchable' });
    expect(searched.body.data.total).toBe(1);
    expect(searched.body.data.drivers[0].id).toBe(String(found._id));
    // Activity never comes from directory pages.
    expect(searched.body.data.drivers[0].shipments).toEqual([]);

    const firstPage = await directory({ scope: 'directory', page: 1, limit: 1 });
    expect(firstPage.body.data.drivers).toHaveLength(1);
    expect(firstPage.body.data.hasMore).toBe(firstPage.body.data.total > 1);
    const secondPage = await directory({ scope: 'directory', page: 2, limit: 1 });
    if (firstPage.body.data.total > 1) {
      expect(secondPage.body.data.drivers[0].id).not.toBe(firstPage.body.data.drivers[0].id);
    }
  });

  it('the Work Availability filter and the assignable list leave out drivers on leave', async () => {
    const { user: onLeave } = await createDriver('paging-onleave');
    await DriverProfile.updateOne({ userId: onLeave._id }, { $set: { operationalStatus: 'on_leave' } });

    const leaveOnly = await directory({ scope: 'directory', status: 'on_leave', search: 'paging-onleave' });
    expect(leaveOnly.body.data.drivers.map((driver: any) => driver.id)).toEqual([String(onLeave._id)]);
    const activeOnly = await directory({ scope: 'directory', status: 'active', search: 'paging-onleave' });
    expect(activeOnly.body.data.total).toBe(0);

    const assignable = await directory({ scope: 'assignable' });
    expect(assignable.body.data.drivers.map((driver: any) => driver.id)).not.toContain(String(onLeave._id));
  });

  it('specific drivers can be fetched by id, and the default list is unchanged', async () => {
    const { user: target } = await createDriver('paging-by-id');
    const byId = await directory({ scope: 'ids', ids: String(target._id) });
    expect(byId.body.data.drivers.map((driver: any) => driver.id)).toEqual([String(target._id)]);

    const legacy = await request(app).get('/api/driver-tracking/org-drivers').set(auth(dispatcherToken)).expect(200);
    expect(legacy.body.data.drivers.length).toBe(legacy.body.data.total);
    expect(legacy.body.data.drivers.map((driver: any) => driver.id)).toContain(String(target._id));
  });

  it('refuses an unknown view with a plain message', async () => {
    const res = await request(app)
      .get('/api/driver-tracking/org-drivers')
      .query({ scope: 'everything' })
      .set(auth(dispatcherToken))
      .expect(400);
    expect(res.body.message).toMatch(/isn't available/);
  });
});

describe('Dispatch Chat unread counts agree (DT-28)', () => {
  it('a system event meant for the dispatcher is counted the same everywhere', async () => {
    const { user: driver } = await createDriver('dt28-counts');
    const employee = await User.create({
      email: `dt28-dispatcher${TEST_EMAIL_DOMAIN}`,
      name: 'DT28 Dispatcher',
      role: 'employee',
      organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id],
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const employeeToken = tokenService.generateAccessToken(employee as any);
    const opened = await request(app)
      .get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
      .set(auth(employeeToken))
      .expect(200);

    // For example an alert response recorded in the dispatcher's own thread.
    await DispatchChatMessage.create({
      organizationId: String(orgA._id),
      threadId: opened.body.data.thread.id,
      dispatcherId: employee._id,
      driverId: driver._id,
      senderId: employee._id,
      senderRole: 'dispatcher',
      messageType: 'system',
      content: 'Driver responded to your alert',
      systemEvent: { type: 'alert_response', metadata: { unreadForParticipantIds: [String(employee._id)] } },
    });

    const single = await request(app).get(`/api/driver-tracking/dispatch-chat/${driver._id}/unread`).set(auth(employeeToken)).expect(200);
    const batch = await request(app).get('/api/driver-tracking/dispatch-chat/unread-by-driver').set(auth(employeeToken)).expect(200);
    const total = await request(app).get('/api/driver-tracking/dispatch-chat/unread-total').set(auth(employeeToken)).expect(200);
    expect(single.body.data.unreadCount).toBe(1);
    expect(batch.body.data.counts[String(driver._id)]).toBe(1);
    expect(total.body.data.unreadTotal).toBe(1);

    // Reading the chat clears it everywhere.
    await request(app).post(`/api/driver-tracking/dispatch-chat/${driver._id}/read`).set(auth(employeeToken)).send({}).expect(200);
    const after = await request(app).get(`/api/driver-tracking/dispatch-chat/${driver._id}/unread`).set(auth(employeeToken)).expect(200);
    expect(after.body.data.unreadCount).toBe(0);
  });
});

// ─── Notification badge counts don't depend on how many are loaded ──────────

describe('Notification unread counts', () => {
  it('returns the same unread and CRM unread counts whether 1 or all notifications are loaded', async () => {
    const staff = await User.create({
      email: `notif-counts${TEST_EMAIL_DOMAIN}`,
      name: 'Notification Counts',
      role: 'admin',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const token = tokenService.generateAccessToken(staff as any);
    const base = { userId: staff._id, organizationId: String(orgA._id), title: 'T', message: 'M', isRead: false };
    await Notification.create([
      { ...base, type: 'crm_message', category: 'crm' },
      { ...base, type: 'new_lead', category: 'crm' },
      { ...base, type: 'load_picked_up', category: 'transportation' },
      { ...base, type: 'load_delivered', category: 'transportation', isRead: true },
    ]);
    // An older row saved before notifications had a category.
    await Notification.collection.insertOne({
      ...base,
      type: 'lead_assigned',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const one = await request(app).get('/api/notifications').query({ limit: 1 }).set(auth(token)).expect(200);
    const all = await request(app).get('/api/notifications').query({ limit: 0 }).set(auth(token)).expect(200);

    for (const res of [one, all]) {
      expect(res.body.data.unreadCount).toBe(4);
      expect(res.body.data.unreadCrmCount).toBe(3);
    }
    expect(one.body.data.notifications).toHaveLength(1);
    expect(all.body.data.notifications).toHaveLength(5);
  });
});

// ─── Batch 8: calendar-day dates (DT-22) and safe load edits (DT-25) ────────

describe('Load edits are checked and never overwrite a newer change (DT-22, DT-25)', () => {
  const edit = (loadId: unknown, token: string, body: Record<string, unknown>) =>
    request(app).put(`/api/loads/${loadId}`).set(auth(token)).send(body);

  it('refuses an edit made from an older version and names the creator', async () => {
    const other = await User.create({
      email: `dt25-editor${TEST_EMAIL_DOMAIN}`,
      name: 'Second Editor',
      role: 'admin',
      organizationId: orgA._id,
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const otherToken = tokenService.generateAccessToken(other as any);
    const load = await seedLoad();
    const openedVersion = await currentVersion(load._id);

    // The creator saves first…
    await new Promise((resolve) => setTimeout(resolve, 5));
    await edit(load._id, dispatcherToken, { additionalInfo: { notes: 'First change' }, expectedUpdatedAt: openedVersion }).expect(200);

    // …then a second dispatcher saves from the version they opened.
    const res = await edit(load._id, otherToken, { additionalInfo: { notes: 'Second change' }, expectedUpdatedAt: openedVersion }).expect(409);
    expect(res.body.message).toMatch(/was changed while you were editing it/);
    expect(res.body.message).toMatch(/check with Dispatcher A, who created this load/);
    expect((await reload(load._id))!.additionalInfo?.notes).toBe('First change');
  });

  it('refuses unknown fields and an edit without a version', async () => {
    const load = await seedLoad();
    const unknown = await edit(load._id, dispatcherToken, { assignedDriverId: String(dispatcher._id), expectedUpdatedAt: await currentVersion(load._id) }).expect(400);
    expect(unknown.body.message).toMatch(/field that can't be changed here/);
    const missing = await edit(load._id, dispatcherToken, { additionalInfo: { notes: 'x' } }).expect(400);
    expect(missing.body.message).toMatch(/out of date/);
  });

  it('keeps the Private setting when an edit leaves visibility out', async () => {
    const load = await seedLoad({ additionalInfo: { visibility: 'private' } });
    await edit(load._id, dispatcherToken, { additionalInfo: { notes: 'Only notes' }, expectedUpdatedAt: await currentVersion(load._id) }).expect(200);
    const saved: any = await reload(load._id);
    expect(saved.additionalInfo.visibility).toBe('private');
    expect(saved.additionalInfo.notes).toBe('Only notes');
  });

  it('refuses switching Load Board / Assign Carrier after a driver is assigned', async () => {
    const { user: driver } = await createDriver('dt25-posttype');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    const res = await edit(load._id, dispatcherToken, { postType: 'assign-carrier', expectedUpdatedAt: await currentVersion(load._id) }).expect(409);
    expect(res.body.message).toMatch(/between Load Board and Assign Carrier/);
  });

  it('stores load dates as calendar days and refuses dates with a time zone', async () => {
    const load = await seedLoad();
    const shifted = await edit(load._id, dispatcherToken, {
      dates: { firstAvailable: '2026-09-04T20:00:00-06:00' },
      expectedUpdatedAt: await currentVersion(load._id),
    }).expect(400);
    expect(shifted.body.message).toMatch(/calendar day/);

    await edit(load._id, dispatcherToken, {
      dates: { firstAvailable: '2026-09-04', pickupDeadline: '2026-09-05T00:00:00.000Z' },
      expectedUpdatedAt: await currentVersion(load._id),
    }).expect(200);
    const saved: any = await reload(load._id);
    expect(saved.dates.firstAvailable.toISOString().slice(0, 10)).toBe('2026-09-04');
    expect(saved.dates.pickupDeadline.toISOString().slice(0, 10)).toBe('2026-09-05');

    await edit(load._id, dispatcherToken, {
      dates: { firstAvailable: '2026-02-30' },
      expectedUpdatedAt: await currentVersion(load._id),
    }).expect(400);
  });
});

// ─── Batch 8: repeated actions don't fail or duplicate (DT-27) ──────────────

describe('Repeated taps and retries (DT-27)', () => {
  it('accept, pickup and start route succeed when repeated', async () => {
    const { user: driver, token } = await createDriver('dt27-repeat');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    const post = (path: string) => request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(token));

    await post('accept').send(signatureFor('Repeat Driver')).expect(200);
    const again = await post('accept').send(signatureFor('Repeat Driver')).expect(200);
    expect(again.body.message).toMatch(/already accepted/);

    await post('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await post('pickup').expect(200);
    await post('pickup').expect(200);
    await post('start-route').expect(200);
    await post('start-route').expect(200);
    expect((await reload(load._id))!.status).toBe('In-Transit');
  });

  it('a repeated load request succeeds without a second request', async () => {
    const { user: driver, token } = await createDriver('dt27-request');
    const load = await seedLoad();
    const requestLoad = () =>
      request(app).post(`/api/driver-tracking/loads/${load._id}/request`).set(auth(token)).send(signatureFor('Request Driver'));
    await requestLoad().expect(200);
    const again = await requestLoad().expect(200);
    expect(again.body.message).toMatch(/already requested/);
    const saved: any = await Load.findById(load._id).lean();
    expect(saved.driverRequests.filter((r: any) => String(r.driverId) === String(driver._id))).toHaveLength(1);
  });

  it('a chat message and an alert sent twice with the same id are stored once', async () => {
    const { user: driver } = await createDriver('dt27-chat');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const sendMessage = () =>
      request(app)
        .post(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
        .set(auth(dispatcherToken))
        .send({ content: 'Are you close?', clientMessageId: 'retry-test-message-1' });
    const first = await sendMessage().expect(201);
    const second = await sendMessage().expect(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await DispatchChatMessage.countDocuments({ driverId: driver._id, content: 'Are you close?' })).toBe(1);

    const sendAlert = () =>
      request(app)
        .post(`/api/driver-tracking/drivers/${driver._id}/alert`)
        .set(auth(dispatcherToken))
        .send({ alertType: 'quick_attention', quickPreset: 'check_dispatch_chat', clientRequestId: 'retry-test-alert-1' });
    await sendAlert().expect(201);
    await sendAlert().expect(200);
    expect(
      await Notification.countDocuments({ userId: driver._id, type: 'driver_dispatch_alert', 'metadata.clientRequestId': 'retry-test-alert-1' }),
    ).toBe(1);
  });
});

// ─── Batch 8b: alerts, email, durable declines, documents, chat, locks ──────

describe('Batch 8b fixes', () => {
  async function assignedDriver(label: string) {
    const driver = await createDriver(label);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    return { ...driver, load };
  }

  it('DT-34: only the first alert response counts, a repeat succeeds, a broken link is a plain 404', async () => {
    const { user: driver, token } = await assignedDriver('dt34-alert');
    const sent = await request(app)
      .post(`/api/driver-tracking/drivers/${driver._id}/alert`)
      .set(auth(dispatcherToken))
      .send({ alertType: 'quick_attention', quickPreset: 'please_respond' })
      .expect(201);
    const alertId = sent.body.data._id;
    const respond = (response: string) =>
      request(app).post(`/api/driver-tracking/alerts/${alertId}/respond`).set(auth(token)).send({ response });

    await respond('acknowledged').expect(200);
    await respond('acknowledged').expect(200);
    const changed = await respond('unable').expect(409);
    expect(changed.body.message).toMatch(/You already responded "Acknowledged"/);
    expect((await Notification.findById(alertId).lean() as any).metadata.response).toBe('acknowledged');

    const broken = await request(app).post('/api/driver-tracking/alerts/not-an-id/respond').set(auth(token)).send({ response: 'acknowledged' }).expect(404);
    expect(broken.body.message).toMatch(/no longer available/);
  });

  it('DT-35: load details email escapes what people typed', async () => {
    const emailModule = require('../src/services/email.service').default;
    const spy = jest.spyOn(emailModule, 'sendEmail').mockResolvedValue(undefined as any);
    try {
      const load = await seedLoad({
        vehicles: [{ year: 2020, make: '<a href="https://evil.example">Click</a>', model: 'Camry', condition: 'Operable' }],
      });
      await request(app)
        .post(`/api/loads/${load._id}/send-email`)
        .set(auth(dispatcherToken))
        .send({ recipientEmail: 'someone@example.com' })
        .expect(200);
      const html = String((spy.mock.calls[0][0] as any).html);
      expect(html).not.toContain('<a href="https://evil.example">');
      expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    } finally {
      spy.mockRestore();
    }
  });

  it('DT-38: declining a load request always delivers the driver notice and the chat card', async () => {
    const { user: driver, token } = await createDriver('dt38-decline');
    const load = await seedLoad();
    await request(app).post(`/api/driver-tracking/loads/${load._id}/request`).set(auth(token)).send(signatureFor('Decline Driver')).expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/reject-request`)
      .set(auth(dispatcherToken))
      .send({ driverId: String(driver._id) })
      .expect(200);
    expect(await Notification.countDocuments({ userId: driver._id, type: 'driver_request_rejected', 'metadata.loadId': String(load._id) })).toBe(1);
    expect(
      await DispatchChatMessage.countDocuments({ driverId: driver._id, 'systemEvent.type': 'driver_load_request_rejected' }),
    ).toBe(1);
  });

  it('DT-39: older public-link documents open only for admins', async () => {
    const { user: driver } = await createDriver('dt39-legacy-doc');
    const profile: any = await DriverProfile.findOneAndUpdate(
      { userId: driver._id },
      { $push: { documents: { type: 'drivers_license', label: 'CDL', fileUrl: 'https://public.example/cdl.png' } } },
      { new: true },
    );
    const documentId = String(profile.documents[0]._id);
    const dispatcherEmployee = await User.create({
      email: `dt39-dispatcher${TEST_EMAIL_DOMAIN}`,
      name: 'DT39 Dispatcher',
      role: 'employee',
      organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id],
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    const path = `/api/driver-tracking/drivers/${driver._id}/documents/${documentId}/file`;

    const refused = await request(app).get(path).set(auth(tokenService.generateAccessToken(dispatcherEmployee as any))).expect(403);
    expect(refused.body.message).toMatch(/only an admin can open it/);
    await request(app).get(path).set(auth(dispatcherToken)).expect(302);
  });

  it('DT-31: the driver list agrees with the Assign button about requests in other organizations', async () => {
    const { user: driver } = await createDriver('dt31-other-org');
    await DriverStatusChangeRequest.create({
      organizationId: String(orgB._id),
      driverId: driver._id,
      requestedStatus: 'on_leave',
      priority: 'emergency',
      status: 'approved_awaiting_reassignment',
    });
    const res = await request(app).get('/api/driver-tracking/org-drivers').query({ scope: 'ids', ids: String(driver._id) }).set(auth(dispatcherToken)).expect(200);
    expect(res.body.data.drivers[0].assignable).toBe(false);
  });

  it('DT-29: mark as read covers only messages on screen, and same-millisecond messages page correctly', async () => {
    const { user: driver, token: driverToken } = await assignedDriver('dt29-chat');
    const opened = await request(app).get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`).set(auth(dispatcherToken)).expect(200);
    const threadId = opened.body.data.thread.id;
    const sameMoment = new Date(Date.now() - 60_000);
    const base = {
      organizationId: String(orgA._id), threadId, dispatcherId: dispatcher._id, driverId: driver._id,
      senderId: driver._id, senderRole: 'driver', messageType: 'message', readBy: [driver._id],
      createdAt: sameMoment, updatedAt: sameMoment,
    };
    await DispatchChatMessage.collection.insertMany([
      { ...base, content: 'same-ms one' },
      { ...base, content: 'same-ms two' },
      { ...base, content: 'same-ms three' },
    ].map((doc) => ({ ...doc, threadId: new mongoose.Types.ObjectId(threadId) })));

    // Page one at a time: all three must appear (older system cards may come first).
    const seen = new Set<string>();
    let before: string | undefined;
    let beforeId: string | undefined;
    for (let i = 0; i < 8 && [...seen].filter((c) => c.startsWith('same-ms')).length < 3; i += 1) {
      const page = await request(app)
        .get(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
        .query({ limit: 1, ...(before ? { before, beforeId } : {}) })
        .set(auth(dispatcherToken))
        .expect(200);
      const message = page.body.data.messages[0];
      seen.add(message.content);
      before = message.createdAt;
      beforeId = message.id;
    }
    expect([...seen].filter((c) => c.startsWith('same-ms')).sort()).toEqual(['same-ms one', 'same-ms three', 'same-ms two']);

    // A newer message arrives after what's on screen: reading stops before it.
    const shownUpTo = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await request(app)
      .post(`/api/driver-tracking/dispatch-chat/${driver._id}/messages`)
      .set(auth(driverToken))
      .send({ threadId, content: 'arrived later' })
      .expect(201);
    await request(app)
      .post(`/api/driver-tracking/dispatch-chat/${driver._id}/read`)
      .set(auth(dispatcherToken))
      .send({ readUpTo: shownUpTo })
      .expect(200);
    const unread = await request(app).get(`/api/driver-tracking/dispatch-chat/${driver._id}/unread`).set(auth(dispatcherToken)).expect(200);
    expect(unread.body.data.unreadCount).toBe(1);
  });

  it('DT-37: the assignment lock is never created for an account that is not a driver', async () => {
    const { withDriverCommitmentLock } = require('../src/services/driverWorkCommitment.service');
    await expect(withDriverCommitmentLock(String(dispatcher._id), async () => 'ran')).rejects.toThrow(/can't be found/);
    expect(await DriverProfile.exists({ userId: dispatcher._id })).toBeNull();
  });
});

// ─── Batch 8c: one status table, missing dispatcher, health logs ────────────

describe('Batch 8c fixes', () => {
  it('DT-40/42: each status change is logged once with ids only, and counted', async () => {
    const logger = require('../src/utils/logger').default;
    const { driverTrackerMetrics } = require('../src/utils/metrics');
    const { user: driver, token } = await createDriver('dt42-log');
    const load = await seedLoad();
    const infoSpy = jest.spyOn(logger, 'info');
    const countedBefore = driverTrackerMetrics.loadTransitions;
    try {
      await request(app)
        .post('/api/driver-tracking/assign-load')
        .set(auth(dispatcherToken))
        .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
        .expect(200);
      await request(app)
        .post(`/api/driver-tracking/loads/${load._id}/accept`)
        .set(auth(token))
        .send(signatureFor('DT42 Driver'))
        .expect(200);

      const lines = infoSpy.mock.calls
        .map((call) => call[0] as any)
        .filter((entry) => entry?.event === 'load_status_transition' && entry.loadId === String(load._id));
      expect(lines.map((entry) => `${entry.from} -> ${entry.to}`)).toEqual(['Posted -> Assigned', 'Assigned -> Accepted']);
      expect(lines[0].actorId).toBe(String(dispatcher._id));
      expect(lines[1].actorId).toBe(String(driver._id));
      expect(lines[0].outboxEventIds.length).toBeGreaterThan(0);
      expect(JSON.stringify(lines)).not.toMatch(/signatureDataUrl|coords/);
      expect(driverTrackerMetrics.loadTransitions - countedBefore).toBeGreaterThanOrEqual(2);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('DT-41: an older load with no responsible dispatcher on file still takes a release request', async () => {
    const { user: driver, token } = await createDriver('dt41-legacy-owner');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    // Looks like a load assigned before the field existed.
    await Load.collection.updateOne({ _id: load._id }, { $unset: { dispatchOwnerId: '' } });

    const res = await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/release-request`)
      .set(auth(token))
      .send({ reason: 'vehicle_issue', message: 'Flat tire' })
      .expect(202);
    expect(res.body.data.dispatcherId).toBe(String(dispatcher._id));
    expect(String(((await reload(load._id)) as any).dispatchOwnerId)).toBe(String(dispatcher._id));
  });
});

// ─── Release request decline / cancel notices are never lost ────────────────

describe('Release request decline and cancel always reach the other person', () => {
  const outbox = require('../src/services/loadLifecycleOutbox.service');

  async function loadWithReleaseRequest(label: string) {
    const { user: driver, token } = await createDriver(label);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/release-request`)
      .set(auth(token))
      .send({ reason: 'vehicle_issue', message: 'Flat tire' })
      .expect(202);
    return { driver, token, load };
  }

  it('a decline saved just before the server stops still notifies the driver, once', async () => {
    const { driver, load } = await loadWithReleaseRequest('release-gap-decline');

    // The server stops right after the decision is saved.
    const handOff = jest.spyOn(outbox, 'handOffReleaseRequestNotices').mockRejectedValueOnce(new Error('server stopped'));
    try {
      await request(app)
        .post(`/api/driver-tracking/loads/${load._id}/release-request/reject`)
        .set(auth(dispatcherToken))
        .send({ decisionReason: 'Keep going' })
        .expect(200);
    } finally {
      handOff.mockRestore();
    }

    const saved: any = await LoadReleaseRequest.findOne({ loadId: load._id }).select('+pendingNotices').lean();
    expect(saved.status).toBe('rejected');
    expect(saved.pendingNotices).toHaveLength(3);
    const driverNotices = () =>
      Notification.countDocuments({ userId: driver._id, title: 'Release Request Not Approved', 'metadata.loadId': String(load._id) });
    expect(await driverNotices()).toBe(0);

    // The outbox worker's sweep recovers it a minute later.
    await LoadReleaseRequest.updateOne({ _id: saved._id }, { $set: { pendingNoticesAt: new Date(Date.now() - 2 * 60_000) } });
    await outbox.recoverStrandedReleaseRequestNotices();
    await outbox.processLoadLifecycleOutboxForLoad(String(load._id));
    expect(await driverNotices()).toBe(1);
    expect(
      await DispatchChatMessage.countDocuments({ driverId: driver._id, 'systemEvent.type': 'driver_load_release_rejected' }),
    ).toBe(1);
    const cleared: any = await LoadReleaseRequest.findById(saved._id).select('+pendingNotices').lean();
    expect(cleared.pendingNotices).toBeUndefined();

    // Stopping again between the hand-off and the clean-up adds nothing twice.
    await LoadReleaseRequest.updateOne(
      { _id: saved._id },
      { $set: { pendingNotices: saved.pendingNotices, pendingNoticesAt: new Date() } },
    );
    await outbox.handOffReleaseRequestNotices(String(saved._id));
    await outbox.processLoadLifecycleOutboxForLoad(String(load._id));
    const eventIds = saved.pendingNotices.map((event: any) => event.eventId);
    const withOutbox: any = await Load.findById(load._id).select('+lifecycleOutbox').lean();
    expect(withOutbox.lifecycleOutbox.filter((event: any) => eventIds.includes(event.eventId))).toHaveLength(3);
    expect(await driverNotices()).toBe(1);
  });

  it('a driver cancelling a release request notifies the dispatcher right away', async () => {
    const { token, load } = await loadWithReleaseRequest('release-gap-cancel');
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/release-request/cancel`)
      .set(auth(token))
      .expect(200);
    expect(
      await Notification.countDocuments({ userId: dispatcher._id, title: 'Release Request Cancelled', 'metadata.loadId': String(load._id) }),
    ).toBe(1);
    const saved: any = await LoadReleaseRequest.findOne({ loadId: load._id }).select('+pendingNotices').lean();
    expect(saved.status).toBe('cancelled');
    expect(saved.pendingNotices).toBeUndefined();
  });
});

// ─── Create Load driver picker ───────────────────────────────────────────────

describe('Create Load lists only drivers who can take work', () => {
  it('shows each driver with their active loads here and leaves out drivers on leave', async () => {
    const { user: busy } = await createDriver('picker-busy');
    const { user: away } = await createDriver('picker-away');
    await DriverProfile.updateOne({ userId: away._id }, { $set: { operationalStatus: 'on_leave' } });
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(busy._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);

    const res = await request(app)
      .get('/api/driver-tracking/org-drivers')
      .query({ scope: 'assignable' })
      .set(auth(dispatcherToken))
      .expect(200);
    const listed = res.body.data.drivers as any[];
    expect(listed.find((driver) => driver.id === String(busy._id))?.activeLoadCount).toBe(1);
    expect(listed.some((driver) => driver.id === String(away._id))).toBe(false);
  });
});
// ─── Driver steps answer before notices go out ───────────────────────────────

describe('Driver steps answer first, notices follow', () => {
  it('Picked Up answers the driver without waiting; Dispatch still gets the notice right after', async () => {
    const outbox = require('../src/services/loadLifecycleOutbox.service');
    const { user: driver, token } = await createDriver('fast-pickup');
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    const driverPost = (path: string) => request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(token));
    await driverPost('accept').send(signatureFor('Fast Driver')).expect(200);
    await driverPost('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);

    outbox.setLifecycleOutboxRequestFlushMode('background');
    try {
      await driverPost('pickup').expect(200);
      expect(((await reload(load._id)) as any).status).toBe('Picked Up');
      await outbox.waitForLifecycleOutboxRequestFlushes();
      expect(
        await Notification.countDocuments({ userId: dispatcher._id, type: 'load_picked_up', title: 'Vehicles Picked Up', 'metadata.loadId': String(load._id) }),
      ).toBe(1);
    } finally {
      outbox.setLifecycleOutboxRequestFlushMode('inline');
    }
  });
});
// ─── Batch 9: Inventory follows the load, withdrawn requests are explained ──

describe('Batch 9 fixes', () => {
  it('a stock vehicle is In Transit from pickup and Ready for Sale again at delivery', async () => {
    const { user: driver, token } = await createDriver('b9-inventory');
    const stock = await Vehicle.create({
      organizationId: String(orgA._id), vin: `B9INV${Date.now()}`, year: 2021, make: 'Honda', modelName: 'Civic',
      status: 'Ready for Sale', stockNumber: `B9-${Date.now()}`,
    });
    const sold = await Vehicle.create({
      organizationId: String(orgA._id), vin: `B9SOLD${Date.now()}`, year: 2019, make: 'Ford', modelName: 'F-150',
      status: 'Sold', stockNumber: `B9S-${Date.now()}`,
    });
    const load = await seedLoad({
      vehicles: [
        { vehicleId: stock._id, year: 2021, make: 'Honda', model: 'Civic', condition: 'Operable' },
        { vehicleId: sold._id, year: 2019, make: 'Ford', model: 'F-150', condition: 'Operable' },
      ],
    });
    const post = (path: string) => request(app).post(`/api/driver-tracking/loads/${load._id}/${path}`).set(auth(token));
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await post('accept').send(signatureFor('B9 Driver')).expect(200);
    expect(((await Vehicle.findById(stock._id).lean()) as any).status).toBe('Ready for Sale');

    await post('submit-pickup-proof').attach('proof', PNG, 'pickup.png').expect(200);
    await post('pickup').expect(200);
    expect(((await Vehicle.findById(stock._id).lean()) as any).status).toBe('In Transit');
    expect(((await Vehicle.findById(sold._id).lean()) as any).status).toBe('Sold');

    await post('start-route').expect(200);
    await post('submit-proof').attach('proof', PNG, 'pod.png').expect(200);
    await post('deliver').expect(200);
    expect(((await Vehicle.findById(stock._id).lean()) as any).status).toBe('Ready for Sale');
    expect(((await Vehicle.findById(sold._id).lean()) as any).status).toBe('Sold');
  });

  it('drivers who requested a load are told when Dispatch deletes it', async () => {
    const { user: driver, token } = await createDriver('b9-withdrawn');
    const load = await seedLoad();
    await request(app).post(`/api/driver-tracking/loads/${load._id}/request`).set(auth(token)).send(signatureFor('Withdrawn Driver')).expect(200);
    await request(app).delete(`/api/loads/${load._id}`).set(auth(dispatcherToken)).expect(200);
    expect(
      await Notification.countDocuments({ userId: driver._id, title: 'Requested Load Withdrawn', 'metadata.loadId': String(load._id) }),
    ).toBe(1);
  });
});

// ─── One location pipeline: sources, late positions, who sees exact GPS ─────
// Traccar readings here are simulated (no Traccar server is involved).

describe('Location pipeline: sources, late positions and who sees exact GPS', () => {
  const PREFIX = 'loc-pipeline';
  let secondAdmin: any;
  let secondAdminToken: string;
  let employeeDispatcher: any;
  let employeeToken: string;

  beforeAll(async () => {
    secondAdmin = await User.create({
      email: `${PREFIX}-admin2${TEST_EMAIL_DOMAIN}`, name: 'Second Admin A', role: 'admin', organizationId: orgA._id,
      emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    // Has Dispatcher access here, but isn't responsible for the test loads.
    employeeDispatcher = await User.create({
      email: `${PREFIX}-employee${TEST_EMAIL_DOMAIN}`, name: 'Employee Dispatcher A', role: 'employee', organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id], emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    secondAdminToken = tokenService.generateAccessToken(secondAdmin);
    employeeToken = tokenService.generateAccessToken(employeeDispatcher);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) return;
    await LoadTripPoint.deleteMany({ organizationId: { $in: [orgA?._id, orgB?._id] } });
  });

  async function trackedDriver(label: string) {
    const driver = await createDriver(`${PREFIX}-${label}`);
    const load = await seedLoad();
    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set(auth(dispatcherToken))
      .send({ loadId: String(load._id), driverId: String(driver.user._id), overrideAvailability: true, overrideCapacity: true })
      .expect(200);
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/accept`)
      .set(auth(driver.token))
      .send(signatureFor(`Driver ${label}`))
      .expect(200);
    return { ...driver, load };
  }

  const browserFix = (token: string, measuredAt = new Date(Date.now() - 2_000)) =>
    request(app)
      .post('/api/driver-tracking/heartbeat')
      .set(auth(token))
      .send({ lat: 40.76, lng: -111.89, accuracy: 12, locationRecordedAt: measuredAt.toISOString() });

  const simulatedTraccarFix = (driverId: string, measuredAt: Date) =>
    ingestDriverLocation({
      driverId, source: 'traccar', sourceDeviceId: 'SIMULATED-TEST-DEVICE',
      lat: 40.7, lng: -111.9, measuredAt, receivedAt: new Date(), accuracy: 8, speed: 20, heading: 90,
    });

  const exactGpsFor = async (token: string, driverId: string) => {
    const res = await request(app).get('/api/driver-tracking/org-drivers').set(auth(token)).expect(200);
    const row = res.body.data.drivers.find((item: any) => item.id === driverId);
    return { canView: row?.presence?.canViewExactGps === true, coords: row?.presence?.coords ?? null };
  };

  const liveRecipients = (spy: jest.SpyInstance) =>
    spy.mock.calls.filter(([, event]) => event === 'driver:location').map(([userId]) => String(userId));

  it('the organization\'s admins see exact GPS as well as the responsible dispatcher; other staff do not', async () => {
    const { user, token } = await trackedDriver('admins');
    const driverId = String(user._id);
    await browserFix(token).expect(200);

    expect((await exactGpsFor(dispatcherToken, driverId)).canView).toBe(true);
    const admin = await exactGpsFor(secondAdminToken, driverId);
    expect(admin.canView).toBe(true);
    expect(admin.coords).toEqual({ lat: 40.76, lng: -111.89 });
    expect(await exactGpsFor(employeeToken, driverId)).toEqual({ canView: false, coords: null });

    const emit = jest.spyOn(socketEmitter, 'emitToUser');
    try {
      await browserFix(token, new Date(Date.now() - 1_000)).expect(200);
      const recipients = liveRecipients(emit);
      expect(recipients).toEqual(expect.arrayContaining([String(dispatcher._id), String(secondAdmin._id)]));
      expect(recipients).not.toContain(String(employeeDispatcher._id));
      expect(recipients).not.toContain(String(dispatcherB._id));
    } finally {
      emit.mockRestore();
    }
  });

  it('a fresh Traccar position stays primary, and the browser takes over once Traccar goes quiet', async () => {
    const { user, token } = await trackedDriver('source-priority');
    const driverId = String(user._id);
    expect((await simulatedTraccarFix(driverId, new Date(Date.now() - 5_000))).accepted).toBe(true);

    const blocked = await browserFix(token).expect(200);
    expect(blocked.body.data.locationAccepted).toBe(false);
    expect(await DriverLocation.findOne({ userId: user._id }).lean()).toMatchObject({
      source: 'traccar', sourceDeviceId: 'SIMULATED-TEST-DEVICE', speed: 20, heading: 90, accuracy: 8,
    });

    // Traccar has been quiet for 90 seconds: the browser reading takes over.
    await DriverLocation.updateOne({ userId: user._id }, { $set: { locationRecordedAt: new Date(Date.now() - 90_000) } });
    const takenOver = await browserFix(token).expect(200);
    expect(takenOver.body.data.locationAccepted).toBe(true);
    expect((await DriverLocation.findOne({ userId: user._id }).lean() as any).source).toBe('browser');

    // A newer Traccar reading is accepted again straight away.
    expect((await simulatedTraccarFix(driverId, new Date(Date.now() - 500))).accepted).toBe(true);
  });

  it('a delayed Traccar position becomes Last known only when newer; old, future and untracked readings are refused', async () => {
    const { user, token } = await trackedDriver('late-positions');
    const driverId = String(user._id);
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000);
    expect((await simulatedTraccarFix(driverId, twentyMinutesAgo)).accepted).toBe(true);
    // Stored with its real measurement time, so it shows as Last known, not live.
    expect((await DriverLocation.findOne({ userId: user._id }).lean() as any).locationRecordedAt.getTime())
      .toBe(twentyMinutesAgo.getTime());

    expect(await simulatedTraccarFix(driverId, new Date(Date.now() - 30 * 60_000))).toEqual({ accepted: false, reason: 'older_than_stored' });
    expect(await simulatedTraccarFix(driverId, new Date(Date.now() + 5 * 60_000))).toEqual({ accepted: false, reason: 'future_reading' });
    expect(await simulatedTraccarFix(driverId, new Date(Date.now() - 2 * 24 * 60 * 60_000))).toEqual({ accepted: false, reason: 'too_old' });
    // Browser readings must still be current.
    await browserFix(token, new Date(Date.now() - 5 * 60_000)).expect(400);

    const { user: noLoad } = await createDriver(`${PREFIX}-no-load`);
    expect(await simulatedTraccarFix(String(noLoad._id), new Date())).toEqual({ accepted: false, reason: 'no_tracking_relationship' });
    expect(await DriverLocation.findOne({ userId: noLoad._id })).toBeNull();
  });

  it('when the load ends, the dispatcher and the admins lose exact GPS and stop receiving it', async () => {
    const { user, token, load } = await trackedDriver('access-ends');
    const driverId = String(user._id);
    await browserFix(token).expect(200);
    expect((await exactGpsFor(secondAdminToken, driverId)).canView).toBe(true);

    await Load.updateOne({ _id: load._id }, { $set: { status: 'Cancelled' } });

    expect(await exactGpsFor(secondAdminToken, driverId)).toEqual({ canView: false, coords: null });
    expect(await exactGpsFor(dispatcherToken, driverId)).toEqual({ canView: false, coords: null });
    const emit = jest.spyOn(socketEmitter, 'emitToUser');
    try {
      const late = await browserFix(token).expect(200);
      expect(late.body.data.locationAccepted).toBe(false);
      expect(liveRecipients(emit)).toHaveLength(0);
    } finally {
      emit.mockRestore();
    }
    expect(await DriverLocation.findOne({ userId: user._id })).toBeNull();
  });

  const tripHistory = (loadId: unknown, token: string) =>
    request(app).get(`/api/driver-tracking/loads/${loadId}/trip-history`).set(auth(token));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('trip history records each tracked position once, from acceptance on, and only its viewers can read it', async () => {
    const { user, token, load } = await trackedDriver('trip-history');
    const driverId = String(user._id);
    const first = new Date();
    await browserFix(token, first).expect(200);
    await browserFix(token, first).expect(200); // the same reading sent again is stored once
    await pause(15);
    await browserFix(token, new Date()).expect(200);
    // A reading from before the driver accepted isn't part of this trip.
    const accepted: any = await reload(load._id);
    await simulatedTraccarFix(driverId, new Date(accepted.acceptedAt.getTime() - 60_000));

    const history = await tripHistory(load._id, dispatcherToken).expect(200);
    expect(history.body.data).toMatchObject({ retentionDays: 30, totalPoints: 2, thinned: false });
    const points = history.body.data.points;
    expect(points.map((point: any) => point.source)).toEqual(['browser', 'browser']);
    expect(new Date(points[0].measuredAt).getTime()).toBe(first.getTime());
    expect(new Date(points[1].measuredAt).getTime()).toBeGreaterThan(first.getTime());
    expect(points[0]).toMatchObject({ driverId, lat: 40.76, lng: -111.89, accuracyMeters: 12, loadStatus: 'Accepted' });
    expect(history.body.data.drivers).toEqual([{ id: driverId, name: user.name }]);

    await tripHistory(load._id, secondAdminToken).expect(200);
    const refused = await tripHistory(load._id, employeeToken).expect(403);
    expect(refused.body.message).toMatch(/responsible dispatcher and organization admins/);
    await tripHistory(load._id, dispatcherBToken).expect(404);
  });

  it('a late Traccar position fills in the trip history without moving the live position back, and the history outlives the load', async () => {
    const { user, load } = await trackedDriver('trip-backfill');
    const driverId = String(user._id);
    const accepted: any = await reload(load._id);
    const whileOffline = new Date(accepted.acceptedAt.getTime() + 1);
    await pause(15);
    const latest = new Date();
    expect((await simulatedTraccarFix(driverId, latest)).accepted).toBe(true);
    expect(await simulatedTraccarFix(driverId, whileOffline)).toEqual({ accepted: false, reason: 'older_than_stored' });
    expect((await DriverLocation.findOne({ userId: user._id }).lean() as any).locationRecordedAt.getTime()).toBe(latest.getTime());

    const history = await tripHistory(load._id, secondAdminToken).expect(200);
    expect(history.body.data.totalPoints).toBe(2);
    expect(history.body.data.points.map((point: any) => new Date(point.measuredAt).getTime())).toEqual([
      whileOffline.getTime(),
      latest.getTime(),
    ]);
    expect(history.body.data.points[1]).toMatchObject({ source: 'traccar', speedMetersPerSecond: 20, heading: 90 });

    // Kept after the load ends (deleted automatically after 30 days).
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Delivered' } });
    expect((await tripHistory(load._id, secondAdminToken).expect(200)).body.data.totalPoints).toBe(2);
  });

  it('trip history points are set to delete themselves 30 days after they were measured', () => {
    const ttl = (LoadTripPoint.schema.indexes() as any[]).find(([fields]) => fields.measuredAt === 1 && Object.keys(fields).length === 1);
    expect(ttl?.[1]?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });
});

describe('Dispatch marks a load as delivered (override)', () => {
  const markDelivered = (loadId: unknown, token: string) =>
    request(app).post(`/api/driver-tracking/loads/${loadId}/mark-delivered`).set(auth(token));

  async function staffMember(label: string) {
    const user = await User.create({
      email: `override-${label}${TEST_EMAIL_DOMAIN}`,
      name: `Override ${label}`,
      role: 'employee',
      organizationId: orgA._id,
      dispatcherOrganizationIds: [orgA._id],
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
    return { user, token: tokenService.generateAccessToken(user as any) };
  }

  it('the responsible dispatcher marks an Accepted load delivered with a reason, and the driver is not notified', async () => {
    const { user: driver } = await createDriver('override-accepted');
    const owner = await staffMember('owner');
    const other = await staffMember('other');
    const load = await seedLoad({
      status: 'Accepted',
      assignedDriverId: driver._id,
      dispatchOwnerId: owner.user._id,
      assignedAt: new Date(),
      acceptedAt: new Date(),
    });

    await markDelivered(load._id, owner.token).send({}).expect(400);
    const refused = await markDelivered(load._id, other.token).send({ reason: 'Driver called in' }).expect(403);
    expect(refused.body.message).toMatch(/responsible dispatcher and organization admins/);

    const reason = 'Driver lost their phone; customer confirmed delivery by phone.';
    await markDelivered(load._id, owner.token).send({ reason }).expect(200);

    const stored: any = await Load.findById(load._id).lean();
    expect(stored.status).toBe('Delivered');
    expect(stored.deliveredAt).toBeTruthy();
    expect(stored.deliveryOverride).toMatchObject({ reason, previousStatus: 'Accepted', proofAdded: false, byName: 'Override owner' });
    expect(String(stored.deliveryOverride.by)).toBe(String(owner.user._id));
    expect(stored.proofOfDelivery?.imageUrl).toBeUndefined();
    expect(await Notification.countDocuments({ userId: driver._id })).toBe(0);

    // Repeating it is safe.
    await markDelivered(load._id, owner.token).send({ reason }).expect(200);
  });

  it('an org admin can attach a delivery photo; a load without a driver cannot be marked', async () => {
    const { user: driver } = await createDriver('override-photo');
    const load = await seedLoad({ status: 'In-Transit', assignedDriverId: driver._id, assignedAt: new Date(), acceptedAt: new Date() });

    await markDelivered(load._id, dispatcherToken)
      .field('reason', 'Driver app crashed at the dealership.')
      .attach('proof', PNG, 'delivery.png')
      .expect(200);
    const stored: any = await Load.findById(load._id).lean();
    expect(stored.status).toBe('Delivered');
    expect(stored.proofOfDelivery.imageUrl).toMatch(/^test\/proof-/);
    expect(String(stored.proofOfDelivery.submittedBy)).toBe(String(dispatcher._id));
    expect(stored.deliveryOverride).toMatchObject({ previousStatus: 'In-Transit', proofAdded: true });

    const posted = await seedLoad();
    const refused = await markDelivered(posted._id, dispatcherToken).send({ reason: 'No driver yet' }).expect(400);
    expect(refused.body.message).toMatch(/Only a load with a driver/);
  });
});
