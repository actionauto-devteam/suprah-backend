/**
 * Google Geocoding for map labels: the Driver Tracker's area name and the
 * available-load map pins.
 *
 * SIMULATED: no real Google key is used. The key below is a made-up test value
 * set only inside this test process, and every call to Google is answered by
 * an in-memory fake (global fetch is mocked). A check with the company's real
 * server key is still required.
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
import tokenService from '../src/services/token.service';
import {
  areaNameFromResults,
  googleGeocodingHealthSnapshot,
  lookupAreaName,
  resetGoogleGeocodingForTests,
  streetAddressFromResults,
} from '../src/services/googleGeocoding.service';

const DOMAIN = '@geocoding-test.com';
const ORG_SLUG = 'geocoding-test-org';
const SIMULATED_KEY = 'simulated-google-server-key';

let org: any;
let owner: any;
let orgAdmin: any;
let otherDispatcher: any;
let driver: any;
let driverToken: string;
let load: any;

// ─── In-memory fake Google Geocoding API ─────────────────────────────────
const fakeGoogle = {
  status: 'OK',
  results: [] as any[],
  calls: [] as URL[],
};
const denverResults = [
  {
    address_components: [
      { long_name: '1600', short_name: '1600', types: ['street_number'] },
      { long_name: 'Denver', short_name: 'Denver', types: ['locality', 'political'] },
      { long_name: 'Denver County', short_name: 'Denver County', types: ['administrative_area_level_2', 'political'] },
      { long_name: 'Colorado', short_name: 'CO', types: ['administrative_area_level_1', 'political'] },
    ],
    geometry: { location: { lat: 39.7392, lng: -104.9903 } },
  },
];
async function fakeFetch(input: any) {
  const url = new URL(String(input));
  fakeGoogle.calls.push(url);
  const body =
    fakeGoogle.status === 'OK'
      ? { status: 'OK', results: fakeGoogle.results }
      : { status: fakeGoogle.status, results: [], error_message: 'simulated failure' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const areaName = (token: string) =>
  request(app).get(`/api/driver-tracking/drivers/${driver._id}/area-name`).set(auth(token));

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@geocoding-test\.com$/ } }).select('_id')).map((u) => u._id);
  const orgs = (await Organization.find({ slug: ORG_SLUG }).select('_id')).map((o) => o._id);
  await Load.deleteMany({ organizationId: { $in: orgs } });
  await LoadTripPoint.deleteMany({ organizationId: { $in: orgs } });
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
  org = await Organization.create({ name: 'Geocoding Test Org', slug: ORG_SLUG, status: 'active' });
  const staff = (label: string, extra: Record<string, unknown>) =>
    User.create({
      email: `${label}${DOMAIN}`, name: `Staff ${label}`, organizationId: org._id,
      emailVerified: true, onboardingCompleted: true, isActive: true, ...extra,
    });
  owner = await staff('owner', { role: 'employee', dispatcherOrganizationIds: [org._id] });
  otherDispatcher = await staff('other', { role: 'employee', dispatcherOrganizationIds: [org._id] });
  orgAdmin = await staff('admin', { role: 'admin' });

  driver = await User.create({
    email: `driver${DOMAIN}`, name: 'Geo Driver', role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  await DriverProfile.create({ userId: driver._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  driverToken = tokenService.generateAccessToken(driver);

  load = await Load.create({
    organizationId: org._id, createdBy: orgAdmin._id, dispatchOwnerId: owner._id, assignedDriverId: driver._id,
    postType: 'assign-carrier', status: 'Accepted', acceptedAt: new Date(Date.now() - 60_000),
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
  });
  await request(app)
    .post('/api/driver-tracking/heartbeat')
    .set(auth(driverToken))
    .send({ lat: 39.73917, lng: -104.99028, accuracy: 10, locationRecordedAt: new Date(Date.now() - 1_000).toISOString() })
    .expect(200);
}, 60000);

beforeEach(() => {
  process.env.GOOGLE_MAPS_SERVER_API_KEY = SIMULATED_KEY;
  resetGoogleGeocodingForTests();
  fakeGoogle.status = 'OK';
  fakeGoogle.results = denverResults;
  fakeGoogle.calls = [];
});

const streetResults = [
  {
    types: ['street_address'],
    place_id: 'simulated-street-place',
    formatted_address: '1600 Glenarm Pl, Denver, CO 80202, USA',
    address_components: [
      { long_name: '1600', short_name: '1600', types: ['street_number'] },
      { long_name: 'Glenarm Place', short_name: 'Glenarm Pl', types: ['route'] },
      { long_name: 'Denver', short_name: 'Denver', types: ['locality', 'political'] },
      { long_name: 'Colorado', short_name: 'CO', types: ['administrative_area_level_1', 'political'] },
      { long_name: '80202', short_name: '80202', types: ['postal_code'] },
      { long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
    ],
    geometry: { location: { lat: 39.7453, lng: -104.9892 } },
  },
];

afterAll(async () => {
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Google Geocoding for map labels (simulated Google)', () => {
  it('reads a street address for the Create Load map picker', () => {
    expect(streetAddressFromResults([{ types: ['locality'], address_components: [] }, ...streetResults])).toEqual({
      address: '1600 Glenarm Pl', city: 'Denver', state: 'CO', zip: '80202', country: 'US', placeId: 'simulated-street-place',
    });
    expect(streetAddressFromResults([])).toBeNull();
  });

  it('looks up the address at a picked spot for staff only, at full precision', async () => {
    fakeGoogle.results = streetResults;
    const staff = tokenService.generateAccessToken(orgAdmin);
    const found = await request(app).get('/api/loads/address-at').query({ lat: 39.745312, lng: -104.989187 }).set(auth(staff)).expect(200);
    expect(found.body.data).toEqual({
      address: { address: '1600 Glenarm Pl', city: 'Denver', state: 'CO', zip: '80202', country: 'US', placeId: 'simulated-street-place' },
      available: true,
    });
    expect(fakeGoogle.calls[0].searchParams.get('latlng')).toBe('39.74531,-104.98919');

    await request(app).get('/api/loads/address-at').query({ lat: 'north', lng: 0 }).set(auth(staff)).expect(400);
    await request(app).get('/api/loads/address-at').query({ lat: 39.7, lng: -104.9 }).set(auth(driverToken)).expect(403);
  });

  it('reads "City, ST", falling back to the county outside towns', () => {
    expect(areaNameFromResults(denverResults)).toBe('Denver, CO');
    const rural = [{ address_components: denverResults[0].address_components.filter((c) => !c.types.includes('locality')) }];
    expect(areaNameFromResults(rural)).toBe('Denver County, CO');
    expect(areaNameFromResults([])).toBeNull();
  });

  it('does nothing without the server key, and the map keeps working', async () => {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    expect(await lookupAreaName(39.7, -104.9)).toBeNull();
    const response = await areaName(tokenService.generateAccessToken(owner)).expect(200);
    expect(response.body.data).toEqual({ areaName: null, available: false });
    expect(fakeGoogle.calls).toHaveLength(0);
    expect(googleGeocodingHealthSnapshot().configured).toBe(false);
  });

  it('sends a rounded position, caches the answer, and never exposes the key', async () => {
    const first = await areaName(tokenService.generateAccessToken(owner)).expect(200);
    expect(first.body.data).toEqual({ areaName: 'Denver, CO', available: true });
    expect(fakeGoogle.calls).toHaveLength(1);
    expect(fakeGoogle.calls[0].searchParams.get('latlng')).toBe('39.739,-104.990');

    // Another viewer of the same area uses the cached answer.
    await areaName(tokenService.generateAccessToken(orgAdmin)).expect(200);
    expect(fakeGoogle.calls).toHaveLength(1);

    const snapshot = googleGeocodingHealthSnapshot();
    expect(snapshot).toMatchObject({ configured: true, lookups: 1, cacheHits: 1, lastFailure: null });
    expect(JSON.stringify(snapshot)).not.toContain(SIMULATED_KEY);
    expect(JSON.stringify(first.body)).not.toContain(SIMULATED_KEY);
  });

  it('does not keep a failed lookup, so the next one retries', async () => {
    fakeGoogle.status = 'REQUEST_DENIED';
    expect(await lookupAreaName(40.1, -105.1)).toBeNull();
    expect(googleGeocodingHealthSnapshot().lastFailure?.reason).toBe('REQUEST_DENIED');

    fakeGoogle.status = 'OK';
    expect(await lookupAreaName(40.1, -105.1)).toBe('Denver, CO');
    expect(fakeGoogle.calls).toHaveLength(2);
  });

  it('shows the area name only to people who can see the exact location', async () => {
    await areaName(tokenService.generateAccessToken(owner)).expect(200);
    await areaName(tokenService.generateAccessToken(orgAdmin)).expect(200);
    // Dispatcher access for the organization is not enough on its own.
    const other = await areaName(tokenService.generateAccessToken(otherDispatcher)).expect(403);
    expect(other.body.message).toMatch(/responsible dispatcher and organization admins/);

    // Assigned but not yet accepted: hidden (business rule 1).
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Assigned' } });
    try {
      await areaName(tokenService.generateAccessToken(owner)).expect(403);
    } finally {
      await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' } });
    }
    await request(app).get('/api/driver-tracking/drivers/not-an-id/area-name').set(auth(tokenService.generateAccessToken(owner))).expect(400);
  });

  it('finds stop positions for drivers and Driver Tracker staff', async () => {
    const found = await request(app).get('/api/driver-tracking/places/lookup').query({ q: 'Denver, CO' }).set(auth(driverToken)).expect(200);
    expect(found.body.data).toEqual({ position: { lat: 39.7392, lng: -104.9903 }, available: true });
    expect(fakeGoogle.calls[0].searchParams.get('components')).toBe('country:US');

    await request(app).get('/api/driver-tracking/places/lookup').query({ q: 'x'.repeat(201) }).set(auth(driverToken)).expect(400);
    // Staff place the selected driver's stops on the Tracker map (answered from the cache here).
    await request(app).get('/api/driver-tracking/places/lookup').query({ q: 'Denver, CO' }).set(auth(tokenService.generateAccessToken(orgAdmin))).expect(200);
  });
});

describe('Driver Tracker map data', () => {
  it('shows the recent route only to people who can see the exact location', async () => {
    const trail = (token: string, query: Record<string, unknown> = {}) =>
      request(app).get(`/api/driver-tracking/drivers/${driver._id}/recent-trail`).query(query).set(auth(token));

    const owned = await trail(tokenService.generateAccessToken(owner)).expect(200);
    expect(owned.body.data.minutes).toBe(120);
    expect(owned.body.data.points.length).toBeGreaterThanOrEqual(1);
    expect(owned.body.data.points.at(-1)).toMatchObject({ lat: 39.73917, lng: -104.99028 });

    // Window limits: at least 15 minutes, at most 6 hours.
    expect((await trail(tokenService.generateAccessToken(orgAdmin), { minutes: 5 }).expect(200)).body.data.minutes).toBe(15);
    expect((await trail(tokenService.generateAccessToken(orgAdmin), { minutes: 9999 }).expect(200)).body.data.minutes).toBe(360);

    const refused = await trail(tokenService.generateAccessToken(otherDispatcher)).expect(403);
    expect(refused.body.message).toMatch(/responsible dispatcher and organization admins/);
    await request(app).get('/api/driver-tracking/drivers/not-an-id/recent-trail').set(auth(tokenService.generateAccessToken(owner))).expect(400);
  });

  it('sends the stop details the map needs to place the selected driver\'s stops', async () => {
    await Load.updateOne(
      { _id: load._id },
      { $set: { 'deliveryLocation.name': 'Denver Dealer', 'deliveryLocation.coordinates': { lat: 39.75, lng: -104.99 } } },
    );
    const res = await request(app).get('/api/driver-tracking/org-drivers').set(auth(tokenService.generateAccessToken(owner))).expect(200);
    const entry = res.body.data.drivers.find((item: any) => item.id === String(driver._id));
    expect(entry.shipments[0].deliveryLocation).toEqual({
      name: 'Denver Dealer', address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202', coordinates: { lat: 39.75, lng: -104.99 },
    });
    expect(entry.shipments[0].pickupLocation).toMatchObject({ name: null, address: '1 Pickup St', city: 'Salt Lake City', coordinates: null });
  });
});
