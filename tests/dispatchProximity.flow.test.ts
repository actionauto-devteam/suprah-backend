/**
 * Dispatch's "miles from pickup" before a load is assigned, through the real
 * endpoints: measured from a location the driver chose to share (under 5
 * minutes old), else their delivery in the last 12 hours, else home base.
 * A driver on a trip always shows home base, distances from the new origins
 * are rounded to 5 miles, and no position is ever sent.
 *
 * Data safety (same as load-flow): every record is created under this suite's
 * own organization and users and removed afterwards.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Load from '../src/models/Load.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverLocation from '../src/models/DriverLocation.model';
import tokenService from '../src/services/token.service';
import { LAST_DELIVERY_WINDOW_MS } from '../src/services/driverDispatchProximity.service';

const TEST_ORG_SLUG = 'dispatch-proximity-test-org';
const TEST_EMAIL_DOMAIN = '@dispatch-proximity-test.com';
const HOUR = 60 * 60 * 1000;

// Home base Denver for everyone; deliveries in Phoenix; a shared location in Tucson.
const DENVER: [number, number] = [-104.9903, 39.7392]; // [lon, lat], as profiles store it
const PHOENIX_DELIVERY = { lat: 33.4484, lng: -112.074 };
const TUCSON = { lat: 32.2226, lng: -110.9747 };
const PHOENIX_PICKUP = { lat: 33.4152, lng: -111.8315 }; // Mesa, about 14 miles from the delivery

let org: any;
let dispatcher: any;
let dispatcherToken: string;
const drivers: Record<string, any> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function loadFields(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: org._id,
    createdBy: dispatcher._id,
    postType: 'assign-carrier',
    status: 'Posted',
    pickupLocation: { address: '1 Pickup St', city: 'Mesa', state: 'AZ', zip: '85201', coordinates: PHOENIX_PICKUP },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Phoenix', state: 'AZ', zip: '85004', coordinates: PHOENIX_DELIVERY },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'private' },
    pricing: { miles: 20, carrierPayAmount: 200, isPricingEnabled: true, isVisibleToDriver: true },
    contract: { agreedToTerms: true, signatureDataUrl: PNG_DATA_URL, signerName: 'Dispatcher' },
    ...overrides,
  };
}

async function makeDriver(label: string) {
  const user = await User.create({
    email: `${label}${TEST_EMAIL_DOMAIN}`,
    name: `Driver ${label}`,
    role: 'driver',
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  await DriverProfile.create({
    userId: user._id,
    operationalStatus: 'active',
    verificationStatus: 'verified',
    trailerType: 'open_2car',
    maxVehicleCapacity: 2,
    homeBase: { city: 'Denver', state: 'CO', coordinates: DENVER },
  });
  return user;
}

async function cleanUp() {
  const orgs = await Organization.find({ slug: TEST_ORG_SLUG }).select('_id');
  await Load.deleteMany({ organizationId: { $in: orgs.map((o) => o._id) } });
  const users = await User.find({ email: { $regex: /@dispatch-proximity-test\.com$/ } }).select('_id');
  const ids = users.map((u) => u._id);
  await DriverLocation.deleteMany({ userId: { $in: ids } });
  await DriverProfile.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await Organization.deleteMany({ _id: { $in: orgs.map((o) => o._id) } });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  org = await Organization.create({ name: 'Dispatch Proximity Test Org', slug: TEST_ORG_SLUG, status: 'active' });
  dispatcher = await User.create({
    email: `dispatcher${TEST_EMAIL_DOMAIN}`,
    name: 'Dispatcher',
    role: 'admin',
    organizationId: org._id,
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
  });
  dispatcherToken = tokenService.generateAccessToken(dispatcher);

  for (const label of ['recent', 'old', 'ontrip', 'shared', 'private', 'stale', 'onleave']) {
    drivers[label] = await makeDriver(label);
  }
  await DriverProfile.updateOne({ userId: drivers.onleave._id }, { $set: { operationalStatus: 'on_leave' } });
  const now = Date.now();
  // On Leave, with a shared location and a delivery an hour ago: neither is used.
  await Load.create(loadFields({ status: 'Delivered', assignedDriverId: drivers.onleave._id, deliveredAt: new Date(now - HOUR) }));
  await DriverLocation.create({ userId: drivers.onleave._id, coords: TUCSON, isSharing: true, manualSharingOptIn: true, lastSeenAt: new Date(now - 60_000), locationRecordedAt: new Date(now - 60_000) });
  // Delivered 2 hours ago in Phoenix.
  await Load.create(loadFields({ status: 'Delivered', assignedDriverId: drivers.recent._id, deliveredAt: new Date(now - 2 * HOUR) }));
  // Delivered just outside the 12-hour window.
  await Load.create(loadFields({ status: 'Delivered', assignedDriverId: drivers.old._id, deliveredAt: new Date(now - LAST_DELIVERY_WINDOW_MS - HOUR) }));
  // Delivered 1 hour ago, but has since accepted another load: on a trip.
  await Load.create(loadFields({ status: 'Delivered', assignedDriverId: drivers.ontrip._id, deliveredAt: new Date(now - HOUR) }));
  await Load.create(loadFields({ status: 'Accepted', assignedDriverId: drivers.ontrip._id, acceptedAt: new Date(now - 10 * 60 * 1000) }));
  // Shared location (Keep Sharing / Share Location) from 1 minute ago, in Tucson.
  await DriverLocation.create({ userId: drivers.shared._id, coords: TUCSON, isSharing: true, manualSharingOptIn: true, lastSeenAt: new Date(now - 60_000), locationRecordedAt: new Date(now - 60_000) });
  // A fresh location the driver did NOT choose to share with Dispatch.
  await DriverLocation.create({ userId: drivers.private._id, coords: TUCSON, isSharing: true, manualSharingOptIn: false, lastSeenAt: new Date(now - 60_000), locationRecordedAt: new Date(now - 60_000) });
  // A shared location that is 20 minutes old.
  await DriverLocation.create({ userId: drivers.stale._id, coords: TUCSON, isSharing: true, manualSharingOptIn: true, lastSeenAt: new Date(now - 20 * 60_000), locationRecordedAt: new Date(now - 20 * 60_000) });
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

async function preview() {
  const res = await request(app)
    .post('/api/driver-tracking/compatibility-preview')
    .set(auth(dispatcherToken))
    .send({
      driverIds: Object.values(drivers).map((d) => String(d._id)),
      load: {
        pickupLocation: { city: 'Mesa', state: 'AZ', zip: '85201', coordinates: PHOENIX_PICKUP },
        deliveryLocation: { city: 'Tucson', state: 'AZ', zip: '85701' },
        trailerType: 'open_2car',
        vehicles: [{}],
      },
    })
    .expect(200);
  return res;
}

describe("Dispatch's distance to pickup before assigning", () => {
  it('uses the last delivery from the past 12 hours, rounded to 5 miles', async () => {
    const res = await preview();
    const proximity = res.body.data.compatibilityByDriverId[String(drivers.recent._id)].proximity;
    expect(proximity.source).toBe('last_delivery');
    expect(proximity.approximate).toBe(true);
    expect(proximity.distanceToPickupMiles % 5).toBe(0);
    expect(proximity.distanceToPickupMiles).toBeGreaterThanOrEqual(10);
    expect(proximity.distanceToPickupMiles).toBeLessThanOrEqual(20);
    // The time shown is when the delivery was made.
    expect(Math.abs(new Date(proximity.lastSeenAt).getTime() - (Date.now() - 2 * HOUR))).toBeLessThan(60_000);
  });

  it('falls back to home base after 12 hours', async () => {
    const res = await preview();
    const proximity = res.body.data.compatibilityByDriverId[String(drivers.old._id)].proximity;
    expect(proximity.source).toBe('home_base');
    expect(proximity.approximate).toBeUndefined();
    expect(proximity.distanceToPickupMiles).toBeGreaterThan(500);
  });

  it('shows home base for a driver on a trip, even right after a delivery', async () => {
    const res = await preview();
    expect(res.body.data.compatibilityByDriverId[String(drivers.ontrip._id)].proximity.source).toBe('home_base');
  });

  it('uses a location the driver chose to share, only while it is under 5 minutes old', async () => {
    const res = await preview();
    const shared = res.body.data.compatibilityByDriverId[String(drivers.shared._id)].proximity;
    expect(shared.source).toBe('shared_location');
    expect(shared.approximate).toBe(true);
    expect(shared.distanceToPickupMiles % 5).toBe(0);
    expect(shared.distanceToPickupMiles).toBeGreaterThan(80);
    expect(shared.distanceToPickupMiles).toBeLessThan(120);
    expect(res.body.data.compatibilityByDriverId[String(drivers.stale._id)].proximity.source).toBe('home_base');
  });

  it('shows home base for a driver who is On Leave', async () => {
    const res = await preview();
    expect(res.body.data.compatibilityByDriverId[String(drivers.onleave._id)].proximity.source).toBe('home_base');
  });

  it('never uses a location the driver did not choose to share', async () => {
    const res = await preview();
    expect(res.body.data.compatibilityByDriverId[String(drivers.private._id)].proximity.source).toBe('home_base');
  });

  it('never sends a delivery address position or a shared position', async () => {
    const res = await preview();
    const body = JSON.stringify(res.body);
    for (const value of [PHOENIX_DELIVERY.lat, PHOENIX_DELIVERY.lng, TUCSON.lat, TUCSON.lng]) {
      expect(body).not.toContain(String(value));
    }
  });

  it("Dispatch's driver requests list uses the same rule", async () => {
    await Load.create(loadFields({
      postType: 'load-board',
      additionalInfo: { visibility: 'public' },
      driverRequests: [{ driverId: drivers.recent._id, requestedAt: new Date() }],
    }));
    const res = await request(app).get('/api/driver-tracking/load-requests').set(auth(dispatcherToken)).expect(200);
    const row = res.body.data.find((r: any) => r.driverId === String(drivers.recent._id));
    expect(row.compatibility.proximity.source).toBe('last_delivery');
    expect(row.compatibility.proximity.approximate).toBe(true);
  });
});
