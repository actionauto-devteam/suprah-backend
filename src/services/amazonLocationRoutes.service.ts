import crypto from "crypto";
import { GeoRoutesClient, SnapToRoadsCommand } from "@aws-sdk/client-geo-routes";
import { getAmazonLocationConfig } from "../config/amazonLocation";
import SnappedRouteCache from "../models/SnappedRouteCache.model";
import logger from "../utils/logger";
import type { TracePoint } from "./routeTrace.service";

/*
 * Snapping GPS readings to the roads actually driven, with Amazon Location
 * Service (Routes: SnapToRoads). Off unless switched on (config/amazonLocation.ts).
 * Every answer is saved (SnappedRouteCache), so the same stretch of readings
 * is only sent once; a per-minute cap protects the bill. Any failure returns
 * null and the caller draws the cleaned GPS line instead.
 */

/** Readings per request; longer stretches are split by the caller. */
export const MAX_SNAP_POINTS_PER_REQUEST = 1_000;
/** Metres around each reading in which a road may be matched. */
const SNAP_RADIUS_METERS = 150;

type LatLng = { lat: number; lng: number };

let client: GeoRoutesClient | null = null;
let clientRegion = "";
const inFlight = new Map<string, Promise<LatLng[] | null>>();
let quotaWindowStart = 0;
let quotaUsed = 0;

const health = {
  snapped: 0,
  cacheHits: 0,
  failed: 0,
  skippedByCap: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
};

function routesClient(region: string): GeoRoutesClient {
  if (!client || clientRegion !== region) {
    // Standard AWS credentials: the EC2 server's IAM role in production.
    client = new GeoRoutesClient({ region });
    clientRegion = region;
  }
  return client;
}

function takeQuota(perMinute: number): boolean {
  const now = Date.now();
  if (now - quotaWindowStart >= 60_000) {
    quotaWindowStart = now;
    quotaUsed = 0;
  }
  if (quotaUsed >= perMinute) return false;
  quotaUsed += 1;
  return true;
}

function cacheKey(points: TracePoint[], travelMode: string): string {
  const text = points
    .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)},${point.measuredAt.getTime()}`)
    .join("|");
  return crypto.createHash("sha256").update(`${travelMode}|${SNAP_RADIUS_METERS}|${text}`).digest("hex");
}

function toLatLng(line: number[][]): LatLng[] {
  return line
    .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([lng, lat]) => ({ lat, lng }));
}

function plainError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? "";
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) return "AWS refused the request: the server isn't allowed to use Snap to Roads yet.";
  if (/Credential/i.test(name)) return "AWS credentials weren't found on this server.";
  if (/Throttl/i.test(name)) return "Amazon Location is limiting requests right now.";
  if (/Validation/i.test(name)) return "Amazon Location didn't accept these GPS readings.";
  return "Amazon Location couldn't be reached.";
}

async function requestSnap(points: TracePoint[], key: string): Promise<LatLng[] | null> {
  const config = getAmazonLocationConfig();
  if (!takeQuota(config.snapsPerMinute)) {
    health.skippedByCap += 1;
    return null;
  }
  try {
    const response = await routesClient(config.region).send(
      new SnapToRoadsCommand({
        TracePoints: points.map((point) => ({
          Position: [point.lng, point.lat],
          Timestamp: point.measuredAt.toISOString(),
          // Suprah stores metres per second; Amazon Location expects km/h.
          ...(typeof point.speed === "number" && Number.isFinite(point.speed) && point.speed >= 0
            ? { Speed: point.speed * 3.6 }
            : {}),
          ...(typeof point.heading === "number" && Number.isFinite(point.heading) && point.heading >= 0 && point.heading <= 360
            ? { Heading: point.heading }
            : {}),
        })),
        TravelMode: config.travelMode,
        SnappedGeometryFormat: "Simple",
        SnapRadius: SNAP_RADIUS_METERS,
      }),
    );
    const line = response.SnappedGeometry?.LineString ?? [];
    const snapped = toLatLng(line);
    if (snapped.length < 2) {
      health.failed += 1;
      health.lastError = "Amazon Location returned no road line for these readings.";
      health.lastErrorAt = new Date();
      return null;
    }
    await SnappedRouteCache.updateOne(
      { key },
      { $setOnInsert: { key, line: snapped.map((point) => [point.lng, point.lat]), createdAt: new Date() } },
      { upsert: true },
    ).catch((error: any) => {
      if (error?.code !== 11000) throw error;
    });
    health.snapped += 1;
    return snapped;
  } catch (error) {
    health.failed += 1;
    health.lastError = plainError(error);
    health.lastErrorAt = new Date();
    logger.warn({ reason: health.lastError, error: (error as Error)?.name }, "[AmazonLocation] Snap to roads failed; drawing GPS points instead");
    return null;
  }
}

/**
 * The roads driven along these readings (time order, at most
 * MAX_SNAP_POINTS_PER_REQUEST), or null when snapping is off, capped or failed.
 */
export async function snapToRoads(points: TracePoint[]): Promise<LatLng[] | null> {
  const config = getAmazonLocationConfig();
  if (!config.snapToRoadsEnabled || points.length < 2 || points.length > MAX_SNAP_POINTS_PER_REQUEST) return null;
  const key = cacheKey(points, config.travelMode);

  const cached: any = await SnappedRouteCache.findOne({ key }).select("line").lean();
  if (cached?.line?.length) {
    health.cacheHits += 1;
    return toLatLng(cached.line);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = requestSnap(points, key).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function amazonLocationRoutesHealthSnapshot() {
  const config = getAmazonLocationConfig();
  return {
    snapToRoadsEnabled: config.snapToRoadsEnabled,
    region: config.region,
    travelMode: config.travelMode,
    snapsPerMinute: config.snapsPerMinute,
    ...health,
  };
}

export function resetAmazonLocationRoutesForTests() {
  client = null;
  clientRegion = "";
  inFlight.clear();
  quotaWindowStart = 0;
  quotaUsed = 0;
  Object.assign(health, { snapped: 0, cacheHits: 0, failed: 0, skippedByCap: 0, lastError: null, lastErrorAt: null });
}
