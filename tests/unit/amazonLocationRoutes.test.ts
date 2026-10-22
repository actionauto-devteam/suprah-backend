import { getAmazonLocationConfig } from '../../src/config/amazonLocation';
import { distanceToLineMeters } from '../../src/services/routeTrace.service';

describe('Amazon Location settings', () => {
  it('is off unless switched on, with a car-hauler truck profile', () => {
    expect(getAmazonLocationConfig({})).toEqual({
      routesEnabled: false,
      region: 'us-west-2',
      travelMode: 'Truck',
      routesPerMinute: 60,
      truck: { heightCm: 411, lengthCm: 2286, grossWeightKg: 36_287 },
    });
    expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTES_ENABLED: 'TRUE ' }).routesEnabled).toBe(true);
    expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTES_ENABLED: 'yes' }).routesEnabled).toBe(false);
  });

  it('ignores settings outside safe limits', () => {
    const config = getAmazonLocationConfig({
      AMAZON_LOCATION_REGION: 'not a region',
      AMAZON_LOCATION_ROUTES_PER_MINUTE: '100000',
      AMAZON_LOCATION_TRUCK_HEIGHT_CM: '-5',
      AMAZON_LOCATION_TRAVEL_MODE: 'boat',
    });
    expect(config).toMatchObject({ region: 'us-west-2', routesPerMinute: 60, travelMode: 'Truck', truck: { heightCm: 411 } });
    expect(getAmazonLocationConfig({ AWS_REGION: 'us-east-1', AMAZON_LOCATION_TRAVEL_MODE: 'car' })).toMatchObject({
      region: 'us-east-1',
      travelMode: 'Car',
    });
  });
});

describe('Distance from a point to a route line', () => {
  const line = [
    { lat: 40, lng: -105 },
    { lat: 40, lng: -104.9 },
    { lat: 40.1, lng: -104.9 },
  ];

  it('is zero on the line and grows with the distance from it', () => {
    expect(distanceToLineMeters({ lat: 40, lng: -104.95 }, line)).toBeLessThan(1);
    // 0.01 degrees of latitude is about 1.1 km.
    const off = distanceToLineMeters({ lat: 40.01, lng: -104.95 }, line);
    expect(off).toBeGreaterThan(1_000);
    expect(off).toBeLessThan(1_200);
  });

  it('measures to the nearest part of the line, including its corners', () => {
    expect(distanceToLineMeters({ lat: 40.05, lng: -104.9 }, line)).toBeLessThan(1);
    expect(distanceToLineMeters({ lat: 39.99, lng: -104.89 }, line)).toBeGreaterThan(1_000);
  });

  it('handles empty and single-point lines', () => {
    expect(distanceToLineMeters({ lat: 40, lng: -105 }, [])).toBe(Infinity);
    expect(distanceToLineMeters({ lat: 40, lng: -105 }, [{ lat: 40, lng: -105 }])).toBeLessThan(1);
  });
});
