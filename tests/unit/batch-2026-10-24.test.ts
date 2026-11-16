// Tests from the October 24, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import { getAmazonLocationConfig } from '../../src/config/amazonLocation';
import { distanceToLineMeters, TracePoint, cleanTrace, distanceMeters, simplifyLine } from '../../src/services/routeTrace.service';
import { deadlineStatus, endOfBusinessDayMs, loadDateDay, paceAdjustmentSeconds, stoppedForMs, trafficLevel } from '../../src/services/etaMath.service';
import { legSafety, listOf, unrecognizedNoticeCodes } from '../../src/services/routeSafety.service';

describe('amazonLocationRoutes.test.ts', () => {
  describe('Amazon Location settings', () => {
    it('is off unless switched on, with a car-hauler truck profile', () => {
      expect(getAmazonLocationConfig({})).toEqual({
        routesEnabled: false,
        region: 'us-west-2',
        travelMode: 'Truck',
        routePreference: 'fastest',
        routesPerMinute: 60,
        truck: { heightCm: 411, lengthCm: 2286, grossWeightKg: 36_287 },
      });
      expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTES_ENABLED: 'TRUE ' }).routesEnabled).toBe(true);
      expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTES_ENABLED: 'yes' }).routesEnabled).toBe(false);
    });

    it('plans the fastest route unless the shortest distance is chosen', () => {
      expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTE_PREFERENCE: ' Shortest ' }).routePreference).toBe('shortest');
      expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTE_PREFERENCE: 'fastest' }).routePreference).toBe('fastest');
      // Anything else keeps the fastest route.
      expect(getAmazonLocationConfig({ AMAZON_LOCATION_ROUTE_PREFERENCE: 'cheapest' }).routePreference).toBe('fastest');
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
});

