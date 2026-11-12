import {
  GeocodeCommand,
  GeoPlacesClient,
  GetPlaceCommand,
  ReverseGeocodeCommand,
  SuggestCommand,
  type Address,
} from "@aws-sdk/client-geo-places";
import { getAmazonLocationConfig } from "../config/amazonLocation";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";

/*
 * Amazon Location places for Create Load's "Pick on map" (2026-11-11): the
 * search box, a searched place's details, and the street address at a picked
 * spot. It replaces Google there, so the load's pickup and delivery spots come
 * from Amazon like its routes.
 *
 *   AMAZON_LOCATION_PLACES_ENABLED  "true" to search places and fill addresses
 *
 * Off by default. It uses the same AWS access, region and per-minute safety
 * cap as the routes (config/amazonLocation.ts); the server needs permission
 * for geo-places:Suggest, geo-places:GetPlace, geo-places:ReverseGeocode and
 * (since 2026-11-12, for driver area names, place pins and ZIP distances)
 * geo-places:Geocode.
 * Results that are saved on a load are asked for with the "Storage" use, as
 * Amazon's terms require.
 */

export type PlaceSettings = { enabled: boolean; region: string; perMinute: number };

export function amazonPlacesSettings(env: Record<string, string | undefined> = process.env): PlaceSettings {
  const config = getAmazonLocationConfig(env);
  return {
    enabled: String(env.AMAZON_LOCATION_PLACES_ENABLED ?? "").trim().toLowerCase() === "true",
    region: config.region,
    perMinute: config.routesPerMinute,
  };
}

export const MAX_PLACE_SEARCH_LENGTH = 200;
/** The middle of the US, to lean searches toward US places when the map has no better spot. */
const US_CENTER: [number, number] = [-98.5795, 39.8283];
const TIME_LIMIT_MS = 6_000;

export type PlaceSuggestion = { id: string; title: string; label: string };

export type PlaceFields = {
  /** A business name (dealership, auction, port), empty for a plain address. */
  name: string;
  /** House number and street. */
  address: string;
  city: string;
  /** Two-letter state code. */
  state: string;
  zip: string;
  /** Two-letter country code. */
  country: string;
  position: { lat: number; lng: number } | null;
  /** A street address or business, rather than only a city or ZIP code. */
  exact: boolean;
};

type PlaceLike = { PlaceType?: string; Title?: string; Address?: Address; Position?: number[] };

/** The load form's address fields from an Amazon place. */
export function placeFields(place: PlaceLike): PlaceFields {
  const address = place.Address ?? {};
  const street = [address.AddressNumber, address.Street].filter(Boolean).join(" ").trim();
  const business = place.PlaceType === "PointOfInterest";
  const [lng, lat] = Array.isArray(place.Position) ? place.Position : [];
  const placed = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
  return {
    name: business ? String(place.Title ?? "").trim() : "",
    address: street,
    city: String(address.Locality || address.District || address.SubRegion?.Name || "").trim(),
    state: String(address.Region?.Code || "").trim().toUpperCase(),
    zip: String(address.PostalCode || "").trim(),
    country: String(address.Country?.Code2 || "").trim().toUpperCase(),
    position: placed ? { lat: Number(lat), lng: Number(lng) } : null,
    exact: Boolean(street) || business,
  };
}

/** Search box suggestions: places only (not query refinements). */
export function suggestionsFrom(items: Array<{ Title?: string; SuggestResultItemType?: string; Place?: { PlaceId?: string; Address?: Address } }>): PlaceSuggestion[] {
  return items
    .filter((item) => item.SuggestResultItemType === "Place" && item.Place?.PlaceId)
    .map((item) => ({
      id: String(item.Place!.PlaceId),
      title: String(item.Title ?? "").trim(),
      label: String(item.Place?.Address?.Label ?? "").trim(),
    }));
}

let client: GeoPlacesClient | null = null;
let clientRegion = "";
let windowStart = 0;
let used = 0;

function placesClient(region: string) {
  if (!client || clientRegion !== region) {
    // Standard AWS credentials: the server's IAM role in production.
    client = new GeoPlacesClient({ region });
    clientRegion = region;
  }
  return client;
}

function takeQuota(perMinute: number): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    used = 0;
  }
  if (used >= perMinute) return false;
  used += 1;
  return true;
}

const BUSY = "Too many place lookups right now. Wait a moment and try again, or click the map where the driver should go.";
const NOT_WORKING = "Place search isn't working right now. Click the map where the driver should go and fill in the address yourself.";

