import { distanceMeters } from "../utils/geofence";
import { amazonPlacesSettings, positionOfStreetAddress, type PlaceSettings } from "./amazonPlaces.service";

/*
 * Map pins for the partner service locations on the customer Service Network
 * page (2026-11-18).
 *
 * The April import placed the pins with a free OpenStreetMap search. For about
 * a third of the Utah stores it found nothing (and saved 0,0, off the coast of
 * Africa) or matched only the street or the city, 0.2 to 3.6 miles from the
 * shop, so the pin, the distance and "Closest" were wrong there.
 *
 * A pin now comes only from a match to the house itself, in the store's own
 * state and ZIP code:
 *   1. the US Census address lookup (free, no key, US public data), then
 *   2. Amazon Location, where the server's Amazon access is switched on
 *      (AMAZON_LOCATION_PLACES_ENABLED), for addresses the Census can't place.
 * A match to only a street, ZIP code or city is never used: no pin is better
 * than a wrong one. Used by scripts/fix-service-location-pins.ts and
 * scripts/import-jiffy-locations.ts.
 */

export type StoreAddress = { address: string; city: string; state: string; zipCode: string };
/** [longitude, latitude], the order map pins are saved in. */
export type LngLat = [number, number];
export type StorePin = { coordinates: LngLat; source: "census" | "amazon"; matched: string };
export type PinLookup = { pin: StorePin | null; failed: Array<"census" | "amazon"> };

/**
 * A saved pin that can go on a map: two finite numbers inside the US (the
 * partner network is US only), and not 0,0, which the April import saved
 * when it found nothing.
 */
export function usablePin(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lng, lat] = value;
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // The US, Alaska and Hawaii included, with room to spare.
  if (lat < 18 || lat > 72 || lng < -180 || lng > -65) return null;
  return [lng, lat];
}

export function oneLineAddress(store: StoreAddress): string {
  const part = (value: string) => String(value ?? "").replace(/\s+/g, " ").trim();
  return `${part(store.address)}, ${part(store.city)}, ${part(store.state)} ${part(store.zipCode)}`.trim();
}

const sameState = (store: StoreAddress, state: unknown) =>
  String(state ?? "").trim().toUpperCase() === store.state.trim().toUpperCase();
const sameZip = (store: StoreAddress, zip: unknown) => {
  const want = store.zipCode.trim().slice(0, 5);
  return /^\d{5}$/.test(want) && String(zip ?? "").trim().slice(0, 5) === want;
};

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const TIME_LIMIT_MS = 8_000;

type CensusMatch = {
  coordinates?: { x?: unknown; y?: unknown };
  addressComponents?: { state?: unknown; zip?: unknown };
  matchedAddress?: unknown;
};

/** The Census answer's first match, used only when it's in the store's state and ZIP code. */
export function censusPinFrom(body: unknown, store: StoreAddress): StorePin | null {
  const match = (body as { result?: { addressMatches?: CensusMatch[] } } | null)?.result?.addressMatches?.[0];
  if (!match) return null;
  const coordinates = usablePin([Number(match.coordinates?.x), Number(match.coordinates?.y)]);
  if (!coordinates || !sameState(store, match.addressComponents?.state) || !sameZip(store, match.addressComponents?.zip)) return null;
  return { coordinates, source: "census", matched: String(match.matchedAddress ?? "") };
}

/** The Census lookup always matches a house number on its street, never only a street or city. */
export async function censusPin(store: StoreAddress, fetchImpl: typeof fetch = fetch): Promise<StorePin | null> {
  const url = `${CENSUS_URL}?address=${encodeURIComponent(oneLineAddress(store))}&benchmark=Public_AR_Current&format=json`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIME_LIMIT_MS) });
  if (!response.ok) throw new Error(`Census address lookup answered ${response.status}`);
  return censusPinFrom(await response.json(), store);
}

/** The store's pin from the Census, then Amazon (when switched on). A failed lookup is reported, not treated as "not found". */
export async function findStorePin(
  store: StoreAddress,
  options: { fetchImpl?: typeof fetch; amazon?: PlaceSettings } = {},
): Promise<PinLookup> {
  const failed: PinLookup["failed"] = [];
  try {
    const pin = await censusPin(store, options.fetchImpl);
    if (pin) return { pin, failed };
  } catch {
    failed.push("census");
  }

  const amazon = options.amazon ?? amazonPlacesSettings();
  if (amazon.enabled) {
    try {
      const place = await positionOfStreetAddress(oneLineAddress(store), amazon);
      const coordinates = place ? usablePin([place.position.lng, place.position.lat]) : null;
      if (place && coordinates && sameState(store, place.state) && sameZip(store, place.zip)) {
        const matched = [place.address, place.city, place.state, place.zip].filter(Boolean).join(", ");
        return { pin: { coordinates, source: "amazon", matched }, failed };
      }
    } catch {
      failed.push("amazon");
    }
  }
  return { pin: null, failed };
}

/** Pins closer than this to the house match are already right and stay as they are. */
export const SAME_SPOT_METERS = 50;

export type PinPlan =
  | { action: "keep" }
  | { action: "move"; to: LngLat; source: StorePin["source"]; matched: string; movedMeters: number | null }
  | { action: "check"; reason: "no-match" | "lookup-failed"; hasPin: boolean };

/**
 * What to do with a store's saved pin: keep it (already at the house), move it
 * to the house match, or leave it for a person to check on a map (no house
 * match, or a lookup failed and should be run again).
 */
export function planStorePin(current: unknown, found: PinLookup): PinPlan {
  const now = usablePin(current);
  if (found.pin) {
    const [lng, lat] = found.pin.coordinates;
    const movedMeters = now ? distanceMeters(now[1], now[0], lat, lng) : null;
    if (movedMeters !== null && movedMeters <= SAME_SPOT_METERS) return { action: "keep" };
    return { action: "move", to: found.pin.coordinates, source: found.pin.source, matched: found.pin.matched, movedMeters };
  }
  return { action: "check", reason: found.failed.length ? "lookup-failed" : "no-match", hasPin: Boolean(now) };
}
