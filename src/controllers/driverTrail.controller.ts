import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import LoadTripPoint from "../models/LoadTripPoint.model";
import { canViewDriverExactGps, getDriverGpsTrackingLoads } from "../services/driverLocationAccess.service";
import { buildRouteLine, routePieceStart } from "../services/routeLine.service";

const DEFAULT_TRAIL_MINUTES = 120;
const MIN_TRAIL_MINUTES = 15;
const MAX_TRAIL_MINUTES = 360;
const MAX_TRAIL_POINTS = 600;
/** Readings read at most (newest kept): 6 hours at one every 5 seconds per load. */
const MAX_TRAIL_READINGS = 10_000;

/**
 * GET /api/driver-tracking/drivers/:driverId/recent-trail?minutes=120
 * The selected driver's recent route on the Driver Tracker map, from trip
 * history. Only positions recorded on tracked loads (Accepted to Delivered) in
 * the current organization that this person may see exactly: the load's
 * responsible dispatcher and the organization's admins, the same rule as live
 * GPS.
 *
 * The line is cleaned (rough readings, glitches and duplicate readings left
 * out) and, when Amazon Location is switched on, follows the roads driven.
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

  // Start at a 15-minute boundary so finished pieces of the route stay the
  // same between refreshes (their road match is reused).
  const since = new Date(routePieceStart(Date.now() - minutes * 60_000));
  const rows: any[] = await LoadTripPoint.find({
    driverId,
    loadId: { $in: visibleLoadIds },
    measuredAt: { $gte: since },
  })
    .sort({ measuredAt: -1 })
    .limit(MAX_TRAIL_READINGS)
    .select("lat lng measuredAt accuracy speed heading source")
    .lean();
  rows.reverse();

  const route = await buildRouteLine(
    rows.map((row) => ({
      lat: row.lat,
      lng: row.lng,
      measuredAt: new Date(row.measuredAt),
      accuracy: row.accuracy ?? null,
      speed: row.speed ?? null,
      heading: row.heading ?? null,
      source: row.source ?? null,
    })),
    MAX_TRAIL_POINTS,
  );

  return res.status(200).json(
    new ApiResponse(200, {
      minutes,
      // The line to draw, in order.
      points: route.points,
      // "roads" (matched to roads), "gps" (cleaned readings), "mixed" or "none".
      routeSource: route.source,
      // Newer live positions extend the line on the map.
      throughMeasuredAt: route.throughMeasuredAt,
    }),
  );
});

export default { getRecentTrail };
