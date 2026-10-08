import { CalculateRoutesCommand, GeoRoutesClient } from "@aws-sdk/client-geo-routes";
import { GeocodeCommand, GeoPlacesClient } from "@aws-sdk/client-geo-places";
import { getAmazonLocationConfig } from "../config/amazonLocation";
import DriverLocation from "../models/DriverLocation.model";
import LoadTripPoint from "../models/LoadTripPoint.model";
import logger from "../utils/logger";
import {
  STOPPED_MIN_MS,
  deadlineStatus,
  loadDateDay,
  paceAdjustmentSeconds,
  stoppedForMs,
  trafficLevel,
  type DeadlineStatus,
} from "./etaMath.service";
import type { TracePoint } from "./routeTrace.service";

/*
 * Arrival time (ETA) for a load's next stop, with Amazon Location Service:
 *
 * 1. Driving time and distance from the driver's latest position along
 *    truck-legal roads, with live traffic (Amazon Location Routes, DepartNow).
 * 2. Adjusted a little by how this driver has actually been moving over the
 *    last 30 minutes (bounded; see etaMath.service).
 * 3. "Stopped for N minutes" instead of a guess when the truck isn't moving.
 * 4. On time / At risk / Late against the stop's deadline day.
 *
 * Results are reused for 2 minutes per load (only computed when someone has
 * the driver or load open), and a per-minute cap protects the bill. Off
 * unless AMAZON_LOCATION_ETA_ENABLED=true; any failure means no ETA, never a
 * wrong one.
 */

export const ETA_REUSE_MS = 2 * 60_000;
/** A position older than this is shown as the basis of the estimate. */
const STALE_POSITION_MS = 15 * 60_000;
const PACE_WINDOW_MS = 30 * 60_000;
const GEOCODE_REUSE_MS = 60 * 60_000;

type LatLng = { lat: number; lng: number };
type Stop = "pickup" | "delivery";

export type EtaUnavailableReason =
  | "eta_off"
  | "not_tracked"
  | "no_driver_position"
  | "no_destination"
  | "unavailable";

export type LoadEta =
  | {
      available: true;
      stop: Stop;
      /** Seconds from now, including the driver-pace adjustment. */
      durationSeconds: number;
      arrivalAt: string;
      distanceMeters: number;
      traffic: {
        level: "light" | "moderate" | "heavy";
        /** Extra time compared with free-flowing roads. */
        delaySeconds: number;
        /** Compared with the usual traffic for this time of day. */
        comparedWithUsual: "better" | "usual" | "worse" | null;
      };
      incidents: Array<{ description: string; severity: string | null }>;
      paceAdjustmentSeconds: number;
      driver: {
        speedMph: number | null;
        stoppedMinutes: number | null;
        positionAgeMinutes: number;
        /** The latest position is over 15 minutes old: the estimate starts from there. */
        positionStale: boolean;
      };
      deadline: { day: string; status: DeadlineStatus } | null;
      computedAt: string;
    }
  | { available: false; reason: EtaUnavailableReason; message: string };

export type EtaLoad = {
  _id: unknown;
  status?: string;
  assignedDriverId?: unknown;
  pickupLocation?: Record<string, any> | null;
  deliveryLocation?: Record<string, any> | null;
  dates?: { pickupDeadline?: unknown; deliveryDeadline?: unknown } | null;
};

const UNAVAILABLE_MESSAGES: Record<EtaUnavailableReason, string> = {
  eta_off: "Arrival times aren't switched on yet.",
  not_tracked: "Arrival times show once the driver has accepted the load.",
  no_driver_position: "No recent location from the driver yet.",
  no_destination: "This stop's address couldn't be found on the map. Add a map pin to the load.",
  unavailable: "The arrival time couldn't be worked out right now. It will try again shortly.",
};

const unavailable = (reason: EtaUnavailableReason): LoadEta => ({ available: false, reason, message: UNAVAILABLE_MESSAGES[reason] });

let routesClient: GeoRoutesClient | null = null;
let placesClient: GeoPlacesClient | null = null;
let clientRegion = "";
const results = new Map<string, { at: number; eta: LoadEta }>();
const inFlight = new Map<string, Promise<LoadEta>>();
const geocodes = new Map<string, { at: number; position: LatLng | null }>();
let quotaWindowStart = 0;
let quotaUsed = 0;

const health = {
  computed: 0,
  reused: 0,
  geocoded: 0,
  failed: 0,
  skippedByCap: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
};

function clients(region: string) {
  if (!routesClient || !placesClient || clientRegion !== region) {
    // Standard AWS credentials: the EC2 server's IAM role in production.
    routesClient = new GeoRoutesClient({ region });
    placesClient = new GeoPlacesClient({ region });
    clientRegion = region;
  }
  return { routes: routesClient, places: placesClient };
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

function plainError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? "";
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) return "AWS refused the request: the server isn't allowed to calculate routes or look up addresses yet.";
  if (/Credential/i.test(name)) return "AWS credentials weren't found on this server.";
  if (/Throttl/i.test(name)) return "Amazon Location is limiting requests right now.";
  if (/Validation/i.test(name)) return "Amazon Location didn't accept this route request.";
  return "Amazon Location couldn't be reached.";
}

