import { CalculateRoutesCommand, GeoRoutesClient } from "@aws-sdk/client-geo-routes";
import { GeocodeCommand, GeoPlacesClient } from "@aws-sdk/client-geo-places";
import { getAmazonLocationConfig, type TruckProfile } from "../config/amazonLocation";
import DriverLocation from "../models/DriverLocation.model";
import DriverProfile from "../models/DriverProfile.model";
import LoadTripPoint from "../models/LoadTripPoint.model";
import logger from "../utils/logger";
import { RIG_HEIGHT_INCHES, RIG_LENGTH_FEET } from "../validations/load.validation";
import {
  STOPPED_MIN_MS,
  deadlineStatus,
  loadDateDay,
  paceAdjustmentSeconds,
  stoppedForMs,
  trafficLevel,
  type DeadlineStatus,
} from "./etaMath.service";
import { MAX_ROUTE_ACCURACY_METERS, distanceToLineMeters, simplifyLine, type TracePoint } from "./routeTrace.service";
import { legSafety, listOf } from "./routeSafety.service";

/*
 * The best route and arrival time (ETA) for a load's next stop, with Amazon
 * Location Service:
 *
 * 1. The fastest truck-legal route from the driver's latest position, with
 *    live traffic (Amazon Location Routes, DepartNow), or the shortest one
 *    when AMAZON_LOCATION_ROUTE_PREFERENCE=shortest. Before pickup the same
 *    request also plans the rest of the trip, from the pickup to the delivery.
 * 2. The arrival time at the next stop, adjusted a little by how this driver
 *    has actually been moving over the last 30 minutes (bounded; see
 *    etaMath.service).
 * 3. "Stopped for N minutes" instead of a guess when the truck isn't moving.
 * 4. On time / At risk / Late against the stop's deadline day.
 * 5. A second check on Amazon's answer (routeSafety.service): a route that
 *    breaks one of the truck's limits is never shown as the way to go, and
 *    one where a limit may apply carries a warning.
 * 6. Rough locations (worse than 100 m) never trigger a new route, and
 *    "off the route" allows for the location's own error. Past 1 km the
 *    arrival card calls the starting location approximate, like the Driver
 *    Tracker does.
 * 7. The route fits the driver's own rig: its height and length from the
 *    Equipment page, or the company default for what the driver hasn't added.
 *
 * A route is reused for 2 minutes per load (only worked out while someone has
 * the driver or load open). When the driver leaves the planned route, a new
 * one is planned sooner. A per-minute cap protects the bill. Off unless
 * AMAZON_LOCATION_ROUTES_ENABLED=true; any failure means no route or arrival
 * time, never a wrong one, and the maps keep their straight line.
 */

export const ROUTE_REUSE_MS = 2 * 60_000;
/** Further than this from the planned route counts as having left it. */
export const OFF_ROUTE_METERS = 250;
/** A new route for a driver who left the planned one, at most this often. */
export const MIN_REROUTE_MS = 45_000;
/** Points per route line sent to the maps (the shape is kept; straight stretches lose points). */
export const MAX_ROUTE_LINE_POINTS = 1_500;
/** Points kept for checking whether the driver left the route (finer than the drawn line). */
const MAX_CHECK_LINE_POINTS = 8_000;
/**
 * A location less precise than this (a computer's Wi-Fi location can be
 * kilometres off) never triggers a new route.
 */
export const ROUGH_POSITION_METERS = MAX_ROUTE_ACCURACY_METERS;
/**
 * Past this, the arrival card says the route starts from an approximate
 * location: the same cut-off as the Driver Tracker's "Approximate GPS" label
 * (LOW_ACCURACY_M in the frontend's lib/driver-tracking-view.ts).
 */
export const APPROXIMATE_POSITION_METERS = 1_000;
/** A position older than this is shown as the basis of the estimate. */
const STALE_POSITION_MS = 15 * 60_000;
const PACE_WINDOW_MS = 30 * 60_000;
const GEOCODE_REUSE_MS = 60 * 60_000;

