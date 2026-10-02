/**
 * Traccar integration — phone linking, forwarded positions, catch-up.
 *
 * SIMULATED: no real Traccar Server is involved. Settings below are made-up
 * test values set only inside this test process, and every call to Traccar
 * Server is answered by an in-memory fake (global fetch is mocked). An
 * end-to-end check against the company's real Traccar Server is still required.
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
import { reconcileTraccarPositions, resetTraccarHealthForTests, traccarHealthSnapshot } from '../src/services/traccar.service';
import { retryFailedTraccarDeviceSyncs } from '../src/services/driverTrackingDevice.service';

const DOMAIN = '@traccar-test.com';
const ORG_SLUG = 'traccar-test-org';
const SIMULATED_SECRET = 'simulated-forward-secret-for-tests-0123456789';
const SIMULATED_SETTINGS: Record<string, string> = {
  TRACCAR_INTEGRATION_ENABLED: 'true',
  TRACCAR_BASE_URL: 'https://traccar.simulated.test',
  TRACCAR_API_TOKEN: 'simulated-api-token',
  TRACCAR_FORWARD_SECRET: SIMULATED_SECRET,
  // The test requests come from this machine.
  TRACCAR_FORWARD_ALLOWED_IPS: '127.0.0.1,::1',
  TRACCAR_DEVICE_SERVER_URL: 'https://traccar.simulated.test:5055',
};

let org: any;
let admin: any;
let adminToken: string;
let employee: any;
let employeeToken: string;

// ─── In-memory fake Traccar Server ─────────────────────────────────────────
const fakeTraccar = {
  nextId: 100,
  devices: new Map<number, any>(),
  positions: [] as any[],
  failNextCreate: false,
  calls: [] as Array<{ method: string; path: string; auth: string | null }>,
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function fakeFetch(input: any, init: any = {}) {
  const url = new URL(String(input));
  const method = String(init.method ?? 'GET');
  const path = url.pathname.replace(/^\/api/, '');
  fakeTraccar.calls.push({ method, path: path + url.search, auth: init.headers?.Authorization ?? null });
  if (init.headers?.Authorization !== `Bearer ${SIMULATED_SETTINGS.TRACCAR_API_TOKEN}`) return json({}, 401);
  if (method === 'GET' && path === '/devices') {
    const uniqueId = url.searchParams.get('uniqueId');
    const id = url.searchParams.get('id');
    return json([...fakeTraccar.devices.values()].filter((d) => (uniqueId ? d.uniqueId === uniqueId : true) && (id ? d.id === Number(id) : true)));
  }
  if (method === 'POST' && path === '/devices') {
    if (fakeTraccar.failNextCreate) {
      fakeTraccar.failNextCreate = false;
      return json({ error: 'boom' }, 500);
    }
    const body = JSON.parse(init.body);
    const device = { id: fakeTraccar.nextId++, name: body.name, uniqueId: body.uniqueId, disabled: false };
    fakeTraccar.devices.set(device.id, device);
    return json(device);
  }
  const put = /^\/devices\/(\d+)$/.exec(path);
  if (method === 'PUT' && put) {
    const body = JSON.parse(init.body);
    fakeTraccar.devices.set(Number(put[1]), body);
    return json(body);
  }
  if (method === 'GET' && path === '/positions') return json(fakeTraccar.positions);
  return json({}, 404);
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const forward = (body: object, secret = SIMULATED_SECRET) =>
  request(app).post('/api/integrations/traccar/positions').set({ Authorization: `Bearer ${secret}` }).send(body);
const traccarPosition = (uniqueId: string, overrides: Record<string, unknown> = {}) => ({
  device: { id: 1, uniqueId, name: 'Simulated phone' },
  position: {
    id: Math.floor(Math.random() * 1e9), deviceId: 1, protocol: 'osmand', valid: true,
    fixTime: new Date(Date.now() - 1_000).toISOString(), latitude: 39.74, longitude: -104.99,
    speed: 10, course: 180, accuracy: 6, ...overrides,
  },
});

async function makeDriver(label: string) {
  const user = await User.create({
    email: `${label}${DOMAIN}`, name: `Driver ${label}`, role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  await DriverProfile.create({ userId: user._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  return { user, token: tokenService.generateAccessToken(user as any) };
}

async function acceptedLoadFor(driverId: unknown) {
  return Load.create({
    organizationId: org._id, createdBy: admin._id, dispatchOwnerId: admin._id, assignedDriverId: driverId,
    postType: 'assign-carrier', status: 'Accepted', acceptedAt: new Date(Date.now() - 60_000),
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
  });
}

/** Driver starts setup, admin approves; returns the driver's identifier. */
async function linkedPhone(driver: { user: any; token: string }) {
  const started = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
  await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
  return started.body.data.device.identifier as string;
}

