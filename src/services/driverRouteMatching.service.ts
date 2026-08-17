import axios from "axios";
import DriverLocation from "../models/DriverLocation.model";
import { cacheService } from "./cache.service";
import { calculateDistance, getCoordinatesFromZip } from "../utils/calculations";
import logger from "../utils/logger";

export type ServiceAreaCompatibilityStatus = "within" | "outside" | "unknown";
export type PreferredRouteCompatibilityStatus =
  | "preferred"
  | "not_preferred"
  | "unknown";
export type ProximityCompatibilitySource = "live_gps" | "home_base" | null;

export interface DriverRouteCompatibilitySignals {
  serviceArea: {
    status: ServiceAreaCompatibilityStatus;
    serviceRadiusMiles: number | null;
    distanceFromHomeBaseToPickupMiles: number | null;
    homeBaseLabel: string | null;
  };
  preferredRoute: {
    status: PreferredRouteCompatibilityStatus;
    originState: string | null;
    originCity?: string | null;
    destinationState: string | null;
    destinationCity?: string | null;
    matchedRoute: string | null;
    matchLevel?: "city" | "mixed" | "state" | null;
    preferredRoutes: string[];
  };
  proximity: {
    distanceToPickupMiles: number | null;
    source: ProximityCompatibilitySource;
    lastSeenAt: string | null;
  };
}

interface CoordinatePair {
  lat: number;
  lon: number;
}

const PRESENCE_STALE_MS = 5 * 60 * 1000;
const homeBaseGeocodeInFlight = new Map<string, Promise<CoordinatePair | null>>();

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

const VALID_STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));
const STATE_NAMES_LONGEST_FIRST = Object.keys(STATE_NAME_TO_CODE).sort(
  (a, b) => b.length - a.length,
);

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function coordinatesFromUnknown(value: unknown): CoordinatePair | null {
  if (Array.isArray(value) && value.length >= 2) {
    const lon = finiteNumber(value[0]);
    const lat = finiteNumber(value[1]);
    if (lat != null && lon != null) return { lat, lon };
  }

  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const lat = finiteNumber(item.lat ?? item.latitude);
    const lon = finiteNumber(item.lng ?? item.lon ?? item.longitude);
    if (lat != null && lon != null) return { lat, lon };
  }

  return null;
}

function normalizeState(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (VALID_STATE_CODES.has(upper)) return upper;

  return STATE_NAME_TO_CODE[raw.toLowerCase()] ?? null;
}

function normalizeCity(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^,+|,+$/g, "")
    .trim();
  return normalized || null;
}