type LatLng = { lat: number; lng: number };
type Stop = "pickup" | "delivery";
/** [longitude, latitude], the order maps draw them in. */
export type RouteCoordinate = [number, number];

export type RouteUnavailableReason =
  | "routes_off"
  | "not_tracked"
  | "no_driver_position"
  | "no_destination"
  | "unavailable"
  | "no_safe_route";

export type LoadRouteLines = {
  /** Where the route starts: the driver's position when it was planned. */
  origin: LatLng;
  /** From the driver to the next stop. */
  ahead: RouteCoordinate[];
  /** Before pickup, the rest of the trip: from the pickup to the delivery. */
  later: { line: RouteCoordinate[]; distanceMeters: number; durationSeconds: number } | null;
  stops: { pickup: LatLng | null; delivery: LatLng | null };
};

export type LoadRoute =
  | {
      available: true;
      stop: Stop;
      /** Which route was planned: the fastest drive time or the shortest distance. */
      optimizedFor: "fastest" | "shortest";
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
        /** How precise the starting location is, in metres (null when unknown). */
        positionAccuracyMeters: number | null;
        /** The route starts from an approximate location (off by more than 1 km). */
        positionApproximate: boolean;
      };
      /**
       * Amazon Location's own warnings checked against the truck's limits.
       * "check": a limit may apply somewhere on the route. A route that
       * breaks a limit on the way to the next stop is never returned (see
       * "no_safe_route"); one that breaks a limit after the pickup loses its
       * rest-of-trip line.
       */
      safety: { status: "ok" | "check"; limits: string[]; restOfTripUnsafe: boolean; restOfTripLimits: string[] };
      /**
       * The rig size the route was planned for (null for car routes). Each
       * part comes from the driver's Equipment page when they added it, or
       * the company default.
       */
      truck: { heightInches: number; lengthFeet: number; fromEquipment: { height: boolean; length: boolean } } | null;
      deadline: { day: string; status: DeadlineStatus } | null;
      /** Null when Amazon Location sent no shape for the route; the arrival time still stands. */
      route: LoadRouteLines | null;
      computedAt: string;
    }
  | { available: false; reason: RouteUnavailableReason; message: string };

export type RouteLoad = {
  _id: unknown;
  status?: string;
  assignedDriverId?: unknown;
  pickupLocation?: Record<string, any> | null;
  deliveryLocation?: Record<string, any> | null;
  dates?: { pickupDeadline?: unknown; deliveryDeadline?: unknown } | null;
};

const UNAVAILABLE_MESSAGES: Record<RouteUnavailableReason, string> = {
  routes_off: "Routes and arrival times aren't switched on yet.",
  not_tracked: "The route shows once the driver has accepted the load.",
  no_driver_position: "No recent location from the driver yet.",
  no_destination: "This stop's address couldn't be found on the map. Add a map pin to the load.",
  unavailable: "The route couldn't be worked out right now. It will try again shortly.",
  no_safe_route: "No truck route was found that avoids every road limit. Plan this drive in a truck navigation app.",
};

const unavailable = (reason: RouteUnavailableReason): LoadRoute => ({
  available: false,
  reason,
  message: UNAVAILABLE_MESSAGES[reason],
});

type CachedRoute = {
  at: number;
  result: LoadRoute;
  /** The route ahead, for checking whether the driver left it. */
  checkLine: LatLng[] | null;
  /** When the driver's position the route started from was measured. */
  originMeasuredMs: number;
  /** The route started from a rough location; a precise one plans it again. */
  originRough: boolean;
};

let routesClient: GeoRoutesClient | null = null;
let placesClient: GeoPlacesClient | null = null;
let clientRegion = "";
const results = new Map<string, CachedRoute>();
const inFlight = new Map<string, Promise<LoadRoute>>();
const geocodes = new Map<string, { at: number; position: LatLng | null }>();
let quotaWindowStart = 0;
let quotaUsed = 0;

const health = {
  computed: 0,
  reused: 0,
  rerouted: 0,
  /** Routes withheld because they break one of the truck's limits. */
  withheldForLimits: 0,
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
  if (/NoRoute/i.test(name)) return "Amazon Location found no truck route between these places.";
  return "Amazon Location couldn't be reached.";
}

