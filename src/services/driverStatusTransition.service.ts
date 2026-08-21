import Load from "../models/Load.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverStatusChangeRequest, {
  IDriverStatusChangeRequest,
} from "../models/DriverStatusChangeRequest.model";
import notificationService from "./notification.service";
import { ApiError } from "../utils/ApiError";
import { emitToOrg, emitToUser } from "../utils/socketEmitter";
import logger from "../utils/logger";

export const ACTIVE_DRIVER_LOAD_STATUSES = [
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const;

export const OPEN_DRIVER_STATUS_REQUEST_STATES = [
  "pending",
  "approved_awaiting_reassignment",
] as const;

export type DriverOperationalStatus =
  | "active"
  | "on_leave"
  | "maintenance";


export type DriverLocationRequirementReason =
  | "active_load"
  | "dispatch_retained_load"
  | null;

export interface DriverLocationRequirement {
  required: boolean;
  reason: DriverLocationRequirementReason;
  activeLoadIds: string[];
  retainedLoadIds: string[];
  policyRequestId: string | null;
}

export interface DriverWorkEligibility {
  eligible: boolean;
  operationalStatus: DriverOperationalStatus;
  blockingRequest: any | null;
  reason: string | null;
  code: string | null;
}

export function isStatusRequestBlockingNewWork(
  request:
    | Pick<IDriverStatusChangeRequest, "priority" | "status">
    | null
    | undefined,
) {
  if (!request) return false;

  if (request.status === "approved_awaiting_reassignment") {
    return true;
  }

  return request.priority === "emergency" && request.status === "pending";
}

export function isEmergencyReleaseActive(
  request:
    | Pick<IDriverStatusChangeRequest, "priority" | "status">
    | null
    | undefined,
) {
  return Boolean(
    request &&
      request.priority === "emergency" &&
      OPEN_DRIVER_STATUS_REQUEST_STATES.includes(request.status as any),
  );
}

export async function getOpenDriverStatusRequest(
  driverId: string,
  organizationId: string,
) {
  return DriverStatusChangeRequest.findOne({
    organizationId,
    driverId,
    status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
  }).sort({ createdAt: -1 });
}

export async function getDriverStatusContext(
  driverId: string,
  organizationId: string,
) {
  const [profile, request] = await Promise.all([
    // A driver has one profile, not one per org (shared pool) — org here is
    // only for the DriverStatusChangeRequest lookup below.
    DriverProfile.findOne({ userId: driverId }).lean(),
    DriverStatusChangeRequest.findOne({
      organizationId,
      driverId,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const operationalStatus = (profile?.operationalStatus ||
    "active") as DriverOperationalStatus;

  return {
    operationalStatus,
    request,
    emergencyReleaseActive: isEmergencyReleaseActive(request as any),
  };
}

export async function getDriverLocationRequirement(
  driverId: string,
  organizationId: string,
  options: {
    operationalStatus?: DriverOperationalStatus;
    emergencyReleaseActive?: boolean;
    activeLoadIds?: string[];
  } = {},
): Promise<DriverLocationRequirement> {
  let operationalStatus = options.operationalStatus;
  let emergencyReleaseActive = options.emergencyReleaseActive;

  if (operationalStatus === undefined || emergencyReleaseActive === undefined) {
    const context = await getDriverStatusContext(driverId, organizationId);
    operationalStatus ??= context.operationalStatus;
    emergencyReleaseActive ??= context.emergencyReleaseActive;
  }

  const activeLoadIds = options.activeLoadIds ?? (
    await Load.find({
      organizationId,
      assignedDriverId: driverId,
      status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
    })
      .select("_id")
      .lean()
  ).map((load: any) => String(load._id));

  if (activeLoadIds.length === 0 || emergencyReleaseActive) {
    return {
      required: false,
      reason: null,
      activeLoadIds,
      retainedLoadIds: [],
      policyRequestId: null,
    };
  }

  // Preserve the existing safety rule for ordinary Active drivers.
  if (operationalStatus === "active") {
    return {
      required: true,
      reason: "active_load",
      activeLoadIds,
      retainedLoadIds: [],
      policyRequestId: null,
    };
  }

  // On Leave / In Shop normally keep GPS optional. The only exception is an
  // explicit dispatcher decision to keep the active load(s) assigned AND
  // require GPS. The request remains the durable policy record after approval.
  const policy: any = await DriverStatusChangeRequest.findOne({
    organizationId,
    driverId,
    requestedStatus: operationalStatus,
    status: { $in: ["approved_awaiting_reassignment", "completed"] },
    loadHandlingDecision: "keep_assigned",
    affectedLoadIds: { $in: activeLoadIds },
  })
    .select("_id affectedLoadIds retainedGpsRequired reviewedAt completedAt createdAt")
    .sort({ reviewedAt: -1, completedAt: -1, createdAt: -1 })
    .lean();

  if (!policy || policy.retainedGpsRequired !== true) {
    return {
      required: false,
      reason: null,
      activeLoadIds,
      retainedLoadIds: [],
      policyRequestId: policy?._id ? String(policy._id) : null,
    };
  }

  const activeSet = new Set(activeLoadIds);
  const retainedLoadIds = (policy.affectedLoadIds ?? [])
    .map((id: any) => String(id))
    .filter((id: string) => activeSet.has(id));

  return {
    required: retainedLoadIds.length > 0,
    reason: retainedLoadIds.length > 0 ? "dispatch_retained_load" : null,
    activeLoadIds,
    retainedLoadIds,
    policyRequestId: String(policy._id),
  };
}

export async function getDriverWorkEligibility(
  driverId: string,
  organizationId: string,
): Promise<DriverWorkEligibility> {
  const { operationalStatus, request } = await getDriverStatusContext(
    driverId,
    organizationId,
  );

  if (operationalStatus === "on_leave") {
    return {
      eligible: false,
      operationalStatus,
      blockingRequest: request,
      reason:
        "This driver is currently On Leave and is unavailable for new load assignments.",
      code: "DRIVER_ON_LEAVE",
    };
  }

  if (operationalStatus === "maintenance") {
    return {
      eligible: false,
      operationalStatus,
      blockingRequest: request,
      reason:
        "This driver is currently In Shop and is unavailable for new load assignments.",
      code: "DRIVER_IN_SHOP",
    };
  }

  if (isStatusRequestBlockingNewWork(request as any)) {
    const emergency = request?.priority === "emergency";
    return {
      eligible: false,
      operationalStatus,
      blockingRequest: request,
      reason: emergency
        ? "This driver has an active emergency release request and cannot receive new work."
        : "This driver's status change was approved and is awaiting load reassignment. New work is blocked until the transition is complete.",
      code: emergency
        ? "DRIVER_EMERGENCY_RELEASE_ACTIVE"
        : "DRIVER_STATUS_CHANGE_AWAITING_REASSIGNMENT",
    };
  }

  return {
    eligible: true,
    operationalStatus,
    blockingRequest: request,
    reason: null,
    code: null,
  };
}

export async function assertDriverCanTakeNewWork(
  driverId: string,
  organizationId: string,
  action: "assign" | "reassign" | "request" | "approve" | "accept",
) {
  const eligibility = await getDriverWorkEligibility(
    driverId,
    organizationId,
  );

  if (eligibility.eligible) return eligibility;

  if (action === "accept") {
    if (eligibility.operationalStatus === "on_leave") {
      throw new ApiError(
        409,
        "Unable to Accept Load — Your Dispatch Status is currently On Leave. You must be Active before you can accept an assigned load.",
      );
    }

    if (eligibility.operationalStatus === "maintenance") {
      throw new ApiError(
        409,
        "Unable to Accept Load — Your vehicle is currently marked In Shop. You must return your Dispatch Status to Active before accepting this load.",
      );
    }
  }

  if (action === "request") {
    if (eligibility.operationalStatus === "on_leave") {
      throw new ApiError(
        409,
        "You cannot request a new load while your Dispatch Status is On Leave. Return to Active first.",
      );
    }
    if (eligibility.operationalStatus === "maintenance") {
      throw new ApiError(
        409,
        "You cannot request a new load while your Dispatch Status is In Shop. Return to Active first.",
      );
    }
  }

  throw new ApiError(
    409,
    eligibility.reason || "This driver is not eligible for new work right now.",
  );
}

export async function applyDriverOperationalStatus(params: {
  driverId: string;
  organizationId: string;
  status: DriverOperationalStatus;
}) {
  const { driverId, organizationId, status } = params;

  const profile = await DriverProfile.findOneAndUpdate(
    { userId: driverId },
    {
      $set: { operationalStatus: status },
      $setOnInsert: { userId: driverId },
    },
    { new: true, upsert: true },
  );

  let location: any = null;
  let forcedLiveStatus: "offline" | "waiting" | null = null;

  // A transition into Active starts from truthful GPS state: Offline until a
  // fresh heartbeat arrives. This avoids treating the last In Shop/On Leave
  // coordinates as live sharing when the driver returns to Active.
  if (status === "active") forcedLiveStatus = "offline";
  if (status === "on_leave") forcedLiveStatus = "offline";
  if (status === "maintenance") forcedLiveStatus = "waiting";

  if (forcedLiveStatus) {
    // A driver has one location record, not one per org (shared pool).
    location = await DriverLocation.findOneAndUpdate(
      { userId: driverId },
      {
        $set: {
          status: forcedLiveStatus,
          // Preserve lastSeenAt as the timestamp of the last actual location
          // event. A Dispatch Status change must not make a stale coordinate
          // look freshly shared.
          offlineAlertSentAt: null,
        },
      },
      { new: true },
    );
  }

  const payload = {
    driverId,
    operationalStatus: status,
    forcedLiveStatus,
    updatedAt: new Date().toISOString(),
  };

  emitToUser(driverId, "driver:operational_status_updated", payload);
  emitToOrg(
    organizationId,
    "driver:operational_status_updated",
    payload,
  );

  if (location && forcedLiveStatus) {
    emitToOrg(organizationId, "driver:location", {
      driverId,
      coords: location.coords ?? null,
      status: forcedLiveStatus,
      // GPS sharing is independent from Dispatch/Live Status. Preserve the
      // driver's current voluntary sharing choice when moving to On Leave or
      // In Shop so Driver Tracker does not infer sharing from the live label.
      isSharing: Boolean(location.isSharing),
      lastSeenAt: location.lastSeenAt,
    });
  }

  return profile;
}

async function notifyDriverStatusCompleted(
  request: IDriverStatusChangeRequest,
) {
  try {
    await notificationService.createNotification({
      userId: request.driverId.toString(),
      organizationId: request.organizationId,
      type: "driver_status_request_completed",
      title: "Dispatch Status Updated",
      message:
        request.requestedStatus === "maintenance"
          ? "Your Dispatch Status is now In Shop."
          : "Your Dispatch Status is now On Leave.",
      metadata: {
        statusRequestId: request._id.toString(),
        requestedStatus: request.requestedStatus,
        route: "/driver",
        pushSource: "Driver Tracker",
      },
    });
  } catch (error) {
    logger.error(
      { error, requestId: request._id },
      "Non-fatal: failed to notify driver that status transition completed",
    );
  }
}

export async function finalizeDriverStatusChangeIfClear(
  driverId: string,
  organizationId: string,
  options: { notifyDriver?: boolean } = {},
) {
  const request = await DriverStatusChangeRequest.findOne({
    organizationId,
    driverId,
    status: "approved_awaiting_reassignment",
  }).sort({ createdAt: -1 });

  if (!request) return null;

  const activeLoadCount = await Load.countDocuments({
    organizationId,
    assignedDriverId: driverId,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  });

  if (activeLoadCount > 0) return null;

  // Apply the permanent operational status before claiming the request as
  // completed. The status update is idempotent, so concurrent finalizers can
  // safely race here. If the profile/location update fails, the request stays
  // in approved_awaiting_reassignment and the next poll can retry instead of
  // leaving a completed request with a stale Dispatch Status.
  await applyDriverOperationalStatus({
    driverId,
    organizationId,
    status: request.requestedStatus,
  });

  const claimed = await DriverStatusChangeRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: "approved_awaiting_reassignment",
    },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
      },
    },
    { new: true },
  );

  if (!claimed) return null;

  const payload = {
    requestId: claimed._id.toString(),
    driverId,
    priority: claimed.priority,
    requestedStatus: claimed.requestedStatus,
    status: claimed.status,
  };

  emitToUser(driverId, "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);
  if (options.notifyDriver !== false) {
    await notifyDriverStatusCompleted(claimed);
  }

  return claimed;
}