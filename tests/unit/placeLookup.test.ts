/**
 * Driver area names, place pins and ZIP distances on Amazon Location
 * (2026-11-12): Amazon once AMAZON_LOCATION_PLACES_ENABLED is on, the previous
 * provider until then. Amazon and Google are never called: stand-ins only.
 */
const mockLookupAreaName = jest.fn();
const mockLookupPlace = jest.fn();
const mockGoogleConfigured = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockAxiosGet = jest.fn();

jest.mock('../../src/services/googleGeocoding.service', () => ({
  isGoogleGeocodingConfigured: mockGoogleConfigured,
  lookupAreaName: mockLookupAreaName,
  lookupPlace: mockLookupPlace,
}));
jest.mock('../../src/services/cache.service', () => ({ cacheService: { get: mockCacheGet, set: mockCacheSet } }));
jest.mock('axios', () => ({ __esModule: true, default: { get: mockAxiosGet } }));

import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { areaNameAt, areaNameFrom, positionOfPlace, positionOfZip, resetAmazonPlacesForTests } from '../../src/services/amazonPlaces.service';
import { areaNameOf, placeLookupProvider, positionOf, resetPlaceLookupForTests } from '../../src/services/placeLookup.service';
import { getCoordinatesFromZip } from '../../src/utils/calculations';

const ON = { enabled: true, region: 'us-west-2', perMinute: 60 };
const orem = {
  PlaceType: 'PostalCode',
  Title: '84058, Orem, UT, United States',
  Position: [-111.6946, 40.2969],
  Address: { Locality: 'Orem', Region: { Code: 'UT', Name: 'Utah' }, PostalCode: '84058', Country: { Code2: 'US' } },
};

let send: jest.SpyInstance;
const originalEnv = process.env.AMAZON_LOCATION_PLACES_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  resetAmazonPlacesForTests();
  resetPlaceLookupForTests();
  send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({ ResultItems: [orem] } as never);
  mockGoogleConfigured.mockReturnValue(true);
  mockCacheGet.mockResolvedValue(null);
});

afterEach(() => {
  send.mockRestore();
  if (originalEnv === undefined) delete process.env.AMAZON_LOCATION_PLACES_ENABLED;
  else process.env.AMAZON_LOCATION_PLACES_ENABLED = originalEnv;
});

describe('Amazon lookups', () => {
  it('finds where a place is, asking only in the US', async () => {
    await expect(positionOfPlace('Orem, UT', ON)).resolves.toEqual({ lat: 40.2969, lng: -111.6946 });
    const input = (send.mock.calls[0][0] as any).input;
    expect(input).toMatchObject({ QueryText: 'Orem, UT', MaxResults: 1, Filter: { IncludeCountries: ['USA'] }, IntendedUse: 'Storage' });
  });

  it('finds the middle of a ZIP code', async () => {
    await expect(positionOfZip('84058', ON)).resolves.toEqual({ lat: 40.2969, lng: -111.6946 });
    expect((send.mock.calls[0][0] as any).input).toMatchObject({
      QueryComponents: { PostalCode: '84058', Country: 'USA' },
      Filter: { IncludeCountries: ['USA'], IncludePlaceTypes: ['PostalCode'] },
    });
  });

  it('names the area around a position as "City, ST"', async () => {
    await expect(areaNameAt(40.297, -111.695, ON)).resolves.toBe('Orem, UT');
    expect(areaNameFrom({ city: '', state: 'UT' })).toBe('UT');
    expect(areaNameFrom({ city: '', state: '' })).toBeNull();
  });

  it('nothing found is null, not an error', async () => {
    send.mockResolvedValue({ ResultItems: [] } as never);
    await expect(positionOfPlace('nowhere', ON)).resolves.toBeNull();
    await expect(areaNameAt(0, 0, ON)).resolves.toBeNull();
  });
});

describe('which service answers', () => {
  it('Amazon once it is switched on, Google until then, nothing when neither is set up', () => {
    expect(placeLookupProvider({ AMAZON_LOCATION_PLACES_ENABLED: 'true' })).toBe('amazon');
    expect(placeLookupProvider({})).toBe('google');
    mockGoogleConfigured.mockReturnValue(false);
    expect(placeLookupProvider({})).toBeNull();
  });

  it('with Amazon on, Google is never asked, and answers are kept for an hour', async () => {
    process.env.AMAZON_LOCATION_PLACES_ENABLED = 'true';
    await expect(areaNameOf(40.29691, -111.69462)).resolves.toBe('Orem, UT');
    await expect(areaNameOf(40.29689, -111.69458)).resolves.toBe('Orem, UT');
    await expect(positionOf('Orem, UT')).resolves.toEqual({ lat: 40.2969, lng: -111.6946 });
    expect(send).toHaveBeenCalledTimes(2);
    // Rounded to about 100 m before asking.
    expect((send.mock.calls[0][0] as any).input.QueryPosition).toEqual([-111.695, 40.297]);
    expect(mockLookupAreaName).not.toHaveBeenCalled();
    expect(mockLookupPlace).not.toHaveBeenCalled();
  });

  it('with Amazon off, Google answers as before', async () => {
    delete process.env.AMAZON_LOCATION_PLACES_ENABLED;
    mockLookupAreaName.mockResolvedValue('Dallas, TX');
    mockLookupPlace.mockResolvedValue({ lat: 32.77, lng: -96.79 });
    await expect(areaNameOf(32.77, -96.79)).resolves.toBe('Dallas, TX');
    await expect(positionOf('Dallas, TX')).resolves.toEqual({ lat: 32.77, lng: -96.79 });
    expect(send).not.toHaveBeenCalled();
  });

  it('an Amazon problem shows no name rather than an error', async () => {
    process.env.AMAZON_LOCATION_PLACES_ENABLED = 'true';
    send.mockRejectedValue(new Error('AccessDeniedException'));
    await expect(areaNameOf(40.3, -111.7)).resolves.toBeNull();
    await expect(positionOf('Orem, UT')).resolves.toBeNull();
  });
});

describe('ZIP codes for quote distances', () => {
  it('Amazon first once it is on', async () => {
    process.env.AMAZON_LOCATION_PLACES_ENABLED = 'true';
    await expect(getCoordinatesFromZip('84058')).resolves.toEqual({ lat: 40.2969, lon: -111.6946 });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('if Amazon can not answer, the free services still do, so quotes keep working', async () => {
    process.env.AMAZON_LOCATION_PLACES_ENABLED = 'true';
    send.mockRejectedValue(new Error('ThrottlingException'));
    mockAxiosGet.mockResolvedValue({ data: { places: [{ latitude: '40.3', longitude: '-111.7' }] } });
    await expect(getCoordinatesFromZip('84058')).resolves.toEqual({ lat: 40.3, lon: -111.7 });
    expect(mockAxiosGet.mock.calls[0][0]).toContain('zippopotam.us/us/84058');
  });

  it('with Amazon off, nothing changes', async () => {
    delete process.env.AMAZON_LOCATION_PLACES_ENABLED;
    mockAxiosGet.mockResolvedValue({ data: { places: [{ latitude: '32.7', longitude: '-96.8' }] } });
    await expect(getCoordinatesFromZip('75201')).resolves.toEqual({ lat: 32.7, lon: -96.8 });
    expect(send).not.toHaveBeenCalled();
  });
});
