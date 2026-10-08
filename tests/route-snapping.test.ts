/**
 * Driver Tracker route line: cleaned GPS readings, and road snapping with
 * Amazon Location Service when it's switched on.
 *
 * SIMULATED: Amazon Location is never called. The AWS client is replaced by a
 * fake that returns a made-up road line, so no AWS account or credentials are
 * needed. A check against the real service is still required once AWS is set up.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-geo-routes', () => ({
  GeoRoutesClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  SnapToRoadsCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import DriverProfile from '../src/models/DriverProfile.model';
import Load from '../src/models/Load.model';
import LoadTripPoint from '../src/models/LoadTripPoint.model';
import SnappedRouteCache from '../src/models/SnappedRouteCache.model';
import tokenService from '../src/services/token.service';
import { amazonLocationRoutesHealthSnapshot, resetAmazonLocationRoutesForTests } from '../src/services/amazonLocationRoutes.service';
import { routePieceStart, ROUTE_PIECE_MS } from '../src/services/routeLine.service';

const DOMAIN = '@route-snapping-test.com';
const ORG_SLUG = 'route-snapping-test-org';

let org: any;
let admin: any;
let adminToken: string;
let driver: any;
let load: any;

const trail = () =>
  request(app).get(`/api/driver-tracking/drivers/${driver._id}/recent-trail`).set({ Authorization: `Bearer ${adminToken}` });

/** Readings every 10 s heading north, inside the current 15-minute piece. */
async function seedReadings(count: number, extra: (index: number) => Record<string, unknown> = () => ({})) {
  const start = Math.max(routePieceStart(Date.now()), Date.now() - 10 * 60_000);
  const rows = Array.from({ length: count }, (_, index) => ({
    loadId: load._id,
    organizationId: org._id,
    driverId: driver._id,
    lat: 39.7 + index * 0.0005,
    lng: -105.0,
    measuredAt: new Date(start + index * 10_000),
    receivedAt: new Date(),
    accuracy: 8,
    speed: 5,
    heading: 0,
    source: 'app',
    loadStatus: 'Accepted',
    ...extra(index),
  }));
  await LoadTripPoint.insertMany(rows);
  return rows;
}

const fakeRoad = (points: number[][]) => ({
  SnappedGeometry: { LineString: points.map(([lng, lat]) => [lng + 0.0001, lat]) },
  SnappedGeometryFormat: 'Simple',
  SnappedTracePoints: [],
  Notices: [],
  PricingBucket: 'test',
});

async function cleanUp() {
  const ids = (await User.find({ email: { $regex: /@route-snapping-test\.com$/ } }).select('_id')).map((u) => u._id);
  const orgs = (await Organization.find({ slug: ORG_SLUG }).select('_id')).map((o) => o._id);
  await LoadTripPoint.deleteMany({ organizationId: { $in: orgs } });
  await Load.deleteMany({ organizationId: { $in: orgs } });
  await DriverProfile.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await Organization.deleteMany({ _id: { $in: orgs } });
  await SnappedRouteCache.deleteMany({});
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  org = await Organization.create({ name: 'Route Snapping Test Org', slug: ORG_SLUG, status: 'active' });
  admin = await User.create({
    email: `admin${DOMAIN}`, name: 'Route Admin', role: 'admin', organizationId: org._id,
    emailVerified: true, onboardingCompleted: true, isActive: true,
  });
  adminToken = tokenService.generateAccessToken(admin);
  driver = await User.create({
    email: `driver${DOMAIN}`, name: 'Route Driver', role: 'driver',
    emailVerified: true, onboardingCompleted: true, isActive: true, isApproved: true,
  });
  await DriverProfile.create({ userId: driver._id, maxVehicleCapacity: 5, operationalStatus: 'active' });
  load = await Load.create({
    organizationId: org._id, createdBy: admin._id, dispatchOwnerId: admin._id, assignedDriverId: driver._id,
    postType: 'assign-carrier', status: 'Accepted', acceptedAt: new Date(Date.now() - 6 * 60 * 60_000),
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
  });
}, 60000);

