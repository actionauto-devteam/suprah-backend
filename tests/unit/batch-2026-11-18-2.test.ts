/**
 * Batch F (2026-11-18): a driver's home city (when the profile has no ZIP code
 * or saved position) is placed with the app's place lookup (Amazon Location,
 * or Google until Amazon is on), like ZIP positions; the OpenStreetMap search
 * is only the last resort. No outside service is called: stand-ins only.
 */
const mockPlaceLookupAvailable = jest.fn();
const mockPositionOf = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockAxiosGet = jest.fn();

jest.mock('../../src/services/placeLookup.service', () => ({
  placeLookupAvailable: () => mockPlaceLookupAvailable(),
  positionOf: (query: string) => mockPositionOf(query),
}));
jest.mock('../../src/services/cache.service', () => ({ cacheService: { get: mockCacheGet, set: mockCacheSet } }));
jest.mock('axios', () => ({ __esModule: true, default: { get: mockAxiosGet } }));

import { evaluateDriverRouteCompatibility } from '../../src/services/driverRouteMatching.service';

// Home base in Ogden (no ZIP, no saved position); pickup in Salt Lake City.
const profile = { homeBase: { city: 'Ogden', state: 'UT' }, serviceRadius: 250 };
const load = { pickupLocation: { city: 'Salt Lake City', state: 'UT', coordinates: [-111.891, 40.7608] } };
const OGDEN = { lat: 41.223, lng: -111.9738 };

beforeEach(() => {
  jest.clearAllMocks();
  mockCacheGet.mockResolvedValue(null);
  mockCacheSet.mockResolvedValue(undefined);
});

describe("a driver's home city", () => {
  it('is placed with the app place lookup, kept for a week, without asking OpenStreetMap', async () => {
    mockPlaceLookupAvailable.mockReturnValue(true);
    mockPositionOf.mockResolvedValue(OGDEN);
    const result = await evaluateDriverRouteCompatibility(profile, load);
    expect(mockPositionOf).toHaveBeenCalledWith('Ogden, UT');
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockCacheSet).toHaveBeenCalledWith('driver:home-base:ogden:ut', { lat: 41.223, lon: -111.9738 }, 86400 * 7);
    expect(result.serviceArea.status).toBe('within');
    expect(result.serviceArea.distanceFromHomeBaseToPickupMiles).toBeGreaterThan(25);
    expect(result.serviceArea.distanceFromHomeBaseToPickupMiles).toBeLessThan(40);
  });

  it('falls back to OpenStreetMap when the place lookup has no answer or none is set up', async () => {
    mockAxiosGet.mockResolvedValue({ data: [{ lat: '41.223', lon: '-111.9738' }] });

    mockPlaceLookupAvailable.mockReturnValue(true);
    mockPositionOf.mockResolvedValue(null);
    await expect(evaluateDriverRouteCompatibility(profile, load)).resolves.toMatchObject({ serviceArea: { status: 'within' } });
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);

    mockPlaceLookupAvailable.mockReturnValue(false);
    await expect(evaluateDriverRouteCompatibility(profile, load)).resolves.toMatchObject({ serviceArea: { status: 'within' } });
    expect(mockPositionOf).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it('a saved position comes first, and nothing found leaves the service area unknown', async () => {
    mockPlaceLookupAvailable.mockReturnValue(true);
    await evaluateDriverRouteCompatibility({ ...profile, homeBase: { ...profile.homeBase, coordinates: [-111.9738, 41.223] } }, load);
    expect(mockPositionOf).not.toHaveBeenCalled();

    mockPositionOf.mockResolvedValue(null);
    mockAxiosGet.mockResolvedValue({ data: [] });
    const result = await evaluateDriverRouteCompatibility(profile, load);
    expect(result.serviceArea.status).toBe('unknown');
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});
