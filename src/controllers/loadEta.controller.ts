import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import { GPS_TRACKING_LOAD_STATUSES } from "../constants/loadStatus";
import { canViewDriverExactGps } from "../services/driverLocationAccess.service";
import { getLoadEta, type EtaLoad } from "../services/loadEta.service";

const ETA_LOAD_FIELDS =
  "_id organizationId assignedDriverId dispatchOwnerId loadNumber status pickupLocation deliveryLocation dates.pickupDeadline dates.deliveryDeadline";

function loadIdFrom(req: ExpressRequest): string {
  const id = String(req.params.id ?? "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "This load link isn't valid. Open the load again.");
  }
  return id;
}

const isTracked = (status: unknown) => GPS_TRACKING_LOAD_STATUSES.includes(status as any);

/**
 * GET /api/driver-tracking/loads/:id/eta
 * Arrival time at the load's next stop, for the Driver Tracker and the
 * Transportation load page. Shown only to the people who can see the driver's
 * exact location (the responsible dispatcher and organization admins), since
 * it reveals how far away the driver is.
 */
const getLoadEtaForStaff = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const loadId = loadIdFrom(req);
  const load: any = await Load.findOne({ _id: loadId, organizationId: req.orgId }).select(ETA_LOAD_FIELDS).lean();
  if (!load) throw new ApiError(404, "This load wasn't found in your organization.");
  // Before acceptance or after delivery there is no arrival time (and no location to protect).
  if (!isTracked(load.status) || !load.assignedDriverId) {
    return res.status(200).json(new ApiResponse(200, await getLoadEta(load as EtaLoad)));
  }
  if (!canViewDriverExactGps(req.user as any, [{ ...load, organizationId: String(load.organizationId) }])) {
    throw new ApiError(
      403,
      "Arrival times are shown only to people who can see this driver's location: the responsible dispatcher and organization admins.",
    );
  }
  return res.status(200).json(new ApiResponse(200, await getLoadEta(load as EtaLoad)));
});

/**
 * GET /api/driver-tracking/my-loads/:id/eta
 * The signed-in driver's arrival time at their load's next stop.
 */
const getMyLoadEta = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const loadId = loadIdFrom(req);
  const load: any = await Load.findOne({ _id: loadId, assignedDriverId: req.user?._id }).select(ETA_LOAD_FIELDS).lean();
  if (!load) throw new ApiError(404, "This load isn't assigned to you.");
  return res.status(200).json(new ApiResponse(200, await getLoadEta(load as EtaLoad)));
});

export default { getLoadEtaForStaff, getMyLoadEta };
