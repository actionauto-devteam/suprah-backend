import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { IUser } from "../models/User.model";
import { getTraccarConfig } from "../config/traccar";
import { getTrackingAppConfig } from "../config/trackingApp";
import {
  assertDriverReviewCenterAccess,
  assertDriverReviewMutationAccess,
  resolveDriverReviewAccess,
} from "../services/driverReviewAccess.service";
import {
  approveDeviceLink,
  currentDeviceLink,
  driverLinkView,
  phoneTrackingProvider,
  phoneTrackingReminder,
  removeOwnDeviceLink,
  renewPairingCode,
  retryDeviceLinkSync,
  reviewerLinkView,
  revokeDeviceLinkByStaff,
  startDeviceLink,
} from "../services/driverTrackingDevice.service";
import { processTraccarForward } from "../services/traccar.service";

/*
 * Phone tracking (Traccar Client or the Suprah Driver Tracker app): the
 * driver's own setup, reviewer approval (the same people who verify
 * drivers), and the endpoint Traccar Server forwards positions to. The app's
 * own endpoints are in trackingApp.controller.ts.
 */

function getUser(req: ExpressRequest): IUser {
  const user = req.user as IUser | undefined;
  if (!user) throw new ApiError(401, "Please sign in again.");
  return user;
}

async function driverPayload(driverId: string, pairingCode: string | null = null) {
  const config = getTraccarConfig();
  const provider = phoneTrackingProvider();
  const link = await currentDeviceLink(driverId);
  return {
    available: provider !== null,
    /** What new setups use: "app" (Suprah Driver Tracker), "traccar", or null. */
    provider,
    // Traccar: the server address the driver enters once in Traccar Client.
    serverUrl: provider === "traccar" ? config.deviceServerUrl : null,
    // App: where drivers install it, when the company has set a link.
    downloadUrl: provider === "app" ? getTrackingAppConfig().downloadUrl : null,
    device: driverLinkView(link),
    // App: the one-time pairing code, only in the response that created it.
    pairingCode,
    reminder: await phoneTrackingReminder(driverId, link),
  };
}

// GET /api/driver-tracking/tracking-device  (driver)
const getMyTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  res.status(200).json(new ApiResponse(200, await driverPayload(String(user._id)), "Phone tracking fetched"));
});

// POST /api/driver-tracking/tracking-device  (driver: set up a first or replacement phone)
const startMyTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const { pairingCode } = await startDeviceLink(String(user._id));
  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        await driverPayload(String(user._id), pairingCode),
        "Phone tracking setup started. A dispatcher or admin will approve it before your phone's positions are used.",
      ),
    );
});

// POST /api/driver-tracking/tracking-device/pairing-code  (driver: a fresh code for the app)
const renewMyPairingCode = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const { pairingCode } = await renewPairingCode(String(user._id));
  res.status(200).json(new ApiResponse(200, await driverPayload(String(user._id), pairingCode), "New pairing code ready"));
});

// DELETE /api/driver-tracking/tracking-device  (driver: stop using the linked phone)
const removeMyTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  await removeOwnDeviceLink(String(user._id));
  res
    .status(200)
    .json(new ApiResponse(200, await driverPayload(String(user._id)), "Your phone was unlinked. Its positions are no longer used."));
});

async function reviewer(req: ExpressRequest, mutate: boolean) {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(404, "We couldn't find this driver. Refresh the page and try again.");
  }
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  if (mutate) assertDriverReviewMutationAccess(access);
  else assertDriverReviewCenterAccess(access);
  return { viewer, driverId };
}

async function reviewerPayload(driverId: string) {
  const link = await currentDeviceLink(driverId);
  const provider = link?.provider ?? phoneTrackingProvider();
  return {
    available: provider === "app" ? getTrackingAppConfig().enabled : provider === "traccar" ? getTraccarConfig().usable : false,
    provider,
    device: await reviewerLinkView(link),
  };
}

// GET /api/driver-tracking/drivers/:driverId/tracking-device  (driver reviewers)
const getDriverTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { driverId } = await reviewer(req, false);
  res.status(200).json(new ApiResponse(200, await reviewerPayload(driverId), "Phone tracking fetched"));
});

// POST /api/driver-tracking/drivers/:driverId/tracking-device/approve
const approveDriverTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { viewer, driverId } = await reviewer(req, true);
  await approveDeviceLink(driverId, String(viewer._id));
  res.status(200).json(new ApiResponse(200, await reviewerPayload(driverId), "Phone approved"));
});

// POST /api/driver-tracking/drivers/:driverId/tracking-device/revoke
const revokeDriverTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { viewer, driverId } = await reviewer(req, true);
  await revokeDeviceLinkByStaff(driverId, String(viewer._id));
  res.status(200).json(new ApiResponse(200, await reviewerPayload(driverId), "Phone unlinked"));
});

// POST /api/driver-tracking/drivers/:driverId/tracking-device/sync
const syncDriverTrackingDevice = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { driverId } = await reviewer(req, true);
  await retryDeviceLinkSync(driverId);
  res.status(200).json(new ApiResponse(200, await reviewerPayload(driverId), "Traccar Server update retried"));
});

// POST /api/integrations/traccar/positions  (Traccar Server; authenticated by the shared secret, not a session)
const receiveTraccarPosition = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const outcome = await processTraccarForward(req.headers.authorization, req.body, req.ip);
  res.status(outcome.status).json(outcome.body);
});

export default {
  getMyTrackingDevice,
  startMyTrackingDevice,
  renewMyPairingCode,
  removeMyTrackingDevice,
  getDriverTrackingDevice,
  approveDriverTrackingDevice,
  revokeDriverTrackingDevice,
  syncDriverTrackingDevice,
  receiveTraccarPosition,
};
