import {
  deadlineStatus,
  endOfBusinessDayMs,
  loadDateDay,
  paceAdjustmentSeconds,
  stoppedForMs,
  trafficLevel,
} from '../../src/services/etaMath.service';
import { TracePoint } from '../../src/services/routeTrace.service';

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
