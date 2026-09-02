import Load from "../models/Load.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverStatusChangeRequest, {
  IDriverStatusChangeRequest,
} from "../models/DriverStatusChangeRequest.model";
import notificationService from "./notification.service";
import { ApiError } from "../utils/ApiError";
import { emitToOrg, emitToUser } from "../utils/socketEmitter";
import {
  GPS_TRACKING_LOAD_STATUSES,
  emitDriverLocationToResponsibleDispatchers,
} from "./driverLocationAccess.service";
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
    | (Pick<IDriverStatusChangeRequest, "priority" | "status"> & {
        transitionGroupId?: string;
      })
    | null
    | undefined,
) {
  if (!request) return false;

  // A coordinated shared-driver transition is global. Once it exists, no
  // organization may add new work until every affected Dispatch team has
  // resolved its part; otherwise a new organization could enter mid-transition
  // without a corresponding review row.
  if (
    request.transitionGroupId &&
    OPEN_DRIVER_STATUS_REQUEST_STATES.includes(request.status as any)
  ) {
    return true;
  }

  // Preserve legacy single-organization behavior for older request rows.
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
  _organizationId?: string,
) {
  return DriverStatusChangeRequest.findOne({
    driverId,
    status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
  }).sort({ priority: 1, createdAt: -1 });
}