function failed(error: unknown, what: string): void {
  health.failed += 1;
  health.lastError = plainError(error);
  health.lastErrorAt = new Date();
  logger.warn({ reason: health.lastError, error: (error as Error)?.name, what }, "[AmazonLocation] Route step failed");
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

function pinOf(place: Record<string, any> | null | undefined): LatLng | null {
  const pin = place?.coordinates;
  return pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) ? { lat: Number(pin.lat), lng: Number(pin.lng) } : null;
}

/** Changes when a stop's pin or address changes, so an edited load gets a new route. */
function stopsKey(load: RouteLoad): string {
  const describe = (place: Record<string, any> | null | undefined) => {
    const pin = pinOf(place);
    return pin ? `${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}` : stopAddressText(place);
  };
  return `${describe(load.pickupLocation)}|${describe(load.deliveryLocation)}`;
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
  const pin = pinOf(place);
  if (pin) return pin;
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

async function latestDriverPosition(driverId: string) {
  const location: any = await DriverLocation.findOne({ userId: driverId })
    .select("coords locationRecordedAt speed accuracy")
    .lean();
  const coords = location?.coords;
  const measuredMs = location?.locationRecordedAt ? new Date(location.locationRecordedAt).getTime() : Number.NaN;
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng) || !Number.isFinite(measuredMs)) return null;
  const accuracy = typeof location.accuracy === "number" && Number.isFinite(location.accuracy) && location.accuracy >= 0
    ? location.accuracy
    : null;
  return {
    position: { lat: Number(coords.lat), lng: Number(coords.lng) },
    measuredMs,
    speed: typeof location.speed === "number" && Number.isFinite(location.speed) ? location.speed : null,
    /** Metres; null when the device didn't say. */
    accuracy,
    rough: accuracy !== null && accuracy > ROUGH_POSITION_METERS,
  };
}

/** A road line from Amazon Location as points, with bad pairs left out. */
function linePoints(lineString: unknown): LatLng[] {
  if (!Array.isArray(lineString)) return [];
  return lineString
    .filter((pair): pair is number[] => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([lng, lat]) => ({ lat, lng }));
}

const toCoordinates = (points: LatLng[]): RouteCoordinate[] => points.map((point) => [point.lng, point.lat]);

const withinLimits = (value: unknown, limits: { min: number; max: number }) =>
  typeof value === "number" && Number.isFinite(value) && value >= limits.min && value <= limits.max ? value : null;

/**
 * The truck to plan for: the driver's rig height and length from the
 * Equipment page, each falling back to the company default. Weight stays the
 * company setting (by default the 80,000 lb legal limit, so a route never
 * crosses a bridge too weak for a fully loaded rig).
 */
async function truckFor(driverId: string, fallback: TruckProfile) {
  const profile: any = await DriverProfile.findOne({ userId: driverId }).select("rigHeightInches rigLengthFeet").lean();
  const heightInches = withinLimits(profile?.rigHeightInches, RIG_HEIGHT_INCHES);
  const lengthFeet = withinLimits(profile?.rigLengthFeet, RIG_LENGTH_FEET);
  return {
    profile: {
      heightCm: heightInches !== null ? Math.round(heightInches * 2.54) : fallback.heightCm,
      lengthCm: lengthFeet !== null ? Math.round(lengthFeet * 30.48) : fallback.lengthCm,
      grossWeightKg: fallback.grossWeightKg,
    },
    shown: {
      heightInches: heightInches ?? Math.round(fallback.heightCm / 2.54),
      lengthFeet: lengthFeet ?? Math.round(fallback.lengthCm / 30.48),
      fromEquipment: { height: heightInches !== null, length: lengthFeet !== null },
    },
  };
}

type LegSummary = {
  distance: number | null;
  duration: number | null;
  typical: number | null;
  freeFlow: number | null;
  incidents: any[];
  notices: unknown;
  line: LatLng[];
};

