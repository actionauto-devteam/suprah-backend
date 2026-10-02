/*
 * Server-side Google Geocoding for map labels:
 *   - the area name in the Driver Tracker's selected-driver popup, and
 *   - pickup/delivery pins on the driver's available-load map.
 *
 * Uses GOOGLE_MAPS_SERVER_API_KEY, a server key kept apart from the browser
 * key (restrict it to the Geocoding API and the backend's IP addresses). Without
 * it, lookups return null and the maps simply show no place name or pins. The
 * key is never logged or returned; failures are recorded by Google's status
 * code only.
 *
 * Results are kept in a small in-memory cache for one hour. Google's terms
 * limit how long geocoding results may be stored, so check them before making
 * this longer or moving it to a shared store.
 */
import logger from "../utils/logger";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 1000;
const REQUEST_TIMEOUT_MS = 5000;
export const MAX_PLACE_QUERY_LENGTH = 200;

type Env = Record<string, string | undefined>;
export type LatLng = { lat: number; lng: number };

function serverKey(env: Env = process.env) {
  return String(env.GOOGLE_MAPS_SERVER_API_KEY ?? "").trim();
}

export function isGoogleGeocodingConfigured(env: Env = process.env) {
  return Boolean(serverKey(env));
}

// Small expiring cache; Map keeps insertion order, so the oldest entry goes first.
class ExpiringCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  get(key: string): { value: T } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value };
  }
  set(key: string, value: T) {
    this.entries.delete(key);
    if (this.entries.size >= CACHE_MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  get size() {
    return this.entries.size;
  }
  clear() {
    this.entries.clear();
  }
}

const placeNames = new ExpiringCache<string | null>();
const places = new ExpiringCache<LatLng | null>();
const inFlight = new Map<string, Promise<unknown>>();

const health = {
  lookups: 0,
  cacheHits: 0,
  lastSuccessAt: null as Date | null,
  lastFailure: null as { reason: string; at: Date } | null,
};

function recordFailure(reason: string) {
  health.lastFailure = { reason, at: new Date() };
  logger.warn({ reason }, "Google Geocoding lookup failed");
}

/** Results, [] when Google found nothing, or null when the lookup failed. */
async function geocode(params: Record<string, string>): Promise<any[] | null> {
  const key = serverKey();
  if (!key) return null;
  const url = new URL(GEOCODE_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("key", key);

  health.lookups += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      recordFailure(`HTTP ${response.status}`);
      return null;
    }
    const body: any = await response.json();
    if (body?.status === "OK") {
      health.lastSuccessAt = new Date();
      return Array.isArray(body.results) ? body.results : [];
    }
    if (body?.status === "ZERO_RESULTS") {
      health.lastSuccessAt = new Date();
      return [];
    }
    // REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST... The status only:
    // error_message can describe the key's restrictions.
    recordFailure(String(body?.status || "unexpected response"));
    return null;
  } catch {
    recordFailure(controller.signal.aborted ? "timed out" : "unreachable");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// One request per key at a time, so a burst of viewers shares a lookup.
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function component(result: any, type: string, form: "long_name" | "short_name" = "long_name"): string {
  const match = (result?.address_components ?? []).find((item: any) => Array.isArray(item?.types) && item.types.includes(type));
  return String(match?.[form] ?? "").trim();
}

/** "City, ST" (or "County, ST" outside towns) from reverse-geocoding results. */
export function areaNameFromResults(results: any[]): string | null {
  const firstWith = (type: string, form?: "long_name" | "short_name") => {
    for (const result of results) {
      const value = component(result, type, form);
      if (value) return value;
    }
    return "";
  };
  const town =
    firstWith("locality") || firstWith("postal_town") || firstWith("sublocality") || firstWith("administrative_area_level_3");
  const area = town || firstWith("administrative_area_level_2");
  const state = firstWith("administrative_area_level_1", "short_name");
  const name = [area, state].filter(Boolean).join(", ");
  return name || null;
}

const validLatLng = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * The area name around a position. Coordinates are rounded to about 100 m
 * before they're sent or cached: an area name doesn't need more, and it keeps
 * both the cost and what leaves Suprah low.
 */
export async function lookupAreaName(lat: number, lng: number): Promise<string | null> {
  if (!validLatLng(lat, lng) || !isGoogleGeocodingConfigured()) return null;
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = placeNames.get(cacheKey);
  if (cached) {
    health.cacheHits += 1;
    return cached.value;
  }
  return once(`area:${cacheKey}`, async () => {
    const results = await geocode({ latlng: cacheKey });
    if (!results) return null; // Failures aren't cached, so the next viewer retries.
    const name = areaNameFromResults(results);
    placeNames.set(cacheKey, name);
    return name;
  });
}

export type StreetAddress = {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  placeId: string | null;
};

/** The street address of the most specific result (a building or street address when there is one). */
export function streetAddressFromResults(results: any[]): StreetAddress | null {
  const best =
    results.find((result) => (result?.types ?? []).some((type: string) => ["street_address", "premise", "subpremise"].includes(type))) ??
    results.find((result) => component(result, "route")) ??
    results[0];
  if (!best) return null;
  const street = [component(best, "street_number"), component(best, "route", "short_name")].filter(Boolean).join(" ");
  const city =
    component(best, "locality") ||
    component(best, "postal_town") ||
    component(best, "sublocality") ||
    component(best, "administrative_area_level_3") ||
    component(best, "neighborhood");
  return {
    address: street || String(best.formatted_address ?? "").split(",")[0]?.trim() || "",
    city,
    state: component(best, "administrative_area_level_1", "short_name"),
    zip: component(best, "postal_code"),
    country: component(best, "country", "short_name"),
    placeId: typeof best.place_id === "string" ? best.place_id : null,
  };
}

const streetAddresses = new ExpiringCache<StreetAddress | null>();

/**
 * The street address at an exact spot, for the map picker on Create Load.
 * Not rounded like the area name: the street number needs the exact spot.
 */
export async function lookupAddressAt(lat: number, lng: number): Promise<StreetAddress | null> {
  if (!validLatLng(lat, lng) || !isGoogleGeocodingConfigured()) return null;
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = streetAddresses.get(cacheKey);
  if (cached) {
    health.cacheHits += 1;
    return cached.value;
  }
  return once(`street:${cacheKey}`, async () => {
    const results = await geocode({ latlng: cacheKey });
    if (!results) return null;
    const address = streetAddressFromResults(results);
    streetAddresses.set(cacheKey, address);
    return address;
  });
}

/** The position of a US place ("Dallas, TX", an address, a ZIP code). */
export async function lookupPlace(query: string): Promise<LatLng | null> {
  const text = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_PLACE_QUERY_LENGTH || !isGoogleGeocodingConfigured()) return null;
  const cacheKey = text.toLowerCase();
  const cached = places.get(cacheKey);
  if (cached) {
    health.cacheHits += 1;
    return cached.value;
  }
  return once(`place:${cacheKey}`, async () => {
    const results = await geocode({ address: text, components: "country:US" });
    if (!results) return null;
    const location = results[0]?.geometry?.location;
    const point =
      location && validLatLng(Number(location.lat), Number(location.lng))
        ? { lat: Number(location.lat), lng: Number(location.lng) }
        : null;
    places.set(cacheKey, point);
    return point;
  });
}

/** For System Stats: whether it's set up and how it's doing. Never the key. */
export function googleGeocodingHealthSnapshot() {
  return {
    configured: isGoogleGeocodingConfigured(),
    lookups: health.lookups,
    cacheHits: health.cacheHits,
    cachedEntries: placeNames.size + places.size + streetAddresses.size,
    lastSuccessAt: health.lastSuccessAt,
    lastFailure: health.lastFailure,
  };
}

export function resetGoogleGeocodingForTests() {
  placeNames.clear();
  places.clear();
  streetAddresses.clear();
  inFlight.clear();
  health.lookups = 0;
  health.cacheHits = 0;
  health.lastSuccessAt = null;
  health.lastFailure = null;
}
