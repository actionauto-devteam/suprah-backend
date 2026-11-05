/**
 * The live map on My Shipments: only the customer who follows the shipment,
 * only from pickup until delivery, with the driver's position, the delivery
 * spot and the arrival time, never anything else about the driver. Models and
 * the route service are stand-ins; no database is used.
 */
const chain = (value: () => unknown) => {
  const self: any = { select: () => self, sort: () => self, lean: () => Promise.resolve(value()) };
  return self;
};
const mockQuoteFindById = jest.fn();
const mockLoadFindOne = jest.fn();
const mockLocationFindOne = jest.fn();
const mockFollower = jest.fn();
const mockCustomerRoute = jest.fn();
jest.mock('../../src/models/Quote.model', () => ({ __esModule: true, default: { findById: (id: unknown) => chain(() => mockQuoteFindById(id)) } }));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: { findOne: (filter: unknown) => chain(() => mockLoadFindOne(filter)) } }));
jest.mock('../../src/models/DriverLocation.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => chain(() => mockLocationFindOne(filter)) },
}));
jest.mock('../../src/services/shipmentFollower', () => ({ __esModule: true, findQuoteFollower: (quote: unknown) => mockFollower(quote) }));
jest.mock('../../src/services/loadRoute.service', () => {
  const actual = jest.requireActual('../../src/services/loadRoute.service');
  return { ...actual, getCustomerLoadRoute: (load: unknown) => mockCustomerRoute(load) };
});
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { SHIPMENT_NOT_FOUND, customerShipmentTracking } from '../../src/services/customerShipmentTracking';

const CUSTOMER = '64b0000000000000000000c9';
const OTHER = '64b0000000000000000000c8';
const QUOTE = '64b0000000000000000000e1';
const ORG = '64b0000000000000000000a1';
const DELIVERY = { lat: 39.75, lng: -104.99 };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindById.mockReturnValue({ _id: QUOTE, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER });
  mockFollower.mockResolvedValue({ id: CUSTOMER, name: 'Maria', email: 'maria@example.com', kind: 'request' });
  mockLoadFindOne.mockReturnValue({
    _id: 'load-1', status: 'In-Transit', assignedDriverId: 'driver-1',
    deliveryLocation: { city: 'Denver', coordinates: DELIVERY },
  });
  mockLocationFindOne.mockReturnValue({ coords: { lat: 40.5, lng: -105.08 }, locationRecordedAt: new Date('2026-11-05T17:00:00Z'), accuracy: 12, speed: 28 });
  mockCustomerRoute.mockResolvedValue({ available: false, reason: 'routes_off', message: 'off' });
});

const notFound = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ statusCode: 404, message: SHIPMENT_NOT_FOUND });
};

describe('who sees the live map', () => {
  it("answers 'not found' for anyone else's shipment, an unlinked one, or a bad link", async () => {
    mockFollower.mockResolvedValueOnce({ id: OTHER, kind: 'shared' });
    await notFound(customerShipmentTracking(CUSTOMER, QUOTE));
    mockFollower.mockResolvedValueOnce(null);
    await notFound(customerShipmentTracking(CUSTOMER, QUOTE));
    mockQuoteFindById.mockReturnValueOnce(null);
    mockFollower.mockResolvedValueOnce(null);
    await notFound(customerShipmentTracking(CUSTOMER, QUOTE));
    await notFound(customerShipmentTracking(CUSTOMER, 'not-an-id'));
    expect(mockLocationFindOne).not.toHaveBeenCalled();
  });

  it("only looks at the quote's own dealership's load", async () => {
    await customerShipmentTracking(CUSTOMER, QUOTE);
    expect(mockLoadFindOne).toHaveBeenCalledWith({ quoteId: QUOTE, organizationId: ORG });
  });
});

