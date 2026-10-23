/**
 * The best route and arrival time (ETA) with live traffic, for the Driver
 * Tracker, the Transportation load page and the Driver Page.
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
import {
  MAX_ROUTE_LINE_POINTS,
  ageLoadRouteForTests,
  loadRouteHealthSnapshot,
  resetLoadRouteForTests,
} from '../src/services/loadRoute.service';

const DOMAIN = '@load-route-test.com';
const ORG_SLUG = 'load-route-test-org';
const DAY_MS = 24 * 60 * 60_000;
const DRIVER = { lat: 40.5, lng: -105.08 };
const PICKUP = { lat: 40.76, lng: -111.89 };
const DELIVERY = { lat: 39.75, lng: -104.99 };

let org: any;
let admin: any;
let adminToken: string;
let otherDispatcherToken: string;
let driver: any;
let driverToken: string;
let otherDriverToken: string;
let load: any;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const staffRoute = (token = adminToken) => request(app).get(`/api/driver-tracking/loads/${load._id}/route`).set(auth(token));
const driverRoute = (token = driverToken) => request(app).get(`/api/driver-tracking/my-loads/${load._id}/route`).set(auth(token));
const day = (offsetDays: number) => new Date(new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00.000Z');

/** Evenly spaced road points from one place to another, as [lng, lat]. */
const road = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, count = 20) =>
  Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    // A gentle bend so the line isn't perfectly straight.
    const bend = Math.sin(t * Math.PI) * 0.05;
    return [from.lng + (to.lng - from.lng) * t + bend, from.lat + (to.lat - from.lat) * t];
  });

type FakeLeg = { distance: number; duration: number; typical?: number; bestCase?: number; line: number[][]; incidents?: unknown[]; notices?: unknown[] };
const leg = ({ distance, duration, typical, bestCase, line, incidents = [], notices = [] }: FakeLeg) => ({
  Geometry: { LineString: line },
  VehicleLegDetails: {
    Summary: { Overview: { Distance: distance, Duration: duration, TypicalDuration: typical, BestCaseDuration: bestCase } },
    Incidents: incidents,
    Notices: notices,
  },
});

/** In-Transit: one 2-hour, 160 km leg to the delivery that takes 1.5 hours on empty roads. */
const toDelivery = () => ({
  Routes: [
    {
      Summary: { Distance: 160_000, Duration: 7200 },
      Legs: [
        leg({
          distance: 160_000, duration: 7200, typical: 6000, bestCase: 5400, line: road(DRIVER, DELIVERY),
          incidents: [
            { Description: 'Right lane closed', Severity: 'Low', Type: 'LaneRestriction' },
            { Description: 'Crash on I-25 northbound', Severity: 'Critical', Type: 'Accident' },
          ],
        }),
      ],
    },
  ],
});

/** Accepted: driver -> pickup (1 hour), then pickup -> delivery (8 hours). */
const throughPickup = () => ({
  Routes: [
    {
      Summary: { Distance: 900_000, Duration: 32_400 },
      Legs: [
        leg({ distance: 80_000, duration: 3600, typical: 3500, bestCase: 3400, line: road(DRIVER, PICKUP) }),
        leg({ distance: 820_000, duration: 28_800, typical: 28_000, bestCase: 27_000, line: road(PICKUP, DELIVERY, 40) }),
      ],
    },
  ],
});