function legSummary(leg: any): LegSummary {
  const overview = leg?.VehicleLegDetails?.Summary?.Overview ?? {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    distance: number(overview.Distance),
    duration: number(overview.Duration),
    typical: number(overview.TypicalDuration),
    freeFlow: number(overview.BestCaseDuration),
    incidents: leg?.VehicleLegDetails?.Incidents ?? [],
    notices: leg?.VehicleLegDetails?.Notices ?? [],
    line: linePoints(leg?.Geometry?.LineString),
  };
}

async function computeRoute(load: RouteLoad, stop: Stop): Promise<CachedRoute> {
  const config = getAmazonLocationConfig();
  const driverId = String(load.assignedDriverId ?? "");
  const notReady = (reason: RouteUnavailableReason): CachedRoute => ({
    at: Date.now(),
    result: unavailable(reason),
    checkLine: null,
    originMeasuredMs: 0,
    originRough: false,
  });

  const latest = await latestDriverPosition(driverId);
  if (!latest) return notReady("no_driver_position");
  const origin = latest.position;

  const nextStop = await stopPosition(stop === "pickup" ? load.pickupLocation : load.deliveryLocation, config.region, config.routesPerMinute);
  if (nextStop === "retry") return notReady("unavailable");
  if (!nextStop) return notReady("no_destination");
  // Before pickup the delivery is planned too, when it can be placed; without
  // it the route to the pickup still stands.
  const delivery =
    stop === "pickup" ? await stopPosition(load.deliveryLocation, config.region, config.routesPerMinute) : nextStop;
  const restOfTrip = stop === "pickup" && delivery && delivery !== "retry" ? delivery : null;

  if (!takeQuota(config.routesPerMinute)) {
    health.skippedByCap += 1;
    return notReady("unavailable");
  }

  const truck = config.travelMode === "Truck" ? await truckFor(driverId, config.truck) : null;

  let ahead: LegSummary;
  let later: LegSummary | null = null;
  try {
    const response = await clients(config.region).routes.send(
      new CalculateRoutesCommand({
        Origin: [origin.lng, origin.lat],
        Destination: restOfTrip ? [restOfTrip.lng, restOfTrip.lat] : [nextStop.lng, nextStop.lat],
        ...(restOfTrip ? { Waypoints: [{ Position: [nextStop.lng, nextStop.lat] }] } : {}),
        DepartNow: true,
        Traffic: { Usage: "UseTrafficData" },
        TravelMode: config.travelMode,
        ...(truck
          ? {
              TravelModeOptions: {
                Truck: {
                  TruckType: "Tractor",
                  Height: truck.profile.heightCm,
                  Length: truck.profile.lengthCm,
                  GrossWeight: truck.profile.grossWeightKg,
                  Trailer: { TrailerCount: 1 },
                },
              },
            }
          : {}),
        OptimizeRoutingFor: config.routePreference === "shortest" ? "ShortestRoute" : "FastestRoute",
        LegGeometryFormat: "Simple",
        LegAdditionalFeatures: ["Summary", "TypicalDuration", "Incidents"],
      }),
    );
    const route = response.Routes?.[0];
    const legs = route?.Legs ?? [];
    ahead = legSummary(legs[0]);
    // A single-leg route may carry its totals on the route instead of the leg.
    if (legs.length === 1) {
      ahead.distance ??= typeof route?.Summary?.Distance === "number" ? route.Summary.Distance : null;
      ahead.duration ??= typeof route?.Summary?.Duration === "number" ? route.Summary.Duration : null;
    }
    if (restOfTrip && legs.length >= 2) later = legSummary(legs[1]);
    if (ahead.distance === null || ahead.duration === null) {
      throw Object.assign(new Error("no route"), { name: "NoRoute" });
    }
  } catch (error) {
    failed(error, "route");
    return notReady("unavailable");
  }

  // A second check on Amazon's answer: its own notices against the truck's
  // limits. A route that breaks one on the way to the next stop is never
  // shown as the way to go.
  const aheadSafety = legSafety(ahead.notices);
  if (aheadSafety.status === "unsafe") {
    health.withheldForLimits += 1;
    return {
      at: Date.now(),
      result: {
        available: false,
        reason: "no_safe_route",
        message: aheadSafety.limits.length
          ? `No truck route to the ${stop} was found that avoids ${listOf(aheadSafety.limits)}. Plan this drive in a truck navigation app.`
          : UNAVAILABLE_MESSAGES.no_safe_route,
      },
      checkLine: null,
      originMeasuredMs: latest.measuredMs,
      originRough: latest.rough,
    };
  }
  const laterSafety = later ? legSafety(later.notices) : null;
  const restOfTripUnsafe = laterSafety?.status === "unsafe";
  if (restOfTripUnsafe) health.withheldForLimits += 1;
  const cautions = [
    ...(aheadSafety.status === "check" ? aheadSafety.limits : []),
    ...(laterSafety?.status === "check" ? laterSafety.limits : []),
  ].filter((limit, index, all) => all.indexOf(limit) === index);

  const distance = ahead.distance as number;
  const duration = ahead.duration as number;
  const now = Date.now();
  const trace = await recentTrace(load._id, driverId, now - PACE_WINDOW_MS);
  const stoppedMs = stoppedForMs(trace, now);
  const stopped = stoppedMs >= STOPPED_MIN_MS;
  const pace = paceAdjustmentSeconds({
    routeDurationSeconds: duration,
    routeDistanceMeters: distance,
    recent: trace,
    stopped,
  });
  const durationSeconds = Math.max(0, Math.round(duration + pace));
  const arrivalMs = now + durationSeconds * 1000;
  const deadlineDay = loadDateDay(stop === "pickup" ? load.dates?.pickupDeadline : load.dates?.deliveryDeadline);
  const severityRank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const comparedWithUsual =
    ahead.typical && ahead.typical > 0
      ? duration > ahead.typical * 1.1
        ? "worse"
        : duration < ahead.typical * 0.9
          ? "better"
          : "usual"
      : null;

  const aheadLine = simplifyLine(ahead.line, MAX_ROUTE_LINE_POINTS);
  const laterLine = later ? simplifyLine(later.line, MAX_ROUTE_LINE_POINTS) : [];
  const lines: LoadRouteLines | null =
    aheadLine.length >= 2
      ? {
          origin,
          ahead: toCoordinates(aheadLine),
          // The rest of the trip is left off the map when it breaks a truck limit.
          later:
            !restOfTripUnsafe && later && laterLine.length >= 2 && later.distance !== null && later.duration !== null
              ? { line: toCoordinates(laterLine), distanceMeters: Math.round(later.distance), durationSeconds: Math.round(later.duration) }
              : null,
          stops: {
            pickup: stop === "pickup" ? nextStop : pinOf(load.pickupLocation),
            delivery: stop === "delivery" ? nextStop : restOfTrip,
          },
        }
      : null;

  health.computed += 1;
  return {
    at: now,
    checkLine: ahead.line.length >= 2 ? simplifyLine(ahead.line, MAX_CHECK_LINE_POINTS) : null,
    originMeasuredMs: latest.measuredMs,
    originRough: latest.rough,
    result: {
      available: true,
      stop,
      optimizedFor: config.routePreference,
      durationSeconds,
      arrivalAt: new Date(arrivalMs).toISOString(),
      distanceMeters: Math.round(distance),
      traffic: {
        level: trafficLevel(duration, ahead.freeFlow),
        delaySeconds: ahead.freeFlow ? Math.max(0, Math.round(duration - ahead.freeFlow)) : 0,
        comparedWithUsual,
      },
      incidents: ahead.incidents
        .filter((incident: any) => String(incident?.Description ?? "").trim())
        .sort((a: any, b: any) => (severityRank[a?.Severity] ?? 9) - (severityRank[b?.Severity] ?? 9))
        .slice(0, 3)
        .map((incident: any) => ({ description: String(incident.Description).trim().slice(0, 200), severity: incident.Severity ?? null })),
      paceAdjustmentSeconds: pace,
      driver: {
        speedMph: latest.speed !== null ? Math.round(latest.speed * 2.236936) : null,
        stoppedMinutes: stopped ? Math.floor(stoppedMs / 60_000) : null,
        positionAgeMinutes: Math.max(0, Math.floor((now - latest.measuredMs) / 60_000)),
        positionStale: now - latest.measuredMs > STALE_POSITION_MS,
        positionAccuracyMeters: latest.accuracy !== null ? Math.round(latest.accuracy) : null,
        positionApproximate: latest.accuracy !== null && latest.accuracy > APPROXIMATE_POSITION_METERS,
      },
      safety: {
        status: cautions.length || restOfTripUnsafe ? "check" : "ok",
        limits: cautions.slice(0, 3),
        restOfTripUnsafe,
        restOfTripLimits: restOfTripUnsafe ? (laterSafety?.limits ?? []) : [],
      },
      truck: truck?.shown ?? null,
      deadline: deadlineDay ? { day: deadlineDay, status: deadlineStatus(arrivalMs, deadlineDay) } : null,
      route: lines,
      computedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * True when the driver has a newer position that's off the planned route, and
 * the route is old enough to be planned again.
 */
async function leftTheRoute(load: RouteLoad, cached: CachedRoute): Promise<boolean> {
  if (!cached.checkLine || Date.now() - cached.at < MIN_REROUTE_MS) return false;
  const latest = await latestDriverPosition(String(load.assignedDriverId ?? ""));
  if (!latest || latest.measuredMs <= cached.originMeasuredMs) return false;
  // A rough location (Wi-Fi, a weak indoor fix) is never a reason to plan again.
  if (latest.rough) return false;
  // The route started from a rough location: plan it again from a precise one.
  if (cached.originRough) return true;
  // Off the route even after allowing for the location's own error.
  return distanceToLineMeters(latest.position, cached.checkLine) - (latest.accuracy ?? 0) > OFF_ROUTE_METERS;
}

/**
 * The best route and arrival time for a load's next stop. Reused for 2
 * minutes per load, or planned again sooner when the driver leaves the route.
 */
export async function getLoadRoute(load: RouteLoad): Promise<LoadRoute> {
  const config = getAmazonLocationConfig();
  if (!config.routesEnabled) return unavailable("routes_off");
  const stop = nextStopFor(load.status);
  if (!stop || !load.assignedDriverId) return unavailable("not_tracked");

  const key = `${String(load._id)}:${stop}:${config.routePreference}:${stopsKey(load)}`;
  const cached = results.get(key);
  if (cached && Date.now() - cached.at < ROUTE_REUSE_MS) {
    if (!(await leftTheRoute(load, cached))) {
      health.reused += 1;
      return cached.result;
    }
    health.rerouted += 1;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = computeRoute(load, stop)
    .then((computed) => {
      const { result } = computed;
      // A withheld route is reused too, so Amazon isn't asked again for a
      // couple of minutes; a failure is retried on the next view instead.
      if (result.available || result.reason === "no_destination" || result.reason === "no_safe_route") results.set(key, computed);
      else results.delete(key);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function loadRouteHealthSnapshot() {
  const config = getAmazonLocationConfig();
  return {
    routesEnabled: config.routesEnabled,
    region: config.region,
    travelMode: config.travelMode,
    routePreference: config.routePreference,
    routesPerMinute: config.routesPerMinute,
    truck: config.truck,
    ...health,
  };
}

export function resetLoadRouteForTests() {
  routesClient = null;
  placesClient = null;
  clientRegion = "";
  results.clear();
  inFlight.clear();
  geocodes.clear();
  quotaWindowStart = 0;
  quotaUsed = 0;
  Object.assign(health, { computed: 0, reused: 0, rerouted: 0, withheldForLimits: 0, geocoded: 0, failed: 0, skippedByCap: 0, lastError: null, lastErrorAt: null });
}

/** Test hook: makes the cached route for a load look older than it is. */
export function ageLoadRouteForTests(loadId: string, byMs: number) {
  for (const [key, entry] of results) if (key.startsWith(`${loadId}:`)) entry.at -= byMs;
}
