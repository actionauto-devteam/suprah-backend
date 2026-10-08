/*
 * Cleaning GPS traces before they're drawn as a route line.
 *
 * Raw positions include readings that make a route look wrong: very rough
 * fixes (a computer's Wi-Fi location can be kilometres off), the same reading
 * stored once per load, a single "teleport" glitch, and a mix of the driver's
 * phone and the Driver Portal in a browser. These rules remove them; the trip
 * history itself keeps every raw reading.
 */

export type TracePoint = {
  lat: number;
  lng: number;
  measuredAt: Date;
  /** Metres. */
  accuracy?: number | null;
  /** Metres per second. */
  speed?: number | null;
  /** Degrees clockwise from north. */
  heading?: number | null;
  source?: string | null;
};

/** Readings less precise than this are left out of route lines. */
export const MAX_ROUTE_ACCURACY_METERS = 100;
/** Faster than this between two readings (about 112 mph) can't be a real drive. */
export const MAX_ROUTE_SPEED_MPS = 50;

const PHONE_SOURCES = new Set(["app", "traccar"]);
const EARTH_RADIUS_METERS = 6_371_000;

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function plausible(from: TracePoint, to: TracePoint): boolean {
  const seconds = (to.measuredAt.getTime() - from.measuredAt.getTime()) / 1000;
  if (seconds <= 0) return false;
  return distanceMeters(from, to) / seconds <= MAX_ROUTE_SPEED_MPS;
}

/**
 * Readings in time order with: one reading per moment (the most precise),
 * browser readings dropped when the phone reported in the same period,
 * rough readings dropped, and single impossible jumps dropped. A jump that
 * the next reading confirms (for example after a long gap) is kept.
 */
export function cleanTrace(points: TracePoint[]): TracePoint[] {
  const valid = points.filter(
    (point) =>
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lng) <= 180 &&
      point.measuredAt instanceof Date &&
      Number.isFinite(point.measuredAt.getTime()),
  );

  const byMoment = new Map<number, TracePoint>();
  for (const point of valid) {
    const key = point.measuredAt.getTime();
    const existing = byMoment.get(key);
    if (!existing || (point.accuracy ?? Infinity) < (existing.accuracy ?? Infinity)) byMoment.set(key, point);
  }
  let ordered = [...byMoment.values()].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());

  if (ordered.some((point) => PHONE_SOURCES.has(String(point.source ?? "")))) {
    ordered = ordered.filter((point) => PHONE_SOURCES.has(String(point.source ?? "")));
  }
  ordered = ordered.filter(
    (point) => point.accuracy === null || point.accuracy === undefined || point.accuracy <= MAX_ROUTE_ACCURACY_METERS,
  );

  const kept: TracePoint[] = [];
  let suspect: TracePoint | null = null;
  for (const point of ordered) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(point);
      continue;
    }
    if (point.measuredAt.getTime() <= last.measuredAt.getTime()) continue;
    if (plausible(last, point)) {
      kept.push(point);
      suspect = null;
    } else if (suspect && plausible(suspect, point)) {
      // Two readings agree with each other: the move was real. If the only
      // reading so far disagrees with both, that first one was the glitch.
      if (kept.length === 1) kept.pop();
      kept.push(suspect, point);
      suspect = null;
    } else {
      suspect = point;
    }
  }
  return kept;
}

function perpendicularMeters(point: { lat: number; lng: number }, start: { lat: number; lng: number }, end: { lat: number; lng: number }) {
  // Small distances: a flat projection in metres around the start point.
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos((start.lat * Math.PI) / 180);
  const px = (point.lng - start.lng) * metersPerDegLng;
  const py = (point.lat - start.lat) * metersPerDegLat;
  const ex = (end.lng - start.lng) * metersPerDegLng;
  const ey = (end.lat - start.lat) * metersPerDegLat;
  const lengthSquared = ex * ex + ey * ey;
  if (lengthSquared === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSquared));
  return Math.hypot(px - t * ex, py - t * ey);
}

function douglasPeucker<T extends { lat: number; lng: number }>(points: T[], toleranceMeters: number): T[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = 0;
    for (let i = first + 1; i < last; i += 1) {
      const d = perpendicularMeters(points[i], points[first], points[last]);
      if (d > farthestDistance) {
        farthestDistance = d;
        farthest = i;
      }
    }
    if (farthest !== -1 && farthestDistance > toleranceMeters) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/**
 * Fewer points with the same shape: straight stretches lose points, bends
 * keep theirs (unlike taking every Nth point, which cuts corners).
 */
export function simplifyLine<T extends { lat: number; lng: number }>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  let tolerance = 2;
  let simplified = douglasPeucker(points, tolerance);
  while (simplified.length > maxPoints && tolerance < 5_000) {
    tolerance *= 1.6;
    simplified = douglasPeucker(points, tolerance);
  }
  return simplified;
}