async function moveDriver(position: { lat: number; lng: number }, secondsAgo = 5, accuracy: number | null = null) {
  await DriverLocation.updateOne(
    { userId: driver._id },
    { $set: { coords: position, locationRecordedAt: new Date(Date.now() - secondsAgo * 1000), accuracy } },
  );
}

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@load-route-test\.com$/ } }).select('_id')).map((u) => u._id);
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
  org = await Organization.create({ name: 'Load Route Test Org', slug: ORG_SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'Route Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  adminToken = tokenService.generateAccessToken(admin);
  const otherDispatcher = await User.create({
    email: `other${DOMAIN}`, name: 'Other Dispatcher', role: 'employee', organizationId: org._id,
    dispatcherOrganizationIds: [org._id], emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  otherDispatcherToken = tokenService.generateAccessToken(otherDispatcher);
  driver = await User.create({
    email: `driver${DOMAIN}`, name: 'Route Driver', role: 'driver',
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
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202', coordinates: DELIVERY },
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
    userId: driver._id, organizationId: org._id, status: 'on-route', coords: DRIVER,
    locationRecordedAt: new Date(Date.now() - 60_000), source: 'browser', speed: 25, isSharing: true,
  });
  mockRoutesSend.mockReset();
  mockPlacesSend.mockReset();
  resetLoadRouteForTests();
  delete process.env.AMAZON_LOCATION_ROUTES_ENABLED;
  delete process.env.AMAZON_LOCATION_ROUTE_PREFERENCE;
});

afterAll(async () => {
  delete process.env.AMAZON_LOCATION_ROUTES_ENABLED;
  delete process.env.AMAZON_LOCATION_ROUTE_PREFERENCE;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Best route and arrival time', () => {
  it('while switched off, shows nothing and never calls AWS', async () => {
    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'routes_off' });
    expect(res.body.data.route).toBeUndefined();
    expect(mockRoutesSend).not.toHaveBeenCalled();
    expect(mockPlacesSend).not.toHaveBeenCalled();
  });

  it('on the way to the delivery: the truck route with live traffic, incidents, deadline and the road line', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    const before = Date.now();

    const res = await staffRoute().expect(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      available: true,
      stop: 'delivery',
      optimizedFor: 'fastest',
      durationSeconds: 7200,
      distanceMeters: 160_000,
      traffic: { level: 'heavy', delaySeconds: 1800, comparedWithUsual: 'worse' },
      paceAdjustmentSeconds: 0,
      driver: { speedMph: 56, stoppedMinutes: null, positionAgeMinutes: 1, positionStale: false },
      deadline: { status: 'on_time' },
    });
    expect(data.incidents.map((incident: any) => incident.description)).toEqual(['Crash on I-25 northbound', 'Right lane closed']);
    expect(Date.parse(data.arrivalAt) - before).toBeGreaterThanOrEqual(7200 * 1000);
    expect(Date.parse(data.arrivalAt) - before).toBeLessThan(7200 * 1000 + 60_000);

    // The road line from the driver to the delivery; nothing planned after it.
    expect(data.route.origin).toEqual(DRIVER);
    expect(data.route.ahead.length).toBeGreaterThanOrEqual(2);
    expect(data.route.ahead[0]).toEqual([DRIVER.lng, DRIVER.lat]);
    expect(data.route.ahead[data.route.ahead.length - 1]).toEqual([DELIVERY.lng, DELIVERY.lat]);
    expect(data.route.later).toBeNull();
    expect(data.route.stops.delivery).toEqual(DELIVERY);

    // The map pin is used, so no address lookup; truck settings, live traffic and the road line are asked for.
    expect(mockPlacesSend).not.toHaveBeenCalled();
    const input = mockRoutesSend.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Origin: [DRIVER.lng, DRIVER.lat],
      Destination: [DELIVERY.lng, DELIVERY.lat],
      DepartNow: true,
      Traffic: { Usage: 'UseTrafficData' },
      TravelMode: 'Truck',
      TravelModeOptions: { Truck: { TruckType: 'Tractor', Height: 411, Length: 2286, GrossWeight: 36287, Trailer: { TrailerCount: 1 } } },
      OptimizeRoutingFor: 'FastestRoute',
      LegGeometryFormat: 'Simple',
    });
    expect(input.Waypoints).toBeUndefined();
    expect(loadRouteHealthSnapshot()).toMatchObject({ routesEnabled: true, computed: 1, failed: 0 });
  });

  it('before pickup: one request plans the drive to the pickup and the rest of the trip to the delivery', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted', 'pickupLocation.coordinates': PICKUP } });
    mockRoutesSend.mockResolvedValue(throughPickup());

    const res = await driverRoute().expect(200);
    const data = res.body.data;
    // The arrival time is for the pickup (the first leg only).
    expect(data).toMatchObject({ available: true, stop: 'pickup', durationSeconds: 3600, distanceMeters: 80_000 });
    expect(data.route.ahead[data.route.ahead.length - 1]).toEqual([PICKUP.lng, PICKUP.lat]);
    expect(data.route.later).toMatchObject({ distanceMeters: 820_000, durationSeconds: 28_800 });
    expect(data.route.later.line[0]).toEqual([PICKUP.lng, PICKUP.lat]);
    expect(data.route.later.line[data.route.later.line.length - 1]).toEqual([DELIVERY.lng, DELIVERY.lat]);
    expect(data.route.stops).toEqual({ pickup: PICKUP, delivery: DELIVERY });

    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
    const input = mockRoutesSend.mock.calls[0][0].input;
    expect(input.Waypoints).toEqual([{ Position: [PICKUP.lng, PICKUP.lat] }]);
    expect(input.Destination).toEqual([DELIVERY.lng, DELIVERY.lat]);
    await Load.updateOne({ _id: load._id }, { $unset: { 'pickupLocation.coordinates': 1 } });
  });

  it('plans the shortest distance instead when that is chosen, still for a truck', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    process.env.AMAZON_LOCATION_ROUTE_PREFERENCE = 'shortest';
    mockRoutesSend.mockResolvedValue(toDelivery());

    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: true, optimizedFor: 'shortest' });
    const input = mockRoutesSend.mock.calls[0][0].input;
    expect(input).toMatchObject({
      OptimizeRoutingFor: 'ShortestRoute',
      TravelMode: 'Truck',
      Traffic: { Usage: 'UseTrafficData' },
    });
    expect(loadRouteHealthSnapshot()).toMatchObject({ routePreference: 'shortest' });
  });

  it('reuses the route for 2 minutes for everyone looking at the load', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    const first = await staffRoute().expect(200);
    const second = await staffRoute().expect(200);
    const fromDriver = await driverRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
    expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
    expect(fromDriver.body.data.computedAt).toBe(first.body.data.computedAt);
  });

  it('plans a new route when the driver leaves the planned one, but not while they follow it', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute().expect(200);
    ageLoadRouteForTests(String(load._id), 60_000);

    // Moving along the planned road: the same route is kept.
    const onRoute = road(DRIVER, DELIVERY)[5];
    await moveDriver({ lat: onRoute[1], lng: onRoute[0] });
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);

    // About 10 km off the road: a new route from where the driver is now.
    await moveDriver({ lat: onRoute[1] + 0.09, lng: onRoute[0] });
    const rerouted = await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
    expect(mockRoutesSend.mock.calls[1][0].input.Origin).toEqual([onRoute[0], onRoute[1] + 0.09]);
    expect(rerouted.body.data.route.origin).toEqual({ lat: onRoute[1] + 0.09, lng: onRoute[0] });
    expect(loadRouteHealthSnapshot()).toMatchObject({ computed: 2, rerouted: 1 });
  });

  it('a rough location (worse than 100 m) never triggers a new route', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute().expect(200);
    ageLoadRouteForTests(String(load._id), 60_000);
    // Kilometres away, but from a 1.5 km Wi-Fi fix.
    const onRoute = road(DRIVER, DELIVERY)[5];
    await moveDriver({ lat: onRoute[1] + 0.09, lng: onRoute[0] }, 5, 1_500);
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
  });

  it("being off the route by less than the location's own error isn't leaving it", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute().expect(200);
    ageLoadRouteForTests(String(load._id), 60_000);
    // About 300 m east of the road: with a ±90 m reading it may still be on it.
    const onRoute = road(DRIVER, DELIVERY)[5];
    const beside = { lat: onRoute[1], lng: onRoute[0] + 0.0035 };
    await moveDriver(beside, 5, 90);
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
    // The same spot measured to ±10 m is clearly off the road.
    await moveDriver(beside, 3, 10);
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
  });

  it('says when the route starts from a rough location, and plans again from a precise one', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await moveDriver(DRIVER, 60, 1_500);
    const rough = await staffRoute().expect(200);
    expect(rough.body.data.driver).toMatchObject({ positionApproximate: true, positionAccuracyMeters: 1_500 });

    ageLoadRouteForTests(String(load._id), 60_000);
    await moveDriver(DRIVER, 5, 8);
    const precise = await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
    expect(precise.body.data.driver).toMatchObject({ positionApproximate: false, positionAccuracyMeters: 8 });
  });

  it('withholds a route that breaks a truck limit, and says which limit', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    const blocked = toDelivery();
    (blocked.Routes[0].Legs[0].VehicleLegDetails as any).Notices = [
      { Code: 'ViolatedVehicleRestriction', Impact: 'High', Details: [{ ViolatedConstraints: { MaxHeight: 381 } }] },
    ];
    mockRoutesSend.mockResolvedValue(blocked);

    const res = await staffRoute().expect(200);
    expect(res.body.data).toEqual({
      available: false,
      reason: 'no_safe_route',
      message: 'No truck route to the delivery was found that avoids a 12 ft 6 in height limit. Plan this drive in a truck navigation app.',
    });
    // The same answer is reused for a couple of minutes instead of asking Amazon again.
    await driverRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
    expect(loadRouteHealthSnapshot()).toMatchObject({ withheldForLimits: 1 });
  });

  it('shows the route with a warning when a truck limit may apply', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    const maybe = toDelivery();
    (maybe.Routes[0].Legs[0].VehicleLegDetails as any).Notices = [
      { Code: 'PotentialViolatedVehicleRestrictionUsage', Impact: 'Low', Details: [{ ViolatedConstraints: { MaxWeight: { Type: 'Gross', Value: 18_144 } } }] },
    ];
    mockRoutesSend.mockResolvedValue(maybe);

    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({
      available: true,
      safety: { status: 'check', limits: ['a 40,000 lb weight limit'], restOfTripUnsafe: false, restOfTripLimits: [] },
    });
    expect(res.body.data.route.ahead.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the rest of the trip off the map when only that part breaks a limit', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted', 'pickupLocation.coordinates': PICKUP } });
    const trip = throughPickup();
    (trip.Routes[0].Legs[1].VehicleLegDetails as any).Notices = [{ Code: 'ViolatedBlockedRoad', Impact: 'High', Details: [] }];
    mockRoutesSend.mockResolvedValue(trip);

    const res = await driverRoute().expect(200);
    expect(res.body.data).toMatchObject({
      available: true,
      stop: 'pickup',
      safety: { status: 'check', limits: [], restOfTripUnsafe: true, restOfTripLimits: ['a blocked road'] },
    });
    expect(res.body.data.route.ahead.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.route.later).toBeNull();
    await Load.updateOne({ _id: load._id }, { $unset: { 'pickupLocation.coordinates': 1 } });
  });

  it("ignores Amazon's notices that aren't about the truck, like toll data", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    const tolls = toDelivery();
    (tolls.Routes[0].Legs[0].VehicleLegDetails as any).Notices = [{ Code: 'TollsDataUnavailable', Impact: 'Low', Details: [] }];
    mockRoutesSend.mockResolvedValue(tolls);
    const res = await staffRoute().expect(200);
    expect(res.body.data.safety).toEqual({ status: 'ok', limits: [], restOfTripUnsafe: false, restOfTripLimits: [] });
  });

  it("doesn't plan again right away for a driver who just left the route", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute().expect(200);
    // Under 45 seconds since the route was planned: wait before paying for another.
    await moveDriver({ lat: DRIVER.lat + 0.2, lng: DRIVER.lng });
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
  });

  it('plans a new route when a stop is moved', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute().expect(200);
    await Load.updateOne({ _id: load._id }, { $set: { 'deliveryLocation.coordinates': { lat: 39.7, lng: -105.0 } } });
    await staffRoute().expect(200);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
    expect(mockRoutesSend.mock.calls[1][0].input.Destination).toEqual([-105.0, 39.7]);
    await Load.updateOne({ _id: load._id }, { $set: { 'deliveryLocation.coordinates': DELIVERY } });
  });

  it('keeps long road lines to a size the maps can draw quickly', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    const long = toDelivery();
    long.Routes[0].Legs[0].Geometry.LineString = road(DRIVER, DELIVERY, 6_000);
    mockRoutesSend.mockResolvedValue(long);
    const res = await staffRoute().expect(200);
    const line = res.body.data.route.ahead;
    expect(line.length).toBeLessThanOrEqual(MAX_ROUTE_LINE_POINTS);
    expect(line[0]).toEqual([DRIVER.lng, DRIVER.lat]);
    expect(line[line.length - 1]).toEqual([DELIVERY.lng, DELIVERY.lat]);
  });

  it('still shows the arrival time when Amazon Location sends no road line', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    const noLine = toDelivery();
    delete (noLine.Routes[0].Legs[0] as any).Geometry;
    mockRoutesSend.mockResolvedValue(noLine);
    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'delivery', durationSeconds: 7200, route: null });
  });

  it('heading to pickup without map pins, looks up each address once', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' }, $unset: { 'deliveryLocation.coordinates': 1 } });
    mockPlacesSend.mockImplementation(async (command: any) => ({
      ResultItems: [{ Position: command.input.QueryText.startsWith('1 Pickup') ? [PICKUP.lng, PICKUP.lat] : [DELIVERY.lng, DELIVERY.lat] }],
    }));
    mockRoutesSend.mockResolvedValue(throughPickup());

    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'pickup', deadline: { status: 'late' } });
    expect(mockPlacesSend).toHaveBeenCalledTimes(2);
    expect(mockPlacesSend.mock.calls.map((call) => call[0].input.QueryText)).toEqual([
      '1 Pickup St, Salt Lake City, UT 84101',
      '2 Delivery Ave, Denver, CO 80202',
    ]);
    expect(mockPlacesSend.mock.calls[0][0].input.Filter).toEqual({ IncludeCountries: ['USA'] });
    expect(mockRoutesSend.mock.calls[0][0].input.Waypoints).toEqual([{ Position: [PICKUP.lng, PICKUP.lat] }]);
    await Load.updateOne({ _id: load._id }, { $set: { 'deliveryLocation.coordinates': DELIVERY } });
  });

  it("when the delivery can't be placed yet, still routes to the pickup", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne(
      { _id: load._id },
      { $set: { status: 'Accepted', 'pickupLocation.coordinates': PICKUP }, $unset: { 'deliveryLocation.coordinates': 1 } },
    );
    mockPlacesSend.mockResolvedValue({ ResultItems: [] });
    mockRoutesSend.mockResolvedValue({ Routes: [{ Legs: [leg({ distance: 80_000, duration: 3600, line: road(DRIVER, PICKUP) })] }] });

    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'pickup', durationSeconds: 3600 });
    expect(res.body.data.route.later).toBeNull();
    const input = mockRoutesSend.mock.calls[0][0].input;
    expect(input.Waypoints).toBeUndefined();
    expect(input.Destination).toEqual([PICKUP.lng, PICKUP.lat]);
    await Load.updateOne(
      { _id: load._id },
      { $set: { 'deliveryLocation.coordinates': DELIVERY }, $unset: { 'pickupLocation.coordinates': 1 } },
    );
  });

  it("when the address lookup fails, says to try again (not that the address doesn't exist) and retries", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' } });
    mockPlacesSend.mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const failed = await staffRoute().expect(200);
    expect(failed.body.data).toMatchObject({ available: false, reason: 'unavailable' });
    expect(mockRoutesSend).not.toHaveBeenCalled();

    mockPlacesSend.mockResolvedValue({ ResultItems: [{ Position: [PICKUP.lng, PICKUP.lat] }] });
    mockRoutesSend.mockResolvedValue(throughPickup());
    const retried = await staffRoute().expect(200);
    expect(retried.body.data).toMatchObject({ available: true, stop: 'pickup' });
  });

  it("says when a stop's address isn't on the map", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await Load.updateOne({ _id: load._id }, { $set: { status: 'Accepted' } });
    mockPlacesSend.mockResolvedValue({ ResultItems: [] });
    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'no_destination' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it("says the driver is stopped and doesn't adjust for their pace while parked", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    const now = Date.now();
    await LoadTripPoint.insertMany(
      Array.from({ length: 11 }, (_, index) => ({
        loadId: load._id, organizationId: org._id, driverId: driver._id,
        lat: DRIVER.lat + (index % 2) * 0.0002, lng: DRIVER.lng,
        measuredAt: new Date(now - (10 - index) * 60_000), receivedAt: new Date(),
        accuracy: 8, speed: 0, source: 'browser', loadStatus: 'In-Transit',
      })),
    );

    const res = await staffRoute().expect(200);
    expect(res.body.data.driver.stoppedMinutes).toBeGreaterThanOrEqual(9);
    expect(res.body.data.paceAdjustmentSeconds).toBe(0);
    expect(res.body.data.durationSeconds).toBe(7200);
  });

  it('is shown only to the responsible dispatcher and organization admins', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    await staffRoute(otherDispatcherToken).expect(403);
    await staffRoute(driverToken).expect(403);
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it("lets drivers see only their own load's route", async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockResolvedValue(toDelivery());
    const res = await driverRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: true, stop: 'delivery' });
    await driverRoute(otherDriverToken).expect(404);
    await driverRoute(adminToken).expect(403);
  });

  it('shows no route before acceptance or after delivery, and reveals no position', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    for (const status of ['Assigned', 'Delivered']) {
      await Load.updateOne({ _id: load._id }, { $set: { status } });
      const res = await staffRoute(otherDispatcherToken).expect(200);
      expect(res.body.data).toEqual({ available: false, reason: 'not_tracked', message: expect.any(String) });
    }
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it('without a driver position, says so instead of guessing', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    await DriverLocation.deleteMany({ userId: driver._id });
    const res = await staffRoute().expect(200);
    expect(res.body.data).toMatchObject({ available: false, reason: 'no_driver_position' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it('when AWS refuses, shows nothing, explains it in the health numbers, and tries again next time', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    mockRoutesSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const failed = await staffRoute().expect(200);
    expect(failed.body.data).toMatchObject({ available: false, reason: 'unavailable' });
    expect(loadRouteHealthSnapshot()).toMatchObject({
      failed: 1,
      lastError: "AWS refused the request: the server isn't allowed to calculate routes or look up addresses yet.",
    });

    mockRoutesSend.mockResolvedValue(toDelivery());
    const retried = await staffRoute().expect(200);
    expect(retried.body.data.available).toBe(true);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
  });
});
