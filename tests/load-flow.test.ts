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
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';

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

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }

  jest.spyOn(storageService, 'upload').mockImplementation(async () => `test/proof-${++uploadCounter}.png`);
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
      .send({ status: 'Delivered' })
      .expect(409);
    expect((await reload(load._id))!.status).toBe('Posted');

    await request(app)
      .put(`/api/loads/${load._id}`)
      .set(auth(dispatcherToken))
      .send({ status: 'Posted', additionalInfo: { visibility: 'public', notes: 'Gate 4' } })
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

  it('DELETE /api/loads/:id allows closed loads and cannot reach another organization', async () => {
    const delivered = await seedLoad({ status: 'Delivered' });
    await request(app).delete(`/api/loads/${delivered._id}`).set(auth(dispatcherToken)).expect(200);

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

  it('a driver cannot request the same load twice', async () => {
    await request(app)
      .post(`/api/driver-tracking/loads/${load._id}/request`)
      .set(auth(first.token))
      .send(signatureFor('First Signer'))
      .expect(409);
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

  const editNotes = (loadId: unknown, token: string, notes: string) =>
    request(app)
      .put(`/api/loads/${loadId}`)
      .set(auth(token))
      .send({ additionalInfo: { visibility: 'public', notes } })
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
      .send({ additionalInfo: { visibility: 'public', notes: 'Use the north gate' } })
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
      .send({ additionalInfo: { visibility: 'public', notes: 'Call before arrival' } })
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
      .send({ additionalInfo: { visibility: 'public', notes: 'Employee change' } })
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
      .send({ additionalInfo: { visibility: 'public', notes: 'Too late' } })
      .expect(400);
    expect(res.body.message).toMatch(/because it is already Delivered/);
  });
});
