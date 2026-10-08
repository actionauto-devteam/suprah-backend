import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import User from "../models/User.model";
import { IDriverTrackingDevice } from "../models/DriverTrackingDevice.model";
import { MAX_POSITIONS_PER_UPLOAD, getTrackingAppConfig } from "../config/trackingApp";
import { getDriverGpsTrackingLoads } from "../services/driverLocationAccess.service";
import { FUTURE_TOLERANCE_MS, ingestDriverLocation } from "../services/driverLocationIngest.service";
import {
  PHONE_TRACKING_UNAVAILABLE,
  authenticateTrackingApp,
  notePhonePosition,
  pairTrackingApp,
  removeTrackingAppLink,
} from "../services/driverTrackingDevice.service";

/*
 * The Suprah Driver Tracker app (Android/iPhone). It never uses a driver's
 * website sign-in: it pairs once with a one-time code from the Driver Portal,
 * then signs every request with its own device key:
 *
 *   Authorization: Device <deviceId>:<deviceKey>
 *
 * Positions go through the same rules as every other source
 * (driverLocationIngest.service): only an approved phone counts, only while
 * the driver has an accepted load, the newest measurement wins, and positions
 * buffered while the phone was offline still fill in the trip history.
 */

type AppRequest = ExpressRequest & { trackingLink?: IDriverTrackingDevice };

/** Machine-readable reasons the app acts on (the message is for people). */
function appError(res: ExpressResponse, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, code: status, reason: code, message });
}

/** Checks the device id and key on every app request. */
export async function requireTrackingAppDevice(req: AppRequest, res: ExpressResponse, next: NextFunction) {
  try {
    if (!getTrackingAppConfig().enabled) {
      return appError(res, 503, "tracking_app_off", PHONE_TRACKING_UNAVAILABLE);
    }
    const header = String(req.headers.authorization ?? "");
    const match = /^Device\s+([A-Za-z0-9]+):([A-Za-z0-9_-]+)$/.exec(header.trim());
    const result = await authenticateTrackingApp(match?.[1] ?? "", match?.[2] ?? "");
    if ("failure" in result) {
      return result.failure === "unlinked"
        ? appError(res, 401, "device_unlinked", "This phone was unlinked from your account. Pair it again with a new code from the Driver Portal.")
        : appError(res, 401, "device_unknown", "This phone isn't paired. Pair it with a code from the Driver Portal.");
    }
    const driver = await User.exists({ _id: result.link.driverId, role: "driver", isActive: true });
    if (!driver) {
      return appError(res, 403, "driver_inactive", "Your driver account isn't active. Contact your dispatcher.");
    }
    req.trackingLink = result.link;
    return next();
  } catch (error) {
    return next(error);
  }
}

function linkOf(req: AppRequest): IDriverTrackingDevice {
  if (!req.trackingLink) throw new ApiError(401, "This phone isn't paired.");
  return req.trackingLink;
}

/** What the app needs to decide whether to track right now. */
async function appStatus(link: IDriverTrackingDevice) {
  const config = getTrackingAppConfig();
  const driver: any = await User.findById(link.driverId).select("name").lean();
  const loads = link.status === "active" ? await getDriverGpsTrackingLoads(String(link.driverId)) : [];
  return {
    status: link.status === "active" ? "approved" : "waiting_for_approval",
    driverName: String(driver?.name ?? "").trim() || "Driver",
    // Track only while the driver has an Accepted, Picked Up or In-Transit load.
    shouldTrack: link.status === "active" && loads.length > 0,
    activeLoadCount: loads.length,
    uploadIntervalSeconds: config.uploadIntervalSeconds,
    locationIntervalSeconds: config.locationIntervalSeconds,
    lastPositionAt: link.lastPositionAt ?? null,
    serverTime: new Date().toISOString(),
  };
}

