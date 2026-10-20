import { evaluateDriverRouteCompatibility } from '../../src/services/driverRouteMatching.service';

// Positions are given directly, so nothing is looked up on a map service.
const profile = { homeBase: { city: 'Denver', state: 'CO', coordinates: [-104.9903, 39.7392] } };
const load = { pickupLocation: { city: 'Mesa', state: 'AZ', coordinates: { lat: 33.4152, lng: -111.8315 } } };
const nearPickup = { lat: 33.4153, lon: -111.8316 };

describe('Pickup distance origins', () => {
  it("the driver's own live location still wins and stays exact", async () => {
    const live = { coords: { lat: 33.4484, lng: -112.074 }, isSharing: true, locationRecordedAt: new Date() };
    const signals = await evaluateDriverRouteCompatibility(profile, load, live, {
      coords: nearPickup,
      source: 'last_delivery',
      at: new Date(),
    });
    expect(signals.proximity.source).toBe('live_gps');
    expect(signals.proximity.approximate).toBeUndefined();
    expect(signals.proximity.distanceToPickupMiles).not.toBe(5);
  });

  it('a dispatch origin a few hundred feet away shows as 5 miles, never 0', async () => {
    const at = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const signals = await evaluateDriverRouteCompatibility(profile, load, null, {
      coords: nearPickup,
      source: 'last_delivery',
      at,
    });
    expect(signals.proximity).toMatchObject({
      source: 'last_delivery',
      approximate: true,
      distanceToPickupMiles: 5,
      lastSeenAt: at.toISOString(),
    });
  });

  it('without a dispatch origin nothing changes: home base, exact miles', async () => {
    const signals = await evaluateDriverRouteCompatibility(profile, load, null, null);
    expect(signals.proximity.source).toBe('home_base');
    expect(signals.proximity.approximate).toBeUndefined();
    expect(signals.proximity.distanceToPickupMiles).toBeGreaterThan(500);
  });
});