describe('etaMath.test.ts', () => {
  const t0 = Date.UTC(2026, 9, 5, 15, 0, 0);
  const pt = (seconds: number, lat: number, lng = -105): TracePoint => ({
    lat,
    lng,
    measuredAt: new Date(t0 + seconds * 1000),
    accuracy: 10,
    source: 'app',
  });
  /** Readings every minute for `minutes`, moving north at `metersPerSecond`. */
  const driving = (minutes: number, metersPerSecond: number): TracePoint[] =>
    Array.from({ length: minutes + 1 }, (_, index) => pt(index * 60, 39.7 + (index * 60 * metersPerSecond) / 111_195));

  describe('arrival time rules', () => {
    describe('stopped', () => {
      it('counts how long the driver has stayed in one spot, up to now', () => {
        const moving = driving(10, 20);
        const last = moving[moving.length - 1];
        const parked = [1, 2, 3, 4, 5, 6].map((minute) => pt(600 + minute * 60, last.lat + 0.0001));
        const now = t0 + 17 * 60_000;
        expect(stoppedForMs([...moving, ...parked], now)).toBe(now - (t0 + 600_000));
      });

      it('is zero while driving and with no readings', () => {
        const trace = driving(10, 20);
        expect(stoppedForMs(trace, t0 + 600_000)).toBe(0);
        expect(stoppedForMs([], t0)).toBe(0);
      });
    });

    describe("driver's own pace", () => {
      // Route: 100 km in an hour, about 27.8 m/s.
      const route = { routeDurationSeconds: 3600, routeDistanceMeters: 100_000 };

      it('adds time (at most +12.5%) when the driver has been slower than the route expects', () => {
        expect(paceAdjustmentSeconds({ ...route, recent: driving(20, 20), stopped: false })).toBe(450);
      });

      it('takes time off (at most -7.5%) when the driver has been faster', () => {
        expect(paceAdjustmentSeconds({ ...route, recent: driving(20, 33), stopped: false })).toBe(-270);
      });

      it('is a small change when the driver matches the route', () => {
        const adjustment = paceAdjustmentSeconds({ ...route, recent: driving(20, 27.8), stopped: false });
        expect(Math.abs(adjustment)).toBeLessThan(10);
      });

      it('is skipped when stopped, close to the stop, or without enough recent driving', () => {
        expect(paceAdjustmentSeconds({ ...route, recent: driving(20, 20), stopped: true })).toBe(0);
        expect(paceAdjustmentSeconds({ routeDurationSeconds: 300, routeDistanceMeters: 4_000, recent: driving(20, 20), stopped: false })).toBe(0);
        expect(paceAdjustmentSeconds({ ...route, recent: driving(5, 20), stopped: false })).toBe(0);
        expect(paceAdjustmentSeconds({ ...route, recent: [], stopped: false })).toBe(0);
      });
    });

    it('rates traffic against free-flowing roads', () => {
      expect(trafficLevel(1000, 1000)).toBe('light');
      expect(trafficLevel(1050, 1000)).toBe('light');
      expect(trafficLevel(1200, 1000)).toBe('moderate');
      expect(trafficLevel(1400, 1000)).toBe('heavy');
      expect(trafficLevel(1400, null)).toBe('light');
    });

    describe('deadline', () => {
      it('ends at midnight Mountain Time, including the daylight-saving days', () => {
        expect(new Date(endOfBusinessDayMs('2026-01-15')).toISOString()).toBe('2026-01-16T06:59:59.000Z');
        expect(new Date(endOfBusinessDayMs('2026-07-15')).toISOString()).toBe('2026-07-16T05:59:59.000Z');
        expect(new Date(endOfBusinessDayMs('2026-03-08')).toISOString()).toBe('2026-03-09T05:59:59.000Z');
        expect(new Date(endOfBusinessDayMs('2026-11-01')).toISOString()).toBe('2026-11-02T06:59:59.000Z');
      });

      it('is on time, at risk within 2 hours of the end of the day, or late', () => {
        const end = endOfBusinessDayMs('2026-10-07');
        expect(deadlineStatus(end - 3 * 60 * 60_000, '2026-10-07')).toBe('on_time');
        expect(deadlineStatus(end - 60 * 60_000, '2026-10-07')).toBe('at_risk');
        expect(deadlineStatus(end + 60_000, '2026-10-07')).toBe('late');
      });

      it('reads load dates as calendar days', () => {
        expect(loadDateDay(new Date('2026-10-07T00:00:00.000Z'))).toBe('2026-10-07');
        expect(loadDateDay('2026-10-07T00:00:00.000Z')).toBe('2026-10-07');
        expect(loadDateDay(null)).toBeNull();
        expect(loadDateDay('not a date')).toBeNull();
      });
    });
  });
});