beforeEach(async () => {
  await LoadTripPoint.deleteMany({ loadId: load._id });
  await SnappedRouteCache.deleteMany({});
  mockSend.mockReset();
  resetAmazonLocationRoutesForTests();
  delete process.env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED;
});

afterAll(async () => {
  delete process.env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Driver Tracker route line', () => {
  it('while snapping is off, draws the cleaned GPS readings and never calls AWS', async () => {
    await seedReadings(5, (index) =>
      index === 2
        ? { lat: 45.0 } // a glitch far away
        : {},
    );
    // The same moment stored once per load is drawn once; a rough browser reading is left out.
    await LoadTripPoint.create({
      loadId: load._id, organizationId: org._id, driverId: driver._id, lat: 41, lng: -104,
      measuredAt: new Date(Date.now() - 60_000), receivedAt: new Date(), accuracy: 40_000, source: 'browser', loadStatus: 'Accepted',
    });

    const res = await trail().expect(200);
    expect(res.body.data.routeSource).toBe('gps');
    expect(res.body.data.points.map((p: any) => Number(p.lat.toFixed(4)))).toEqual([39.7, 39.7005, 39.7015, 39.702]);
    expect(res.body.data.throughMeasuredAt).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('when switched on, follows the roads, sends truck readings in km/h, and reuses the saved match', async () => {
    process.env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED = 'true';
    await seedReadings(4);
    mockSend.mockImplementation(async (command: any) =>
      fakeRoad(command.input.TracePoints.map((point: any) => point.Position)),
    );

    const first = await trail().expect(200);
    expect(first.body.data.routeSource).toBe('roads');
    expect(first.body.data.points[0]).toEqual({ lat: 39.7, lng: -104.9999 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input).toMatchObject({ TravelMode: 'Truck', SnappedGeometryFormat: 'Simple' });
    expect(input.TracePoints[0]).toMatchObject({ Position: [-105, 39.7], Speed: 18, Heading: 0 });

    // Nothing new: the saved match is used, AWS isn't called again.
    await trail().expect(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(amazonLocationRoutesHealthSnapshot()).toMatchObject({ snapped: 1, cacheHits: 1 });
  });

  it('a finished 15-minute piece is matched once; only the piece still being driven is matched again', async () => {
    process.env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED = 'true';
    mockSend.mockImplementation(async (command: any) =>
      fakeRoad(command.input.TracePoints.map((point: any) => point.Position)),
    );
    const currentPiece = routePieceStart(Date.now());
    const earlier = currentPiece - ROUTE_PIECE_MS;
    const at = (ms: number, lat: number) => ({
      loadId: load._id, organizationId: org._id, driverId: driver._id, lat, lng: -105,
      measuredAt: new Date(ms), receivedAt: new Date(), accuracy: 8, source: 'app', loadStatus: 'Accepted',
    });
    await LoadTripPoint.insertMany([at(earlier + 60_000, 39.70), at(earlier + 120_000, 39.701), at(currentPiece + 1_000, 39.702)]);

    await trail().expect(200);
    expect(mockSend).toHaveBeenCalledTimes(2);

    // A new reading in the current piece: only that piece goes to AWS again.
    await LoadTripPoint.create(at(Math.min(Date.now() - 1_000, currentPiece + 30_000), 39.70205));
    const res = await trail().expect(200);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(res.body.data.routeSource).toBe('roads');
  });

  it('falls back to the GPS line in plain words when AWS refuses', async () => {
    process.env.AMAZON_LOCATION_SNAP_TO_ROADS_ENABLED = 'true';
    await seedReadings(3);
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const res = await trail().expect(200);
    expect(res.body.data.routeSource).toBe('gps');
    expect(res.body.data.points).toHaveLength(3);
    expect(amazonLocationRoutesHealthSnapshot()).toMatchObject({
      failed: 1,
      lastError: "AWS refused the request: the server isn't allowed to use Snap to Roads yet.",
    });
  });
});