export async function getDriverStatusContext(
  driverId: string,
  _organizationId?: string,
) {
  const [profile, request, emergencyRequest] = await Promise.all([
    DriverProfile.findOne({ userId: driverId }).lean(),
    // Work Availability is a platform-wide driver property. Any open
    // coordinated request must therefore block eligibility in every org, not
    // just in the organization currently making the API call.
    DriverStatusChangeRequest.findOne({
      driverId,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    })
      .sort({ priority: 1, createdAt: -1 })
      .lean(),
    DriverStatusChangeRequest.findOne({
      driverId,
      priority: "emergency",
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    })
      .select("_id priority status transitionGroupId")
      .lean(),
  ]);

  const operationalStatus = (profile?.operationalStatus ||
    "active") as DriverOperationalStatus;

  return {
    operationalStatus,
    request,
    emergencyReleaseActive: Boolean(emergencyRequest),
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
      status: { $in: GPS_TRACKING_LOAD_STATUSES },
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
    const coordinated = Boolean((request as any)?.transitionGroupId);
    return {
      eligible: false,
      operationalStatus,
      blockingRequest: request,
      reason: emergency
        ? "This driver has an active emergency release request and cannot receive new work."
        : coordinated
          ? "This driver has a Work Availability change being coordinated across Dispatch teams. New work is blocked until every affected organization resolves its part."
          : "This driver's status change was approved and is awaiting load reassignment. New work is blocked until the transition is complete.",
      code: emergency
        ? "DRIVER_EMERGENCY_RELEASE_ACTIVE"
        : coordinated
          ? "DRIVER_STATUS_CHANGE_COORDINATED"
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
  organizationId?: string;
  organizationIds?: string[];
  status: DriverOperationalStatus;
}) {
  const { driverId, organizationId, organizationIds = [], status } = params;

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

  if (status === "active") forcedLiveStatus = "offline";
  if (status === "on_leave") forcedLiveStatus = "offline";
  if (status === "maintenance") forcedLiveStatus = "waiting";

  if (forcedLiveStatus) {
    location = await DriverLocation.findOneAndUpdate(
      { userId: driverId },
      {
        $set: {
          status: forcedLiveStatus,
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

  const orgIds = new Set(
    [organizationId, ...organizationIds]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  for (const orgId of orgIds) {
    emitToOrg(orgId, "driver:operational_status_updated", payload);
  }

  if (location && forcedLiveStatus) {
    // Exact GPS remains restricted to dispatchers who own an Accepted,
    // Picked Up, or In-Transit load for this driver.
    await emitDriverLocationToResponsibleDispatchers(driverId, {
      coords: location.coords ?? null,
      status: forcedLiveStatus,
      isSharing: Boolean(location.isSharing),
      lastSeenAt: location.lastSeenAt,
    });
  }

  return profile;
}

async function notifyDriverStatusCompleted(
  request: IDriverStatusChangeRequest,
  organizationCount = 1,
) {
  try {
    await notificationService.createNotification({
      userId: request.driverId.toString(),
      organizationId: request.organizationId,
      type: "driver_status_request_completed",
      title: "Work Availability Updated",
      message:
        request.requestedStatus === "maintenance"
          ? organizationCount > 1
            ? `All ${organizationCount} affected Dispatch teams completed their review. Your Work Availability is now In Shop.`
            : "Your Work Availability is now In Shop."
          : organizationCount > 1
            ? `All ${organizationCount} affected Dispatch teams completed their review. Your Work Availability is now On Leave.`
            : "Your Work Availability is now On Leave.",
      metadata: {
        statusRequestId: request._id.toString(),
        transitionGroupId: request.transitionGroupId ?? null,
        requestedStatus: request.requestedStatus,
        organizationCount,
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

export async function finalizeDriverStatusTransitionGroup(params: {
  driverId: string;
  transitionGroupId: string;
  fallbackOrganizationId?: string;
  notifyDriver?: boolean;
}) {
  const {
    driverId,
    transitionGroupId,
    fallbackOrganizationId,
    notifyDriver = true,
  } = params;

  const requests = await DriverStatusChangeRequest.find({
    driverId,
    transitionGroupId,
  }).sort({ createdAt: 1 });

  if (!requests.length) return null;

  // One rejection/cancellation ends the coordinated global transition. Other
  // organizations may already have moved their own loads, but no single org
  // can force the driver's global Work Availability to change after another
  // affected Dispatch team declined it.
  if (requests.some((request) => ["rejected", "cancelled"].includes(request.status))) {
    return null;
  }

  if (requests.some((request) =>
    OPEN_DRIVER_STATUS_REQUEST_STATES.includes(request.status as any),
  )) {
    return null;
  }

  if (!requests.every((request) => request.status === "completed")) {
    return null;
  }

  const requestedStatuses = new Set(requests.map((request) => request.requestedStatus));
  if (requestedStatuses.size !== 1) {
    logger.error(
      { driverId, transitionGroupId },
      "Refusing to apply inconsistent coordinated Work Availability group",
    );
    return null;
  }

  const primary = requests[0];
  const requestedStatus = primary.requestedStatus;
  const organizationIds = [...new Set(
    requests.map((request) => String(request.organizationId ?? "").trim()).filter(Boolean),
  )];

  // Applying the profile status is idempotent. We intentionally set the group
  // marker only after the profile update succeeds so a transient DB/storage
  // failure can be retried by the next status-context refresh.
  if (!primary.globalStatusAppliedAt) {
    await applyDriverOperationalStatus({
      driverId,
      organizationId: fallbackOrganizationId || primary.organizationId,
      organizationIds,
      status: requestedStatus,
    });

    const appliedAt = new Date();
    const claimed = await DriverStatusChangeRequest.findOneAndUpdate(
      {
        _id: primary._id,
        $or: [
          { globalStatusAppliedAt: { $exists: false } },
          { globalStatusAppliedAt: null },
        ],
      },
      { $set: { globalStatusAppliedAt: appliedAt } },
      { new: true },
    );

    if (claimed && notifyDriver) {
      await notifyDriverStatusCompleted(claimed, organizationIds.length || 1);
    }
  }

  const payload = {
    transitionGroupId,
    driverId,
    requestedStatus,
    status: "completed",
    coordinated: true,
    organizationCount: organizationIds.length,
  };
  emitToUser(driverId, "driver:status_request_updated", payload);
  for (const orgId of organizationIds) {
    emitToOrg(orgId, "driver:status_request_updated", payload);
  }

  return primary;
}

export async function finalizeResolvedDriverStatusGroups(
  driverId: string,
  options: { notifyDriver?: boolean } = {},
) {
  const candidate: any = await DriverStatusChangeRequest.findOne({
    driverId,
    transitionGroupId: { $exists: true, $ne: null },
    status: "completed",
    $or: [
      { globalStatusAppliedAt: { $exists: false } },
      { globalStatusAppliedAt: null },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!candidate?.transitionGroupId) return null;

  return finalizeDriverStatusTransitionGroup({
    driverId,
    transitionGroupId: String(candidate.transitionGroupId),
    fallbackOrganizationId: String(candidate.organizationId ?? "") || undefined,
    notifyDriver: options.notifyDriver,
  });
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

  if (!request) {
    // This also retries the final global apply if all coordinated per-org rows
    // were completed by another controller before a previous apply succeeded.
    return finalizeResolvedDriverStatusGroups(driverId, options);
  }

  const activeLoadCount = await Load.countDocuments({
    organizationId,
    assignedDriverId: driverId,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  });

  if (activeLoadCount > 0) return null;

  if (request.transitionGroupId) {
    // Narrow once from the already-validated request row. The schema keeps
    // transitionGroupId optional for legacy single-organization requests, so
    // a freshly returned Mongoose document still exposes it as string | undefined.
    const transitionGroupId = request.transitionGroupId;

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
      transitionGroupId,
      driverId,
      priority: claimed.priority,
      requestedStatus: claimed.requestedStatus,
      status: claimed.status,
      coordinated: true,
    };
    emitToUser(driverId, "driver:status_request_updated", payload);
    emitToOrg(organizationId, "driver:status_request_updated", payload);

    await finalizeDriverStatusTransitionGroup({
      driverId,
      transitionGroupId,
      fallbackOrganizationId: organizationId,
      notifyDriver: options.notifyDriver,
    });

    return claimed;
  }

  // Legacy single-org behavior remains unchanged.
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