describe('when the map is live', () => {
  it('shows nothing before pickup, after delivery or cancellation, or without a driver', async () => {
    for (const status of ['Posted', 'Assigned', 'Accepted', 'Delivered', 'Cancelled']) {
      mockLoadFindOne.mockReturnValueOnce({ _id: 'load-1', status, assignedDriverId: 'driver-1' });
      expect(await customerShipmentTracking(CUSTOMER, QUOTE)).toEqual({ live: false, driver: null, delivery: null, eta: null, route: null });
    }
    mockLoadFindOne.mockReturnValueOnce({ _id: 'load-1', status: 'In-Transit', assignedDriverId: null });
    expect((await customerShipmentTracking(CUSTOMER, QUOTE)).live).toBe(false);
    mockLoadFindOne.mockReturnValueOnce(null);
    expect((await customerShipmentTracking(CUSTOMER, QUOTE)).live).toBe(false);
    expect(mockLocationFindOne).not.toHaveBeenCalled();
  });

  it("shows the driver's position and the delivery spot, without an arrival time while routes are off", async () => {
    const view = await customerShipmentTracking(CUSTOMER, QUOTE);
    expect(view).toEqual({
      live: true,
      driver: { position: { lat: 40.5, lng: -105.08 }, measuredAt: '2026-11-05T17:00:00.000Z', approximate: false },
      delivery: DELIVERY,
      eta: null,
      route: null,
    });
    expect(mockLocationFindOne).toHaveBeenCalledWith({ userId: 'driver-1' });
    // Never the speed, breaks or anything else about the driver.
    expect(JSON.stringify(view)).not.toMatch(/speed|stopped|accuracy/i);
  });

  it('says when the position is rough, and copes with no position yet', async () => {
    mockLocationFindOne.mockReturnValueOnce({ coords: { lat: 40.5, lng: -105.08 }, locationRecordedAt: new Date(), accuracy: 2500 });
    expect((await customerShipmentTracking(CUSTOMER, QUOTE)).driver?.approximate).toBe(true);
    mockLocationFindOne.mockReturnValueOnce(null);
    expect((await customerShipmentTracking(CUSTOMER, QUOTE))).toMatchObject({ live: true, driver: null, delivery: DELIVERY });
  });

  it('adds the arrival time, "Running late" and the road when there is a route', async () => {
    mockCustomerRoute.mockResolvedValueOnce({
      available: true,
      arrivalAt: '2026-11-05T19:40:00.000Z',
      computedAt: '2026-11-05T17:01:00.000Z',
      deadline: { day: '2026-11-05', status: 'at_risk' },
      driver: { stoppedMinutes: 12, speedMph: 0 },
      traffic: { level: 'heavy' },
      route: { ahead: [[-105.08, 40.5], [-104.99, 39.75]], stops: { pickup: { lat: 1, lng: 1 }, delivery: { lat: 39.7501, lng: -104.9901 } } },
    });
    const view = await customerShipmentTracking(CUSTOMER, QUOTE);
    expect(view.eta).toEqual({ arrivalAt: '2026-11-05T19:40:00.000Z', runningLate: true, updatedAt: '2026-11-05T17:01:00.000Z' });
    expect(view.route).toEqual([[-105.08, 40.5], [-104.99, 39.75]]);
    expect(view.delivery).toEqual({ lat: 39.7501, lng: -104.9901 });
    expect(JSON.stringify(view)).not.toMatch(/stopped|traffic|pickup/i);

    mockCustomerRoute.mockResolvedValueOnce({
      available: true, arrivalAt: '2026-11-05T19:40:00.000Z', computedAt: '2026-11-05T17:01:00.000Z',
      deadline: { day: '2026-11-06', status: 'on_time' }, route: null,
    });
    const onTime = await customerShipmentTracking(CUSTOMER, QUOTE);
    expect(onTime.eta?.runningLate).toBe(false);
    expect(onTime.route).toBeNull();
    expect(onTime.delivery).toEqual(DELIVERY);
  });

  it('still shows the map when the route lookup fails', async () => {
    mockCustomerRoute.mockRejectedValueOnce(new Error('aws down'));
    expect(await customerShipmentTracking(CUSTOMER, QUOTE)).toMatchObject({ live: true, eta: null, route: null });
  });
});
