/**
 * Load Flow — Integration Test Suite
 *
 * Tests the complete unified Load lifecycle:
 *   Draft → Posted → Assigned → Accepted → Picked Up → In-Transit → Delivered
 *
 * Data safety rules:
 *   1. beforeAll: deletes ALL Load + Shipment documents (they're being migrated away)
 *   2. Every test entity uses TEST_ORG_ID / TEST_ORG_ID_B for scope isolation
 *   3. afterAll: deletes ONLY the records created by this test suite (by ID)
 *   4. No other collections are touched
 */

import request from 'supertest';
import app from '../src/server';
import mongoose from 'mongoose';
import Load from '../src/models/Load.model';
import Shipment from '../src/models/Shipment.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverLocation from '../src/models/DriverLocation.model';
import DriverPayout from '../src/models/DriverPayout.model';
import tokenService from '../src/services/token.service';

// ─── Test Identifiers ─────────────────────────────────────────────────────────
// All test entities are tagged with this org ID so we can cleanly target them
const TEST_ORG_SLUG_A = 'load-flow-test-org-a';
const TEST_ORG_SLUG_B = 'load-flow-test-org-b';

// ─── Shared State ─────────────────────────────────────────────────────────────
let orgA: any;
let orgB: any;
let dispatcher: any;
let driver: any;
let driverB: any; // second driver for assignment conflict tests
let dispatcherToken: string;
let driverToken: string;
let driverBToken: string;

