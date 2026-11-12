import { amazonPlacesSettings, areaNameAt, positionOfPlace } from "./amazonPlaces.service";
import { isGoogleGeocodingConfigured, lookupAreaName, lookupPlace } from "./googleGeocoding.service";

/*
 * Driver area names and place positions (2026-11-12): Amazon Location when
 * it's switched on (AMAZON_LOCATION_PLACES_ENABLED, the same setting as Create
 * Load's Pick on map), so every lookup then uses Amazon. Until then Google, if
 * it's set up, so nothing stops working before the Amazon setup is ready; once
 * Amazon is on, Google isn't asked at all and its server key can be removed.
 *
 * Amazon answers are kept for an hour. Positions are rounded to about 100 m
 * before an area name is asked for: an area name doesn't need more, and it
 * keeps the driver's exact spot out of the lookup.
 */

export const MAX_PLACE_QUERY_LENGTH = 200;
export type LatLng = { lat: number; lng: number };
export type PlaceLookupProvider = "amazon" | "google";

const HOUR_MS = 60 * 60 * 1000;
const MAX_CACHED = 2_000;
const cache = new Map<string, { value: unknown; until: number }>();

function remember<T>(key: string, value: T): T {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, until: Date.now() + HOUR_MS });
  return value;
}

function recall<T>(key: string): { hit: boolean; value: T | null } {
  const entry = cache.get(key);
  if (!entry || entry.until < Date.now()) {
    if (entry) cache.delete(key);
    return { hit: false, value: null };
  }
  return { hit: true, value: entry.value as T | null };
}

/** Which service answers place lookups now, or null when none is set up. */
export function placeLookupProvider(env: Record<string, string | undefined> = process.env): PlaceLookupProvider | null {
  if (amazonPlacesSettings(env).enabled) return "amazon";
  return isGoogleGeocodingConfigured(env) ? "google" : null;
}

export function placeLookupAvailable(): boolean {
  return placeLookupProvider() !== null;
}

/** "Dallas, TX" around a position, or null. */
export async function areaNameOf(lat: number, lng: number): Promise<string | null> {
  const provider = placeLookupProvider();
  if (provider === "google") return lookupAreaName(lat, lng);
  if (provider !== "amazon") return null;
  const rounded = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const key = `area:${rounded}`;
  const cached = recall<string>(key);
  if (cached.hit) return cached.value;
  try {
    return remember(key, await areaNameAt(Number(lat.toFixed(3)), Number(lng.toFixed(3))));
  } catch {
    return null; // Not kept, so the next viewer tries again.
  }
}

/** Where a US place or address is, or null. */
export async function positionOf(query: string): Promise<LatLng | null> {
  const text = String(query ?? "").trim().slice(0, MAX_PLACE_QUERY_LENGTH);
  if (!text) return null;
  const provider = placeLookupProvider();
  if (provider === "google") return lookupPlace(text);
  if (provider !== "amazon") return null;
  const key = `place:${text.toLowerCase()}`;
  const cached = recall<LatLng>(key);
  if (cached.hit) return cached.value;
  try {
    return remember(key, await positionOfPlace(text));
  } catch {
    return null;
  }
}

export function resetPlaceLookupForTests() {
  cache.clear();
}