describe('routeSafety.test.ts', () => {
  const notice = (Code: string, ViolatedConstraints?: Record<string, unknown>, Impact = 'High') => ({
    Code,
    Impact,
    Details: ViolatedConstraints ? [{ Title: 'Limit', ViolatedConstraints }] : [],
  });

  describe('route safety check', () => {
    it('a route with no notices, or only notices about tolls and the like, is fine', () => {
      expect(legSafety(undefined)).toEqual({ status: 'ok', limits: [] });
      expect(legSafety([])).toEqual({ status: 'ok', limits: [] });
      expect(
        legSafety([notice('TollsDataUnavailable'), notice('AccuratePolylineUnavailable'), notice('TravelTimeExceedsDriverWorkHours')]),
      ).toEqual({ status: 'ok', limits: [] });
    });

    it('a broken limit makes the route unsafe and names the limit in US units', () => {
      expect(legSafety([notice('ViolatedVehicleRestriction', { MaxHeight: 381 })])).toEqual({
        status: 'unsafe',
        limits: ['a 12 ft 6 in height limit'],
      });
      expect(legSafety([notice('ViolatedVehicleRestriction', { MaxLength: 1829, MaxWidth: 244 })]).limits).toEqual([
        'a 60 ft length limit',
        'an 8 ft width limit',
      ]);
      expect(legSafety([notice('ViolatedVehicleRestriction', { MaxWeight: { Type: 'Gross', Value: 18_144 } })]).limits).toEqual([
        'a 40,000 lb weight limit',
      ]);
      expect(legSafety([notice('ViolatedVehicleRestriction', { MaxWeightPerAxle: 4_000 })]).limits).toEqual([
        'an 8,800 lb per-axle weight limit',
      ]);
    });

    it('a limit that may apply asks the driver to check the route', () => {
      expect(legSafety([notice('PotentialViolatedVehicleRestrictionUsage', { MaxHeight: 411 }, 'Low')])).toEqual({
        status: 'check',
        limits: ['a 13 ft 6 in height limit'],
      });
      expect(legSafety([notice('SeasonalClosure')])).toEqual({ status: 'check', limits: ['a road that may be closed for the season'] });
    });

    it('a broken limit wins over one that may apply', () => {
      const safety = legSafety([
        notice('PotentialViolatedVehicleRestrictionUsage', { MaxHeight: 411 }),
        notice('ViolatedBlockedRoad'),
      ]);
      expect(safety).toEqual({ status: 'unsafe', limits: ['a 13 ft 6 in height limit', 'a blocked road'] });
    });

    it('names the kind of limit when Amazon gives no numbers', () => {
      const limitsFor = (code: string) => legSafety([notice(code)]).limits;
      expect(limitsFor('ViolatedBlockedRoad')).toEqual(['a blocked road']);
      expect(limitsFor('ViolatedTurnRestriction')).toEqual(["a turn trucks can't make"]);
      expect(limitsFor('PotentialViolatedZoneRestrictionUsage')).toEqual(["an area trucks can't enter"]);
      expect(limitsFor('ViolatedAvoidTruckRoadType')).toEqual(["a road trucks shouldn't use"]);
      expect(limitsFor('ViolatedEmergencyGate')).toEqual(['an emergency gate']);
      expect(limitsFor('ViolatedVehicleRestriction')).toEqual(['a road with truck limits']);
    });

    it('lists each limit once and at most three', () => {
      const safety = legSafety([
        notice('ViolatedVehicleRestriction', { MaxHeight: 381 }),
        notice('ViolatedVehicleRestriction', { MaxHeight: 381 }),
        notice('ViolatedVehicleRestriction', { MaxLength: 1829 }),
        notice('ViolatedBlockedRoad'),
        notice('ViolatedEmergencyGate'),
      ]);
      expect(safety.limits).toEqual(['a 12 ft 6 in height limit', 'a 60 ft length limit', 'a blocked road']);
    });

    it('ignores notices it cannot read', () => {
      expect(legSafety([null, 'text', { Code: 42 }, { Details: 'none' }])).toEqual({ status: 'ok', limits: [] });
      expect(legSafety([notice('ViolatedVehicleRestriction', { MaxHeight: -1, MaxWeight: { Value: 'heavy' } })]).limits).toEqual([
        'a road with truck limits',
      ]);
    });

    it('recognises the truck-limit notices and the ones about tolls and the like', () => {
      expect(
        unrecognizedNoticeCodes([
          notice('ViolatedBlockedRoad'),
          notice('PotentialViolatedVehicleRestrictionUsage'),
          notice('SeasonalClosure'),
          notice('TollsDataUnavailable'),
          notice('TravelTimeExceedsDriverWorkHours'),
        ]),
      ).toEqual([]);
      expect(unrecognizedNoticeCodes(undefined)).toEqual([]);
    });

    it('lists notice codes it does not recognise yet, once each, for review', () => {
      expect(
        unrecognizedNoticeCodes([notice('Other'), notice('NewTruckRule'), notice('Other'), null, { Code: 42 }, { Code: '  ' }]),
      ).toEqual(['Other', 'NewTruckRule']);
      // Recording them never changes the route's own safety result.
      expect(legSafety([notice('NewTruckRule')])).toEqual({ status: 'ok', limits: [] });
    });

    it('joins limits into one sentence', () => {
      expect(listOf([])).toBe('');
      expect(listOf(['a'])).toBe('a');
      expect(listOf(['a', 'b'])).toBe('a and b');
      expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    });
  });
});