function cityKey(value: unknown): string | null {
  const city = normalizeCity(value);
  if (!city) return null;
  return city
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePreferredRoutes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((route) => String(route ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

interface ParsedRouteEndpoint {
  city: string | null;
  state: string | null;
}

function parseRouteEndpoint(rawEndpoint: string): ParsedRouteEndpoint {
  const endpoint = rawEndpoint.trim();
  if (!endpoint) return { city: null, state: null };

  const commaParts = endpoint
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (commaParts.length >= 2) {
    const state = normalizeState(commaParts[commaParts.length - 1]);
    if (state) {
      return {
        city: normalizeCity(commaParts.slice(0, -1).join(", ")),
        state,
      };
    }
  }

  const directState = normalizeState(endpoint);
  if (directState) return { city: null, state: directState };

  const abbreviationMatch = endpoint.match(/^(.*?)[\s,]+([A-Za-z]{2})$/);
  if (abbreviationMatch) {
    const state = normalizeState(abbreviationMatch[2]);
    if (state) {
      return {
        city: normalizeCity(abbreviationMatch[1]),
        state,
      };
    }
  }

  const lower = endpoint.toLowerCase();
  for (const stateName of STATE_NAMES_LONGEST_FIRST) {
    if (lower === stateName) {
      return { city: null, state: STATE_NAME_TO_CODE[stateName] };
    }
    if (lower.endsWith(` ${stateName}`) || lower.endsWith(`, ${stateName}`)) {
      const cityPart = endpoint.slice(0, endpoint.length - stateName.length);
      return {
        city: normalizeCity(cityPart.replace(/[\s,]+$/, "")),
        state: STATE_NAME_TO_CODE[stateName],
      };
    }
  }

  return { city: null, state: null };
}

function parsePreferredRoute(route: string): {
  origin: ParsedRouteEndpoint;
  destination: ParsedRouteEndpoint;
  bidirectional: boolean;
} {
  const bidirectional = /↔|<->|⇄/.test(route);
  const parts = route
    .split(/\s*(?:↔|<->|⇄|→|->|\bto\b|\s[-–—]\s)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      origin: parseRouteEndpoint(parts[0]),
      destination: parseRouteEndpoint(parts[1]),
      bidirectional,
    };
  }

  const stateTokens = route.toUpperCase().match(/\b[A-Z]{2}\b/g) ?? [];
  return {
    origin: { city: null, state: normalizeState(stateTokens[0]) },
    destination: { city: null, state: normalizeState(stateTokens[1]) },
    bidirectional,
  };
}

function routeEndpointMatches(
  endpoint: ParsedRouteEndpoint,
  loadState: string | null,
  loadCity: string | null,
) {
  if (!endpoint.state || endpoint.state !== loadState) return false;
  if (!endpoint.city) return true;

  const expectedCity = cityKey(endpoint.city);
  const actualCity = cityKey(loadCity);
  return Boolean(expectedCity && actualCity && expectedCity === actualCity);
}

function homeBaseLabel(profile: any): string | null {
  const parts = [profile?.homeBase?.city, profile?.homeBase?.state]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function geocodeHomeBase(profile: any): Promise<CoordinatePair | null> {
  const direct = coordinatesFromUnknown(profile?.homeBase?.coordinates);
  if (direct) return direct;

  const zip = String(profile?.homeBase?.zip ?? "").trim();
  if (/^\d{5}(?:-\d{4})?$/.test(zip)) {
    const byZip = await getCoordinatesFromZip(zip.slice(0, 5));
    if (byZip) return byZip;
  }

  const city = String(profile?.homeBase?.city ?? "").trim();
  const state = String(profile?.homeBase?.state ?? "").trim();
  if (!city || !state) return null;

  const cacheKey = `driver:home-base:${city.toLowerCase()}:${state.toLowerCase()}`;
  const cached = await cacheService.get<CoordinatePair>(cacheKey);
  if (cached) return cached;

  const existing = homeBaseGeocodeInFlight.get(cacheKey);
  if (existing) return existing;

  const lookup = (async (): Promise<CoordinatePair | null> => {
    try {
      const query = encodeURIComponent(`${city}, ${state}, USA`);
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/search?q=${query}&countrycodes=us&format=json&limit=1`,
        {
          headers: { "User-Agent": "VehicleShippingApp/1.0" },
          timeout: 8000,
        },
      );

      const first = response.data?.[0];
      const lat = finiteNumber(first?.lat);
      const lon = finiteNumber(first?.lon);
      if (lat == null || lon == null) return null;

      const result = { lat, lon };
      await cacheService.set(cacheKey, result, 86400 * 7);
      return result;
    } catch (error) {
      logger.warn(
        { error, city, state },
        "Non-fatal: could not geocode driver home base for load matching",
      );
      return null;
    } finally {
      homeBaseGeocodeInFlight.delete(cacheKey);
    }
  })();

  homeBaseGeocodeInFlight.set(cacheKey, lookup);
  return lookup;
}

async function resolvePickupCoordinates(load: any): Promise<CoordinatePair | null> {
  const direct =
    coordinatesFromUnknown(load?.pickupLocation?.coordinates) ??
    coordinatesFromUnknown(load?.pickupCoordinates);
  if (direct) return direct;

  const zip = String(load?.pickupLocation?.zip ?? load?.pickupZip ?? "").trim();
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) return null;
  return getCoordinatesFromZip(zip.slice(0, 5));
}

function resolveLiveCoordinates(location: any): {
  coords: CoordinatePair | null;
  lastSeenAt: string | null;
} {
  const lastSeen = location?.lastSeenAt ? new Date(location.lastSeenAt) : null;
  const lastSeenAt =
    lastSeen && Number.isFinite(lastSeen.getTime()) ? lastSeen.toISOString() : null;
  const stale = !lastSeen || Date.now() - lastSeen.getTime() > PRESENCE_STALE_MS;
  const sharing = location?.isSharing !== false;
  const coords = !stale && sharing ? coordinatesFromUnknown(location?.coords) : null;
  return { coords, lastSeenAt };
}

export async function evaluateDriverRouteCompatibility(
  profile: any | null | undefined,
  load: any,
  location?: any | null,
): Promise<DriverRouteCompatibilitySignals> {
  const [pickupCoords, homeBaseCoords] = await Promise.all([
    resolvePickupCoordinates(load),
    geocodeHomeBase(profile),
  ]);

  const radius = finiteNumber(profile?.serviceRadius);
  const serviceRadiusMiles = radius != null && radius > 0 ? radius : null;
  const serviceDistance =
    pickupCoords && homeBaseCoords
      ? calculateDistance(
          homeBaseCoords.lat,
          homeBaseCoords.lon,
          pickupCoords.lat,
          pickupCoords.lon,
        )
      : null;

  const serviceAreaStatus: ServiceAreaCompatibilityStatus =
    serviceRadiusMiles == null || serviceDistance == null
      ? "unknown"
      : serviceDistance <= serviceRadiusMiles
        ? "within"
        : "outside";

  const originState = normalizeState(load?.pickupLocation?.state ?? load?.originState);
  const destinationState = normalizeState(
    load?.deliveryLocation?.state ?? load?.destinationState,
  );
  const originCity = normalizeCity(load?.pickupLocation?.city);
  const destinationCity = normalizeCity(load?.deliveryLocation?.city);
  const preferredRoutes = normalizePreferredRoutes(profile?.preferredRoutes);

  let preferredRouteStatus: PreferredRouteCompatibilityStatus = "unknown";
  let matchedRoute: string | null = null;
  let preferredRouteMatchLevel: "city" | "mixed" | "state" | null = null;

  if (originState && destinationState && preferredRoutes.length > 0) {
    preferredRouteStatus = "not_preferred";
    for (const route of preferredRoutes) {
      const parsed = parsePreferredRoute(route);
      const forward =
        routeEndpointMatches(parsed.origin, originState, originCity) &&
        routeEndpointMatches(
          parsed.destination,
          destinationState,
          destinationCity,
        );
      const reverse =
        parsed.bidirectional &&
        routeEndpointMatches(parsed.origin, destinationState, destinationCity) &&
        routeEndpointMatches(parsed.destination, originState, originCity);

      if (forward || reverse) {
        preferredRouteStatus = "preferred";
        matchedRoute = route;
        const cityCount =
          Number(Boolean(parsed.origin.city)) +
          Number(Boolean(parsed.destination.city));
        preferredRouteMatchLevel =
          cityCount === 2 ? "city" : cityCount === 1 ? "mixed" : "state";
        break;
      }
    }
  }

  const live = resolveLiveCoordinates(location);
  const proximityOrigin = live.coords ?? homeBaseCoords;
  const proximitySource: ProximityCompatibilitySource = live.coords
    ? "live_gps"
    : homeBaseCoords
      ? "home_base"
      : null;
  const distanceToPickupMiles =
    pickupCoords && proximityOrigin
      ? calculateDistance(
          proximityOrigin.lat,
          proximityOrigin.lon,
          pickupCoords.lat,
          pickupCoords.lon,
        )
      : null;

  return {
    serviceArea: {
      status: serviceAreaStatus,
      serviceRadiusMiles,
      distanceFromHomeBaseToPickupMiles: serviceDistance,
      homeBaseLabel: homeBaseLabel(profile),
    },
    preferredRoute: {
      status: preferredRouteStatus,
      originState,
      originCity,
      destinationState,
      destinationCity,
      matchedRoute,
      matchLevel: preferredRouteMatchLevel,
      preferredRoutes,
    },
    proximity: {
      distanceToPickupMiles,
      source: proximitySource,
      lastSeenAt: live.lastSeenAt,
    },
  };
}

export async function getDriverLocationForMatching(
  driverId: string,
  organizationId: string,
) {
  return DriverLocation.findOne({ userId: driverId, organizationId })
    .select("coords isSharing lastSeenAt")
    .lean();
}