/**
 * Arrival times (ETA) with live traffic, for the Driver Tracker, the
 * Transportation load page and the Driver Page.
 *
 * SIMULATED: Amazon Location is never called. The AWS clients are replaced by
 * fakes that return made-up routes and addresses, so no AWS account or
 * credentials are needed. A check against the real service is still required
 * once AWS is set up.
 */
const mockRoutesSend = jest.fn();
const mockPlacesSend = jest.fn();
jest.mock('@aws-sdk/client-geo-routes', () => ({
  GeoRoutesClient: jest.fn().mockImplementation(() => ({ send: mockRoutesSend })),
  CalculateRoutesCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  SnapToRoadsCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));
jest.mock('@aws-sdk/client-geo-places', () => ({
  GeoPlacesClient: jest.fn().mockImplementation(() => ({ send: mockPlacesSend })),
  GeocodeCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import DriverLocation from '../src/models/DriverLocation.model';
import Load from '../src/models/Load.model';
import LoadTripPoint from '../src/models/LoadTripPoint.model';
import tokenService from '../src/services/token.service';
import { loadEtaHealthSnapshot, resetLoadEtaForTests } from '../src/services/loadEta.service';

const DOMAIN = '@load-eta-test.com';
const ORG_SLUG = 'load-eta-test-org';
const DAY_MS = 24 * 60 * 60_000;

let org: any;
let admin: any;
let adminToken: string;
let otherDispatcherToken: string;
let driver: any;
let driverToken: string;
let otherDriverToken: string;
let load: any;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const staffEta = (token = adminToken) => request(app).get(`/api/driver-tracking/loads/${load._id}/eta`).set(auth(token));
const driverEta = (token = driverToken) => request(app).get(`/api/driver-tracking/my-loads/${load._id}/eta`).set(auth(token));
const day = (offsetDays: number) => new Date(new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00.000Z');

/** A 2-hour, 160 km route that would take 1.5 hours on empty roads. */
const fakeRoute = (overrides: Record<string, unknown> = {}) => ({
  Routes: [
    {
      Summary: { Distance: 160_000, Duration: 7200 },
      Legs: [
        {
          VehicleLegDetails: {
            Summary: { Overview: { Distance: 160_000, Duration: 7200, TypicalDuration: 6000, BestCaseDuration: 5400 } },
            Incidents: [
              { Description: 'Right lane closed', Severity: 'Low', Type: 'LaneRestriction' },
              { Description: 'Crash on I-25 northbound', Severity: 'Critical', Type: 'Accident' },
            ],
          },
        },
      ],
      ...overrides,
    },
  ],
});

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@load-eta-test\.com$/ } }).select('_id')).map((u) => u._id);
  const orgs = (await Organization.find({ slug: ORG_SLUG }).select('_id')).map((o) => o._id);
  await LoadTripPoint.deleteMany({ organizationId: { $in: orgs } });
  await Load.deleteMany({ organizationId: { $in: orgs } });
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
  org = await Organization.create({ name: 'Load ETA Test Org', slug: ORG_SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'ETA Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  adminToken = tokenService.generateAccessToken(admin);
  const otherDispatcher = await User.create({
    email: `other${DOMAIN}`, name: 'Other Dispatcher', role: 'employee', organizationId: org._id,
    dispatcherOrganizationIds: [org._id], emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  otherDispatcherToken = tokenService.generateAccessToken(otherDispatcher);
  driver = await User.create({
    email: `driver${DOMAIN}`, name: 'ETA Driver', role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  driverToken = tokenService.generateAccessToken(driver);
  const otherDriver = await User.create({
    email: `driver2${DOMAIN}`, name: 'Other Driver', role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  otherDriverToken = tokenService.generateAccessToken(otherDriver);
  await DriverProfile.create({ userId: driver._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  await DriverProfile.create({ userId: otherDriver._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  load = await Load.create({
    organizationId: org._id, createdBy: admin._id, dispatchOwnerId: admin._id, assignedDriverId: driver._id,
    postType: 'assign-carrier', status: 'In-Transit', acceptedAt: new Date(Date.now() - 6 * 60 * 60_000),
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202', coordinates: { lat: 39.75, lng: -104.99 } },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    dates: { pickupDeadline: day(-1), deliveryDeadline: day(10) },
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
  });
}, 60000);

beforeEach(async () => {
  await Load.updateOne(
    { _id: load._id },
    { $set: { status: 'In-Transit', 'dates.pickupDeadline': day(-1), 'dates.deliveryDeadline': day(10) } },
  );
  await LoadTripPoint.deleteMany({ loadId: load._id });
  await DriverLocation.deleteMany({ userId: driver._id });
  await DriverLocation.create({
    userId: driver._id, organizationId: org._id, status: 'on-route', coords: { lat: 40.5, lng: -105.08 },
    locationRecordedAt: new Date(Date.now() - 60_000), source: 'app', speed: 25, isSharing: true,
  });
  mockRoutesSend.mockReset();
  mockPlacesSend.mockReset();
  resetLoadEtaForTests();
  delete process.env.AMAZON_LOCATION_ETA_ENABLED;
});

afterAll(async () => {
  delete process.env.AMAZON_LOCATION_ETA_ENABLED;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Arrival times (ETA)', () => {
  it('while switched off, shows no arrival time and never calls AWS', async () => {
    const res = await staffEta().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'eta_off' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
    expect(mockPlacesSend).not.toHaveBeenCalled();
  });

  it('when switched on, works out the drive time for a truck with live traffic, incidents and the deadline', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(fakeRoute());
    const before = Date.now();

    const res = await staffEta().expect(200);
    const eta = res.body.data;
    expect(eta).toMatchObject({
      available: true,
      stop: 'delivery',
      durationSeconds: 7200,
      distanceMeters: 160_000,
      traffic: { level: 'heavy', delaySeconds: 1800, comparedWithUsual: 'worse' },
      paceAdjustmentSeconds: 0,
      driver: { speedMph: 56, stoppedMinutes: null, positionAgeMinutes: 1, positionStale: false },
      deadline: { status: 'on_time' },
    });
    expect(eta.incidents.map((incident: any) => incident.description)).toEqual(['Crash on I-25 northbound', 'Right lane closed']);
    expect(Date.parse(eta.arrivalAt) - before).toBeGreaterThanOrEqual(7200 * 1000);
    expect(Date.parse(eta.arrivalAt) - before).toBeLessThan(7200 * 1000 + 60_000);

    // The map pin is used, so no address lookup; truck settings and live traffic are sent.
    expect(mockPlacesSend).not.toHaveBeenCalled();
    const input = mockRoutesSend.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Origin: [-105.08, 40.5],
      Destination: [-104.99, 39.75],
      DepartNow: true,
      Traffic: { Usage: 'UseTrafficData' },
      TravelMode: 'Truck',
      TravelModeOptions: { Truck: { TruckType: 'Tractor', Height: 411, Length: 2286, GrossWeight: 36287, Trailer: { TrailerCount: 1 } } },
    });
    expect(loadEtaHealthSnapshot()).toMatchObject({ etaEnabled: true, computed: 1, failed: 0 });
  });

  it('reuses the arrival time for 2 minutes for everyone looking at the load', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(fakeRoute());
    const first = await staffEta().expect(200);
    const second = await staffEta().expect(200);
    const fromDriver = await driverEta().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
    expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
    expect(fromDriver.body.data.computedAt).toBe(first.body.data.computedAt);
  });

  it('heading to pickup without a map pin, looks up the pickup address once', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted', 'dates.pickupDeadline': day(-1) } });
    mockPlacesSend.mockResolvedValue({ ResultItems: [{ Position: [-111.89, 40.76] }] });
    mockRoutesSend.mockResolvedValue(fakeRoute());

    const res = await staffEta().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'pickup', deadline: { status: 'late' } });
    expect(mockPlacesSend).toHaveBeenCalledTimes(1);
    expect(mockPlacesSend.mock.calls[0][0].input).toMatchObject({
      QueryText: '1 Pickup St, Salt Lake City, UT 84101',
      Filter: { IncludeCountries: ['USA'] },
    });
    expect(mockRoutesSend.mock.calls[0][0].input.Destination).toEqual([-111.89, 40.76]);
  });

  it("when the address lookup fails, says to try again (not that the address doesn't exist) and retries", async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' } });
    mockPlacesSend.mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const failed = await staffEta().expect(200);
    expect(failed.body.data).toMatchObject({ available: false, reason: 'unavailable' });
    expect(mockRoutesSend).not.toHaveBeenCalled();

    mockPlacesSend.mockResolvedValue({ ResultItems: [{ Position: [-111.89, 40.76] }] });
    mockRoutesSend.mockResolvedValue(fakeRoute());
    const retried = await staffEta().expect(200);
    expect(retried.body.data).toMatchObject({ available: true, stop: 'pickup' });
  });

  it("says when a stop's address isn't on the map", async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' } });
    mockPlacesSend.mockResolvedValue({ ResultItems: [] });
    const res = await staffEta().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'no_destination' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it("says the driver is stopped and doesn't adjust for their pace while parked", async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(fakeRoute());
    const now = Date.now();
    await LoadTripPoint.insertMany(
      Array.from({ length: 11 }, (_, index) => ({
        loadId: load._id, organizationId: org._id, driverId: driver._id,
        lat: 40.5 + (index % 2) * 0.0002, lng: -105.08,
        measuredAt: new Date(now - (10 - index) * 60_000), receivedAt: new Date(),
        accuracy: 8, speed: 0, source: 'app', loadStatus: 'In-Transit',
      })),
    );

    const res = await staffEta().expect(200);
    expect(res.body.data.driver.stoppedMinutes).toBeGreaterThanOrEqual(9);
    expect(res.body.data.paceAdjustmentSeconds).toBe(0);
    expect(res.body.data.durationSeconds).toBe(7200);
  });

  it('is shown only to the responsible dispatcher and organization admins', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(fakeRoute());
    await staffEta(otherDispatcherToken).expect(403);
    await staffEta(driverToken).expect(403);
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it("lets drivers see only their own load's arrival time", async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(fakeRoute());
    const res = await driverEta().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'delivery' });
    await driverEta(otherDriverToken).expect(404);
    await driverEta(adminToken).expect(403);
  });

  it('shows no arrival time before acceptance or after delivery', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    for (const status of ['Assigned', 'Delivered']) {
      await Load.updateOne({ _id: load._id }, { $set: { status } });
      const res = await staffEta().expect(200);
      expect(res.body.data).toMatchObject({ available: false, reason: 'not_tracked' });
    }
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it('without a driver position, says so instead of guessing', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    await DriverLocation.deleteMany({ userId: driver._id });
    const res = await staffEta().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'no_driver_position' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it('when AWS refuses, shows no arrival time, explains it in admin stats, and tries again next time', async () => {
    process.env.AMAZON_LOCATION_ETA_ENABLED = 'true';
    mockRoutesSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const failed = await staffEta().expect(200);
    expect(failed.body.data).toMatchObject({ available: false, reason: 'unavailable' });
    expect(loadEtaHealthSnapshot()).toMatchObject({
      failed: 1,
      lastError: "AWS refused the request: the server isn't allowed to calculate routes or look up addresses yet.",
    });

    mockRoutesSend.mockResolvedValue(fakeRoute());
    const retried = await staffEta().expect(200);
    expect(retried.body.data.available).toBe(true);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
  });
});
