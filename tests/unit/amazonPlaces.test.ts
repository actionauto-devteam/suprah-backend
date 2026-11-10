/**
 * Amazon Location places for Create Load's "Pick on map" (2026-11-11).
 * Amazon is never called: the client's send is a stand-in.
 */
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import {
  addressAtPosition,
  amazonPlacesSettings,
  placeDetails,
  placeFields,
  resetAmazonPlacesForTests,
  searchPlaces,
  suggestionsFrom,
} from '../../src/services/amazonPlaces.service';

const ON = { enabled: true, region: 'us-west-2', perMinute: 60 };

const dealership = {
  PlaceId: 'amazon-place-1',
  PlaceType: 'PointOfInterest',
  Title: 'Action Auto Utah',
  Position: [-111.6946, 40.2969],
  Address: {
    Label: 'Action Auto Utah, 100 State St, Orem, UT 84058, United States',
    AddressNumber: '100',
    Street: 'State St',
    Locality: 'Orem',
    Region: { Code: 'UT', Name: 'Utah' },
    PostalCode: '84058',
    Country: { Code2: 'US', Code3: 'USA', Name: 'United States' },
  },
};

beforeEach(() => resetAmazonPlacesForTests());
afterEach(() => jest.restoreAllMocks());

describe('settings', () => {
  it('is off unless switched on, and uses the route region and cap', () => {
    expect(amazonPlacesSettings({})).toEqual({ enabled: false, region: 'us-west-2', perMinute: 60 });
    expect(amazonPlacesSettings({ AMAZON_LOCATION_PLACES_ENABLED: ' TRUE ', AMAZON_LOCATION_REGION: 'us-east-1', AMAZON_LOCATION_ROUTES_PER_MINUTE: '30' }))
      .toEqual({ enabled: true, region: 'us-east-1', perMinute: 30 });
  });
});

describe('reading an Amazon place into the load form', () => {
  it('a business keeps its name; the address, city, state, ZIP and position fill in', () => {
    expect(placeFields(dealership)).toEqual({
      name: 'Action Auto Utah', address: '100 State St', city: 'Orem', state: 'UT', zip: '84058', country: 'US',
      position: { lat: 40.2969, lng: -111.6946 }, exact: true,
    });
  });

  it('a plain street address has no business name; a city alone is not exact', () => {
    expect(placeFields({ ...dealership, PlaceType: 'PointAddress', Title: '100 State St' }).name).toBe('');
    const city = placeFields({ PlaceType: 'Locality', Title: 'Orem, UT', Address: { Locality: 'Orem', Region: { Code: 'UT' } } });
    expect(city).toMatchObject({ address: '', city: 'Orem', state: 'UT', exact: false, position: null });
  });

  it('search suggestions list places only', () => {
    expect(suggestionsFrom([
      { Title: 'Action Auto Utah', SuggestResultItemType: 'Place', Place: { PlaceId: 'amazon-place-1', Address: dealership.Address } },
      { Title: 'action auto', SuggestResultItemType: 'Query' },
      { Title: 'No id', SuggestResultItemType: 'Place', Place: {} },
    ])).toEqual([{ id: 'amazon-place-1', title: 'Action Auto Utah', label: dealership.Address.Label }]);
  });
});

describe('asking Amazon', () => {
  it('searches near the map, in the US', async () => {
    const send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({
      ResultItems: [{ Title: 'Action Auto Utah', SuggestResultItemType: 'Place', Place: { PlaceId: 'amazon-place-1' } }],
    } as never);
    expect(await searchPlaces('action auto', { lat: 40.3, lng: -111.7 }, ON)).toEqual([{ id: 'amazon-place-1', title: 'Action Auto Utah', label: '' }]);
    const input = (send.mock.calls[0][0] as any).input;
    expect(input).toMatchObject({ QueryText: 'action auto', BiasPosition: [-111.7, 40.3], Filter: { IncludeCountries: ['USA'] } });
  });

  it('asks for places and addresses that are saved on a load with the "Storage" use', async () => {
    const send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue(dealership as never);
    expect((await placeDetails('amazon-place-1', ON))?.name).toBe('Action Auto Utah');
    expect((send.mock.calls[0][0] as any).input).toMatchObject({ PlaceId: 'amazon-place-1', IntendedUse: 'Storage' });

    send.mockResolvedValue({ ResultItems: [{ ...dealership, PlaceType: 'PointAddress' }] } as never);
    expect(await addressAtPosition(40.2969, -111.6946, ON)).toMatchObject({ address: '100 State St', city: 'Orem', zip: '84058' });
    expect((send.mock.calls[1][0] as any).input).toMatchObject({ QueryPosition: [-111.6946, 40.2969], IntendedUse: 'Storage' });

    send.mockResolvedValue({ ResultItems: [] } as never);
    expect(await addressAtPosition(0, 0, ON)).toBeNull();
  });

  it('a failure or the safety cap gives a plain message', async () => {
    jest.spyOn(GeoPlacesClient.prototype, 'send').mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }) as never);
    await expect(searchPlaces('x', null, ON)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('Click the map') });

    resetAmazonPlacesForTests();
    jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({ ResultItems: [] } as never);
    const tight = { ...ON, perMinute: 1 };
    await searchPlaces('a', null, tight);
    await expect(searchPlaces('b', null, tight)).rejects.toMatchObject({ statusCode: 429 });
  });
});
