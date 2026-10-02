import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation from "../models/DriverLocation.model";
import { canViewDriverExactGps, getDriverGpsTrackingLoads } from "../services/driverLocationAccess.service";
import {
  isGoogleGeocodingConfigured,
  lookupAddressAt,
  lookupAreaName,
  lookupPlace,
  MAX_PLACE_QUERY_LENGTH,
} from "../services/googleGeocoding.service";

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
  const areaName = Number.isFinite(lat) && Number.isFinite(lng) ? await lookupAreaName(lat, lng) : null;

  return res.status(200).json(new ApiResponse(200, { areaName, available: isGoogleGeocodingConfigured() }));
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
  const position = await lookupPlace(query);
  return res.status(200).json(new ApiResponse(200, { position, available: isGoogleGeocodingConfigured() }));
});

/**
 * GET /api/loads/address-at?lat=..&lng=..
 * The street address at a spot picked on the map in Create Load, to fill the
 * address fields. Staff only (the same people who can create loads),
 * rate-limited by the route.
 */
const getAddressAtPosition = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ApiError(400, "Pick a spot on the map to look up its address.");
  }
  const address = await lookupAddressAt(lat, lng);
  return res.status(200).json(new ApiResponse(200, { address, available: isGoogleGeocodingConfigured() }));
});

export default { getDriverAreaName, lookupPlacePosition, getAddressAtPosition };