describe('routeTrace.test.ts', () => {
  const t0 = Date.UTC(2026, 9, 5, 15, 0, 0);
  // About 111 m per 0.001° of latitude.
  const pt = (seconds: number, lat: number, lng = -105, extra: Partial<TracePoint> = {}): TracePoint => ({
    lat,
    lng,
    measuredAt: new Date(t0 + seconds * 1000),
    accuracy: 10,
    source: 'app',
    ...extra,
  });

  describe('route line cleaning', () => {
    it('keeps one reading per moment (the most precise) in time order', () => {
      const cleaned = cleanTrace([pt(20, 40.002), pt(0, 40.0, -105, { accuracy: 30 }), pt(0, 40.0001, -105, { accuracy: 5 }), pt(10, 40.001)]);
      expect(cleaned.map((point) => point.measuredAt.getTime() - t0)).toEqual([0, 10_000, 20_000]);
      expect(cleaned[0].accuracy).toBe(5);
    });

    it('uses only phone readings when the phone reported, and drops rough readings', () => {
      const cleaned = cleanTrace([
        pt(0, 40.0),
        pt(5, 40.5, -104, { source: 'browser', accuracy: 50_000 }),
        pt(10, 40.001),
        pt(20, 40.002, -105, { accuracy: 250 }),
        pt(30, 40.003),
      ]);
      expect(cleaned.map((point) => point.lat)).toEqual([40.0, 40.001, 40.003]);

      // Without phone readings, precise browser readings are used.
      const browserOnly = cleanTrace([pt(0, 40, -105, { source: 'browser' }), pt(30, 40.001, -105, { source: 'browser' })]);
      expect(browserOnly).toHaveLength(2);
    });

    it('drops a single impossible jump but keeps a move confirmed by the next reading', () => {
      // 40.0 -> 41.0 (111 km in 10 s) -> back to the road: the jump is a glitch.
      expect(cleanTrace([pt(0, 40.0), pt(10, 41.0), pt(20, 40.0015)]).map((point) => point.lat)).toEqual([40.0, 40.0015]);
      // A jump that two agreeing readings confirm is kept (for example the
      // phone's earlier fixes were off and it corrected itself).
      const moved = cleanTrace([pt(0, 40.0), pt(5, 40.0004), pt(10, 40.5), pt(20, 40.5005)]);
      expect(moved.map((point) => point.lat)).toEqual([40.0, 40.0004, 40.5, 40.5005]);
      // A long gap at driving speed is simply a normal reading.
      expect(cleanTrace([pt(0, 40.0), pt(3600, 40.5)])).toHaveLength(2);
    });

    it('drops a glitch at the very start', () => {
      expect(cleanTrace([pt(0, 45.0), pt(10, 40.0), pt(20, 40.001)]).map((point) => point.lat)).toEqual([40.0, 40.001]);
    });
  });

  describe('route line simplifying', () => {
    it('keeps the corners and both ends while removing points on straight stretches', () => {
      const line: Array<{ lat: number; lng: number }> = [];
      for (let i = 0; i <= 50; i += 1) line.push({ lat: 40 + i * 0.0001, lng: -105 }); // north
      for (let i = 1; i <= 50; i += 1) line.push({ lat: 40.005, lng: -105 + i * 0.0001 }); // then east
      const simplified = simplifyLine(line, 10);
      expect(simplified.length).toBeLessThanOrEqual(10);
      expect(simplified[0]).toEqual(line[0]);
      expect(simplified.at(-1)).toEqual(line.at(-1));
      // The corner where the road turns east is still there.
      expect(simplified.some((point) => distanceMeters(point, { lat: 40.005, lng: -105 }) < 1)).toBe(true);
    });

    it('returns short lines unchanged', () => {
      const line = [{ lat: 40, lng: -105 }, { lat: 40.1, lng: -105 }];
      expect(simplifyLine(line, 10)).toBe(line);
    });
  });
});