function failed(error: unknown, what: string): void {
  health.failed += 1;
  health.lastError = plainError(error);
  health.lastErrorAt = new Date();
  logger.warn({ reason: health.lastError, error: (error as Error)?.name, what }, "[AmazonLocation] Arrival time step failed");
}

export function nextStopFor(status: string | undefined): Stop | null {
  if (status === "Accepted") return "pickup";
  if (status === "Picked Up" || status === "In-Transit") return "delivery";
  return null;
}

function stopAddressText(place: Record<string, any> | null | undefined): string {
  if (!place) return "";
  return [place.address, place.city, [place.state, place.zip].filter(Boolean).join(" ")]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * The stop's map pin, or its address looked up with Amazon Location (reused
 * for an hour). Null when the address isn't on the map; "retry" when it
 * couldn't be checked right now (safety cap or an AWS error).
 */
async function stopPosition(
  place: Record<string, any> | null | undefined,
  region: string,
  perMinute: number,
): Promise<LatLng | null | "retry"> {
  const pin = place?.coordinates;
  if (pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng)) return { lat: Number(pin.lat), lng: Number(pin.lng) };
  const address = stopAddressText(place);
  if (!address) return null;

  const cached = geocodes.get(address);
  if (cached && Date.now() - cached.at < GEOCODE_REUSE_MS) return cached.position;
  if (!takeQuota(perMinute)) {
    health.skippedByCap += 1;
    return "retry";
  }
  try {
    const response = await clients(region).places.send(
      new GeocodeCommand({ QueryText: address, MaxResults: 1, Filter: { IncludeCountries: ["USA"] } }),
    );
    const position = response.ResultItems?.[0]?.Position;
    const found = Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[1])
      ? { lat: Number(position[1]), lng: Number(position[0]) }
      : null;
    health.geocoded += 1;
    geocodes.set(address, { at: Date.now(), position: found });
    return found;
  } catch (error) {
    failed(error, "geocode");
    return "retry";
  }
}

/** This trip's recent positions (trip points are indexed by load and time). */
async function recentTrace(loadId: unknown, driverId: string, sinceMs: number): Promise<TracePoint[]> {
  const rows: any[] = await LoadTripPoint.find({ loadId, driverId, measuredAt: { $gte: new Date(sinceMs) } })
    .sort({ measuredAt: -1 })
    .limit(2_000)
    .select("lat lng measuredAt accuracy speed heading source")
    .lean();
  return rows.reverse().map((row) => ({
    lat: row.lat,
    lng: row.lng,
    measuredAt: new Date(row.measuredAt),
    accuracy: row.accuracy ?? null,
    speed: row.speed ?? null,
    heading: row.heading ?? null,
    source: row.source ?? null,
  }));
}

