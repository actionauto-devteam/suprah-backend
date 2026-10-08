/**
 * Suprah Driver Tracker app: pairing with a one-time code, approval, device
 * keys, batched positions (including ones buffered while offline), unlinking,
 * and staying off unless switched on.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import Load from '../src/models/Load.model';
import DriverLocation from '../src/models/DriverLocation.model';
import LoadTripPoint from '../src/models/LoadTripPoint.model';
import DriverTrackingDevice from '../src/models/DriverTrackingDevice.model';
import tokenService from '../src/services/token.service';

const DOMAIN = '@tracking-app-test.com';
const ORG_SLUG = 'tracking-app-test-org';

let org: any;
let admin: any;
let adminToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const device = (id: string, key: string) => ({ Authorization: `Device ${id}:${key}` });
const pos = (lat: number, lng: number, agoMs: number, extra: Record<string, unknown> = {}) => ({
  lat,
  lng,
  measuredAt: new Date(Date.now() - agoMs).toISOString(),
  accuracy: 8,
  ...extra,
});

async function makeDriver(label: string) {
  const user = await User.create({
    email: `${label}${DOMAIN}`, name: `Driver ${label}`, role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  await DriverProfile.create({ userId: user._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  return { user, token: tokenService.generateAccessToken(user as any) };
}

async function acceptedLoadFor(driverId: unknown, acceptedAgoMs = 60 * 60_000) {
  return Load.create({
    organizationId: org._id, createdBy: admin._id, dispatchOwnerId: admin._id, assignedDriverId: driverId,
    postType: 'assign-carrier', status: 'Accepted', acceptedAt: new Date(Date.now() - acceptedAgoMs),
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
  });
}

/** Driver starts setup in the Driver Portal and the app pairs with the code. */
async function pairedApp(driver: { user: any; token: string }) {
  const started = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
  const code = started.body.data.pairingCode as string;
  const paired = await request(app)
    .post('/api/tracking-app/pair')
    .send({ code, deviceName: 'Pixel 8', platform: 'android', appVersion: '1.0.0' })
    .expect(201);
  return { code, deviceId: paired.body.data.deviceId as string, key: paired.body.data.deviceKey as string, paired };
}

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@tracking-app-test\.com$/ } }).select('_id')).map((u) => u._id);
  const orgs = (await Organization.find({ slug: ORG_SLUG }).select('_id')).map((o) => o._id);
  await Load.deleteMany({ organizationId: { $in: orgs } });
  await LoadTripPoint.deleteMany({ organizationId: { $in: orgs } });
  await DriverTrackingDevice.deleteMany({ driverId: { $in: ids } });
  await DriverLocation.deleteMany({ userId: { $in: ids } });
  await DriverProfile.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await Organization.deleteMany({ _id: { $in: orgs } });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  org = await Organization.create({ name: 'Tracking App Test Org', slug: ORG_SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'Tracking Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  adminToken = tokenService.generateAccessToken(admin);
}, 60000);

beforeEach(() => {
  process.env.TRACKING_APP_ENABLED = 'true';
});

