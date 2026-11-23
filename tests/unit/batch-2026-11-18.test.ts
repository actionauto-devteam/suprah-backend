/**
 * Service Network pins (2026-11-18): a partner location's map pin comes only
 * from a match to the house itself, in the store's state and ZIP code (US
 * Census, then Amazon where it's on), and the correction script changes only
 * pins. The Census and Amazon are never called: stand-ins only.
 */
import fs from 'fs';
import path from 'path';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { positionOfStreetAddress, resetAmazonPlacesForTests } from '../../src/services/amazonPlaces.service';
import {
  censusPin,
  censusPinFrom,
  findStorePin,
  oneLineAddress,
  planStorePin,
  SAME_SPOT_METERS,
  usablePin,
} from '../../src/services/storeLocationPin.service';

const ON = { enabled: true, region: 'us-west-2', perMinute: 60 };
const OFF = { ...ON, enabled: false };
const store = { address: '1850 W. 4100 S.', city: 'West Valley', state: 'UT', zipCode: '84119' };
const censusBody = (state = 'UT', zip = '84119', x: unknown = -111.941769, y: unknown = 40.68218) => ({
  result: {
    addressMatches: [
      { coordinates: { x, y }, addressComponents: { state, zip }, matchedAddress: '1850 W 4100 S, WEST VALLEY, UT, 84119' },
    ],
  },
});
const reply = (body: unknown, status = 200) =>
  jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
const amazonPlace = (PlaceType: string, Region = 'UT', PostalCode = '84119-1234') => ({
  PlaceType,
  Position: [-111.9418, 40.6822],
  Address: { AddressNumber: '1850', Street: 'W 4100 S', Locality: 'West Valley City', Region: { Code: Region }, PostalCode, Country: { Code2: 'US' } },
});

let send: jest.SpyInstance;
beforeEach(() => {
  resetAmazonPlacesForTests();
  send = jest.spyOn(GeoPlacesClient.prototype, 'send').mockResolvedValue({ ResultItems: [amazonPlace('PointAddress')] } as never);
});
afterEach(() => send.mockRestore());

describe('a usable pin', () => {
  it('is two numbers inside the US, not 0,0', () => {
    expect(usablePin([-111.94, 40.68])).toEqual([-111.94, 40.68]);
    expect(usablePin([0, 0])).toBeNull();
    expect(usablePin([])).toBeNull();
    expect(usablePin(undefined)).toBeNull();
    expect(usablePin([40.68, -111.94])).toBeNull(); // latitude and longitude swapped
    expect(usablePin(['-111.94', 40.68])).toBeNull();
    expect(usablePin([Number.NaN, 40.68])).toBeNull();
    expect(usablePin([-111.94, 40.68, 0])).toBeNull();
    expect(usablePin([151.2, -33.87])).toBeNull(); // outside the US
  });
});