async function computeEta(load: EtaLoad, stop: Stop): Promise<LoadEta> {
  const config = getAmazonLocationConfig();
  const driverId = String(load.assignedDriverId ?? "");
  const location: any = await DriverLocation.findOne({ userId: driverId })
    .select("coords locationRecordedAt speed")
    .lean();
  const origin = location?.coords;
  const measuredMs = location?.locationRecordedAt ? new Date(location.locationRecordedAt).getTime() : Number.NaN;
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || !Number.isFinite(measuredMs)) {
    return unavailable("no_driver_position");
  }

  const destination = await stopPosition(stop === "pickup" ? load.pickupLocation : load.deliveryLocation, config.region, config.etasPerMinute);
  if (destination === "retry") return unavailable("unavailable");
  if (!destination) return unavailable("no_destination");

  if (!takeQuota(config.etasPerMinute)) {
    health.skippedByCap += 1;
    return unavailable("unavailable");
  }

  let summary: { distance: number; duration: number; typical: number | null; freeFlow: number | null; incidents: any[] };
  try {
    const response = await clients(config.region).routes.send(
      new CalculateRoutesCommand({
        Origin: [origin.lng, origin.lat],
        Destination: [destination.lng, destination.lat],
        DepartNow: true,
        Traffic: { Usage: "UseTrafficData" },
        TravelMode: config.travelMode,
        ...(config.travelMode === "Truck"
          ? {
              TravelModeOptions: {
                Truck: {
                  TruckType: "Tractor",
                  Height: config.truck.heightCm,
                  Length: config.truck.lengthCm,
                  GrossWeight: config.truck.grossWeightKg,
                  Trailer: { TrailerCount: 1 },
                },
              },
            }
          : {}),
        OptimizeRoutingFor: "FastestRoute",
        LegAdditionalFeatures: ["Summary", "TypicalDuration", "Incidents"],
      }),
    );
    const route = response.Routes?.[0];
    const legs = route?.Legs ?? [];
    const sum = (pick: (leg: any) => number | undefined) => {
      let total = 0;
      let any = false;
      for (const leg of legs) {
        const value = pick(leg);
        if (typeof value === "number" && Number.isFinite(value)) {
          total += value;
          any = true;
        }
      }
      return any ? total : null;
    };
    const distance = route?.Summary?.Distance ?? sum((leg) => leg.VehicleLegDetails?.Summary?.Overview?.Distance);
    const duration = route?.Summary?.Duration ?? sum((leg) => leg.VehicleLegDetails?.Summary?.Overview?.Duration);
    if (typeof distance !== "number" || typeof duration !== "number") throw Object.assign(new Error("no route"), { name: "NoRoute" });
    summary = {
      distance,
      duration,
      typical: sum((leg) => leg.VehicleLegDetails?.Summary?.Overview?.TypicalDuration),
      freeFlow: sum((leg) => leg.VehicleLegDetails?.Summary?.Overview?.BestCaseDuration),
      incidents: legs.flatMap((leg: any) => leg.VehicleLegDetails?.Incidents ?? []),
    };
  } catch (error) {
    failed(error, "route");
    return unavailable("unavailable");
  }

  const now = Date.now();
  const trace = await recentTrace(load._id, driverId, now - PACE_WINDOW_MS);
  const stoppedMs = stoppedForMs(trace, now);
  const stopped = stoppedMs >= STOPPED_MIN_MS;
  const pace = paceAdjustmentSeconds({
    routeDurationSeconds: summary.duration,
    routeDistanceMeters: summary.distance,
    recent: trace,
    stopped,
  });
  const durationSeconds = Math.max(0, Math.round(summary.duration + pace));
  const arrivalMs = now + durationSeconds * 1000;
  const deadlineDay = loadDateDay(stop === "pickup" ? load.dates?.pickupDeadline : load.dates?.deliveryDeadline);
  const severityRank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const comparedWithUsual =
    summary.typical && summary.typical > 0
      ? summary.duration > summary.typical * 1.1
        ? "worse"
        : summary.duration < summary.typical * 0.9
          ? "better"
          : "usual"
      : null;

  health.computed += 1;
  return {
    available: true,
    stop,
    durationSeconds,
    arrivalAt: new Date(arrivalMs).toISOString(),
    distanceMeters: Math.round(summary.distance),
    traffic: {
      level: trafficLevel(summary.duration, summary.freeFlow),
      delaySeconds: summary.freeFlow ? Math.max(0, Math.round(summary.duration - summary.freeFlow)) : 0,
      comparedWithUsual,
    },
    incidents: summary.incidents
      .filter((incident: any) => String(incident?.Description ?? "").trim())
      .sort((a: any, b: any) => (severityRank[a?.Severity] ?? 9) - (severityRank[b?.Severity] ?? 9))
      .slice(0, 3)
      .map((incident: any) => ({ description: String(incident.Description).trim().slice(0, 200), severity: incident.Severity ?? null })),
    paceAdjustmentSeconds: pace,
    driver: {
      speedMph:
        typeof location.speed === "number" && Number.isFinite(location.speed) ? Math.round(location.speed * 2.236936) : null,
      stoppedMinutes: stopped ? Math.floor(stoppedMs / 60_000) : null,
      positionAgeMinutes: Math.max(0, Math.floor((now - measuredMs) / 60_000)),
      positionStale: now - measuredMs > STALE_POSITION_MS,
    },
    deadline: deadlineDay ? { day: deadlineDay, status: deadlineStatus(arrivalMs, deadlineDay) } : null,
    computedAt: new Date(now).toISOString(),
  };
}

/** The arrival time for a load's next stop, reused for 2 minutes per load. */
export async function getLoadEta(load: EtaLoad): Promise<LoadEta> {
  if (!getAmazonLocationConfig().etaEnabled) return unavailable("eta_off");
  const stop = nextStopFor(load.status);
  if (!stop || !load.assignedDriverId) return unavailable("not_tracked");

  const key = `${String(load._id)}:${stop}`;
  const cached = results.get(key);
  if (cached && Date.now() - cached.at < ETA_REUSE_MS) {
    health.reused += 1;
    return cached.eta;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = computeEta(load, stop)
    .then((eta) => {
      // A failure is retried on the next view instead of being reused.
      if (eta.available || eta.reason === "no_destination") results.set(key, { at: Date.now(), eta });
      return eta;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function loadEtaHealthSnapshot() {
  const config = getAmazonLocationConfig();
  return { etaEnabled: config.etaEnabled, etasPerMinute: config.etasPerMinute, truck: config.truck, ...health };
}

export function resetLoadEtaForTests() {
  routesClient = null;
  placesClient = null;
  clientRegion = "";
  results.clear();
  inFlight.clear();
  geocodes.clear();
  quotaWindowStart = 0;
  quotaUsed = 0;
  Object.assign(health, { computed: 0, reused: 0, geocoded: 0, failed: 0, skippedByCap: 0, lastError: null, lastErrorAt: null });
}
