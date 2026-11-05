/**
 * Where Dispatch's "miles from pickup" is measured from while they choose a
 * driver (decided 2026-11-05): any location the driver is sharing right now
 * (by choice or for a trip, under 5 minutes old), else a delivery in the last
 * 12 hours for a driver who isn't on a trip, else home base. Never for a
 * driver On Leave or In Shop, and only ever as a distance rounded to 5 miles.
 * Models are stand-ins; no database is used.
 */
const mockDistinct = jest.fn();
const mockAggregate = jest.fn();
const mockProfileFind = jest.fn();
const mockLocationFind = jest.fn();
const lean = (value: () => unknown) => ({ select: () => ({ lean: () => Promise.resolve().then(value) }) });

jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { distinct: (...args: unknown[]) => Promise.resolve(mockDistinct(...args)), aggregate: (p: unknown) => Promise.resolve(mockAggregate(p)) },
}));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: { find: (f: unknown) => lean(() => mockProfileFind(f)) } }));
jest.mock('../../src/models/DriverLocation.model', () => ({ __esModule: true, default: { find: (f: unknown) => lean(() => mockLocationFind(f)) } }));
jest.mock('../../src/utils/calculations', () => ({ __esModule: true, getCoordinatesFromZip: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { getDispatchProximityOrigins } from '../../src/services/driverDispatchProximity.service';
import { approximateMiles } from '../../src/services/driverRouteMatching.service';

const SHARING_BY_CHOICE = '64b0000000000000000000d1';
const SHARING_FOR_TRIP = '64b0000000000000000000d2';
const ON_LEAVE = '64b0000000000000000000d3';
const STALE = '64b0000000000000000000d4';
const STOPPED = '64b0000000000000000000d5';
const RECENT_DELIVERY = '64b0000000000000000000d6';
const ON_TRIP_NOT_SHARING = '64b0000000000000000000d7';
const NOW = new Date('2026-11-05T18:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const TUCSON = { lat: 32.2226, lng: -110.9747 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockDistinct.mockReturnValue([SHARING_FOR_TRIP, ON_TRIP_NOT_SHARING]);
  mockProfileFind.mockReturnValue([{ userId: ON_LEAVE }]);
  mockLocationFind.mockReturnValue([
    { userId: SHARING_BY_CHOICE, coords: TUCSON, isSharing: true, manualSharingOptIn: true, locationRecordedAt: minutesAgo(1) },
    { userId: SHARING_FOR_TRIP, coords: TUCSON, isSharing: true, manualSharingOptIn: false, locationRecordedAt: minutesAgo(2) },
    { userId: ON_LEAVE, coords: TUCSON, isSharing: true, locationRecordedAt: minutesAgo(1) },
    { userId: STALE, coords: TUCSON, isSharing: true, locationRecordedAt: minutesAgo(20) },
  ]);
  mockAggregate.mockReturnValue([
    { _id: RECENT_DELIVERY, deliveredAt: minutesAgo(120), deliveryLocation: { coordinates: { lat: 33.45, lng: -112.07 } } },
    { _id: ON_TRIP_NOT_SHARING, deliveredAt: minutesAgo(60), deliveryLocation: { coordinates: { lat: 33.45, lng: -112.07 } } },
  ]);
});

afterEach(() => jest.useRealTimers());

const all = [SHARING_BY_CHOICE, SHARING_FOR_TRIP, ON_LEAVE, STALE, STOPPED, RECENT_DELIVERY, ON_TRIP_NOT_SHARING];

describe('where the distance is measured from', () => {
  it('any location the driver is sharing now, by choice or for a trip', async () => {
    const origins = await getDispatchProximityOrigins(all, NOW);
    expect(origins.get(SHARING_BY_CHOICE)?.source).toBe('shared_location');
    expect(origins.get(SHARING_FOR_TRIP)?.source).toBe('shared_location');
    // Every sharing driver is looked at, not only those who chose to share.
    expect(mockLocationFind.mock.calls[0][0]).toMatchObject({ isSharing: { $ne: false } });
    expect(mockLocationFind.mock.calls[0][0]).not.toHaveProperty('manualSharingOptIn');
  });

  it('never a driver On Leave or In Shop, an old position, or one no longer shared', async () => {
    const origins = await getDispatchProximityOrigins(all, NOW);
    expect(origins.has(ON_LEAVE)).toBe(false);
    expect(origins.has(STALE)).toBe(false);
    expect(origins.has(STOPPED)).toBe(false);
  });

  it("a recent delivery only for a driver who isn't on a trip now", async () => {
    const origins = await getDispatchProximityOrigins(all, NOW);
    expect(origins.get(RECENT_DELIVERY)?.source).toBe('last_delivery');
    expect(origins.has(ON_TRIP_NOT_SHARING)).toBe(false);
  });
});

describe('the distance Dispatch sees', () => {
  it('is rounded to 5 miles, and "under 5" (0) when closer', () => {
    expect(approximateMiles(0.4)).toBe(0);
    expect(approximateMiles(4.9)).toBe(0);
    expect(approximateMiles(5)).toBe(5);
    expect(approximateMiles(7.4)).toBe(5);
    expect(approximateMiles(7.6)).toBe(10);
    expect(approximateMiles(21.2)).toBe(20);
    expect(approximateMiles(Number.NaN)).toBe(0);
  });
});