describe('the US Census lookup', () => {
  it('sends the one-line address and gives the house pin in the same state and ZIP code', async () => {
    const fetchImpl = reply(censusBody());
    await expect(censusPin(store, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      coordinates: [-111.941769, 40.68218],
      source: 'census',
      matched: '1850 W 4100 S, WEST VALLEY, UT, 84119',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('onelineaddress?address=1850%20W.%204100%20S.%2C%20West%20Valley%2C%20UT%2084119&');
    expect(init.signal).toBeDefined();
    expect(oneLineAddress({ ...store, address: ' 1850  W. 4100 S. ' })).toBe('1850 W. 4100 S., West Valley, UT 84119');
  });

  it('ignores a match in another state or ZIP code, a bad position, or no match', () => {
    expect(censusPinFrom(censusBody('ID'), store)).toBeNull();
    expect(censusPinFrom(censusBody('UT', '84120'), store)).toBeNull();
    expect(censusPinFrom(censusBody('UT', '84119', 0, 0), store)).toBeNull();
    expect(censusPinFrom(censusBody('UT', '84119', 'x', null), store)).toBeNull();
    expect(censusPinFrom({ result: { addressMatches: [] } }, store)).toBeNull();
    expect(censusPinFrom(null, store)).toBeNull();
    expect(censusPinFrom(censusBody(), { ...store, zipCode: '' })).toBeNull();
  });

  it('a failed answer is an error, not "not found"', async () => {
    await expect(censusPin(store, reply({}, 503) as unknown as typeof fetch)).rejects.toThrow('503');
  });
});

describe('the Amazon house match', () => {
  it('gives a house-level match only, asking in the US with the Storage use', async () => {
    await expect(positionOfStreetAddress('1850 W. 4100 S., West Valley, UT 84119', ON)).resolves.toMatchObject({
      position: { lat: 40.6822, lng: -111.9418 },
      state: 'UT',
      zip: '84119-1234',
    });
    expect((send.mock.calls[0][0] as any).input).toMatchObject({
      QueryText: '1850 W. 4100 S., West Valley, UT 84119',
      MaxResults: 1,
      Filter: { IncludeCountries: ['USA'] },
      IntendedUse: 'Storage',
    });
    send.mockResolvedValue({ ResultItems: [amazonPlace('InterpolatedAddress')] } as never);
    await expect(positionOfStreetAddress('x', ON)).resolves.not.toBeNull();
  });

  it('a street, ZIP code or city match is not a pin', async () => {
    for (const type of ['Street', 'PostalCode', 'Locality', 'PointOfInterest']) {
      send.mockResolvedValue({ ResultItems: [amazonPlace(type)] } as never);
      await expect(positionOfStreetAddress('x', ON)).resolves.toBeNull();
    }
    send.mockResolvedValue({ ResultItems: [] } as never);
    await expect(positionOfStreetAddress('x', ON)).resolves.toBeNull();
  });
});

describe('finding a store pin', () => {
  it('uses the Census first and asks Amazon only when the Census has no house match', async () => {
    const found = await findStorePin(store, { fetchImpl: reply(censusBody()) as unknown as typeof fetch, amazon: ON });
    expect(found).toMatchObject({ pin: { source: 'census' }, failed: [] });
    expect(send).not.toHaveBeenCalled();

    const fromAmazon = await findStorePin(store, { fetchImpl: reply({ result: { addressMatches: [] } }) as unknown as typeof fetch, amazon: ON });
    expect(fromAmazon).toEqual({
      pin: { coordinates: [-111.9418, 40.6822], source: 'amazon', matched: '1850 W 4100 S, West Valley City, UT, 84119-1234' },
      failed: [],
    });
  });

  it('Amazon stays off unless switched on, and its match must be in the same state and ZIP code', async () => {
    const none = reply({ result: { addressMatches: [] } }) as unknown as typeof fetch;
    await expect(findStorePin(store, { fetchImpl: none, amazon: OFF })).resolves.toEqual({ pin: null, failed: [] });
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValue({ ResultItems: [amazonPlace('PointAddress', 'NV')] } as never);
    await expect(findStorePin(store, { fetchImpl: none, amazon: ON })).resolves.toEqual({ pin: null, failed: [] });
    send.mockResolvedValue({ ResultItems: [amazonPlace('PointAddress', 'UT', '84120')] } as never);
    await expect(findStorePin(store, { fetchImpl: none, amazon: ON })).resolves.toEqual({ pin: null, failed: [] });
  });

  it('reports failed lookups so they can be run again', async () => {
    const down = jest.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    await expect(findStorePin(store, { fetchImpl: down, amazon: OFF })).resolves.toEqual({ pin: null, failed: ['census'] });
    send.mockRejectedValue(new Error('AccessDenied'));
    await expect(findStorePin(store, { fetchImpl: down, amazon: ON })).resolves.toEqual({ pin: null, failed: ['census', 'amazon'] });
  });
});

describe('what happens to a saved pin', () => {
  const pin = { coordinates: [-111.941769, 40.68218] as [number, number], source: 'census' as const, matched: 'm' };

  it('keeps a pin already at the house, and moves one that is off', () => {
    expect(planStorePin([-111.9418, 40.6822], { pin, failed: [] })).toEqual({ action: 'keep' });
    const off = planStorePin([-111.9, 40.66], { pin, failed: [] });
    expect(off).toMatchObject({ action: 'move', to: pin.coordinates, source: 'census' });
    expect((off as { movedMeters: number }).movedMeters).toBeGreaterThan(SAME_SPOT_METERS);
    expect(planStorePin([0, 0], { pin, failed: [] })).toMatchObject({ action: 'move', movedMeters: null });
    expect(planStorePin([], { pin, failed: [] })).toMatchObject({ action: 'move', movedMeters: null });
  });

  it('without a house match the pin stays and the store is listed to check', () => {
    expect(planStorePin([-111.9, 40.66], { pin: null, failed: [] })).toEqual({ action: 'check', reason: 'no-match', hasPin: true });
    expect(planStorePin([0, 0], { pin: null, failed: [] })).toEqual({ action: 'check', reason: 'no-match', hasPin: false });
    expect(planStorePin([0, 0], { pin: null, failed: ['census'] })).toEqual({ action: 'check', reason: 'lookup-failed', hasPin: false });
  });
});

describe('the scripts', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src/scripts', rel), 'utf8');

  it('the correction script is a dry run unless asked, and only changes pins', () => {
    const script = read('fix-service-location-pins.ts');
    expect(script.indexOf("import '../config/productionDbGuard';")).toBeLessThan(script.indexOf('import mongoose'));
    expect(script).toContain("const APPLY = process.argv.includes('--apply');");
    expect(script).toMatch(/if \(APPLY && moves\.length\)/);
    expect(script).toContain("update: { $set: { 'location.type': 'Point', 'location.coordinates': move.to } }");
    expect(script).toContain("filter: Array.isArray(move.from)");
    expect(script).not.toMatch(/delete(Many|One)|insertMany|\$unset|drop\(/);
  });

  it('the import uses the house match, not the OpenStreetMap search, and keeps its database guard first', () => {
    const script = read('import-jiffy-locations.ts');
    expect(script).not.toMatch(/nominatim|openstreetmap/i);
    expect(script).toContain("const found = await findStorePin({ address, city, state: 'UT', zipCode });");
    expect(script.trimStart().startsWith("import '../config/productionDbGuard';")).toBe(true);
  });
});
