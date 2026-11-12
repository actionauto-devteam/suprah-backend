import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation from "../models/DriverLocation.model";
import { canViewDriverExactGps, getDriverGpsTrackingLoads } from "../services/driverLocationAccess.service";
import { areaNameOf, MAX_PLACE_QUERY_LENGTH, placeLookupAvailable, positionOf } from "../services/placeLookup.service";
import {
  addressAtPosition,
  amazonPlacesSettings,
  MAX_PLACE_SEARCH_LENGTH,
  placeDetails,
  searchPlaces,
} from "../services/amazonPlaces.service";

/** A map position from the query string, or null when it isn't one. */
function positionFrom(latValue: unknown, lngValue: unknown): { lat: number; lng: number } | null {
  if (latValue === undefined || lngValue === undefined || latValue === "" || lngValue === "") return null;
  const lat = Number(latValue);
  const lng = Number(lngValue);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/**
 * GET /api/driver-tracking/drivers/:driverId/area-name
 * The area ("Dallas, TX") around the driver's stored position, for the Driver
 * Tracker popup. Only for people who can see that driver's exact GPS in the
 * current organization. It uses the stored position, never one sent by the
 * browser.
 */
const getDriverAreaName = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const driverId = String(req.params.driverId ?? "");
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "This driver link isn't valid. Open the driver from Driver Tracker again.");
  }

  const loads = await getDriverGpsTrackingLoads(driverId, req.orgId as string);
  if (!canViewDriverExactGps(req.user as any, loads)) {
    throw new ApiError(
      403,
      "The area name is shown only to people who can see this driver's location: the responsible dispatcher and organization admins, while a load is accepted.",
    );
  }

  const location: any = await DriverLocation.findOne({ userId: driverId }).select("coords").lean();
  const lat = Number(location?.coords?.lat);
  const lng = Number(location?.coords?.lng);
  // Amazon Location once it's switched on, Google until then (2026-11-12).
  const areaName = Number.isFinite(lat) && Number.isFinite(lng) ? await areaNameOf(lat, lng) : null;

  return res.status(200).json(new ApiResponse(200, { areaName, available: placeLookupAvailable() }));
});

/**
 * GET /api/driver-tracking/places/lookup?q=Dallas, TX
 * Where a US place is, for the pickup/delivery pins on the driver's
 * available-load map. Signed-in drivers only, rate-limited by the route.
 */
const lookupPlacePosition = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query || query.length > MAX_PLACE_QUERY_LENGTH) {
    throw new ApiError(400, `Enter a place to look up (up to ${MAX_PLACE_QUERY_LENGTH} characters).`);
  }
  const position = await positionOf(query);
  return res.status(200).json(new ApiResponse(200, { position, available: placeLookupAvailable() }));
});

/**
 * GET /api/loads/address-at?lat=..&lng=..
 * The street address at a spot picked on the map in Create Load, to fill the
 * address fields. Staff only (the same people who can create loads),
 * rate-limited by the route. Amazon Location since 2026-11-11.
 */
const getAddressAtPosition = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const position = positionFrom(req.query.lat, req.query.lng);
  if (!position) throw new ApiError(400, "Pick a spot on the map to look up its address.");
  const settings = amazonPlacesSettings();
  if (!settings.enabled) return res.status(200).json(new ApiResponse(200, { address: null, available: false }));
  const found = await addressAtPosition(position.lat, position.lng, settings);
  const address = found
    ? { address: found.address, city: found.city, state: found.state, zip: found.zip, country: found.country }
    : null;
  return res.status(200).json(new ApiResponse(200, { address, available: true }));
});

/**
 * GET /api/loads/place-search?q=..&lat=..&lng=..
 * Create Load's map search box: places matching what was typed, nearest to
 * the map's centre first (Amazon Location, 2026-11-11). Staff only,
 * rate-limited by the route.
 */
const searchPlacesForLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query || query.length > MAX_PLACE_SEARCH_LENGTH) {
    throw new ApiError(400, `Type a place or address to search for (up to ${MAX_PLACE_SEARCH_LENGTH} characters).`);
  }
  const settings = amazonPlacesSettings();
  if (!settings.enabled) return res.status(200).json(new ApiResponse(200, { places: [], available: false }));
  const places = await searchPlaces(query, positionFrom(req.query.lat, req.query.lng), settings);
  return res.status(200).json(new ApiResponse(200, { places, available: true }));
});

/**
 * GET /api/loads/place-details?id=..
 * A searched place's address and position for Create Load (Amazon Location,
 * 2026-11-11). Staff only, rate-limited by the route.
 */
const getPlaceForLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id || id.length > 2_000) throw new ApiError(400, "Choose a place from the search results.");
  const settings = amazonPlacesSettings();
  if (!settings.enabled) return res.status(200).json(new ApiResponse(200, { place: null, available: false }));
  const place = await placeDetails(id, settings);
  return res.status(200).json(new ApiResponse(200, { place, available: true }));
});

export default { getDriverAreaName, lookupPlacePosition, getAddressAtPosition, searchPlacesForLoad, getPlaceForLoad };
