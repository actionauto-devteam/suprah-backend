/**
 * The arrival time customers see (decided 2026-11-05): the same route
 * dispatchers see, reused for up to 10 minutes for customers, never planned
 * again just because a customer is watching, and customers can only start part
 * of the per-minute cap. SIMULATED: Amazon Location and the database are
 * stand-ins; nothing is sent anywhere.
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
const chain = (value: () => unknown) => {
  const self: any = { select: () => self, sort: () => self, limit: () => self, lean: () => Promise.resolve(value()) };
  return self;
};
const mockDriverPosition = jest.fn();
jest.mock('../../src/models/DriverLocation.model', () => ({
  __esModule: true,
  default: { findOne: () => chain(() => mockDriverPosition()) },
}));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: { findOne: () => chain(() => null) } }));
jest.mock('../../src/models/LoadTripPoint.model', () => ({ __esModule: true, default: { find: () => chain(() => []) } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), fatal: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
  CUSTOMER_ROUTE_REUSE_MS,
  ageLoadRouteForTests,
  getCustomerLoadRoute,
  getLoadRoute,
  loadRouteHealthSnapshot,
  resetLoadRouteForTests,
} from '../../src/services/loadRoute.service';

const DRIVER = { lat: 40.5, lng: -105.08 };
const DELIVERY = { lat: 39.75, lng: -104.99 };
const road = (count = 10) =>
  Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return [DRIVER.lng + (DELIVERY.lng - DRIVER.lng) * t, DRIVER.lat + (DELIVERY.lat - DRIVER.lat) * t];
  });
const toDelivery = () => ({
  Routes: [
    {
      Summary: { Distance: 90_000, Duration: 3600 },
      Legs: [
        {
          Geometry: { LineString: road() },
          VehicleLegDetails: { Summary: { Overview: { Distance: 90_000, Duration: 3600, TypicalDuration: 3500, BestCaseDuration: 3300 } }, Incidents: [], Notices: [] },
        },
      ],
    },
  ],
});

let seq = 0;
const loadOnTheWay = () => ({
  _id: `load-${++seq}`,
  status: 'In-Transit',
  assignedDriverId: 'driver-1',
  pickupLocation: { address: '1 Main St', city: 'Orem', state: 'UT', zip: '84057', coordinates: { lat: 40.29, lng: -111.69 } },
  deliveryLocation: { address: '2 Oak St', city: 'Denver', state: 'CO', zip: '80202', coordinates: DELIVERY },
});

const ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  resetLoadRouteForTests();
  process.env = { ...ENV, AMAZON_LOCATION_ROUTES_ENABLED: 'true', AMAZON_LOCATION_ROUTES_PER_MINUTE: '10' };
  mockRoutesSend.mockImplementation(async () => toDelivery());
  mockDriverPosition.mockReturnValue({ coords: DRIVER, locationRecordedAt: new Date(Date.now() - 5_000), speed: 20, accuracy: 10 });
});
afterAll(() => {
  process.env = ENV;
});

describe("the customer's arrival time", () => {
  it('shows nothing while road routes are off, or before pickup', async () => {
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'false';
    expect(await getCustomerLoadRoute(loadOnTheWay())).toMatchObject({ available: false, reason: 'routes_off' });
    process.env.AMAZON_LOCATION_ROUTES_ENABLED = 'true';
    expect(await getCustomerLoadRoute({ ...loadOnTheWay(), status: 'Accepted' })).toMatchObject({ available: false, reason: 'not_tracked' });
    expect(mockRoutesSend).not.toHaveBeenCalled();
  });

  it("reuses the dispatcher's route instead of asking Amazon again", async () => {
    const load = loadOnTheWay();
    const staff = await getLoadRoute(load);
    expect(staff.available).toBe(true);
    const customer = await getCustomerLoadRoute(load);
    expect(customer).toBe(staff);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the same arrival time for up to 10 minutes, then asks again', async () => {
    const load = loadOnTheWay();
    const first = await getCustomerLoadRoute(load);
    expect(first.available).toBe(true);
    // Past the dispatchers' 2 minutes, but customers still reuse it.
    ageLoadRouteForTests(load._id, 5 * 60_000);
    expect(await getCustomerLoadRoute(load)).toBe(first);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);

    ageLoadRouteForTests(load._id, CUSTOMER_ROUTE_REUSE_MS);
    await getCustomerLoadRoute(load);
    expect(mockRoutesSend).toHaveBeenCalledTimes(2);
  });

  it("never plans the route again because the driver moved while only a customer watches", async () => {
    const load = loadOnTheWay();
    await getCustomerLoadRoute(load);
    ageLoadRouteForTests(load._id, 3 * 60_000);
    // Far off the planned road, with a newer, precise position.
    mockDriverPosition.mockReturnValue({ coords: { lat: 41.5, lng: -106 }, locationRecordedAt: new Date(), speed: 20, accuracy: 5 });
    await getCustomerLoadRoute(load);
    expect(mockRoutesSend).toHaveBeenCalledTimes(1);
  });

  it('lets customers start only half of the per-minute cap, keeping the rest for dispatchers', async () => {
    // A cap of 10 a minute: customers may start 5.
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await getCustomerLoadRoute(loadOnTheWay()));
    expect(results.filter((route) => route.available)).toHaveLength(5);
    expect(results.slice(5)).toEqual([
      expect.objectContaining({ available: false, reason: 'unavailable' }),
      expect.objectContaining({ available: false, reason: 'unavailable' }),
    ]);
    expect(loadRouteHealthSnapshot().skippedByCap).toBe(2);
    // Dispatchers still get a route.
    expect((await getLoadRoute(loadOnTheWay())).available).toBe(true);
  });

  it('keeps showing the last arrival time when customers are over their share', async () => {
    const load = loadOnTheWay();
    const first = await getCustomerLoadRoute(load);
    for (let i = 0; i < 4; i += 1) await getCustomerLoadRoute(loadOnTheWay());
    ageLoadRouteForTests(load._id, CUSTOMER_ROUTE_REUSE_MS);
    expect(await getCustomerLoadRoute(load)).toBe(first);
  });
});