// POST /api/tracking-app/pair  { code, deviceName?, platform?, appVersion? }   (no sign-in; rate limited)
const pair = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { link, deviceSecret } = await pairTrackingApp({
    code: req.body?.code,
    deviceName: req.body?.deviceName,
    platform: req.body?.platform,
    appVersion: req.body?.appVersion,
  });
  res.status(201).json(
    new ApiResponse(
      201,
      {
        deviceId: link.uniqueId,
        // Shown only this once; Suprah keeps only its hash.
        deviceKey: deviceSecret,
        ...(await appStatus(link)),
      },
      link.status === "active"
        ? "Phone paired."
        : "Phone paired. A dispatcher or admin will approve it before your location is used.",
    ),
  );
});

// GET /api/tracking-app/status
const status = asyncHandler(async (req: AppRequest, res: ExpressResponse) => {
  res.status(200).json(new ApiResponse(200, await appStatus(linkOf(req)), "Status fetched"));
});

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

// POST /api/tracking-app/positions  { positions: [{ lat, lng, measuredAt, accuracy?, speed?, heading? }] }
const positions = asyncHandler(async (req: AppRequest, res: ExpressResponse) => {
  const link = linkOf(req);
  if (link.status !== "active") {
    return appError(res, 403, "waiting_for_approval", "Your phone is waiting for a dispatcher or admin to approve it.");
  }
  const raw = Array.isArray(req.body?.positions) ? req.body.positions : null;
  if (!raw || raw.length === 0) throw new ApiError(400, "Send at least one position.");
  if (raw.length > MAX_POSITIONS_PER_UPLOAD) {
    throw new ApiError(400, `Send at most ${MAX_POSITIONS_PER_UPLOAD} positions at a time.`);
  }

  const receivedAt = new Date();
  const readings = raw
    .map((item: any) => ({
      lat: finite(item?.lat),
      lng: finite(item?.lng),
      measuredAt: new Date(String(item?.measuredAt ?? "")),
      accuracy: finite(item?.accuracy),
      speed: finite(item?.speed),
      heading: finite(item?.heading),
    }))
    // Oldest first, so the newest one is the last to update the live position.
    .sort((a: any, b: any) => a.measuredAt.getTime() - b.measuredAt.getTime());

  const refused: Record<string, number> = {};
  let accepted = 0;
  let newest: Date | null = null;
  for (const reading of readings) {
    const measuredMs = reading.measuredAt.getTime();
    if (reading.lat === null || reading.lng === null || !Number.isFinite(measuredMs)) {
      refused.invalid_location = (refused.invalid_location ?? 0) + 1;
      continue;
    }
    if (measuredMs <= receivedAt.getTime() + FUTURE_TOLERANCE_MS && (!newest || measuredMs > newest.getTime())) {
      newest = reading.measuredAt;
    }
    const result = await ingestDriverLocation({
      driverId: String(link.driverId),
      source: "app",
      sourceDeviceId: link.uniqueId,
      lat: reading.lat,
      lng: reading.lng,
      measuredAt: reading.measuredAt,
      receivedAt,
      accuracy: reading.accuracy,
      speed: reading.speed,
      heading: reading.heading,
    });
    if (result.accepted) accepted += 1;
    else refused[result.reason] = (refused[result.reason] ?? 0) + 1;
  }
  // Remember the newest reading even when Suprah doesn't keep it (no active
  // load): the Driver Portal's reminders use it.
  if (newest) await notePhonePosition(link._id, newest);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        received: readings.length,
        accepted,
        refused,
        ...(await appStatus(link)),
      },
      "Positions received",
    ),
  );
});

// DELETE /api/tracking-app/device   (the driver unlinks the phone from the app)
const unlink = asyncHandler(async (req: AppRequest, res: ExpressResponse) => {
  await removeTrackingAppLink(linkOf(req));
  res.status(200).json(new ApiResponse(200, { unlinked: true }, "This phone was unlinked from your account."));
});

export default { pair, status, positions, unlink };