// IDs of records created during the test run — only these are cleaned up
const createdLoadIds: mongoose.Types.ObjectId[] = [];
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdOrgIds: mongoose.Types.ObjectId[] = [];
const createdPayoutIds: mongoose.Types.ObjectId[] = [];
const createdDriverProfileIds: mongoose.Types.ObjectId[] = [];
const createdDriverLocationIds: mongoose.Types.ObjectId[] = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }

  // ── Step 1: Wipe ALL Load + Shipment data ──────────────────────────────────
  // These are the two collections being unified. A clean slate ensures tests
  // are not polluted by any existing production or seed data.
  // Safety: check the URI string directly — mongoose.connection.name is unreliable
  // after the global setup's clearMongooseRegistry() has run.
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test';
  const isSafeDb = MONGODB_URI.includes('localhost') || MONGODB_URI.toLowerCase().includes('test');
  if (!isSafeDb && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
    throw new Error(`SAFETY BLOCK: Refusing to wipe Load/Shipment data. URI does not appear to be a local or test database. Set ALLOW_REMOTE_TEST_DB=true to proceed.`);
  }

  const loadDeleteResult = await Load.deleteMany({ _id: { $exists: true } });
  const shipDeleteResult = await Shipment.deleteMany({ _id: { $exists: true } });
  console.log(`[SETUP] Cleared ${loadDeleteResult.deletedCount} Load(s) and ${shipDeleteResult.deletedCount} Shipment(s) before test run.`);

  // ── Step 2: Clean up any leaked data from previous failed test runs ────────
  await Organization.deleteMany({ slug: { $in: [TEST_ORG_SLUG_A, TEST_ORG_SLUG_B] } });
  await User.deleteMany({ email: { $regex: /@load-flow-test\.com$/ } });

  // ── Step 3: Create test organizations ─────────────────────────────────────
  orgA = await Organization.create({ name: 'Load Flow Test Org A', slug: TEST_ORG_SLUG_A, status: 'active' });
  orgB = await Organization.create({ name: 'Load Flow Test Org B', slug: TEST_ORG_SLUG_B, status: 'active' });
  createdOrgIds.push(orgA._id, orgB._id);

  // ── Step 4: Create test users ─────────────────────────────────────────────
  dispatcher = await User.create({
    email: 'dispatcher@load-flow-test.com',
    name: 'Test Dispatcher',
    role: 'admin',
    organizationId: orgA._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  createdUserIds.push(dispatcher._id);

  driver = await User.create({
    email: 'driver@load-flow-test.com',
    name: 'Test Driver',
    role: 'driver',
    organizationId: orgA._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
    stripeConnectAccountId: 'acct_test_stripe_driver',
  });
  createdUserIds.push(driver._id);

  driverB = await User.create({
    email: 'driverb@load-flow-test.com',
    name: 'Test Driver B',
    role: 'driver',
    organizationId: orgA._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  createdUserIds.push(driverB._id);

  // ── Step 5: Create driver profiles ────────────────────────────────────────
  const profileA = await DriverProfile.create({
    userId: driver._id,
    organizationId: orgA._id.toString(),
    trailerType: 'open_3car_wedge',
    maxVehicleCapacity: 10,
    operationalStatus: 'active',
    isComplianceExpired: false,
  });
  createdDriverProfileIds.push(profileA._id);

  const profileB = await DriverProfile.create({
    userId: driverB._id,
    organizationId: orgA._id.toString(),
    trailerType: 'open_3car_wedge',
    maxVehicleCapacity: 10,
    operationalStatus: 'active',
    isComplianceExpired: false,
  });
  createdDriverProfileIds.push(profileB._id);

  // ── Step 6: Create driver location records ────────────────────────────────
  const locA = await DriverLocation.create({
    userId: driver._id,
    organizationId: orgA._id.toString(),
    coords: { lat: 40.76, lng: -111.89 },
    status: 'idle',
    lastSeenAt: new Date(),
  });
  createdDriverLocationIds.push(locA._id);

  const locB = await DriverLocation.create({
    userId: driverB._id,
    organizationId: orgA._id.toString(),
    coords: { lat: 40.80, lng: -111.90 },
    status: 'idle',
    lastSeenAt: new Date(),
  });
  createdDriverLocationIds.push(locB._id);

  // ── Step 7: Generate JWT tokens ────────────────────────────────────────────
  dispatcherToken = tokenService.generateAccessToken(dispatcher);
  driverToken = tokenService.generateAccessToken(driver);
  driverBToken = tokenService.generateAccessToken(driverB);
}, 60000);

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Ensure connection is still alive before cleanup — the global setup.ts afterAll
  // may have already closed it if test suites race. Reconnect if needed.
  if (mongoose.connection.readyState === 0) {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test';
    await mongoose.connect(MONGODB_URI);
  }

  // Delete ONLY the records this test suite created — by tracked ID
  try {
    if (createdLoadIds.length) await Load.deleteMany({ _id: { $in: createdLoadIds } });
    if (createdPayoutIds.length) await DriverPayout.deleteMany({ _id: { $in: createdPayoutIds } });
    if (createdDriverLocationIds.length) await DriverLocation.deleteMany({ _id: { $in: createdDriverLocationIds } });
    if (createdDriverProfileIds.length) await DriverProfile.deleteMany({ _id: { $in: createdDriverProfileIds } });
    if (createdUserIds.length) await User.deleteMany({ _id: { $in: createdUserIds } });
    if (createdOrgIds.length) await Organization.deleteMany({ _id: { $in: createdOrgIds } });
    console.log(`[TEARDOWN] Cleaned up ${createdLoadIds.length} load(s), ${createdPayoutIds.length} payout(s), ${createdUserIds.length} user(s), ${createdOrgIds.length} org(s).`);
  } catch (err) {
    console.error('[TEARDOWN] Cleanup error (non-fatal):', err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 1 — Load CRUD
// ═════════════════════════════════════════════════════════════════════════════

describe('Load CRUD', () => {

  it('POST /api/loads — dispatcher creates a load (status: Posted)', async () => {
    const res = await request(app)
      .post('/api/loads')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({
        postType: 'assign-carrier',
        pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
        deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
        vehicles: [{ trailerType: 'open', condition: 'Operable' }],
        pricing: { carrierPayAmount: 500 },
      })
      .expect(201);

    expect(res.body.data.status).toBe('Posted');
    expect(res.body.data.loadNumber).toMatch(/^LD-/);
    expect(res.body.data.organizationId).toBe(orgA._id.toString());

    createdLoadIds.push(new mongoose.Types.ObjectId(res.body.data._id));
  });

  it('GET /api/loads — returns only loads for this org', async () => {
    // Create a load in orgB to confirm isolation
    const orgBLoad = await Load.create({
      organizationId: orgB._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      pickupLocation: { city: 'Phoenix', state: 'AZ', zip: '85001', country: 'US' },
      deliveryLocation: { city: 'Denver', state: 'CO', zip: '80201', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(orgBLoad._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .get('/api/loads')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    const orgIds = res.body.data.loads.map((l: any) => l.organizationId);
    const hasOtherOrg = orgIds.some((id: string) => id === orgB._id.toString());

    expect(hasOtherOrg).toBe(false);
    expect(orgIds.every((id: string) => id === orgA._id.toString())).toBe(true);
  });

  it('GET /api/loads?status=Posted — status filter works', async () => {
    const res = await request(app)
      .get('/api/loads?status=Posted')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data.loads.every((l: any) => l.status === 'Posted')).toBe(true);
  });

  it('GET /api/loads?status=Accepted — filter works for new statuses (B5 fix)', async () => {
    // Create a load in Accepted state directly
    const acceptedLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Accepted',
      loadNumber: `LD-TEST-ACCEPTED-${Date.now()}`,
      pickupLocation: { city: 'Provo', state: 'UT', zip: '84601', country: 'US' },
      deliveryLocation: { city: 'Reno', state: 'NV', zip: '89501', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(acceptedLoad._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .get('/api/loads?status=Accepted')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data.loads.length).toBeGreaterThan(0);
    expect(res.body.data.loads.every((l: any) => l.status === 'Accepted')).toBe(true);
  });

  it('GET /api/loads?status=Picked Up — filter works for Picked Up (B5 fix)', async () => {
    const pickedUpLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Picked Up',
      loadNumber: `LD-TEST-PICKEDUP-${Date.now()}`,
      pickupLocation: { city: 'Ogden', state: 'UT', zip: '84401', country: 'US' },
      deliveryLocation: { city: 'Boise', state: 'ID', zip: '83701', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(pickedUpLoad._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .get('/api/loads?status=Picked Up')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data.loads.length).toBeGreaterThan(0);
    expect(res.body.data.loads.every((l: any) => l.status === 'Picked Up')).toBe(true);
  });

  it('GET /api/loads/:id — returns single load', async () => {
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      loadNumber: `LD-TEST-GET-${Date.now()}`,
      pickupLocation: { city: 'Moab', state: 'UT', zip: '84532', country: 'US' },
      deliveryLocation: { city: 'Flagstaff', state: 'AZ', zip: '86001', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(load._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .get(`/api/loads/${load._id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data._id).toBe(load._id.toString());
  });

  it('DELETE /api/loads/:id — dispatcher can delete a Posted load', async () => {
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      loadNumber: `LD-TEST-DEL-${Date.now()}`,
      pickupLocation: { city: 'Cedar City', state: 'UT', zip: '84720', country: 'US' },
      deliveryLocation: { city: 'Albuquerque', state: 'NM', zip: '87101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    // Don't push to createdLoadIds — it gets deleted in this test

    await request(app)
      .delete(`/api/loads/${load._id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    const found = await Load.findById(load._id);
    expect(found).toBeNull();
  });

  it('DELETE /api/loads/:id — cannot delete an In-Transit load', async () => {
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'In-Transit',
      loadNumber: `LD-TEST-NODELETE-${Date.now()}`,
      assignedDriverId: driver._id,
      pickupLocation: { city: 'St George', state: 'UT', zip: '84770', country: 'US' },
      deliveryLocation: { city: 'Tucson', state: 'AZ', zip: '85701', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(load._id as mongoose.Types.ObjectId);

    await request(app)
      .delete(`/api/loads/${load._id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(400);
  });

  it('GET /api/loads/stats — returns counts per status', async () => {
    const res = await request(app)
      .get('/api/loads/stats')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data).toHaveProperty('all');
    expect(res.body.data).toHaveProperty('Posted');
    expect(res.body.data).toHaveProperty('Assigned');
    expect(res.body.data).toHaveProperty('In-Transit');
    expect(res.body.data).toHaveProperty('Delivered');
  });

  it('Driver role cannot create a load', async () => {
    await request(app)
      .post('/api/loads')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        postType: 'load-board',
        pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
        deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
        vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      })
      .expect(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 2 — Assignment (assign-carrier path)
// ═════════════════════════════════════════════════════════════════════════════

describe('Load Assignment — assign-carrier path', () => {
  let testLoad: any;

  beforeEach(async () => {
    testLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Posted',
      loadNumber: `LD-ASSIGN-${Date.now()}`,
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 600 },
    });
    createdLoadIds.push(testLoad._id as mongoose.Types.ObjectId);
  });

  it('POST /api/driver-tracking/assign-load — assigns driver, status → Assigned', async () => {
    const res = await request(app)
      .post('/api/driver-tracking/assign-load')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ shipmentId: testLoad._id.toString(), driverId: driver._id.toString() })
      .expect(200);

    expect(res.body.data.status).toBe('Assigned');
    expect(res.body.data.assignedDriverId).toBe(driver._id.toString());
    expect(res.body.data.assignedAt).toBeDefined();
  });

  it('POST /api/driver-tracking/assign-load — blocks double-assignment on In-Transit load', async () => {
    // Advance directly to a state where re-assignment should be blocked
    await Load.findByIdAndUpdate(testLoad._id, {
      status: 'In-Transit',
      assignedDriverId: driver._id,
    });

    await request(app)
      .post('/api/driver-tracking/assign-load')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ shipmentId: testLoad._id.toString(), driverId: driverB._id.toString() })
      .expect(409);
  });

  it('POST /api/driver-tracking/remove-load — removes driver, status → Posted', async () => {
    // First assign
    await Load.findByIdAndUpdate(testLoad._id, {
      status: 'Assigned',
      assignedDriverId: driver._id,
      assignedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/driver-tracking/remove-load')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ shipmentId: testLoad._id.toString() })
      .expect(200);

    const updated = await Load.findById(testLoad._id);
    expect(updated!.status).toBe('Posted');
    expect(updated!.assignedDriverId).toBeUndefined();
  });

  it('POST /api/driver-tracking/reassign-load — reassigns to new driver', async () => {
    await Load.findByIdAndUpdate(testLoad._id, {
      status: 'Assigned',
      assignedDriverId: driver._id,
      assignedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/driver-tracking/reassign-load')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ shipmentId: testLoad._id.toString(), newDriverId: driverB._id.toString() })
      .expect(200);

    const updated = await Load.findById(testLoad._id);
    expect(updated!.assignedDriverId!.toString()).toBe(driverB._id.toString());
    expect(updated!.status).toBe('Assigned');
    // Timestamps from previous driver cleared
    expect(updated!.driverAcceptedAt).toBeUndefined();
    expect(updated!.acceptedAt).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 3 — Load Board path (request → approve → reject)
// ═════════════════════════════════════════════════════════════════════════════

describe('Load Board — request / approve / reject', () => {
  let boardLoad: any;

  beforeEach(async () => {
    boardLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      loadNumber: `LD-BOARD-${Date.now()}`,
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 400 },
    });
    createdLoadIds.push(boardLoad._id as mongoose.Types.ObjectId);
  });

  it('GET /api/driver-tracking/available-loads — driver sees Posted load', async () => {
    const res = await request(app)
      .get('/api/driver-tracking/available-loads')
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    const loadIds = res.body.data.map((l: any) => l._id);
    expect(loadIds).toContain(boardLoad._id.toString());
  });

  it('POST /api/driver-tracking/request-load — driver requests a load', async () => {
    await request(app)
      .post('/api/driver-tracking/request-load')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: boardLoad._id.toString() })
      .expect(200);

    const updated = await Load.findById(boardLoad._id);
    const req = updated!.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driver._id.toString()
    );
    expect(req).toBeDefined();
    expect(req!.status).toBe('pending');
  });

  it('POST /api/driver-tracking/request-load — driver cannot request the same load twice', async () => {
    await Load.findByIdAndUpdate(boardLoad._id, {
      $push: {
        pendingDriverRequests: {
          driverId: driver._id,
          driverName: driver.name,
          requestedAt: new Date(),
          status: 'pending',
        },
      },
    });

    await request(app)
      .post('/api/driver-tracking/request-load')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: boardLoad._id.toString() })
      .expect(400);
  });

  it('POST /api/driver-tracking/approve-request — approves driver, auto-rejects others', async () => {
    // Add two pending requests
    await Load.findByIdAndUpdate(boardLoad._id, {
      $push: {
        pendingDriverRequests: {
          $each: [
            { driverId: driver._id, driverName: driver.name, requestedAt: new Date(), status: 'pending' },
            { driverId: driverB._id, driverName: driverB.name, requestedAt: new Date(), status: 'pending' },
          ],
        },
      },
    });

    await request(app)
      .post('/api/driver-tracking/approve-request')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ loadId: boardLoad._id.toString(), driverId: driver._id.toString() })
      .expect(200);

    const updated = await Load.findById(boardLoad._id);
    expect(updated!.status).toBe('Assigned');
    expect(updated!.assignedDriverId!.toString()).toBe(driver._id.toString());

    const approvedReq = updated!.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driver._id.toString()
    );
    expect(approvedReq!.status).toBe('approved');

    const rejectedReq = updated!.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driverB._id.toString()
    );
    expect(rejectedReq!.status).toBe('rejected');
    expect(rejectedReq!.rejectionReason).toBe('Another driver was approved for this load');
  });

  it('POST /api/driver-tracking/reject-request — rejects a single driver request', async () => {
    await Load.findByIdAndUpdate(boardLoad._id, {
      $push: {
        pendingDriverRequests: {
          driverId: driver._id,
          driverName: driver.name,
          requestedAt: new Date(),
          status: 'pending',
        },
      },
    });

    await request(app)
      .post('/api/driver-tracking/reject-request')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ loadId: boardLoad._id.toString(), driverId: driver._id.toString(), reason: 'Equipment mismatch' })
      .expect(200);

    const updated = await Load.findById(boardLoad._id);
    const req = updated!.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driver._id.toString()
    );
    expect(req!.status).toBe('rejected');
    expect(req!.rejectionReason).toBe('Equipment mismatch');
    // Load stays Posted — no driver assigned
    expect(updated!.status).toBe('Posted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 4 — Driver Status Progression (the full 5-step flow)
// ═════════════════════════════════════════════════════════════════════════════

describe('Driver Status Progression — full 5-step flow', () => {
  let flowLoad: any;

  beforeEach(async () => {
    flowLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Assigned',
      loadNumber: `LD-FLOW-${Date.now()}`,
      assignedDriverId: driver._id,
      assignedAt: new Date(),
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 750 },
    });
    createdLoadIds.push(flowLoad._id as mongoose.Types.ObjectId);
  });

  it('Step 1 — POST /api/driver-tracking/accept-load → Assigned → Accepted', async () => {
    const res = await request(app)
      .post('/api/driver-tracking/accept-load')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(200);

    expect(res.body.data.status).toBe('Accepted');
    expect(res.body.data.acceptedAt).toBeDefined();
    expect(res.body.data.driverAcceptedAt).toBeDefined();
  });

  it('Step 1b — accept-load fails if not the assigned driver', async () => {
    await request(app)
      .post('/api/driver-tracking/accept-load')
      .set('Authorization', `Bearer ${driverBToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(403);
  });

  it('Step 2 — POST /api/driver-tracking/mark-picked-up → Accepted → Picked Up', async () => {
    await Load.findByIdAndUpdate(flowLoad._id, {
      status: 'Accepted',
      acceptedAt: new Date(),
      driverAcceptedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/driver-tracking/mark-picked-up')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(200);

    expect(res.body.data.status).toBe('Picked Up');
    expect(res.body.data.pickedUpAt).toBeDefined();
  });

  it('Step 2b — mark-picked-up fails if status is not Accepted', async () => {
    // Still in Assigned status — cannot skip Accepted
    await request(app)
      .post('/api/driver-tracking/mark-picked-up')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(400);
  });

  it('Step 3 — POST /api/driver-tracking/start-route → Picked Up → In-Transit', async () => {
    await Load.findByIdAndUpdate(flowLoad._id, {
      status: 'Picked Up',
      pickedUpAt: new Date(),
    });

    const res = await request(app)
      .post('/api/driver-tracking/start-route')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(200);

    expect(res.body.data.status).toBe('In-Transit');
  });

  it('Step 3b — start-route is idempotent if already In-Transit', async () => {
    await Load.findByIdAndUpdate(flowLoad._id, { status: 'In-Transit' });

    const res = await request(app)
      .post('/api/driver-tracking/start-route')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(200);

    expect(res.body.data.status).toBe('In-Transit');
  });

  it('Step 3c — start-route fails if not Picked Up (cannot skip steps)', async () => {
    // Load is still in Assigned status
    await request(app)
      .post('/api/driver-tracking/start-route')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: flowLoad._id.toString() })
      .expect(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 5 — Drop Load
// ═════════════════════════════════════════════════════════════════════════════

describe('Driver Drop Load', () => {
  it('Dropping a Load reverts status to Posted (not Assigned)', async () => {
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Accepted',
      loadNumber: `LD-DROP-${Date.now()}`,
      assignedDriverId: driver._id,
      assignedAt: new Date(),
      acceptedAt: new Date(),
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(load._id as mongoose.Types.ObjectId);

    await request(app)
      .post('/api/driver-tracking/drop-load')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: load._id.toString() })
      .expect(200);

    const updated = await Load.findById(load._id);
    expect(updated!.status).toBe('Posted');
    expect(updated!.droppedAt).toBeDefined();
    expect(updated!.acceptedAt).toBeUndefined();
    expect(updated!.pickedUpAt).toBeUndefined();
  });

  it('drop-load (B4 fix) — uses org-scoped query, not raw findById', async () => {
    // Create a load in orgB that the orgA driver should NOT be able to drop
    const orgBLoad = await Load.create({
      organizationId: orgB._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Accepted',
      loadNumber: `LD-DROP-SECURITY-${Date.now()}`,
      assignedDriverId: driver._id, // same driver ID — but different org
      assignedAt: new Date(),
      pickupLocation: { city: 'Phoenix', state: 'AZ', zip: '85001', country: 'US' },
      deliveryLocation: { city: 'Denver', state: 'CO', zip: '80201', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(orgBLoad._id as mongoose.Types.ObjectId);

    // Driver from orgA trying to drop a load from orgB — should fail
    const res = await request(app)
      .post('/api/driver-tracking/drop-load')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ loadId: orgBLoad._id.toString() })
      .expect(404);

    // Load should NOT have been dropped
    const stillExists = await Load.findById(orgBLoad._id);
    expect(stillExists!.status).toBe('Accepted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 6 — Confirm Delivery
// ═════════════════════════════════════════════════════════════════════════════

describe('Confirm Delivery', () => {
  it('POST /api/loads/:id/confirm-delivery — sets status=Delivered AND deliveredAt (B1 fix)', async () => {
    // Create a load with proof already submitted
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'In-Transit',
      loadNumber: `LD-CONFIRM-${Date.now()}`,
      assignedDriverId: driver._id,
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 850 },
      proofOfDelivery: {
        imageUrl: 'proof-of-delivery/test-load-proof.jpg',
        submittedAt: new Date(),
        submittedTo: dispatcher._id,
      },
    });
    createdLoadIds.push(load._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .post(`/api/loads/${load._id}/confirm-delivery`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('Delivered');

    // THE CRITICAL B1 FIX — deliveredAt must be set
    expect(res.body.data.deliveredAt).toBeDefined();
    expect(new Date(res.body.data.deliveredAt).getTime()).toBeGreaterThan(0);

    // proofOfDelivery.confirmedAt must also be set
    expect(res.body.data.proofOfDelivery.confirmedAt).toBeDefined();
    expect(res.body.data.proofOfDelivery.confirmedBy).toBe(dispatcher._id.toString());
  });

  it('confirm-delivery fails without a submitted proof image', async () => {
    const load = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'In-Transit',
      loadNumber: `LD-CONFIRM-NOPROOF-${Date.now()}`,
      assignedDriverId: driver._id,
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(load._id as mongoose.Types.ObjectId);

    await request(app)
      .post(`/api/loads/${load._id}/confirm-delivery`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 7 — Driver Dashboard Stats (B3 fix)
// ═════════════════════════════════════════════════════════════════════════════

describe('Driver Dashboard Stats — Load-aware (B3 fix)', () => {
  it('GET /api/driver-tracking/dashboard-stats — counts Loads (not just Shipments)', async () => {
    // Create two loads: one active, one delivered
    const activeLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'In-Transit',
      loadNumber: `LD-STATS-ACTIVE-${Date.now()}`,
      assignedDriverId: driver._id,
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 300 },
    });
    createdLoadIds.push(activeLoad._id as mongoose.Types.ObjectId);

    const deliveredLoad = await Load.create({
      organizationId: orgA._id.toString(),
      createdBy: dispatcher._id,
      postType: 'assign-carrier',
      status: 'Delivered',
      loadNumber: `LD-STATS-DELIVERED-${Date.now()}`,
      assignedDriverId: driver._id,
      deliveredAt: new Date(),
      pickupLocation: { city: 'Salt Lake City', state: 'UT', zip: '84101', country: 'US' },
      deliveryLocation: { city: 'Las Vegas', state: 'NV', zip: '89101', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
      pricing: { carrierPayAmount: 400 },
    });
    createdLoadIds.push(deliveredLoad._id as mongoose.Types.ObjectId);

    const res = await request(app)
      .get('/api/driver-tracking/dashboard-stats')
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    // After B3 fix: these must reflect Load collection — not 0
    expect(res.body.data.totalLoads).toBeGreaterThanOrEqual(2);
    expect(res.body.data.activeLoads).toBeGreaterThanOrEqual(1);
    expect(res.body.data.completedLoads).toBeGreaterThanOrEqual(1);
    // Earnings from Load.pricing.carrierPayAmount — must not be 0
    expect(res.body.data.totalEarnings).toBeGreaterThanOrEqual(400);
  });

  it('GET /api/driver-tracking/my-loads — returns Load documents with normalized fields', async () => {
    const res = await request(app)
      .get('/api/driver-tracking/my-loads')
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    const loads = res.body.data.loads;
    expect(loads.length).toBeGreaterThan(0);

    // Every load must have the normalized fields
    for (const l of loads) {
      expect(l.__docType).toBe('load');
      expect(l.origin).toBeDefined();
      expect(l.destination).toBeDefined();
      expect(l.trackingNumber).toBeDefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 8 — Org Isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('Org Isolation', () => {
  it('Dispatcher from Org A cannot see loads from Org B', async () => {
    const orgBLoad = await Load.create({
      organizationId: orgB._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      loadNumber: `LD-ISOLATION-${Date.now()}`,
      pickupLocation: { city: 'Miami', state: 'FL', zip: '33101', country: 'US' },
      deliveryLocation: { city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(orgBLoad._id as mongoose.Types.ObjectId);

    // GET by ID from orgA token — should 404
    await request(app)
      .get(`/api/loads/${orgBLoad._id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(404);
  });

  it('Dispatcher from Org A cannot delete a load owned by Org B', async () => {
    const orgBLoad = await Load.create({
      organizationId: orgB._id.toString(),
      createdBy: dispatcher._id,
      postType: 'load-board',
      status: 'Posted',
      loadNumber: `LD-ISO-DEL-${Date.now()}`,
      pickupLocation: { city: 'Seattle', state: 'WA', zip: '98101', country: 'US' },
      deliveryLocation: { city: 'Portland', state: 'OR', zip: '97201', country: 'US' },
      vehicles: [{ trailerType: 'open', condition: 'Operable' }],
    });
    createdLoadIds.push(orgBLoad._id as mongoose.Types.ObjectId);

    await request(app)
      .delete(`/api/loads/${orgBLoad._id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .expect(404);

    // Still exists
    const stillExists = await Load.findById(orgBLoad._id);
    expect(stillExists).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 9 — Available Loads (Load-only, no Shipments)
// ═════════════════════════════════════════════════════════════════════════════

describe('Available Loads — Load-only', () => {
  it('GET /api/driver-tracking/available-loads — returns only Posted Loads (no Shipments)', async () => {
    const res = await request(app)
      .get('/api/driver-tracking/available-loads')
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    const items = res.body.data;
    // After removing Shipment from the backend, every item must be a Load
    // (no __docType: "shipment" should appear)
    const shipmentItems = items.filter((i: any) => i.__docType === 'shipment');
    expect(shipmentItems.length).toBe(0);

    // All loads must be in Posted status
    const nonPosted = items.filter((i: any) => i.__docType === 'load' && i.status !== 'Posted');
    expect(nonPosted.length).toBe(0);
  });
});
});