function useSimulatedSettings(overrides: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries({ ...SIMULATED_SETTINGS, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function clearSettings() {
  for (const key of Object.keys(SIMULATED_SETTINGS)) delete process.env[key];
}

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@traccar-test\.com$/ } }).select('_id')).map((u) => u._id);
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
  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch as any);
  org = await Organization.create({ name: 'Traccar Test Org', slug: ORG_SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'Traccar Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  employee = await User.create({
    email: `employee${DOMAIN}`, name: 'Plain Employee', role: 'employee', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  adminToken = tokenService.generateAccessToken(admin);
  employeeToken = tokenService.generateAccessToken(employee);
}, 60000);

beforeEach(() => {
  useSimulatedSettings();
  resetTraccarHealthForTests();
  fakeTraccar.calls = [];
});

afterAll(async () => {
  clearSettings();
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Traccar integration (simulated server)', () => {
  it('stays off until it is switched on and fully configured', async () => {
    const driver = await makeDriver('off');
    clearSettings();
    await forward(traccarPosition('SPRANYTHING')).expect(503);
    const status = await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(status.body.data).toMatchObject({ available: false, serverUrl: null, device: null, reminder: null });
    await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(409);

    useSimulatedSettings({ TRACCAR_FORWARD_SECRET: 'too-short' });
    await forward(traccarPosition('SPRANYTHING'), 'too-short').expect(503);
    const health = traccarHealthSnapshot();
    expect(health).toMatchObject({ enabled: true, usable: false });
    expect(health.settingsNeedingAttention.join(' ')).toMatch(/TRACCAR_FORWARD_SECRET/);
    expect(JSON.stringify(health)).not.toContain('too-short');
    expect(fakeTraccar.calls).toHaveLength(0);
  });

  it('a driver links a phone, a reviewer approves it, and Suprah adds it to Traccar', async () => {
    const driver = await makeDriver('link');
    const started = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    const identifier: string = started.body.data.device.identifier;
    expect(identifier).toMatch(/^SPR[0-9A-F]{24}$/);
    expect(started.body.data).toMatchObject({ available: true, serverUrl: SIMULATED_SETTINGS.TRACCAR_DEVICE_SERVER_URL });
    expect(started.body.data.device.status).toBe('pending');

    // Not counted before approval.
    expect((await forward(traccarPosition(identifier)).expect(202)).body.reason).toBe('unknown_or_unapproved_device');

    const review = await request(app).get(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device`).set(auth(adminToken)).expect(200);
    expect(review.body.data.device).toMatchObject({ status: 'pending', identifierEndsWith: identifier.slice(-4) });
    expect(JSON.stringify(review.body)).not.toContain(identifier);

    await request(app).get(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device`).set(auth(employeeToken)).expect(403);
    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(employeeToken)).expect(403);

    const approved = await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
    expect(approved.body.data.device).toMatchObject({ status: 'active', traccarSyncStatus: 'synced', approvedByName: 'Traccar Admin' });
    const stored: any = await DriverTrackingDevice.findOne({ uniqueId: identifier }).lean();
    expect(fakeTraccar.devices.get(stored.traccarDeviceId)).toMatchObject({ uniqueId: identifier, disabled: false });
    expect(fakeTraccar.calls.every((call) => call.auth === `Bearer ${SIMULATED_SETTINGS.TRACCAR_API_TOKEN}`)).toBe(true);
  });

  it('only takes forwards from the Traccar Server address', async () => {
    useSimulatedSettings({ TRACCAR_FORWARD_ALLOWED_IPS: '203.0.113.7' });
    // Refused before the secret is even checked.
    expect((await forward(traccarPosition('SPRANYTHING')).expect(403)).body.reason).toBe('address_not_allowed');
    expect(traccarHealthSnapshot().counts.addressRefused).toBe(1);

    // Ranges work too.
    useSimulatedSettings({ TRACCAR_FORWARD_ALLOWED_IPS: '127.0.0.0/8, ::1' });
    expect((await forward(traccarPosition('SPRANYTHING')).expect(202)).body.reason).toBe('unknown_or_unapproved_device');

    // Required once the integration is switched on.
    useSimulatedSettings({ TRACCAR_FORWARD_ALLOWED_IPS: undefined });
    await forward(traccarPosition('SPRANYTHING')).expect(503);
    expect(traccarHealthSnapshot().settingsNeedingAttention.join(' ')).toMatch(/TRACCAR_FORWARD_ALLOWED_IPS/);
  });

  it('forwarded positions need the secret, only count for approved phones on active loads, and convert knots', async () => {
    const driver = await makeDriver('forward');
    const identifier = await linkedPhone(driver);

    await forward(traccarPosition(identifier), 'wrong-secret-wrong-secret-wrong-secret-00').expect(401);
    expect((await forward(traccarPosition('SPRNOTALINKEDPHONE000000000')).expect(202)).body.reason).toBe('unknown_or_unapproved_device');
    // No active load yet: not kept.
    expect((await forward(traccarPosition(identifier)).expect(202)).body.reason).toBe('no_tracking_relationship');

    const load = await acceptedLoadFor(driver.user._id);
    expect((await forward(traccarPosition(identifier)).expect(200)).body).toEqual({ accepted: true });
    const location: any = await DriverLocation.findOne({ userId: driver.user._id }).lean();
    expect(location).toMatchObject({ source: 'traccar', sourceDeviceId: identifier, heading: 180, accuracy: 6 });
    expect(location.speed).toBeCloseTo(10 * 0.514444, 5);
    expect(await LoadTripPoint.countDocuments({ loadId: load._id, source: 'traccar' })).toBe(1);
    expect((await DriverTrackingDevice.findOne({ uniqueId: identifier }).lean() as any).lastPositionAt).toBeTruthy();

    expect((await forward(traccarPosition(identifier, { valid: false })).expect(202)).body.reason).toBe('invalid_fix');
    expect((await forward({ device: { uniqueId: identifier } }).expect(202)).body.reason).toBe('malformed');
    expect(traccarHealthSnapshot().counts).toMatchObject({ unauthorized: 1, accepted: 1 });
  });

  it('catch-up takes positions missed while forwarding was down, and skips ones already seen', async () => {
    const driver = await makeDriver('catchup');
    const identifier = await linkedPhone(driver);
    await acceptedLoadFor(driver.user._id);
    const link: any = await DriverTrackingDevice.findOne({ uniqueId: identifier }).lean();
    const missedAt = new Date(Date.now() - 2_000).toISOString();
    fakeTraccar.positions = [
      { id: 1, deviceId: link.traccarDeviceId, valid: true, fixTime: missedAt, latitude: 40.1, longitude: -105.1, speed: 0, course: 0, accuracy: 5 },
      { id: 2, deviceId: 999_999, valid: true, fixTime: missedAt, latitude: 1, longitude: 1 },
    ];

    await reconcileTraccarPositions();
    const location: any = await DriverLocation.findOne({ userId: driver.user._id }).lean();
    expect(location.coords).toEqual({ lat: 40.1, lng: -105.1 });
    expect(location.locationRecordedAt.toISOString()).toBe(missedAt);

    await DriverLocation.updateOne({ userId: driver.user._id }, { $set: { offlineAlertSentAt: new Date() } });
    await reconcileTraccarPositions();
    // Already seen: nothing re-applied, alert state untouched.
    expect((await DriverLocation.findOne({ userId: driver.user._id }).lean() as any).offlineAlertSentAt).toBeTruthy();
    expect(traccarHealthSnapshot()).toMatchObject({ counts: expect.objectContaining({ reconciled: 1 }), lastReconcileError: null });
  });

  it('revoking a phone disables it on Traccar and its positions stop counting; replacing gives a new identifier', async () => {
    const driver = await makeDriver('revoke');
    const identifier = await linkedPhone(driver);
    await acceptedLoadFor(driver.user._id);
    const link: any = await DriverTrackingDevice.findOne({ uniqueId: identifier }).lean();

    await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/revoke`).set(auth(adminToken)).expect(200);
    expect(fakeTraccar.devices.get(link.traccarDeviceId).disabled).toBe(true);
    expect((await forward(traccarPosition(identifier)).expect(202)).body.reason).toBe('unknown_or_unapproved_device');
    expect((await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200)).body.data.device).toBeNull();

    const replaced = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    expect(replaced.body.data.device.identifier).not.toBe(identifier);
    const again = await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    expect(await DriverTrackingDevice.countDocuments({ driverId: driver.user._id, isCurrent: true })).toBe(1);
    expect(await DriverTrackingDevice.findOne({ uniqueId: replaced.body.data.device.identifier }).lean()).toMatchObject({
      status: 'revoked', revokeReason: 'replaced_by_driver',
    });
    expect(again.body.data.device.status).toBe('pending');

    // The driver can unlink their own phone (for example it was lost).
    await request(app).delete('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200);
    expect(await DriverTrackingDevice.countDocuments({ driverId: driver.user._id, isCurrent: true })).toBe(0);
  });

  it('a failed Traccar update is recorded in plain words and retried', async () => {
    const driver = await makeDriver('retry');
    await request(app).post('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(201);
    fakeTraccar.failNextCreate = true;
    const approved = await request(app).post(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device/approve`).set(auth(adminToken)).expect(200);
    expect(approved.body.data.device).toMatchObject({ status: 'active', traccarSyncStatus: 'failed' });
    expect(approved.body.data.device.traccarSyncError).toMatch(/Traccar Server answered with an error/);

    await retryFailedTraccarDeviceSyncs();
    const review = await request(app).get(`/api/driver-tracking/drivers/${driver.user._id}/tracking-device`).set(auth(adminToken)).expect(200);
    expect(review.body.data.device).toMatchObject({ traccarSyncStatus: 'synced', traccarSyncError: null });
  });

  it('reminds the driver to turn Traccar Client on, warns when positions stop, and says when it can be turned off', async () => {
    const driver = await makeDriver('reminders');
    const identifier = await linkedPhone(driver);
    const reminder = async () =>
      (await request(app).get('/api/driver-tracking/tracking-device').set(auth(driver.token)).expect(200)).body.data.reminder;

    expect(await reminder()).toBeNull(); // no active load, phone never reported
    const load = await acceptedLoadFor(driver.user._id);
    await Load.updateOne({ _id: load._id }, { $set: { acceptedAt: new Date(Date.now() - 30 * 60_000) } });
    expect(await reminder()).toBe('turn_on');
    await forward(traccarPosition(identifier)).expect(200);
    expect(await reminder()).toBe('keep_on');
    // Positions arrived after acceptance, then stopped 10 minutes ago.
    await DriverTrackingDevice.updateOne({ uniqueId: identifier }, { $set: { lastPositionAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await reminder()).toBe('not_receiving');
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Delivered' } });
    expect(await reminder()).toBe('turn_off');
  });
});
