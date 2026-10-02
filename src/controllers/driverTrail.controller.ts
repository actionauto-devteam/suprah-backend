import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import LoadTripPoint from "../models/LoadTripPoint.model";
import { canViewDriverExactGps, getDriverGpsTrackingLoads } from "../services/driverLocationAccess.service";

const DEFAULT_TRAIL_MINUTES = 120;
const MIN_TRAIL_MINUTES = 15;
const MAX_TRAIL_MINUTES = 360;
const MAX_TRAIL_POINTS = 600;

/**
 * GET /api/driver-tracking/drivers/:driverId/recent-trail?minutes=120
 * The selected driver's recent route on the Driver Tracker map, from trip
 * history. Only positions recorded on tracked loads (Accepted to Delivered) in
 * the current organization that this person may see exactly: the load's
 * responsible dispatcher and the organization's admins, the same rule as live
 * GPS.
 */
const getRecentTrail = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const driverId = String(req.params.driverId ?? "");
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "This driver link isn't valid. Open the driver from Driver Tracker again.");
  }
  const requested = Number(req.query.minutes ?? DEFAULT_TRAIL_MINUTES);
  const minutes = Number.isFinite(requested)
    ? Math.min(MAX_TRAIL_MINUTES, Math.max(MIN_TRAIL_MINUTES, Math.round(requested)))
    : DEFAULT_TRAIL_MINUTES;

  const loads = await getDriverGpsTrackingLoads(driverId, req.orgId as string);
  const visibleLoadIds = loads.filter((load) => canViewDriverExactGps(req.user as any, [load])).map((load) => load._id);
  if (visibleLoadIds.length === 0) {
    throw new ApiError(
      403,
      "The recent route is shown only to people who can see this driver's location: the responsible dispatcher and organization admins, while a load is accepted.",
    );
  }

  const rows: any[] = await LoadTripPoint.find({
    driverId,
    loadId: { $in: visibleLoadIds },
    measuredAt: { $gte: new Date(Date.now() - minutes * 60_000) },
  })
    .sort({ measuredAt: 1 })
    .limit(MAX_TRAIL_POINTS * 5)
    .select("lat lng measuredAt")
    .lean();
  // Evenly thinned, always keeping the newest point.
  const step = Math.max(1, Math.ceil(rows.length / MAX_TRAIL_POINTS));
  const points = step === 1 ? rows : rows.filter((_, index) => index % step === 0 || index === rows.length - 1);

  return res.status(200).json(
    new ApiResponse(200, {
      minutes,
      points: points.map((point) => ({ lat: point.lat, lng: point.lng, measuredAt: point.measuredAt })),
    }),
  );
});

export default { getRecentTrail };
