import { MAX_SNAP_POINTS_PER_REQUEST, snapToRoads } from "./amazonLocationRoutes.service";
import { TracePoint, cleanTrace, distanceMeters, simplifyLine } from "./routeTrace.service";

/*
 * A driver's route line for a map: cleaned GPS readings, snapped to the roads
 * with Amazon Location when that's switched on.
 *
 * Readings are grouped into fixed 15-minute pieces (aligned to the clock), and
 * each piece starts at the previous piece's last reading so the line stays
 * joined. Finished pieces never change, so their road match is found in the
 * saved results; only the piece still being driven is matched again.
 */

export const ROUTE_PIECE_MS = 15 * 60_000;

export type RouteLine = {
  points: Array<{ lat: number; lng: number }>;
  /** "roads": matched to roads; "gps": cleaned GPS readings; "mixed": partly each. */
  source: "roads" | "gps" | "mixed" | "none";
  /** Measurement time of the newest reading included. */
  throughMeasuredAt: Date | null;
};

/** The start of the 15-minute piece containing this time. */
export function routePieceStart(ms: number): number {
  return Math.floor(ms / ROUTE_PIECE_MS) * ROUTE_PIECE_MS;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  // Consecutive chunks share one reading so the matched pieces join up.
  for (let start = 0; start < items.length - 1; start += size - 1) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export async function buildRouteLine(raw: TracePoint[], maxPoints: number): Promise<RouteLine> {
  const cleaned = cleanTrace(raw);
  const newest = cleaned[cleaned.length - 1];
  if (!newest) return { points: [], source: "none", throughMeasuredAt: null };
  if (cleaned.length === 1) {
    return { points: [{ lat: newest.lat, lng: newest.lng }], source: "gps", throughMeasuredAt: newest.measuredAt };
  }

  const pieces = new Map<number, TracePoint[]>();
  for (const point of cleaned) {
    const start = routePieceStart(point.measuredAt.getTime());
    const list = pieces.get(start) ?? [];
    list.push(point);
    pieces.set(start, list);
  }

  const line: Array<{ lat: number; lng: number }> = [];
  const append = (part: Array<{ lat: number; lng: number }>) => {
    for (const point of part) {
      const last = line[line.length - 1];
      if (!last || distanceMeters(last, point) > 1) line.push(point);
    }
  };

  let roads = 0;
  let gps = 0;
  let previous: TracePoint | null = null;
  for (const start of [...pieces.keys()].sort((a, b) => a - b)) {
    const own = pieces.get(start)!;
    const piece = previous ? [previous, ...own] : own;
    previous = own[own.length - 1];
    if (piece.length < 2) {
      append(piece);
      continue;
    }
    for (const part of chunks(piece, MAX_SNAP_POINTS_PER_REQUEST)) {
      const snapped = await snapToRoads(part);
      if (snapped) {
        roads += 1;
        append(snapped);
      } else {
        gps += 1;
        append(part.map((point) => ({ lat: point.lat, lng: point.lng })));
      }
    }
  }

  return {
    points: simplifyLine(line, maxPoints),
    source: roads && gps ? "mixed" : roads ? "roads" : "gps",
    throughMeasuredAt: newest.measuredAt,
  };
}