afterAll(async () => {
  delete process.env.TRACKING_APP_ENABLED;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Suprah Driver Tracker app', () => {
  it('stays off unless it is switched on', async () => {
    delete process.env.TRACKING_APP_ENABLED;
    const driver = await makeDriver('off');
    const view = await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(view.body.data.provider).toBeNull();
    expect(view.body.data.available).toBe(false);
    await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(409);
    await request(app).post('/api/tracking-app/pair').send({ code: 'ABCD-EFGH' }).expect(409);
    await request(app).get('/api/tracking-app/status').set(device('SPRX', 'key')).expect(503);
  });

  it('pairs once with the code, waits for approval, then accepts positions on an active load', async () => {
    const driver = await makeDriver('pair');
    const started = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    expect(started.body.data.provider).toBe('app');
    expect(started.body.data.pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.body.data.device).toMatchObject({ provider: 'app', status: 'pending', paired: false, identifier: null });

    // The code is never shown again and is stored only as a hash.
    const again = await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(again.body.data.pairingCode).toBeNull();
    const stored: any = await DriverTrackingDevice.findOne({ driverId: driver.user._id, isCurrent: true }).select('+pairingCodeHash').lean();
    expect(stored.pairingCodeHash).not.toContain(started.body.data.pairingCode.replace('-', ''));

    await request(app).post('/api/tracking-app/pair').send({ code: 'WRONG-CODE' }).expect(400);
    await request(app).post('/api/tracking-app/pair').send({ code: 'ABCD-EFGH' }).expect(404);

    // Case, spaces and the dash don't matter.
    const typed = ` ${started.body.data.pairingCode.toLowerCase().replace('-', ' ')} `;
    const paired = await request(app)
      .post('/api/tracking-app/pair')
      .send({ code: typed, deviceName: 'Pixel 8', platform: 'android', appVersion: '1.0.0' })
      .expect(201);
    const { deviceId, deviceKey } = paired.body.data;
    expect(deviceKey.length).toBeGreaterThan(30);
    expect(paired.body.data).toMatchObject({ status: 'waiting_for_approval', shouldTrack: false, driverName: 'Driver pair' });

    // The same code can't pair a second phone.
    await request(app).post('/api/tracking-app/pair').send({ code: started.body.data.pairingCode }).expect(404);

    // A wrong key is refused; the right key works but positions wait for approval.
    await request(app).get('/api/tracking-app/status').set(device(deviceId, 'not-the-key')).expect(401);
    await request(app).get('/api/tracking-app/status').set(device(deviceId, deviceKey)).expect(200);
    const early = await request(app)
      .post('/api/tracking-app/positions').set(device(deviceId, deviceKey))
      .send({ positions: [pos(39.74, -104.99, 5_000)] }).expect(403);
    expect(early.body.reason).toBe('waiting_for_approval');

    // The reviewer sees the phone model and approves.
    const review = await request(app).get(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device`).set(auth(adminToken)).expect(200);
    expect(review.body.data.device).toMatchObject({ provider: 'app', paired: true, deviceName: 'Pixel 8', traccarSyncStatus: null });
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);

    // No active load: approved, but there's nothing to track yet.
    const idle = await request(app).get('/api/tracking-app/status').set(device(deviceId, deviceKey)).expect(200);
    expect(idle.body.data).toMatchObject({ status: 'approved', shouldTrack: false });
    const ignored = await request(app)
      .post('/api/tracking-app/positions').set(device(deviceId, deviceKey))
      .send({ positions: [pos(39.74, -104.99, 5_000)] }).expect(200);
    expect(ignored.body.data).toMatchObject({ accepted: 0, refused: { no_tracking_relationship: 1 } });

    const load = await acceptedLoadFor(driver.user._id);
    const sent = await request(app)
      .post('/api/tracking-app/positions').set(device(deviceId, deviceKey))
      .send({ positions: [pos(39.70, -105.00, 40_000, { speed: 20, heading: 90 }), pos(39.74, -104.99, 10_000)] })
      .expect(200);
    expect(sent.body.data).toMatchObject({ received: 2, accepted: 2, shouldTrack: true, activeLoadCount: 1 });

    const live: any = await DriverLocation.findOne({ userId: driver.user._id }).lean();
    expect(live).toMatchObject({ source: 'app', sourceDeviceId: deviceId, coords: { lat: 39.74, lng: -104.99 } });
    expect(await LoadTripPoint.countDocuments({ loadId: load._id, source: 'app' })).toBe(2);
  });

  it('positions buffered offline fill the trip history without moving the live position backwards', async () => {
    const driver = await makeDriver('offline');
    const { deviceId, key } = await pairedApp(driver);
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
    const load = await acceptedLoadFor(driver.user._id);

    await request(app).post('/api/tracking-app/positions').set(device(deviceId, key))
      .send({ positions: [pos(40.0, -105.0, 5_000)] }).expect(200);

    // Reconnecting after 30 minutes in a dead zone: older readings arrive late.
    const late = await request(app).post('/api/tracking-app/positions').set(device(deviceId, key))
      .send({ positions: [pos(39.5, -105.5, 30 * 60_000), pos(39.6, -105.4, 20 * 60_000)] }).expect(200);
    expect(late.body.data).toMatchObject({ accepted: 0, refused: { older_than_stored: 2 } });

    const live: any = await DriverLocation.findOne({ userId: driver.user._id }).lean();
    expect(live.coords).toEqual({ lat: 40.0, lng: -105.0 });
    expect(await LoadTripPoint.countDocuments({ loadId: load._id })).toBe(3);

    // Too many at once, or a reading a day old, is refused.
    const tooMany = Array.from({ length: 101 }, () => pos(40, -105, 1_000));
    await request(app).post('/api/tracking-app/positions').set(device(deviceId, key)).send({ positions: tooMany }).expect(400);
    const stale = await request(app).post('/api/tracking-app/positions').set(device(deviceId, key))
      .send({ positions: [pos(40, -105, 25 * 60 * 60_000)] }).expect(200);
    expect(stale.body.data.refused).toEqual({ too_old: 1 });
  });

  it('the phone beats the Driver Portal while it keeps reporting', async () => {
    const driver = await makeDriver('priority');
    const { deviceId, key } = await pairedApp(driver);
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
    await acceptedLoadFor(driver.user._id);

    await request(app).post('/api/tracking-app/positions').set(device(deviceId, key))
      .send({ positions: [pos(41.0, -104.0, 3_000)] }).expect(200);
    await request(app).post('/api/driver-tracking/heartbeat').set(auth(driver.token))
      .send({ lat: 42.0, lng: -103.0, locationRecordedAt: new Date().toISOString(), accuracy: 20 })
      .expect(200);

    const live: any = await DriverLocation.findOne({ userId: driver.user._id }).lean();
    expect(live).toMatchObject({ source: 'app', coords: { lat: 41.0, lng: -104.0 } });
  });

  it('a new code before pairing, unlinking from the app or by Dispatch, and replacing the phone', async () => {
    const driver = await makeDriver('unlink');
    const started = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    const renewed = await request(app).post('/api/driver-tracking/tracking-device/pairing-code').set(auth(driver.token)).expect(200);
    expect(renewed.body.data.pairingCode).not.toBe(started.body.data.pairingCode);
    // The old code stopped working.
    await request(app).post('/api/tracking-app/pair').send({ code: started.body.data.pairingCode }).expect(404);
    const paired = await request(app).post('/api/tracking-app/pair').send({ code: renewed.body.data.pairingCode }).expect(201);
    const { deviceId, deviceKey } = paired.body.data;
    // Once paired, a new code isn't offered.
    await request(app).post('/api/driver-tracking/tracking-device/pairing-code').set(auth(driver.token)).expect(409);

    // Unlinking from the app: the key stops working and the app is told why.
    await request(app).delete('/api/tracking-app/device').set(device(deviceId, deviceKey)).expect(200);
    const gone = await request(app).get('/api/tracking-app/status').set(device(deviceId, deviceKey)).expect(401);
    expect(gone.body.reason).toBe('device_unlinked');

    // Pair again, then Dispatch removes it.
    const second = await pairedApp(driver);
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/revoke`).set(auth(adminToken)).expect(200);
    const revoked = await request(app).get('/api/tracking-app/status').set(device(second.deviceId, second.key)).expect(401);
    expect(revoked.body.reason).toBe('device_unlinked');

    // Setting up a new phone replaces the old link.
    const third = await pairedApp(driver);
    const fourth = await pairedApp(driver);
    await request(app).get('/api/tracking-app/status').set(device(third.deviceId, third.key)).expect(401);
    await request(app).get('/api/tracking-app/status').set(device(fourth.deviceId, fourth.key)).expect(200);
  });

  it('reminds the driver in the Driver Portal when the app stops sending during a load', async () => {
    const driver = await makeDriver('remind');
    const { deviceId, key } = await pairedApp(driver);
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
    await acceptedLoadFor(driver.user._id, 60_000);

    const before = await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(before.body.data.reminder).toBe('turn_on');
    await request(app).post('/api/tracking-app/positions').set(device(deviceId, key))
      .send({ positions: [pos(40, -105, 2_000)] }).expect(200);
    const after = await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(after.body.data.reminder).toBe('keep_on');
    expect(after.body.data.device.lastPositionAt).toBeTruthy();
  });
});