async function send<T>(settings: PlaceSettings, what: string, run: (client: GeoPlacesClient, abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  if (!takeQuota(settings.perMinute)) throw new ApiError(429, BUSY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIME_LIMIT_MS);
  try {
    return await run(placesClient(settings.region), controller.signal);
  } catch (error) {
    logger.warn({ error: (error as Error)?.name ?? "unknown", what }, "Amazon Location place lookup failed");
    throw new ApiError(502, NOT_WORKING);
  } finally {
    clearTimeout(timer);
  }
}

/** Places matching what the dispatcher typed, nearest to the map's centre first. */
export async function searchPlaces(query: string, near?: { lat: number; lng: number } | null, settings = amazonPlacesSettings()): Promise<PlaceSuggestion[]> {
  const response = await send(settings, "suggest", (places, abortSignal) =>
    places.send(
      new SuggestCommand({
        QueryText: query,
        MaxResults: 6,
        BiasPosition: near ? [near.lng, near.lat] : US_CENTER,
        Filter: { IncludeCountries: ["USA"] },
      }),
      { abortSignal },
    ),
  );
  return suggestionsFrom(response.ResultItems ?? []);
}

/** A searched place's address and position, to save on the load. */
export async function placeDetails(placeId: string, settings = amazonPlacesSettings()): Promise<PlaceFields | null> {
  const response = await send(settings, "get_place", (places, abortSignal) =>
    places.send(new GetPlaceCommand({ PlaceId: placeId, IntendedUse: "Storage" }), { abortSignal }),
  );
  return response ? placeFields(response) : null;
}

/** The street address at a picked spot, to save on the load. Null when there isn't one nearby. */
export async function addressAtPosition(lat: number, lng: number, settings = amazonPlacesSettings()): Promise<PlaceFields | null> {
  const response = await send(settings, "reverse_geocode", (places, abortSignal) =>
    places.send(
      new ReverseGeocodeCommand({ QueryPosition: [lng, lat], MaxResults: 1, IntendedUse: "Storage" }),
      { abortSignal },
    ),
  );
  const match = response.ResultItems?.[0];
  if (!match) return null;
  const fields = placeFields(match);
  return fields.address || fields.city || fields.zip ? fields : null;
}

/**
 * Where a US place or address is (the driver's load pins, the customer's
 * shipment map), or null when Amazon finds nothing (2026-11-12). The result is
 * cached by the caller, so it's asked for with the "Storage" use.
 */
export async function positionOfPlace(query: string, settings = amazonPlacesSettings()): Promise<{ lat: number; lng: number } | null> {
  const response = await send(settings, "geocode_place", (places, abortSignal) =>
    places.send(
      new GeocodeCommand({ QueryText: query, MaxResults: 1, Filter: { IncludeCountries: ["USA"] }, IntendedUse: "Storage" }),
      { abortSignal },
    ),
  );
  const match = response.ResultItems?.[0];
  return match ? placeFields(match).position : null;
}

/** The middle of a US ZIP code, for quote distances and nearby drivers (2026-11-12). */
export async function positionOfZip(zip: string, settings = amazonPlacesSettings()): Promise<{ lat: number; lng: number } | null> {
  const response = await send(settings, "geocode_zip", (places, abortSignal) =>
    places.send(
      new GeocodeCommand({
        QueryComponents: { PostalCode: zip, Country: "USA" },
        MaxResults: 1,
        Filter: { IncludeCountries: ["USA"], IncludePlaceTypes: ["PostalCode"] },
        IntendedUse: "Storage",
      }),
      { abortSignal },
    ),
  );
  const match = response.ResultItems?.[0];
  return match ? placeFields(match).position : null;
}

/** "Dallas, TX" from an Amazon place: the city and state, or whichever is known. */
export function areaNameFrom(fields: Pick<PlaceFields, "city" | "state">): string | null {
  const parts = [fields.city.trim(), fields.state.trim()].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The area ("Dallas, TX") around a position, for the Driver Tracker popup (2026-11-12). */
export async function areaNameAt(lat: number, lng: number, settings = amazonPlacesSettings()): Promise<string | null> {
  const response = await send(settings, "area_name", (places, abortSignal) =>
    places.send(
      new ReverseGeocodeCommand({ QueryPosition: [lng, lat], MaxResults: 1, IntendedUse: "Storage" }),
      { abortSignal },
    ),
  );
  const match = response.ResultItems?.[0];
  return match ? areaNameFrom(placeFields(match)) : null;
}

export function resetAmazonPlacesForTests() {
  client = null;
  clientRegion = "";
  windowStart = 0;
  used = 0;
}
