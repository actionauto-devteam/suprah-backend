import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { createHash } from "crypto";
// t
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import {
  getLoadAcceptanceMaterialVersion,
} from "../services/loadAcceptanceMaterial.service";
import {
  assertNoDriverCommitmentConflict,
  withDriverCommitmentLock,
} from "../services/driverWorkCommitment.service";
import User, { IUser } from "../models/User.model";
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from "../models/DriverProfile.model";
import DriverRequest from "../models/DriverRequest.model";
import DriverLocation from "../models/DriverLocation.model";
import storageService from "../services/storage.service";
import DriverPayout from "../models/DriverPayout.model";
import logger from "../utils/logger";
import { getSocketIO, emitToOrg, emitToUser } from "../utils/socketEmitter";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";
import activityService from "../services/activity.service";
import Notification from "../models/Notification.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
import LoadReleaseRequest, {
  LOAD_RELEASE_REQUEST_REASONS,
  LoadReleaseRequestReason,
} from "../models/LoadReleaseRequest.model";
import {
  emitToDispatchChatThreadParticipants,
  ensureDispatchChatThread,
  touchDispatchChatThread,
} from "../services/dispatchChat.service";
import notificationService from "../services/notification.service";
import { driverSignSchema } from "../validations/load.validation";
import {
  assertDriverCanTakeNewWork,
  finalizeDriverStatusChangeIfClear,
  getDriverLocationRequirement,
  getDriverStatusContext,
  getDriverWorkEligibility,
} from "../services/driverStatusTransition.service";
import {
  assertDriverLoadCompatibility,
  evaluateDriverLoadCompatibilityWithRecommendations,
} from "../services/driverLoadCompatibility.service";
import { getCoordinatesFromZip } from "../utils/calculations";
import {
  GPS_TRACKING_LOAD_STATUSES,
  emitDriverLocationToResponsibleDispatchers,
  getDriverGpsTrackingLoads,
} from "../services/driverLocationAccess.service";
import {
  clearDriverExactLocationIfUnneeded,
} from "../services/driverLocationRetention.service";
import {
  appendLoadLifecycleOutbox,
  createLoadLifecycleOutboxEvent,
  processLoadLifecycleOutboxForLoad,
} from "../services/loadLifecycleOutbox.service";
import {
  DRIVER_ACTIVE_LOAD_STATUSES,
  assertDriverReviewCenterAccess,
  assertDriverReviewMutationAccess,
  resolveDriverReviewAccess,
} from "../services/driverReviewAccess.service";
import {
  approveDriverVerification,
  evaluateDriverVerificationEligibility,
  listDriverReviewEvents,
  recordDriverReviewEvent,
  reviewDriverDocument,
} from "../services/driverVerificationReview.service";

// ── Driver contract signature — required on both accept and request; a
// driver cannot take a load without agreeing to terms and signing. ──
function parseDriverSignature(body: unknown) {
  const result = driverSignSchema.safeParse(body);
  if (!result.success) {
    const message =
      result.error.issues[0]?.message || "A signed contract is required";
    throw new ApiError(400, message);
  }
  return result.data;
}

const getUser = (req: ExpressRequest) => req.user as IUser;


function assignmentCompatibilityOverrides(load: any) {
  const stored = load?.assignmentCompatibilityOverrides;
  if (
    stored &&
    typeof stored.overrideAvailability === "boolean" &&
    typeof stored.overrideCapacity === "boolean"
  ) {
    return {
      overrideAvailability: stored.overrideAvailability,
      overrideCapacity: stored.overrideCapacity,
      legacyFallback: false,
    };
  }

  // Legacy Assigned loads predate persisted override decisions. Preserve their
  // existing ability to accept when no material edit is detected; all newly
  // assigned loads persist the exact override decisions and are fully rechecked.
  return {
    overrideAvailability: true,
    overrideCapacity: true,
    legacyFallback: true,
  };
}


/**
 * Remove staff-only/internal fields before a Load leaves a driver-facing API.
 * Drivers still receive the operational route, contacts, vehicles, dates,
 * instructions and compensation they need to evaluate or execute the load.
 */
function sanitizeLoadForDriver(load: any, driverId: string) {
  const source = load?.toJSON ? load.toJSON() : { ...(load ?? {}) };
  const requests = Array.isArray(source.driverRequests)
    ? source.driverRequests
    : [];
  const myRequest = requests.find(
    (request: any) => String(request?.driverId ?? "") === String(driverId),
  );

  const vehicles = Array.isArray(source.vehicles)
    ? source.vehicles.map((vehicle: any) => {
        const { inspectionPhotoUrl: _privateInspectionKey, ...safeVehicle } =
          vehicle ?? {};
        return safeVehicle;
      })
    : [];

  const contract = source.contract
    ? {
        agreedToTerms: Boolean(source.contract.agreedToTerms),
        signedAt: source.contract.signedAt ?? null,
        signerName: source.contract.signerName ?? "",
      }
    : undefined;

  const driverContract = source.driverContract
    ? {
        agreedToTerms: Boolean(source.driverContract.agreedToTerms),
        signedAt: source.driverContract.signedAt ?? null,
        signerName: source.driverContract.signerName ?? "",
      }
    : undefined;

  const proofOfDelivery = source.proofOfDelivery
    ? {
        submittedAt: source.proofOfDelivery.submittedAt ?? null,
        note: source.proofOfDelivery.note ?? "",
        confirmedAt: source.proofOfDelivery.confirmedAt ?? null,
      }
    : undefined;

  const {
    orgId: _legacyOrgId,
    createdBy: _createdBy,
    quoteId: _quoteId,
    dispatchOwnerId: _dispatchOwnerId,
    assignmentMaterialFingerprint: _assignmentMaterialFingerprint,
    assignmentCompatibilityOverrides: _assignmentCompatibilityOverrides,
    driverAmendments: _driverAmendments,
    driverRequests: _driverRequests,
    notes: _staffNotes,
    ...rest
  } = source;

  return {
    ...rest,
    vehicles,
    ...(contract ? { contract } : {}),
    ...(driverContract ? { driverContract } : {}),
    ...(proofOfDelivery ? { proofOfDelivery } : {}),
    // Opaque material version only; internal assignment fingerprints and
    // dispatcher override decisions never leave the server.
    acceptanceMaterialVersion: getLoadAcceptanceMaterialVersion(source),
    pendingDriverAmendments: Array.isArray(_driverAmendments)
      ? _driverAmendments
          .filter(
            (amendment: any) =>
              amendment?.status === "pending" &&
              String(amendment?.driverId ?? "") === driverId,
          )
          .map((amendment: any) => ({
            id: String(amendment._id),
            createdAt: amendment.createdAt ?? null,
            loadStatusAtChange: amendment.loadStatusAtChange ?? null,
            materialVersionBefore: amendment.materialVersionBefore ?? null,
            materialVersionAfter: amendment.materialVersionAfter ?? null,
            changes: Array.isArray(amendment.changes)
              ? amendment.changes.map((change: any) => ({
                  field: String(change.field ?? ""),
                  label: String(change.label ?? "Load Details"),
                  before: String(change.before ?? ""),
                  after: String(change.after ?? ""),
                }))
              : [],
          }))
      : [],
    hasRequested: Boolean(myRequest),
    myRequestedAt: myRequest?.requestedAt ?? null,
  };
}


/**
 * Staged disclosure for the shared Available Loads board.
 *
 * A Posted/unassigned Load can be browsed by drivers from across the platform.
 * Before assignment they receive enough information to make a work decision,
 * but not customer/contact identifiers or exact operational access details.
 *
 * Requesting a Load does NOT unlock these fields. Full operational details are
 * returned only after this exact driver is assigned to the Load.
 */
function sanitizeAvailableLoadForDriver(load: any, driverId: string) {
  const source = load?.toJSON ? load.toJSON() : { ...(load ?? {}) };
  const requests = Array.isArray(source.driverRequests)
    ? source.driverRequests
    : [];
  const myRequest = requests.find(
    (request: any) => String(request?.driverId ?? "") === String(driverId),
  );

  const redactLocation = (location: any) => ({
    // Coarse route information is sufficient for evaluating geography.
    city: String(location?.city ?? ""),
    state: String(location?.state ?? ""),
    zip: String(location?.zip ?? ""),
    country: String(location?.country ?? ""),
    locationType: location?.locationType ?? undefined,

    // Preserve the normal frontend object shape without exposing PII.
    name: "",
    address: "Available after assignment",
    phone: "",
    phoneExt: "",
    email: "",
    contactName: "",
    notes: "",
  });

  const vehicles = Array.isArray(source.vehicles)
    ? source.vehicles.map((vehicle: any) => {
        const vin = String(vehicle?.vin ?? "").trim();
        return {
          year: vehicle?.year ?? undefined,
          make: String(vehicle?.make ?? ""),
          model: String(vehicle?.model ?? ""),
          color: String(vehicle?.color ?? ""),
          condition: vehicle?.condition ?? "Operable",
          // A full VIN is an exact asset identifier. Show only a recognizable
          // suffix until Dispatch actually assigns this driver.
          vin: vin
            ? `••••••${vin.slice(-6).toUpperCase()}`
            : "",
        };
      })
    : [];

  const publicInfo =
    source.additionalInfo?.visibility === "public"
      ? {
          visibility: "public",
          notes: String(source.additionalInfo?.notes ?? ""),
          instructions: String(source.additionalInfo?.instructions ?? ""),
          // Reference numbers can identify a customer/order in another org.
          referenceNumber: "",
        }
      : {
          visibility: source.additionalInfo?.visibility ?? "private",
          notes: "",
          instructions: "",
          referenceNumber: "",
        };

  const dates = source.dates
    ? {
        firstAvailable: source.dates.firstAvailable ?? null,
        pickupDeadline: source.dates.pickupDeadline ?? null,
        deliveryDeadline: source.dates.deliveryDeadline ?? null,
        // Date notes often contain appointment/contact/gate instructions.
        notes: "",
      }
    : undefined;

  const pricing = source.pricing
    ? {
        // These are the driver's decision-making fields.
        miles: source.pricing.miles ?? null,
        pricePerMile: source.pricing.pricePerMile ?? null,
        carrierPayAmount: source.pricing.carrierPayAmount ?? null,

        // Internal estimate, cash-collection and balance details unlock only
        // after assignment.
        estimatedRate: undefined,
        copCodAmount: undefined,
        balanceAmount: undefined,
      }
    : undefined;

  return {
    _id: source._id,
    loadNumber: source.loadNumber,
    postType: source.postType,
    status: source.status,
    pickupLocation: redactLocation(source.pickupLocation),
    deliveryLocation: redactLocation(source.deliveryLocation),
    vehicles,
    trailerType: source.trailerType,
    ...(dates ? { dates } : {}),
    ...(pricing ? { pricing } : {}),
    additionalInfo: publicInfo,
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,

    // Explicit UI/API contract: this is intentionally a limited Load view.
    detailsDisclosure: {
      stage: "available",
      exactLocationsAvailableAfterAssignment: true,
      contactDetailsAvailableAfterAssignment: true,
      fullVinAvailableAfterAssignment: true,
      privateInstructionsAvailableAfterAssignment: true,
    },

    hasRequested: Boolean(myRequest),
    myRequestedAt: myRequest?.requestedAt ?? null,
  };
}

// The active workload statuses are centralized in driverReviewAccess.service
// so Driver Tracking and Review Center cannot drift on relationship state.

// ─── Loosely-typed service aliases ───────────────────────────────────────────
// activityService and the notification utils type their `type` param as
// closed string unions that don't yet include the driver-lifecycle events
// introduced here (load_reassigned, load_dropped, load_request_approved, …).
// Until those unions are extended in the service files, these aliases keep
// the controller compiling; every call site is wrapped in a non-fatal
// try/catch, so an unknown enum value at runtime logs and moves on instead
// of failing the request. PROPER FIX: add the new event names to the
// ActivityType / NotificationType unions (and the Activity model enum) —
// they're valuable Pulse360 signals.
const logLoadActivityLoose = activityService.logLoadActivity.bind(
  activityService,
) as unknown as (
  userId: string,
  organizationId: string,
  type: string,
  loadId: string,
  description: string,
) => Promise<unknown>;

const safeCreateNotificationLoose = safeCreateNotification as unknown as (
  args: Record<string, unknown>,
) => Promise<unknown>;

const notifyOrgAdminsLoose = notifyOrgAdmins as unknown as (
  organizationId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
  excludeUserId?: string,
) => Promise<unknown>;

// ─── Real-time helpers ────────────────────────────────────────────────────────
// EVERY load status change must reach BOTH audiences:
//   · the driver's Account/app        → user:{driverId} "driver:loads_updated"
//   · the Transportation page + Tracker → org:{orgId}   "load:change"
// The org broadcast was previously missing from driver-side actions, which
// left the Transportation page stale until a manual refresh.

const emitLoadSync = (
  organizationId: string | undefined,
  driverIds: Array<string | undefined | null>,
  loadId: string,
) => {
  const io = getSocketIO();
  if (!io) return;
  if (organizationId) {
    io.to(`org:${organizationId}`).emit("load:change", {
      action: "updated",
      loadId,
    });
  }
  for (const driverId of driverIds) {
    if (driverId) {
      io.to(`user:${driverId}`).emit("driver:loads_updated", { loadId });
    }
  }
};


// Persist dispatcher-triggered load assignment/reassignment activity inside
// the exact private Dispatcher ↔ Driver chat. This is intentionally non-fatal:
// the load state and the normal notification remain authoritative even if the
// chat timeline is temporarily unavailable.
async function persistDispatcherLoadChatEvent(params: {
  dispatcher: IUser;
  organizationId: string;
  driverId: string;
  eventType: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}) {
  const {
    dispatcher,
    organizationId,
    driverId,
    eventType,
    title,
    message,
    metadata,
  } = params;

  try {
    const thread: any = await ensureDispatchChatThread({
      organizationId,
      dispatcherId: dispatcher._id,
      driverId,
    });

    const explicitUnreadParticipantIds = new Set(
      Array.isArray((metadata as any)?.unreadForParticipantIds)
        ? ((metadata as any).unreadForParticipantIds as unknown[])
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        : [],
    );
    const participantIds = [
      dispatcher._id.toString(),
      String(driverId),
    ];
    const readBy =
      explicitUnreadParticipantIds.size > 0
        ? participantIds.filter(
            (participantId) =>
              !explicitUnreadParticipantIds.has(participantId),
          )
        : [dispatcher._id.toString()];

    const chatMessage: any = await DispatchChatMessage.create({
      organizationId,
      threadId: thread._id,
      dispatcherId: dispatcher._id,
      driverId,
      senderId: dispatcher._id,
      senderRole: "dispatcher",
      messageType: "system",
      systemEvent: {
        type: eventType,
        title,
        message,
        metadata: {
          ...metadata,
          sentByUserId: dispatcher._id.toString(),
          sentByName: dispatcher.name || "Dispatch",
        },
      },
      content: message,
      attachments: [],
      // Existing events preserve their previous semantics. Test-14
      // lifecycle events opt in through unreadForParticipantIds so the same
      // durable system row can surface to both participants.
      readBy,
    });

    await touchDispatchChatThread({
      threadId: thread._id,
      senderId: dispatcher._id,
      messageType: "system",
      content: message,
      fallbackPreview: title,
      at: chatMessage.createdAt,
    });

    emitToDispatchChatThreadParticipants(
      thread,
      "dispatch-chat:message",
      {
        id: String(chatMessage._id),
        threadId: String(thread._id),
        dispatcherId: dispatcher._id.toString(),
        driverId,
        sender: {
          id: dispatcher._id.toString(),
          name: dispatcher.name || "Dispatcher",
          email: dispatcher.email || "",
          role: dispatcher.role,
        },
        senderRole: "dispatcher" as const,
        messageType: "system" as const,
        systemEvent: chatMessage.systemEvent,
        content: message,
        attachments: [],
        readBy: readBy.map((id) => String(id)),
        createdAt: chatMessage.createdAt,
        updatedAt: chatMessage.updatedAt,
      },
    );
  } catch (err) {
    logger.error(
      {
        err,
        driverId,
        dispatcherId: dispatcher._id.toString(),
        eventType,
      },
      "Non-fatal: failed to persist load activity into private Dispatch Chat",
    );
  }
}

// Resolve ownership for an older assigned load only when the private chat
// history contains explicit dispatcher-authored assignment evidence. Never
// guess from organization membership: privacy is more important than forcing
// a recipient for legacy data.
async function resolveExplicitDispatchOwnerFromAssignmentHistory(params: {
  organizationId: string;
  driverId: string;
  loadId: string;
}) {
  const { organizationId, driverId, loadId } = params;

  const evidence: any = await DispatchChatMessage.findOne({
    organizationId,
    driverId,
    senderRole: "dispatcher",
    messageType: "system",
    "systemEvent.metadata.loadId": loadId,
    "systemEvent.type": {
      $in: [
        "driver_load_assigned",
        "driver_load_request_approved",
      ],
    },
  })
    .select("dispatcherId senderId createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const candidateId = String(
    evidence?.dispatcherId ?? evidence?.senderId ?? "",
  ).trim();
  if (!candidateId) return null;

  const dispatcher = await User.findOne({
    _id: candidateId,
    organizationId,
    role: { $in: ["employee", "admin", "super_admin"] },
    isActive: true,
  })
    .select("_id")
    .lean();

  return dispatcher?._id ?? null;
}


const RELEASE_REQUEST_ELIGIBLE_STATUSES = [
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const;

function releaseRequestSummary(request: any) {
  if (!request) return null;
  return {
    id: String(request._id),
    status: request.status,
    priority: request.priority,
    reason: request.reason,
    message: request.message ?? null,
    requestedAt: request.requestedAt ?? request.createdAt ?? null,
    dispatcherId: request.dispatcherId ? String(request.dispatcherId) : null,
  };
}

function compatibilityNoticeMessages(compatibility: any): string[] {
  if (!compatibility) return [];
  const messages: string[] = [];
  const pickupDay = compatibility.availability?.pickupDay;
  if (compatibility.availability?.status === "off_schedule") {
    messages.push(
      `Pickup is outside your regular Work Availability${pickupDay ? ` (${pickupDay})` : ""}.`,
    );
  }
  if (compatibility.capacity?.status === "exceeded") {
    messages.push(
      `This load has ${compatibility.capacity.requiredVehicles} vehicle(s), above your configured capacity of ${compatibility.capacity.maxVehicles}.`,
    );
  } else if (compatibility.capacity?.status === "unknown") {
    messages.push("Your vehicle capacity could not be verified for this load.");
  }
  if (compatibility.trailer?.status === "mismatch") {
    messages.push(
      `Trailer mismatch: load requires ${compatibility.trailer.requiredTrailerType || "another trailer type"}, while your profile lists ${compatibility.trailer.driverTrailerType || "a different trailer"}.`,
    );
  }
  if (compatibility.serviceArea?.status === "outside") {
    messages.push("Pickup is outside your configured service radius.");
  }
  if (compatibility.preferredRoute?.status === "not_preferred") {
    messages.push("This route is outside your saved route preferences.");
  }
  return messages;
}

async function findActiveDispatcherForLoad(
  load: any,
  candidateId: string,
) {
  const normalizedId = String(candidateId ?? "").trim();
  if (!normalizedId || !mongoose.Types.ObjectId.isValid(normalizedId)) {
    return null;
  }

  const dispatcher: any = await User.findOne({
    _id: normalizedId,
    role: { $in: ["employee", "admin", "super_admin"] },
    isActive: true,
  })
    .select("_id role organizationId name email")
    .lean();

  if (!dispatcher) return null;

  // Normal organization staff must belong to the Load's organization.
  // A global super_admin remains a valid explicit owner when they performed
  // the assignment through the organization context.
  if (
    dispatcher.role !== "super_admin" &&
    String(dispatcher.organizationId ?? "") !==
      String(load.organizationId ?? "")
  ) {
    return null;
  }

  return dispatcher;
}

async function resolveActiveDispatcherForLoad(load: any, driverId: string) {
  let dispatcher = await findActiveDispatcherForLoad(
    load,
    String((load as any).dispatchOwnerId ?? ""),
  );
  if (dispatcher) return dispatcher;

  const recovered = await resolveExplicitDispatchOwnerFromAssignmentHistory({
    organizationId: String(load.organizationId),
    driverId,
    loadId: String(load._id),
  });

  dispatcher = await findActiveDispatcherForLoad(
    load,
    String(recovered ?? ""),
  );
  if (!dispatcher) return null;

  // Repair legacy ownership without calling load.save(), which could write a
  // stale in-memory Load over a newer concurrent state. The repair is
  // best-effort; callers still receive the exact validated dispatcher.
  const repairResult = await Load.updateOne(
    expectedLoadRevisionFilter(load, {
      organizationId: load.organizationId,
    }),
    { $set: { dispatchOwnerId: dispatcher._id } },
  );

  if (repairResult.modifiedCount > 0) {
    (load as any).dispatchOwnerId = dispatcher._id;
  }

  return dispatcher;
}

function assertNoPendingLoadAmendments(load: any, driverId: string) {
  const pending = Array.isArray((load as any)?.driverAmendments)
    ? (load as any).driverAmendments.find(
        (amendment: any) =>
          amendment?.status === "pending" &&
          String(amendment?.driverId ?? "") === driverId,
      )
    : null;

  if (!pending) return;

  throw new ApiError(
    409,
    "Dispatch changed material details on this active load. Review and acknowledge the Load Update before continuing the load lifecycle.",
    [
      {
        type: "load_amendment_acknowledgement_required",
        amendmentId: String(pending._id),
        loadId: String(load._id),
      },
    ],
  );
}

async function requireDispatchOwnerBeforeAcceptance(
  load: any,
  driverId: string,
) {
  const existingOwner = await findActiveDispatcherForLoad(
    load,
    String((load as any).dispatchOwnerId ?? ""),
  );
  if (existingOwner) {
    return {
      dispatcher: existingOwner,
      recoveredFromHistory: false,
    };
  }

  const recoveredId =
    await resolveExplicitDispatchOwnerFromAssignmentHistory({
      organizationId: String(load.organizationId),
      driverId,
      loadId: String(load._id),
    });

  const recoveredOwner = await findActiveDispatcherForLoad(
    load,
    String(recoveredId ?? ""),
  );
  if (recoveredOwner) {
    return {
      dispatcher: recoveredOwner,
      recoveredFromHistory: true,
    };
  }

  throw new ApiError(
    409,
    "This load does not currently have a valid responsible dispatcher. Dispatch must reconfirm the assignment before you can accept it.",
    [
      {
        type: "dispatch_owner_required_before_acceptance",
        requiresDispatchOwnerReconfirmation: true,
        loadId: String(load._id),
      },
    ],
  );
}

function canReviewReleaseRequest(req: ExpressRequest, load: any, request: any) {
  const user = getUser(req);
  const effectiveRole = String((req as any).orgRole ?? user.role ?? "");
  if (user.role === "super_admin" || ["admin", "super_admin"].includes(effectiveRole)) {
    return true;
  }
  const ownerId = String(request?.dispatcherId ?? (load as any).dispatchOwnerId ?? "");
  return Boolean(ownerId && ownerId === user._id.toString());
}

function assertCanReviewReleaseRequest(req: ExpressRequest, load: any, request: any) {
  if (canReviewReleaseRequest(req, load, request)) return;
  throw new ApiError(
    403,
    "This release request must be reviewed by the dispatcher responsible for the load or an organization administrator.",
  );
}


const DISPATCH_OWNER_PROTECTED_LOAD_STATUSES = new Set<string>([
  "Accepted",
  "Picked Up",
  "In-Transit",
]);

function isOrganizationAdminOverride(req: ExpressRequest) {
  const user = getUser(req);
  const effectiveRole = String((req as any).orgRole ?? user.role ?? "");
  return (
    user.role === "super_admin" ||
    ["admin", "super_admin"].includes(effectiveRole)
  );
}

function getActiveLoadControlContext(
  req: ExpressRequest,
  load: any,
) {
  const user = getUser(req);
  const actorId = user._id.toString();
  const originalDispatcherId = String(load?.dispatchOwnerId ?? "").trim() || null;
  const protectedActiveLoad = DISPATCH_OWNER_PROTECTED_LOAD_STATUSES.has(
    String(load?.status ?? ""),
  );

  // Remove/Reassign are organization-support actions. The controller already
  // scopes the Load lookup to req.orgId, so another organization cannot use
  // these actions. A different member of the SAME organization may step in
  // when the responsible dispatcher is unavailable; that intervention is
  // recorded durably in the original dispatcher↔driver private chat.
  return {
    protectedActiveLoad,
    adminOverride: protectedActiveLoad && isOrganizationAdminOverride(req),
    originalDispatcherId,
    supportMemberAction: Boolean(
      originalDispatcherId && originalDispatcherId !== actorId,
    ),
  };
}

async function resolveOriginalDispatcherIdForSupportAudit(
  load: any,
  driverId: string | null,
) {
  const stored = String(load?.dispatchOwnerId ?? "").trim();
  if (stored && mongoose.Types.ObjectId.isValid(stored)) return stored;
  if (!driverId) return null;

  const recovered = await resolveExplicitDispatchOwnerFromAssignmentHistory({
    organizationId: String(load.organizationId),
    driverId,
    loadId: String(load._id),
  });
  return recovered ? String(recovered) : null;
}

async function getDriverGpsPolicyAcrossOrganizations(
  driverId: string,
  fallbackOrganizationId?: string,
) {
  const trackingLoads = await getDriverGpsTrackingLoads(driverId);
  const byOrg = new Map<string, string[]>();
  for (const load of trackingLoads) {
    const orgId = String(load.organizationId ?? "").trim();
    if (!orgId) continue;
    const ids = byOrg.get(orgId) ?? [];
    ids.push(String(load._id));
    byOrg.set(orgId, ids);
  }

  let operationalStatus: "active" | "on_leave" | "maintenance" = "active";
  let required = false;
  let reason: "active_load" | "dispatch_retained_load" | null = null;
  const requiredLoadIds = new Set<string>();
  const retainedLoadIds = new Set<string>();

  for (const [organizationId, activeLoadIds] of byOrg.entries()) {
    await finalizeDriverStatusChangeIfClear(driverId, organizationId);
    const statusContext = await getDriverStatusContext(driverId, organizationId);
    operationalStatus = statusContext.operationalStatus;
    const requirement = await getDriverLocationRequirement(
      driverId,
      organizationId,
      {
        operationalStatus: statusContext.operationalStatus,
        emergencyReleaseActive: statusContext.emergencyReleaseActive,
        activeLoadIds,
      },
    );

    if (!requirement.required) continue;
    required = true;
    if (requirement.reason === "dispatch_retained_load") {
      reason = "dispatch_retained_load";
      for (const loadId of requirement.retainedLoadIds) {
        retainedLoadIds.add(loadId);
        requiredLoadIds.add(loadId);
      }
    } else {
      if (!reason) reason = "active_load";
      for (const loadId of activeLoadIds) requiredLoadIds.add(loadId);
    }
  }

  if (byOrg.size === 0) {
    if (fallbackOrganizationId) {
      const statusContext = await getDriverStatusContext(driverId, fallbackOrganizationId);
      operationalStatus = statusContext.operationalStatus;
    } else {
      const profile: any = await DriverProfile.findOne({ userId: driverId })
        .select("operationalStatus")
        .lean();
      operationalStatus =
        profile?.operationalStatus === "on_leave" || profile?.operationalStatus === "maintenance"
          ? profile.operationalStatus
          : "active";
    }
  }

  return {
    trackingLoads,
    operationalStatus,
    required,
    reason,
    requiredLoadIds: [...requiredLoadIds],
    retainedLoadIds: [...retainedLoadIds],
  };
}

// ─── Location Heartbeat ───────────────────────────────────────────────────────
// POST /api/driver-tracking/heartbeat  { lat, lng, status? }

const heartbeat = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const { lat, lng, status, manualSharingEnabled = false } = req.body as {
    lat?: number;
    lng?: number;
    status?: string;
    manualSharingEnabled?: boolean;
  };

  if (user.role !== "driver") {
    throw new ApiError(403, "Only driver accounts can publish Driver Tracker locations");
  }

  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw new ApiError(400, "A valid latitude and longitude are required");
  }

  const driverId = user._id.toString();
  const policy = await getDriverGpsPolicyAcrossOrganizations(
    driverId,
    req.orgId as string | undefined,
  );
  const hasTrackingRelationship = policy.trackingLoads.length > 0;
  const manualSharingOptIn = manualSharingEnabled === true;

  // A stale browser watcher can send one more heartbeat immediately after the
  // last Load relationship disappears. Without an explicit Manual GPS opt-in,
  // do not recreate exact coordinates that lifecycle cleanup just removed.
  if (!hasTrackingRelationship && !manualSharingOptIn) {
    await clearDriverExactLocationIfUnneeded(
      driverId,
      "heartbeat_without_tracking_relationship",
    );

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          ok: true,
          locationAccepted: false,
          exactLocationRetained: false,
          isSharing: false,
          visibleToResponsibleDispatch: false,
        },
        "GPS is not retained because there is no active tracking relationship or Manual GPS opt-in",
      ),
    );
  }

  const allowedStatuses = ["on-route", "idle", "on-break", "waiting", "offline"];
  const requestedStatus =
    status && allowedStatuses.includes(status) ? status : undefined;
  const nextStatus =
    policy.operationalStatus === "on_leave"
      ? "offline"
      : policy.operationalStatus === "maintenance"
        ? "waiting"
        : requestedStatus;

  // DriverLocation is a platform-wide driver record. organizationId remains a
  // legacy hint only and is never used to authorize who may read coordinates.
  const contextOrganizationId =
    String(policy.trackingLoads[0]?.organizationId ?? req.orgId ?? "").trim() || undefined;
  const locationSet: Record<string, any> = {
    coords: { lat, lng },
    lastSeenAt: new Date(),
    isSharing: true,
    manualSharingOptIn,
    offlineAlertSentAt: null,
    ...(nextStatus ? { status: nextStatus } : {}),
  };
  if (contextOrganizationId) locationSet.organizationId = contextOrganizationId;

  const locationUpdate: Record<string, any> = { $set: locationSet };
  if (!nextStatus) locationUpdate.$setOnInsert = { status: "idle" };

  const location = await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    locationUpdate,
    { new: true, upsert: true },
  );

  // A heartbeat may be stored for the driver's own portal/manual sharing, but
  // exact coordinates are emitted only to dispatchers who own an Accepted,
  // Picked Up, or In-Transit load for this driver.
  await emitDriverLocationToResponsibleDispatchers(driverId, {
    coords: location.coords,
    status: location.status,
    isSharing: true,
    lastSeenAt: location.lastSeenAt,
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        ok: true,
        locationAccepted: true,
        isSharing: true,
        exactLocationRetained: true,
        manualSharingOptIn,
        status: location.status,
        visibleToResponsibleDispatch: hasTrackingRelationship,
      },
      policy.operationalStatus === "maintenance"
        ? "Location shared while driver remains In Shop"
        : policy.operationalStatus === "on_leave"
          ? "Location shared while driver remains On Leave"
          : "Location updated",
    ),
  );
});

// POST /api/driver-tracking/location-offline
const markLocationOffline = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);

    if (user.role !== "driver") {
      throw new ApiError(
        403,
        "Only driver accounts can publish Driver Tracker presence",
      );
    }

    const driverId = user._id.toString();
    const policy = await getDriverGpsPolicyAcrossOrganizations(
      driverId,
      req.orgId as string | undefined,
    );
    const forcedStatus =
      policy.operationalStatus === "maintenance" ? "waiting" : "offline";
    const locationRequired = policy.required;

    const now = new Date();
    const existing: any = await DriverLocation.findOne({ userId: user._id });
    let location: any = existing;

    if (!locationRequired) {
      await DriverLocation.deleteOne({ userId: user._id });
      return res.status(200).json(
        new ApiResponse(
          200,
          {
            ok: true,
            required: false,
            requirementReason: null,
            status: forcedStatus,
            isSharing: false,
            exactLocationRetained: false,
            silenceStartedAt: null,
          },
          policy.operationalStatus === "maintenance"
            ? "GPS sharing turned off while driver remains In Shop"
            : policy.operationalStatus === "on_leave"
              ? "GPS sharing turned off while driver remains On Leave"
              : "GPS sharing turned off",
        ),
      );
    }
    let silenceStartedAt: Date | null =
      existing?.lastSeenAt ? new Date(existing.lastSeenAt) : null;

    if (existing) {
      const update: Record<string, any> = {
        status: forcedStatus,
        isSharing: false,
        manualSharingOptIn: false,
        offlineAlertSentAt: null,
      };
      if (locationRequired) {
        update.lastSeenAt = now;
        silenceStartedAt = now;
      }
      location = await DriverLocation.findOneAndUpdate(
        { _id: existing._id },
        { $set: update },
        { new: true },
      );
    } else if (locationRequired) {
      silenceStartedAt = now;
    }

    await emitDriverLocationToResponsibleDispatchers(driverId, {
      coords: location?.coords ?? null,
      status: forcedStatus,
      isSharing: false,
      lastSeenAt: location?.lastSeenAt ?? silenceStartedAt,
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          ok: true,
          required: locationRequired,
          requirementReason: policy.reason,
          status: forcedStatus,
          isSharing: false,
          silenceStartedAt: locationRequired
            ? silenceStartedAt?.toISOString() ?? now.toISOString()
            : null,
        },
        locationRequired
          ? policy.reason === "dispatch_retained_load"
            ? "GPS is required by Dispatch while retained loads remain assigned"
            : "Driver location marked offline; required GPS silence monitoring remains active"
          : policy.operationalStatus === "maintenance"
            ? "GPS sharing turned off while driver remains In Shop"
            : policy.operationalStatus === "on_leave"
              ? "GPS sharing turned off while driver remains On Leave"
              : "GPS sharing turned off",
      ),
    );
  },
);

// ─── Active Drivers (map view) ────────────────────────────────────────────────
// GET /api/driver-tracking/active-drivers
// Identity always comes from the User record (Driver's Account is the
// source of truth); equipment from DriverProfile; presence from tracker.

const getActiveDrivers = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const dispatcherId = user._id.toString();

  // Exact GPS is a dispatcher↔driver relationship, not an organization-wide
  // permission. Assigned-only loads do not qualify because tracking begins
  // only after the driver accepts.
  const loads: any[] = await Load.find({
    organizationId,
    dispatchOwnerId: user._id,
    assignedDriverId: { $ne: null },
    status: { $in: GPS_TRACKING_LOAD_STATUSES },
  })
    .select(
      "loadNumber status pickupLocation deliveryLocation assignedDriverId dispatchOwnerId vehicles trailerType dates",
    )
    .lean();

  const activeDriverIds = [
    ...new Set(loads.map((load: any) => String(load.assignedDriverId ?? "")).filter(Boolean)),
  ];
  if (!activeDriverIds.length) {
    return res.status(200).json(new ApiResponse(200, [], "Active drivers fetched"));
  }

  const [locations, users, profiles] = await Promise.all([
    DriverLocation.find({ userId: { $in: activeDriverIds } }).lean(),
    User.find({ _id: { $in: activeDriverIds }, role: "driver", isActive: true })
      .select("name email avatar phone")
      .lean(),
    DriverProfile.find({ userId: { $in: activeDriverIds } }).lean(),
  ]);

  const userById = new Map(users.map((u: any) => [String(u._id), u]));
  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const loadsByDriver = new Map<string, any[]>();
  for (const load of loads) {
    const key = String(load.assignedDriverId);
    const current = loadsByDriver.get(key) ?? [];
    current.push(load);
    loadsByDriver.set(key, current);
  }

  const data = locations
    .filter((loc: any) => userById.has(String(loc.userId)))
    .map((loc: any) => {
      const key = String(loc.userId);
      const u: any = userById.get(key);
      const p: any = profileByUser.get(key) ?? null;
      const driverLoads = loadsByDriver.get(key) ?? [];
      const operationalStatus = p?.operationalStatus ?? "active";
      const persistedSharing =
        typeof loc.isSharing === "boolean" ? loc.isSharing : loc.status !== "offline";
      const locationIsFresh =
        Boolean(loc.lastSeenAt) &&
        Date.now() - new Date(loc.lastSeenAt).getTime() <= 5 * 60 * 1000;
      const effectiveSharing =
        Boolean(loc.coords) && locationIsFresh && Boolean(persistedSharing);
      const effectiveStatus =
        operationalStatus === "on_leave"
          ? "offline"
          : operationalStatus === "maintenance"
            ? "waiting"
            : effectiveSharing
              ? (loc.status ?? "idle")
              : "offline";

      return {
        id: key,
        status: effectiveStatus,
        coords: effectiveSharing ? (loc.coords ?? null) : null,
        lastSeenAt: loc.lastSeenAt ?? null,
        isSharing: effectiveSharing,
        dispatcherId,
        driver: {
          id: key,
          name: u.name ?? "",
          email: u.email ?? "",
          avatar: u.avatar ?? undefined,
        },
        equipment: p
          ? {
              trailerType: p.trailerType ?? null,
              maxVehicleCapacity:
                typeof p.maxVehicleCapacity === "number" ? p.maxVehicleCapacity : null,
              operationalStatus: p.operationalStatus ?? "active",
              truckMake: p.truckMake ?? undefined,
              truckModel: p.truckModel ?? undefined,
              isComplianceExpired: Boolean(p.isComplianceExpired),
            }
          : null,
        availability: {
          availableDays: Array.isArray(p?.availableDays) ? p.availableDays : [],
        },
        shipments: driverLoads.map((load: any) => ({
          id: String(load._id),
          trackingNumber: load.loadNumber,
          status: load.status,
          origin: `${load.pickupLocation?.city ?? ""}, ${load.pickupLocation?.state ?? ""}`,
          destination: `${load.deliveryLocation?.city ?? ""}, ${load.deliveryLocation?.state ?? ""}`,
          vehicleCount: Array.isArray(load.vehicles) ? load.vehicles.length : 0,
          trailerType: load.trailerType ?? null,
          pickupDate: load.dates?.firstAvailable ?? load.dates?.pickupDeadline ?? null,
        })),
      };
    });

  return res.status(200).json(new ApiResponse(200, data, "Active drivers fetched"));
});


function lifecycleSyncEvent(
  organizationId: string,
  driverIds: Array<string | null | undefined>,
  loadId: string,
) {
  return createLoadLifecycleOutboxEvent("load_sync", {
    organizationId,
    driverIds: driverIds.filter(Boolean),
    loadId,
  });
}

function lifecycleUserNotificationEvent(params: {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  return createLoadLifecycleOutboxEvent("user_notification", params);
}

function lifecycleAdminNotificationEvent(params: {
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  excludeUserId?: string;
}) {
  return createLoadLifecycleOutboxEvent("org_admin_notification", params);
}

function lifecycleActivityEvent(params: {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  description: string;
  loadId: string;
  metadata?: Record<string, unknown>;
}) {
  return createLoadLifecycleOutboxEvent("activity", params);
}

function lifecycleDispatchChatEvent(params: {
  organizationId: string;
  dispatcherId: string;
  driverId: string;
  eventType: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  // Optional actor lets a same-org support member write an auditable system
  // event into the ORIGINAL dispatcher's private thread without pretending
  // that the original dispatcher performed the action.
  performedByUserId?: string;
  performedByName?: string;
  performedByRole?: "driver" | "dispatcher";
  notifyThreadOwner?: boolean;
}) {
  return createLoadLifecycleOutboxEvent("dispatch_chat_system", params);
}

function releaseRequestSnapshot(request: any) {
  return {
    dispatcherId: request?.dispatcherId
      ? String(request.dispatcherId)
      : null,
    priority: request?.priority ?? "standard",
    reason: request?.reason ?? "other",
    message: request?.message ?? "",
    loadStatusAtRequest:
      request?.loadStatusAtRequest ?? "Assigned",
    requestedAt: request?.requestedAt ?? null,
  };
}

function lifecycleReleaseResolutionEvent(params: {
  request: any;
  organizationId: string;
  loadId: string;
  driverId: string;
  status: "approved" | "cancelled";
  decision:
    | "reassign"
    | "return_available"
    | "delivery_completed";
  reviewedBy?: string;
  replacementDriverId?: string;
}) {
  return createLoadLifecycleOutboxEvent(
    "release_request_resolution",
    {
      requestId: String(params.request._id),
      organizationId: params.organizationId,
      loadId: params.loadId,
      driverId: params.driverId,
      status: params.status,
      decision: params.decision,
      reviewedAt: new Date(),
      reviewedBy: params.reviewedBy,
      replacementDriverId: params.replacementDriverId,
      requestSnapshot: releaseRequestSnapshot(params.request),
    },
  );
}

async function flushLifecycleOutbox(loadId: string) {
  // Preserve immediate UX. Any failed effect remains durably queued and the
  // worker retries it later; lifecycle requests never become 500s because a
  // notification/socket/audit service is temporarily unavailable.
  try {
    await processLoadLifecycleOutboxForLoad(loadId);
  } catch (error) {
    logger.error(
      { error, loadId },
      "Non-fatal: immediate Load lifecycle outbox flush failed",
    );
  }
}

// ─── Atomic Load transition helpers ──────────────────────────────────────────
//
// Driver Tracker actions frequently need to perform compatibility/permission
// checks before changing a Load. Those checks operate on a snapshot. The final
// write must therefore prove that the same Load state is still current; without
// this guard, two concurrent actions can both validate an old snapshot and the
// later save can overwrite the earlier winner.
function expectedLoadRevisionFilter(
  load: any,
  expected: Record<string, unknown> = {},
) {
  const filter: Record<string, any> = {
    _id: load._id,
    ...expected,
  };

  const rawUpdatedAt = load?.updatedAt;
  if (rawUpdatedAt) {
    const updatedAt =
      rawUpdatedAt instanceof Date ? rawUpdatedAt : new Date(rawUpdatedAt);
    if (!Number.isNaN(updatedAt.getTime())) {
      filter.updatedAt = updatedAt;
    }
  }

  return filter;
}

async function updateLoadIfCurrent(params: {
  load: any;
  expected: Record<string, unknown>;
  update: Record<string, unknown>;
  action: string;
}) {
  const updated = await Load.findOneAndUpdate(
    expectedLoadRevisionFilter(params.load, params.expected),
    params.update as any,
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw new ApiError(
      409,
      `This load changed while ${params.action}. Refresh the load and try again.`,
    );
  }

  return updated;
}


type PendingLoadRequestAssignmentRequester = {
  driverId: string;
  driverName: string;
  requestedAt: string | null;
  selected: boolean;
};

type PendingLoadRequestAssignmentConflict = {
  type: "pending_load_request_assignment_confirmation";
  loadId: string;
  loadNumber: string;
  fingerprint: string;
  selectedDriverId: string;
  selectedDriverName: string;
  selectedDriverRequested: boolean;
  creatorDispatcherId: string | null;
  creatorDispatcherName: string | null;
  pendingRequesters: PendingLoadRequestAssignmentRequester[];
};

function pendingLoadRequestSnapshot(load: any) {
  const requests = Array.isArray(load?.driverRequests)
    ? load.driverRequests
    : [];

  return requests
    .map((request: any) => {
      const driverId = String(request?.driverId ?? "").trim();
      if (!driverId) return null;

      const rawRequestedAt = request?.requestedAt;
      const date = rawRequestedAt ? new Date(rawRequestedAt) : null;
      const requestedAt =
        date && !Number.isNaN(date.getTime())
          ? date.toISOString()
          : rawRequestedAt
            ? String(rawRequestedAt)
            : "";

      return {
        requestId: String(request?._id ?? ""),
        driverId,
        requestedAt,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) =>
      `${a.driverId}:${a.requestedAt}:${a.requestId}`.localeCompare(
        `${b.driverId}:${b.requestedAt}:${b.requestId}`,
      ),
    );
}

function pendingLoadRequestFingerprint(load: any) {
  return createHash("sha256")
    .update(JSON.stringify(pendingLoadRequestSnapshot(load)))
    .digest("hex");
}

async function buildPendingLoadRequestAssignmentConflict(params: {
  load: any;
  selectedDriverId: string;
  selectedDriverName: string;
}): Promise<PendingLoadRequestAssignmentConflict> {
  const { load, selectedDriverId, selectedDriverName } = params;
  const pendingRequests = Array.isArray(load?.driverRequests)
    ? load.driverRequests
    : [];
  const requesterIds = [
    ...new Set(
      pendingRequests
        .map((request: any) => String(request?.driverId ?? "").trim())
        .filter(Boolean),
    ),
  ];

  const creatorDispatcherId = String(load?.createdBy ?? "").trim();
  const [requesters, creatorDispatcher] = await Promise.all([
    requesterIds.length > 0
      ? User.find({
          _id: { $in: requesterIds },
          role: "driver",
        })
          .select("_id name")
          .lean()
      : Promise.resolve([]),
    creatorDispatcherId
      ? findActiveDispatcherForLoad(load, creatorDispatcherId)
      : Promise.resolve(null),
  ]);

  const nameByDriverId = new Map(
    (requesters as any[]).map((requester: any) => [
      String(requester._id),
      String(requester.name || "Driver").trim() || "Driver",
    ]),
  );

  const pendingRequesters: PendingLoadRequestAssignmentRequester[] =
    pendingRequests
      .map((request: any) => {
        const requestDriverId = String(request?.driverId ?? "").trim();
        if (!requestDriverId) return null;
        const rawRequestedAt = request?.requestedAt;
        const date = rawRequestedAt ? new Date(rawRequestedAt) : null;
        return {
          driverId: requestDriverId,
          driverName:
            nameByDriverId.get(requestDriverId) ||
            (requestDriverId === selectedDriverId
              ? selectedDriverName
              : "Driver"),
          requestedAt:
            date && !Number.isNaN(date.getTime())
              ? date.toISOString()
              : null,
          selected: requestDriverId === selectedDriverId,
        };
      })
      .filter(Boolean) as PendingLoadRequestAssignmentRequester[];

  return {
    type: "pending_load_request_assignment_confirmation",
    loadId: String(load._id),
    loadNumber: String(load.loadNumber || load._id),
    fingerprint: pendingLoadRequestFingerprint(load),
    selectedDriverId,
    selectedDriverName,
    selectedDriverRequested: pendingRequesters.some(
      (requester) => requester.driverId === selectedDriverId,
    ),
    creatorDispatcherId: creatorDispatcher
      ? String((creatorDispatcher as any)._id)
      : null,
    creatorDispatcherName: creatorDispatcher
      ? String((creatorDispatcher as any).name || "Dispatch").trim() ||
        "Dispatch"
      : null,
    pendingRequesters,
  };
}

function pendingLoadRequestAssignmentMessage(
  conflict: PendingLoadRequestAssignmentConflict,
) {
  const requestCount = conflict.pendingRequesters.length;
  const requestLabel = requestCount === 1 ? "request" : "requests";

  return conflict.selectedDriverRequested
    ? `Load ${conflict.loadNumber} has ${requestCount} pending driver ${requestLabel}. Confirm the assignment to fulfill ${conflict.selectedDriverName}'s request and resolve the remaining requests.`
    : `Load ${conflict.loadNumber} has ${requestCount} pending driver ${requestLabel}. Confirm the assignment to ${conflict.selectedDriverName}; the pending requests will be marked not selected.`;
}

// ─── Assign / Reassign / Remove (dispatcher actions) ─────────────────────────

// POST /api/driver-tracking/assign-load  { loadId, driverId }
const assignLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const {
    loadId,
    driverId,
    overrideAvailability = false,
    overrideCapacity = false,
    pendingRequestFingerprint,
  } = req.body as {
    loadId?: string;
    driverId?: string;
    overrideAvailability?: boolean;
    overrideCapacity?: boolean;
    pendingRequestFingerprint?: string;
  };

  if (!loadId || !driverId) {
    throw new ApiError(400, "loadId and driverId are required");
  }

  let [load, driver] = await Promise.all([
    Load.findOne({ _id: loadId, organizationId }),
    // Drivers are a shared platform-wide pool — assignable regardless of org.
    User.findOne({ _id: driverId, role: "driver", isActive: true }).lean(),
  ]);

  if (!load) throw new ApiError(404, "Load not found");
  if (!driver) throw new ApiError(404, "Driver not found");
  await assertDriverCanTakeNewWork(driverId, organizationId, "assign");

  // Normal assignment owns only Posted + unassigned loads. Already-assigned
  // records must go through the dedicated reassign path so one action cannot
  // silently replace another driver's assignment.
  if (load.status !== "Posted" || load.assignedDriverId) {
    throw new ApiError(
      409,
      load.assignedDriverId
        ? "This load is already assigned. Use Reassign instead."
        : `Cannot assign a load in ${load.status} status`,
    );
  }

  const dispatcherId = user._id.toString();
  const dispatcherName =
    String(user.name || "Dispatch").trim() || "Dispatch";
  const assignedDriverName =
    String((driver as any).name || "Driver").trim() || "Driver";
  const pendingRequests = Array.isArray((load as any).driverRequests)
    ? ((load as any).driverRequests as any[])
    : [];

  // A pending driver request is a real workflow state. Direct assignment is
  // still allowed, but it can no longer erase that state silently. Dispatch
  // must confirm the exact request snapshot it reviewed before assignment.
  let pendingRequestConflict: PendingLoadRequestAssignmentConflict | null = null;
  if (pendingRequests.length > 0) {
    pendingRequestConflict =
      await buildPendingLoadRequestAssignmentConflict({
        load,
        selectedDriverId: driverId,
        selectedDriverName: assignedDriverName,
      });

    if (
      !pendingRequestFingerprint ||
      pendingRequestFingerprint !== pendingRequestConflict.fingerprint
    ) {
      throw new ApiError(
        409,
        pendingLoadRequestAssignmentMessage(pendingRequestConflict),
        [pendingRequestConflict],
      );
    }
  }

  // Preserve the existing compatibility gate after Dispatch has acknowledged
  // the pending-request consequences. The confirmation fingerprint travels
  // through the compatibility review so both protections remain active.
  await assertDriverLoadCompatibility({
    driverId,
    organizationId,
    load,
    actor: "dispatcher",
    overrides: { overrideAvailability, overrideCapacity },
  });

  const validatedLoad = load;
  const requestDispatcherId = String((load as any).createdBy ?? "").trim();
  const actorIsLoadRequestDispatcher = Boolean(
    requestDispatcherId && requestDispatcherId === dispatcherId,
  );
  const creatorDispatcherId =
    pendingRequestConflict?.creatorDispatcherId ?? null;
  const creatorDispatcherName =
    pendingRequestConflict?.creatorDispatcherName ?? "Dispatch";
  const selectedDriverRequested = Boolean(
    pendingRequestConflict?.selectedDriverRequested,
  );
  const pendingRequesters =
    pendingRequestConflict?.pendingRequesters ?? [];
  const affectedDriverIds = [
    ...new Set([
      driverId,
      ...pendingRequesters.map((requester) => requester.driverId),
    ]),
  ];

  const assignmentOutbox: any[] = [
    lifecycleSyncEvent(
      organizationId,
      affectedDriverIds,
      load._id.toString(),
    ),
  ];

  if (selectedDriverRequested) {
    assignmentOutbox.push(
      lifecycleUserNotificationEvent({
        userId: driverId,
        organizationId,
        type: "driver_request_approved",
        title: "Load Request Fulfilled",
        message: `Your request for load ${load.loadNumber} was fulfilled and the load was assigned to you.`,
        metadata: {
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
          driverId,
          assignmentResolution: "fulfilled",
          route: "/driver",
        },
      }),
    );

    if (actorIsLoadRequestDispatcher) {
      assignmentOutbox.push(
        lifecycleDispatchChatEvent({
          organizationId,
          dispatcherId,
          driverId,
          eventType: "driver_load_request_fulfilled",
          title: "Load Request Fulfilled",
          message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled the pending request.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            action: "request_fulfilled_by_load_dispatcher",
            actorId: dispatcherId,
            actorName: dispatcherName,
            actorRole: "dispatcher",
            driverId,
            driverName: assignedDriverName,
            dispatcherId,
            dispatcherName,
            originalDispatcherId: requestDispatcherId || dispatcherId,
            unreadForParticipantIds: [dispatcherId, driverId],
            audienceMessages: {
              actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled their pending request.`,
              dispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled their pending request.`,
              driver: `${dispatcherName} assigned load ${load.loadNumber} to you and fulfilled your pending request.`,
            },
          },
        }),
      );
    } else {
      // B ↔ X is a separate private thread. B sees their own identity; X sees
      // only "another dispatcher" because B is not the dispatcher tied to
      // THIS requested load, regardless of any unrelated B ↔ X relationship.
      assignmentOutbox.push(
        lifecycleDispatchChatEvent({
          organizationId,
          dispatcherId,
          driverId,
          eventType: "driver_load_request_fulfilled_by_support_dispatcher",
          title: "Load Request Fulfilled",
          message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled the pending request.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            action: "request_fulfilled_by_support_dispatcher",
            actorId: dispatcherId,
            actorName: dispatcherName,
            actorRole: "dispatcher",
            dispatcherId,
            dispatcherName,
            driverId,
            driverName: assignedDriverName,
            originalDispatcherId: requestDispatcherId || null,
            performedByUserId: dispatcherId,
            performedByName: dispatcherName,
            hidePerformerIdentityFromDriver: true,
            unreadForParticipantIds: [dispatcherId, driverId],
            audienceMessages: {
              actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled their pending request.`,
              dispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled their pending request.`,
              driver: `Another dispatcher assigned load ${load.loadNumber} to you and fulfilled your pending request.`,
            },
          },
          performedByUserId: dispatcherId,
          performedByName: dispatcherName,
        }),
      );

      if (creatorDispatcherId && creatorDispatcherId !== dispatcherId) {
        assignmentOutbox.push(
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: creatorDispatcherId,
            driverId,
            eventType: "driver_load_request_fulfilled_by_org_member",
            title: "Load Request Fulfilled",
            message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName}, fulfilling ${assignedDriverName}'s pending request.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "request_fulfilled_by_org_member",
              actorId: dispatcherId,
              actorName: dispatcherName,
              actorRole: "dispatcher",
              dispatcherId: creatorDispatcherId,
              dispatcherName: creatorDispatcherName,
              driverId,
              driverName: assignedDriverName,
              originalDispatcherId: creatorDispatcherId,
              performedByUserId: dispatcherId,
              performedByName: dispatcherName,
              hidePerformerIdentityFromDriver: true,
              unreadForParticipantIds: [creatorDispatcherId],
              audienceMessages: {
                actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName} and fulfilled their pending request.`,
                threadDispatcher: `${assignedDriverName}'s request for load ${load.loadNumber} was fulfilled by ${dispatcherName}, who assigned the load to ${assignedDriverName}.`,
                dispatcher: `${assignedDriverName}'s request for load ${load.loadNumber} was fulfilled by ${dispatcherName}, who assigned the load to ${assignedDriverName}.`,
                driver: `Your request for load ${load.loadNumber} was fulfilled by another dispatcher.`,
              },
            },
            performedByUserId: dispatcherId,
            performedByName: dispatcherName,
            notifyThreadOwner: true,
          }),
        );
      }
    }
  } else {
    // No request from the selected driver: preserve the normal direct
    // assignment notification. This newly assigned driver now has a direct
    // relationship to the acting dispatcher for this specific load.
    assignmentOutbox.push(
      lifecycleUserNotificationEvent({
        userId: driverId,
        organizationId,
        type: "driver_assigned",
        title: "New Load Assigned",
        message: `You've been assigned load ${load.loadNumber}`,
        metadata: {
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
        },
      }),
      lifecycleDispatchChatEvent({
        organizationId,
        dispatcherId,
        driverId,
        eventType: "driver_load_assigned",
        title: "New Load Assigned",
        message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName}.`,
        metadata: {
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
          action: "assigned",
          actorId: dispatcherId,
          actorName: dispatcherName,
          actorRole: "dispatcher",
          driverId,
          driverName: assignedDriverName,
          dispatcherId,
          dispatcherName,
          unreadForParticipantIds: [dispatcherId, driverId],
          audienceMessages: {
            dispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}.`,
            driver: `${dispatcherName} assigned load ${load.loadNumber} to you.`,
          },
        },
      }),
    );
  }

  // Resolve every outstanding requester. The selected requester (if any) was
  // handled above as fulfilled; every other requester receives an explicit
  // Not Selected outcome rather than disappearing from driverRequests.
  for (const requester of pendingRequesters) {
    if (requester.driverId === driverId) continue;

    assignmentOutbox.push(
      lifecycleUserNotificationEvent({
        userId: requester.driverId,
        organizationId,
        type: "driver_request_rejected",
        title: "Load Request Not Selected",
        message: `Your request for load ${load.loadNumber} was not selected because the load was assigned to another driver.`,
        metadata: {
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
          driverId: requester.driverId,
          selectedDriverId: driverId,
          assignmentResolution: "not_selected",
          route: "/driver",
        },
      }),
    );

    if (actorIsLoadRequestDispatcher) {
      assignmentOutbox.push(
        lifecycleDispatchChatEvent({
          organizationId,
          dispatcherId,
          driverId: requester.driverId,
          eventType: "driver_load_request_not_selected",
          title: "Load Request Not Selected",
          message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName}; ${requester.driverName}'s pending request was not selected.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            action: "request_not_selected_by_load_dispatcher",
            actorId: dispatcherId,
            actorName: dispatcherName,
            actorRole: "dispatcher",
            dispatcherId,
            dispatcherName,
            driverId: requester.driverId,
            driverName: requester.driverName,
            selectedDriverId: driverId,
            selectedDriverName: assignedDriverName,
            originalDispatcherId: requestDispatcherId || dispatcherId,
            unreadForParticipantIds: [dispatcherId, requester.driverId],
            audienceMessages: {
              actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}. ${requester.driverName}'s pending request was not selected.`,
              dispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}. ${requester.driverName}'s pending request was not selected.`,
              driver: `${dispatcherName} assigned load ${load.loadNumber} to another driver. Your request was not selected.`,
            },
          },
        }),
      );
    } else {
      assignmentOutbox.push(
        lifecycleDispatchChatEvent({
          organizationId,
          dispatcherId,
          driverId: requester.driverId,
          eventType: "driver_load_request_not_selected",
          title: "Load Request Not Selected",
          message: `${dispatcherName} assigned load ${load.loadNumber} to ${assignedDriverName}; ${requester.driverName}'s pending request was not selected.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            action: "request_not_selected_by_support_dispatcher",
            actorId: dispatcherId,
            actorName: dispatcherName,
            actorRole: "dispatcher",
            dispatcherId,
            dispatcherName,
            driverId: requester.driverId,
            driverName: requester.driverName,
            selectedDriverId: driverId,
            selectedDriverName: assignedDriverName,
            originalDispatcherId: requestDispatcherId || null,
            performedByUserId: dispatcherId,
            performedByName: dispatcherName,
            hidePerformerIdentityFromDriver: true,
            unreadForParticipantIds: [dispatcherId, requester.driverId],
            audienceMessages: {
              actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}. ${requester.driverName}'s pending request was not selected.`,
              dispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}. ${requester.driverName}'s pending request was not selected.`,
              driver: `Your request for load ${load.loadNumber} was not selected because another dispatcher assigned the load to another driver.`,
            },
          },
          performedByUserId: dispatcherId,
          performedByName: dispatcherName,
        }),
      );

      if (creatorDispatcherId && creatorDispatcherId !== dispatcherId) {
        assignmentOutbox.push(
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: creatorDispatcherId,
            driverId: requester.driverId,
            eventType: "driver_load_request_not_selected_by_org_member",
            title: "Load Request Not Selected",
            message: `${requester.driverName}'s request for load ${load.loadNumber} was closed because ${dispatcherName} assigned the load to ${assignedDriverName}.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "request_not_selected_by_org_member",
              actorId: dispatcherId,
              actorName: dispatcherName,
              actorRole: "dispatcher",
              dispatcherId: creatorDispatcherId,
              dispatcherName: creatorDispatcherName,
              driverId: requester.driverId,
              driverName: requester.driverName,
              selectedDriverId: driverId,
              selectedDriverName: assignedDriverName,
              originalDispatcherId: creatorDispatcherId,
              performedByUserId: dispatcherId,
              performedByName: dispatcherName,
              hidePerformerIdentityFromDriver: true,
              unreadForParticipantIds: [creatorDispatcherId],
              audienceMessages: {
                actorDispatcher: `You assigned load ${load.loadNumber} to ${assignedDriverName}. ${requester.driverName}'s pending request was not selected.`,
                threadDispatcher: `${requester.driverName}'s request for load ${load.loadNumber} was closed because ${dispatcherName} assigned the load to ${assignedDriverName}.`,
                dispatcher: `${requester.driverName}'s request for load ${load.loadNumber} was closed because ${dispatcherName} assigned the load to ${assignedDriverName}.`,
                driver: `Your request for load ${load.loadNumber} was not selected because another dispatcher assigned the load to another driver.`,
              },
            },
            performedByUserId: dispatcherId,
            performedByName: dispatcherName,
            notifyThreadOwner: true,
          }),
        );
      }
    }
  }

  assignmentOutbox.push(
    lifecycleActivityEvent({
      userId: user._id.toString(),
      organizationId,
      type: "load_assigned",
      title: "Load Assigned",
      description: pendingRequesters.length
        ? `Assigned load ${load.loadNumber} to ${assignedDriverName} and resolved ${pendingRequesters.length} pending driver request${pendingRequesters.length === 1 ? "" : "s"}`
        : `Assigned load ${load.loadNumber} to ${assignedDriverName}`,
      loadId: load._id.toString(),
      metadata: {
        driverId,
        pendingRequestCount: pendingRequesters.length,
        selectedDriverRequested,
      },
    }),
  );

  load = await withDriverCommitmentLock(driverId, async () => {
    // Re-read eligibility while holding the global driver lock so a concurrent
    // cross-org Work Availability transition cannot slip between checks.
    await assertDriverCanTakeNewWork(driverId, organizationId, "assign");
    await assertNoDriverCommitmentConflict({
      driverId,
      targetLoad: validatedLoad,
      excludeLoadId: validatedLoad._id.toString(),
      actor: "dispatcher",
    });

    const updated = await Load.findOneAndUpdate(
      expectedLoadRevisionFilter(validatedLoad, {
        organizationId,
        status: "Posted",
        assignedDriverId: null,
      }),
      appendLoadLifecycleOutbox(
        {
          $set: {
            assignedDriverId: driver._id,
            dispatchOwnerId: user._id,
            status: "Assigned",
            assignedAt: new Date(),
            // Safe only after every request in this exact confirmed snapshot
            // has received a durable fulfilled/not-selected resolution above.
            driverRequests: [],
            assignmentMaterialFingerprint:
              getLoadAcceptanceMaterialVersion(validatedLoad),
            assignmentCompatibilityOverrides: {
              overrideAvailability: Boolean(overrideAvailability),
              overrideCapacity: Boolean(overrideCapacity),
            },
          },
        },
        assignmentOutbox,
      ) as any,
      { new: true, runValidators: true },
    );

    if (updated) return updated;

    // The revision guard protects the gap between confirmation and commit. If
    // another driver requested the load during that gap, return a NEW
    // confirmation snapshot instead of silently resolving a request Dispatch
    // never saw.
    const latest = await Load.findOne({ _id: loadId, organizationId });
    if (latest && latest.status === "Posted" && !latest.assignedDriverId) {
      const latestPendingRequests = Array.isArray(
        (latest as any).driverRequests,
      )
        ? ((latest as any).driverRequests as any[])
        : [];
      const latestFingerprint = latestPendingRequests.length
        ? pendingLoadRequestFingerprint(latest)
        : "";

      if (
        latestPendingRequests.length > 0 &&
        latestFingerprint !== String(pendingRequestFingerprint ?? "")
      ) {
        const latestConflict =
          await buildPendingLoadRequestAssignmentConflict({
            load: latest,
            selectedDriverId: driverId,
            selectedDriverName: assignedDriverName,
          });
        throw new ApiError(
          409,
          "The pending request list changed before assignment. Review the updated requests and confirm again.",
          [latestConflict],
        );
      }
    }

    throw new ApiError(
      409,
      "This load changed while assigning it. Refresh the load and try again.",
    );
  });

  await flushLifecycleOutbox(load._id.toString());

  logger.info(
    {
      loadId,
      driverId,
      orgId: organizationId,
      resolvedPendingRequests: pendingRequesters.length,
      selectedDriverRequested,
    },
    "Load assigned to driver",
  );

  return res
    .status(200)
    .json(new ApiResponse(200, load, "Load assigned successfully"));
});

// POST /api/driver-tracking/reassign-load  { loadId, driverId }
const reassignLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const {
    loadId,
    driverId,
    overrideAvailability = false,
    overrideCapacity = false,
  } = req.body as {
    loadId?: string;
    driverId?: string;
    overrideAvailability?: boolean;
    overrideCapacity?: boolean;
  };

  if (!loadId || !driverId) throw new ApiError(400, "loadId and driverId are required");

  let load = await Load.findOne({ _id: loadId, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot reassign a load in ${load.status} status`);
  }

  const previousDriverId = load.assignedDriverId
    ? load.assignedDriverId.toString()
    : null;
  let pendingReleaseRequest = previousDriverId
    ? await LoadReleaseRequest.findOne({
        loadId: load._id,
        driverId: previousDriverId,
        status: "pending",
      })
    : null;
  const originalDispatcherId =
    await resolveOriginalDispatcherIdForSupportAudit(load, previousDriverId);
  const activeAuthority = {
    ...getActiveLoadControlContext(req, load),
    originalDispatcherId,
    supportMemberAction: Boolean(
      originalDispatcherId && originalDispatcherId !== user._id.toString(),
    ),
  };

  // Reassign/Remove are intentionally available to any authenticated member
  // of the same organization so another dispatcher can support the trip when
  // the original dispatcher is unavailable. If a release request is pending,
  // the actual reassignment resolves it and records reviewedBy = this actor;
  // the dedicated approve/reject review endpoints retain their stricter rules.

  const [driver, previousDriver] = await Promise.all([
    User.findOne({
      _id: driverId,
      role: "driver",
      isActive: true,
    }).lean(),
    previousDriverId
      ? User.findOne({ _id: previousDriverId, role: "driver" })
          .select("_id name")
          .lean()
      : Promise.resolve(null),
  ]);
  if (!driver) throw new ApiError(404, "Driver not found");
  await assertDriverCanTakeNewWork(driverId, organizationId, "reassign");

  await assertDriverLoadCompatibility({
    driverId,
    organizationId,
    load,
    actor: "dispatcher",
    overrides: { overrideAvailability, overrideCapacity },
  });

  const previousStatus = load.status;
  const previousAssignedDriver = load.assignedDriverId ?? null;
  const validatedLoad = load;
  const actorName = String(user.name || "Organization member").trim();
  const previousDriverName = String(
    (previousDriver as any)?.name || "the assigned driver",
  ).trim();
  const newDriverName = String(
    (driver as any)?.name || "the replacement driver",
  ).trim();

  const reassignmentOutbox = [
    lifecycleSyncEvent(
      organizationId,
      [previousDriverId, driverId],
      load._id.toString(),
    ),
    ...(previousDriverId && previousDriverId !== driverId
      ? [
          lifecycleUserNotificationEvent({
            userId: previousDriverId,
            organizationId,
            type: "driver_assigned",
            title: pendingReleaseRequest ? "Release Request Approved" : "Load Reassigned",
            message: pendingReleaseRequest
              ? `Dispatch approved your release request for load ${load.loadNumber} and reassigned the load to another driver. Location sharing for this load is no longer required.`
              : `Load ${load.loadNumber} has been reassigned to another driver`,
            metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
          }),
          ...(!activeAuthority.supportMemberAction
            ? [
                lifecycleDispatchChatEvent({
                  organizationId,
                  dispatcherId: user._id.toString(),
                  driverId: previousDriverId,
                  eventType: "driver_load_reassigned",
                  title: "Load Reassigned",
                  message: `${actorName} reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                  metadata: {
                    loadId: load._id.toString(),
                    loadNumber: load.loadNumber,
                    action: "reassigned_away",
                    actorId: user._id.toString(),
                    actorName,
                    actorRole: "dispatcher",
                    driverId: previousDriverId,
                    driverName: previousDriverName,
                    dispatcherId: user._id.toString(),
                    dispatcherName: actorName,
                    previousDriverId,
                    previousDriverName,
                    newDriverId: driverId,
                    newDriverName,
                    unreadForParticipantIds: [
                      user._id.toString(),
                      previousDriverId,
                    ],
                    audienceMessages: {
                      actorDispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      threadDispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      dispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      driver: `${actorName} reassigned load ${load.loadNumber} from you to another driver.`,
                    },
                  },
                }),
              ]
            : []),
        ]
      : []),
    ...(activeAuthority.supportMemberAction &&
    activeAuthority.originalDispatcherId &&
    previousDriverId
      ? [
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: activeAuthority.originalDispatcherId,
            driverId: previousDriverId,
            eventType: "driver_load_reassigned_by_org_member",
            title: "Load Reassigned",
            message:
              previousDriverId === driverId
                ? `${actorName} reassigned load ${load.loadNumber} for ${previousDriverName} and became the responsible dispatcher.`
                : `${actorName} reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "organization_member_reassigned",
              actorId: user._id.toString(),
              actorName,
              actorRole: "dispatcher",
              driverId: previousDriverId,
              driverName: previousDriverName,
              dispatcherId: activeAuthority.originalDispatcherId,
              previousDriverId,
              previousDriverName,
              newDriverId: driverId,
              newDriverName,
              originalDispatcherId: activeAuthority.originalDispatcherId,
              performedByUserId: user._id.toString(),
              performedByName: actorName,
              hidePerformerIdentityFromDriver: true,
              unreadForParticipantIds: [
                activeAuthority.originalDispatcherId,
              ],
              audienceMessages: {
                actorDispatcher:
                  previousDriverId === driverId
                    ? `You took over load ${load.loadNumber} for ${previousDriverName}.`
                    : `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                threadDispatcher:
                  previousDriverId === driverId
                    ? `Load ${load.loadNumber} for ${previousDriverName} was taken over by ${actorName}.`
                    : `Load ${load.loadNumber} was reassigned from ${previousDriverName} to ${newDriverName} by ${actorName}.`,
                dispatcher:
                  previousDriverId === driverId
                    ? `Load ${load.loadNumber} for ${previousDriverName} was taken over by ${actorName}.`
                    : `Load ${load.loadNumber} was reassigned from ${previousDriverName} to ${newDriverName} by ${actorName}.`,
                driver:
                  previousDriverId === driverId
                    ? `Your load ${load.loadNumber} is now managed by another dispatcher.`
                    : `Your load ${load.loadNumber} was reassigned by another dispatcher.`,
              },
            },
            performedByUserId: user._id.toString(),
            performedByName: actorName,
            notifyThreadOwner: true,
          }),
          ...(previousDriverId !== driverId
            ? [
                lifecycleDispatchChatEvent({
                  organizationId,
                  dispatcherId: user._id.toString(),
                  driverId: previousDriverId,
                  eventType: "driver_load_reassigned_by_support_dispatcher",
                  title: "Load Reassigned",
                  message: `${actorName} reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                  metadata: {
                    loadId: load._id.toString(),
                    loadNumber: load.loadNumber,
                    action: "support_dispatcher_reassigned_away",
                    actorId: user._id.toString(),
                    actorName,
                    actorRole: "dispatcher",
                    dispatcherId: user._id.toString(),
                    dispatcherName: actorName,
                    driverId: previousDriverId,
                    driverName: previousDriverName,
                    previousDriverId,
                    previousDriverName,
                    newDriverId: driverId,
                    newDriverName,
                    originalDispatcherId: activeAuthority.originalDispatcherId,
                    performedByUserId: user._id.toString(),
                    performedByName: actorName,
                    hidePerformerIdentityFromDriver: true,
                    threadPreview: `Load ${load.loadNumber} reassigned.`,
                    unreadForParticipantIds: [
                      user._id.toString(),
                      previousDriverId,
                    ],
                    audienceMessages: {
                      actorDispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      threadDispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      dispatcher: `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`,
                      driver: `Your load ${load.loadNumber} was reassigned by another dispatcher.`,
                    },
                  },
                  performedByUserId: user._id.toString(),
                  performedByName: actorName,
                }),
              ]
            : []),
        ]
      : []),
    lifecycleUserNotificationEvent({
      userId: driverId,
      organizationId,
      type: "driver_assigned",
      title: previousDriverId && previousDriverId !== driverId
        ? "Load Reassigned to You"
        : "New Load Assigned",
      message: previousDriverId && previousDriverId !== driverId
        ? `${actorName} reassigned load ${load.loadNumber} to you.`
        : `${actorName} assigned load ${load.loadNumber} to you.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        driverId,
        driverName: newDriverName,
        dispatcherId: user._id.toString(),
        dispatcherName: actorName,
        previousDriverId,
        previousDriverName,
        action: previousDriverId && previousDriverId !== driverId
          ? "reassigned_to"
          : "assigned_to",
        route: "/driver",
      },
    }),
    lifecycleDispatchChatEvent({
      organizationId,
      dispatcherId: user._id.toString(),
      driverId,
      eventType: "driver_load_assigned",
      title: previousDriverId && previousDriverId !== driverId
        ? "Load Reassigned to You"
        : "New Load Assigned",
      message: previousDriverId && previousDriverId !== driverId
        ? `${actorName} reassigned load ${load.loadNumber} to ${newDriverName}.`
        : `${actorName} assigned load ${load.loadNumber} to ${newDriverName}.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        action: previousDriverId && previousDriverId !== driverId
          ? "reassigned_to"
          : "assigned_to",
        actorId: user._id.toString(),
        actorName,
        actorRole: "dispatcher",
        driverId,
        driverName: newDriverName,
        dispatcherId: user._id.toString(),
        dispatcherName: actorName,
        previousDriverId,
        previousDriverName,
        newDriverId: driverId,
        newDriverName,
        unreadForParticipantIds: [
          user._id.toString(),
          driverId,
        ],
        audienceMessages: {
          actorDispatcher: previousDriverId && previousDriverId !== driverId
            ? `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`
            : `You assigned load ${load.loadNumber} to ${newDriverName}.`,
          threadDispatcher: previousDriverId && previousDriverId !== driverId
            ? `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`
            : `You assigned load ${load.loadNumber} to ${newDriverName}.`,
          dispatcher: previousDriverId && previousDriverId !== driverId
            ? `You reassigned load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}.`
            : `You assigned load ${load.loadNumber} to ${newDriverName}.`,
          driver: previousDriverId && previousDriverId !== driverId
            ? `${actorName} reassigned load ${load.loadNumber} to you.`
            : `${actorName} assigned load ${load.loadNumber} to you.`,
        },
      },
    }),
    lifecycleActivityEvent({
      userId: user._id.toString(),
      organizationId,
      type: "load_reassigned",
      title: "Load Reassigned",
      description: activeAuthority.supportMemberAction
        ? `${actorName} supported the transaction by reassigning load ${load.loadNumber} from ${previousDriverName} to ${newDriverName}`
        : activeAuthority.adminOverride
          ? `Administrator override: reassigned active load ${load.loadNumber} to ${newDriverName}`
          : `Reassigned load ${load.loadNumber} to ${newDriverName}`,
      loadId: load._id.toString(),
      metadata: {
        previousDriverId,
        newDriverId: driverId,
        originalDispatcherId: activeAuthority.originalDispatcherId,
        performedByUserId: user._id.toString(),
        supportMemberAction: activeAuthority.supportMemberAction,
      },
    }),
    ...(pendingReleaseRequest
      ? [
          lifecycleReleaseResolutionEvent({
            request: pendingReleaseRequest,
            organizationId,
            loadId: load._id.toString(),
            driverId: previousDriverId as string,
            status: "approved",
            decision: "reassign",
            reviewedBy: user._id.toString(),
            replacementDriverId: driverId,
          }),
        ]
      : []),
  ];

  load = await withDriverCommitmentLock(driverId, async () => {
    await assertDriverCanTakeNewWork(driverId, organizationId, "reassign");
    await assertNoDriverCommitmentConflict({
      driverId,
      targetLoad: validatedLoad,
      excludeLoadId: validatedLoad._id.toString(),
      actor: "dispatcher",
    });

    return updateLoadIfCurrent({
      load: validatedLoad,
      expected: {
        organizationId,
        status: previousStatus,
        assignedDriverId: previousAssignedDriver,
      },
      update: appendLoadLifecycleOutbox(
        {
          $set: {
            assignedDriverId: driver._id,
            dispatchOwnerId: user._id,
            status: "Assigned",
            assignedAt: new Date(),
            assignmentMaterialFingerprint: getLoadAcceptanceMaterialVersion(validatedLoad),
            assignmentCompatibilityOverrides: {
              overrideAvailability: Boolean(overrideAvailability),
              overrideCapacity: Boolean(overrideCapacity),
            },
          },
        },
        reassignmentOutbox,
      ),
      action: "reassigning it",
    });
  });

  await flushLifecycleOutbox(load._id.toString());

  if (previousDriverId && previousDriverId !== driverId) {
    try {
      await clearDriverExactLocationIfUnneeded(
        previousDriverId,
        "load_reassigned_away",
      );
    } catch (err) {
      logger.error(
        { err, previousDriverId },
        "Non-fatal: failed to clear exact GPS after reassignment",
      );
    }

    try {
      await finalizeDriverStatusChangeIfClear(previousDriverId, organizationId);
    } catch (err) {
      logger.error({ err, previousDriverId }, "Non-fatal: failed to finalize driver status transition after reassignment");
    }
  }

  return res.status(200).json(new ApiResponse(200, load, "Load reassigned successfully"));
});

// POST /api/driver-tracking/remove-load  { loadId }
// Dispatcher pulls a load back from a driver → returns to the available pool
const removeLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { loadId } = req.body as { loadId?: string };

  if (!loadId) throw new ApiError(400, "loadId is required");

  let load = await Load.findOne({ _id: loadId, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId) throw new ApiError(400, "Load has no assigned driver");
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot remove driver from a load in ${load.status} status`);
  }

  const previousDriverId = load.assignedDriverId.toString();
  let pendingReleaseRequest = await LoadReleaseRequest.findOne({
    loadId: load._id,
    driverId: previousDriverId,
    status: "pending",
  });
  const originalDispatcherId =
    await resolveOriginalDispatcherIdForSupportAudit(load, previousDriverId);
  const activeAuthority = {
    ...getActiveLoadControlContext(req, load),
    originalDispatcherId,
    supportMemberAction: Boolean(
      originalDispatcherId && originalDispatcherId !== user._id.toString(),
    ),
  };
  const previousDriver: any = await User.findOne({
    _id: previousDriverId,
    role: "driver",
  })
    .select("_id name")
    .lean();
  const actorName = String(user.name || "Organization member").trim();
  const previousDriverName = String(
    previousDriver?.name || "the assigned driver",
  ).trim();

  const previousStatus = load.status;
  const removalOutbox = [
    lifecycleSyncEvent(organizationId, [previousDriverId], load._id.toString()),
    lifecycleUserNotificationEvent({
      userId: previousDriverId,
      organizationId,
      type: "general",
      title: pendingReleaseRequest ? "Release Request Approved" : "Load Removed",
      message: pendingReleaseRequest
        ? `Dispatch approved your release request for load ${load.loadNumber}. The load has returned to Available Loads and location sharing for it is no longer required.`
        : `Load ${load.loadNumber} has been removed from your assignments`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    }),
    ...(!activeAuthority.supportMemberAction
      ? [
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: user._id.toString(),
            driverId: previousDriverId,
            eventType: "driver_load_removed",
            title: "Load Removed",
            message: `${actorName} removed load ${load.loadNumber} from ${previousDriverName}.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "removed",
              actorId: user._id.toString(),
              actorName,
              actorRole: "dispatcher",
              driverId: previousDriverId,
              driverName: previousDriverName,
              dispatcherId: user._id.toString(),
              dispatcherName: actorName,
              previousDriverId,
              previousDriverName,
              unreadForParticipantIds: [
                user._id.toString(),
                previousDriverId,
              ],
              audienceMessages: {
                actorDispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                threadDispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                dispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                driver: `${actorName} removed load ${load.loadNumber} from you.`,
              },
            },
          }),
        ]
      : []),
    ...(activeAuthority.supportMemberAction &&
    activeAuthority.originalDispatcherId
      ? [
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: activeAuthority.originalDispatcherId,
            driverId: previousDriverId,
            eventType: "driver_load_removed_by_org_member",
            title: "Load Removed",
            message: `${actorName} removed load ${load.loadNumber} from ${previousDriverName} and returned it to Available Loads.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "organization_member_removed",
              actorId: user._id.toString(),
              actorName,
              actorRole: "dispatcher",
              driverId: previousDriverId,
              driverName: previousDriverName,
              dispatcherId: activeAuthority.originalDispatcherId,
              previousDriverId,
              previousDriverName,
              originalDispatcherId: activeAuthority.originalDispatcherId,
              performedByUserId: user._id.toString(),
              performedByName: actorName,
              hidePerformerIdentityFromDriver: true,
              unreadForParticipantIds: [
                activeAuthority.originalDispatcherId,
              ],
              audienceMessages: {
                actorDispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                threadDispatcher: `Load ${load.loadNumber} was removed from ${previousDriverName} by ${actorName}.`,
                dispatcher: `Load ${load.loadNumber} was removed from ${previousDriverName} by ${actorName}.`,
                driver: `Your load ${load.loadNumber} was removed by another dispatcher.`,
              },
            },
            performedByUserId: user._id.toString(),
            performedByName: actorName,
            notifyThreadOwner: true,
          }),
          lifecycleDispatchChatEvent({
            organizationId,
            dispatcherId: user._id.toString(),
            driverId: previousDriverId,
            eventType: "driver_load_removed_by_support_dispatcher",
            title: "Load Removed",
            message: `${actorName} removed load ${load.loadNumber} from ${previousDriverName}.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              action: "support_dispatcher_removed",
              actorId: user._id.toString(),
              actorName,
              actorRole: "dispatcher",
              dispatcherId: user._id.toString(),
              dispatcherName: actorName,
              driverId: previousDriverId,
              driverName: previousDriverName,
              previousDriverId,
              previousDriverName,
              originalDispatcherId: activeAuthority.originalDispatcherId,
              performedByUserId: user._id.toString(),
              performedByName: actorName,
              hidePerformerIdentityFromDriver: true,
              threadPreview: `Load ${load.loadNumber} removed.`,
              unreadForParticipantIds: [
                user._id.toString(),
                previousDriverId,
              ],
              audienceMessages: {
                actorDispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                threadDispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                dispatcher: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
                driver: `Your load ${load.loadNumber} was removed by another dispatcher.`,
              },
            },
            performedByUserId: user._id.toString(),
            performedByName: actorName,
          }),
          // Keep the existing Notification Center self-audit as a second,
          // durable confirmation for the support dispatcher. The new private
          // B ↔ X system row above is the Dispatch Chat notification.
          lifecycleUserNotificationEvent({
            userId: user._id.toString(),
            organizationId,
            type: "general",
            title: "Load Removed",
            message: `You removed load ${load.loadNumber} from ${previousDriverName}.`,
            metadata: {
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              driverId: previousDriverId,
              driverName: previousDriverName,
              action: "organization_member_removed",
              route: "/driver-tracker",
            },
          }),
        ]
      : []),
    lifecycleActivityEvent({
      userId: user._id.toString(),
      organizationId,
      type: "load_removed",
      title: "Driver Removed from Load",
      description: activeAuthority.supportMemberAction
        ? `${actorName} supported the transaction by removing load ${load.loadNumber} from ${previousDriverName}`
        : activeAuthority.adminOverride
          ? `Administrator override: removed driver from active load ${load.loadNumber}`
          : `Removed driver from load ${load.loadNumber}`,
      loadId: load._id.toString(),
      metadata: {
        previousDriverId,
        originalDispatcherId: activeAuthority.originalDispatcherId,
        performedByUserId: user._id.toString(),
        supportMemberAction: activeAuthority.supportMemberAction,
      },
    }),
    ...(pendingReleaseRequest
      ? [
          lifecycleReleaseResolutionEvent({
            request: pendingReleaseRequest,
            organizationId,
            loadId: load._id.toString(),
            driverId: previousDriverId,
            status: "approved",
            decision: "return_available",
            reviewedBy: user._id.toString(),
          }),
        ]
      : []),
  ];
  load = await updateLoadIfCurrent({
    load,
    expected: {
      organizationId,
      status: previousStatus,
      assignedDriverId: previousDriverId,
    },
    update: appendLoadLifecycleOutbox(
      {
        $set: { status: "Posted" },
        $unset: {
          assignedDriverId: "",
          dispatchOwnerId: "",
          assignmentMaterialFingerprint: "",
          assignmentCompatibilityOverrides: "",
        },
      },
      removalOutbox,
    ),
    action: "returning it to Available Loads",
  });

  await flushLifecycleOutbox(load._id.toString());

  try {
    await clearDriverExactLocationIfUnneeded(
      previousDriverId,
      "load_returned_available",
    );
  } catch (err) {
    logger.error(
      { err, previousDriverId },
      "Non-fatal: failed to clear exact GPS after returning load to Available",
    );
  }

  try {
    await finalizeDriverStatusChangeIfClear(previousDriverId, organizationId);
  } catch (err) {
    logger.error({ err, previousDriverId }, "Non-fatal: failed to finalize driver status transition after load removal");
  }

  return res.status(200).json(new ApiResponse(200, load, "Driver removed from load"));
});

// ─── Driver's Account: dashboard statistics ─────────────────────────────────
// GET /api/driver-tracking/dashboard-stats
//
// Read-only summary used by the /driver Command Center.
// IMPORTANT:
// - Drivers are a shared platform-wide pool and may work with multiple orgs.
// - These metrics therefore follow the authenticated driver across orgs.
// - Total earnings come from PAID DriverPayout records, not quoted/carrier pay.
// - No load, payout, profile, notification, GPS, or messaging records are changed.
const getDashboardStats = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  if (user.role !== "driver") {
    throw new ApiError(403, "Only driver accounts can view driver dashboard statistics");
  }

  const [pendingRequests, completedLoads, profile, payoutTotals] =
    await Promise.all([
      // A request is pending only while the load is still Posted and this
      // authenticated driver's request entry still exists. The driver may
      // have pending requests with more than one organization.
      Load.countDocuments({
        status: "Posted",
        "driverRequests.driverId": user._id,
      }),

      // Completed Loads follow the driver across every organization where
      // they performed transportation work.
      Load.countDocuments({
        assignedDriverId: user._id,
        status: "Delivered",
      }),

      // DriverProfile is already platform-wide/shared. A missing profile must
      // not prevent a valid driver account from loading the dashboard.
      DriverProfile.findOne({
        userId: user._id,
      })
        .select("profileCompletionScore isComplianceExpired")
        .lean(),

      // Earnings are authoritative only after a payout reaches paid. Because
      // the payout belongs to the exact authenticated driver, organization
      // membership is intentionally not used as the dashboard filter.
      DriverPayout.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            driverId: user._id,
            status: "paid",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
          },
        },
      ]),
    ]);

  const totalEarnings =
    payoutTotals.length > 0 && Number.isFinite(payoutTotals[0]?.total)
      ? payoutTotals[0].total
      : 0;

  const data = {
    pendingRequests,
    totalEarnings,
    profileCompletionScore: profile?.profileCompletionScore ?? 0,
    isComplianceExpired: Boolean(profile?.isComplianceExpired),
    completedLoads,
  };

  return res
    .status(200)
    .json(new ApiResponse(200, data, "Driver dashboard statistics fetched"));
});

// ─── Driver's Account: my loads / available loads / detail ───────────────────

// GET /api/driver-tracking/my-loads
const getMyLoads = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const driverId = user._id.toString();

  const loads = await Load.find({
    assignedDriverId: user._id,
    status: { $nin: ["Cancelled"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  // Work Availability and retained-GPS policy are evaluated across every
  // organization for a shared driver. No first-organization fallback is used.
  const gpsPolicy = await getDriverGpsPolicyAcrossOrganizations(
    driverId,
    req.orgId as string | undefined,
  );
  const retainedRequiredIds = new Set(gpsPolicy.retainedLoadIds);

  const [profile, pendingReleaseRequests] = await Promise.all([
    DriverProfile.findOne({ userId: user._id }).lean(),
    LoadReleaseRequest.find({
      driverId: user._id,
      loadId: { $in: (loads as any[]).map((load) => load._id) },
      status: "pending",
    }).lean(),
  ]);
  const releaseByLoadId = new Map(
    (pendingReleaseRequests as any[]).map((request) => [String(request.loadId), request]),
  );

  const data = await Promise.all(
    (loads as any[]).map(async (load) => ({
      ...sanitizeLoadForDriver(load, driverId),
      compatibility: await evaluateDriverLoadCompatibilityWithRecommendations(
        profile,
        load,
        null,
      ),
      releaseRequest: releaseRequestSummary(releaseByLoadId.get(String(load._id))),
      // Only retained On Leave/In Shop policy needs this explicit flag. Normal
      // Accepted/Picked Up/In-Transit GPS enforcement still comes from status.
      dispatchGpsRequired: retainedRequiredIds.has(String(load._id)),
    })),
  );

  return res.status(200).json(new ApiResponse(200, data, "My loads fetched"));
});

// POST /api/driver-tracking/compatibility-preview
// Staff-only compatibility preview used by Create Load and Driver Tracker.
// It supports one load or a small load matrix and never mutates assignments,
// profiles, Dispatch Status, or GPS state.
const previewDriverLoadCompatibility = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const organizationId = req.orgId as string;
  const body = (req.body ?? {}) as {
    driverIds?: string[];
    loadId?: string;
    load?: Record<string, any>;
    loads?: Array<{ key?: string; loadId?: string; load?: Record<string, any> }>;
  };

  const requestedDriverIds = Array.isArray(body.driverIds)
    ? [...new Set(body.driverIds.map((id) => String(id)).filter(Boolean))].slice(0, 100)
    : [];

  if (requestedDriverIds.length === 0) {
    throw new ApiError(400, "At least one driver is required for compatibility preview");
  }

  const normalizePreviewLoad = async (previewLoad: any) => {
    const pickupZip = String(
      previewLoad?.pickupLocation?.zip ?? previewLoad?.pickupZip ?? "",
    ).trim();
    let pickupCoordinates = previewLoad?.pickupLocation?.coordinates;

    // Resolve the pickup once per previewed load instead of once per driver.
    // This avoids a burst of identical ZIP geocoding calls when Dispatch is
    // comparing many drivers against the same load. Failure is non-blocking.
    if (!pickupCoordinates && /^\d{5}(?:-\d{4})?$/.test(pickupZip)) {
      try {
        const coords = await getCoordinatesFromZip(pickupZip.slice(0, 5));
        if (coords) {
          pickupCoordinates = { lat: coords.lat, lng: coords.lon };
        }
      } catch {
        // Recommendation preview degrades to unknown proximity/service area.
      }
    }

    return {
      pickupLocation: {
        city: previewLoad?.pickupLocation?.city ?? "",
        state: previewLoad?.pickupLocation?.state ?? previewLoad?.originState ?? "",
        zip: pickupZip,
        coordinates: pickupCoordinates,
      },
      deliveryLocation: {
        city: previewLoad?.deliveryLocation?.city ?? "",
        state:
          previewLoad?.deliveryLocation?.state ?? previewLoad?.destinationState ?? "",
        zip: previewLoad?.deliveryLocation?.zip ?? previewLoad?.deliveryZip ?? "",
        coordinates: previewLoad?.deliveryLocation?.coordinates,
      },
      dates: previewLoad?.dates ?? null,
      requestedPickupDate: previewLoad?.requestedPickupDate ?? null,
      trailerType:
        previewLoad?.trailerType ?? previewLoad?.trailerTypeRequired ?? null,
      vehicleCount: Array.isArray(previewLoad?.vehicles)
        ? previewLoad.vehicles.length
        : Number(previewLoad?.vehicleCount ?? 0),
    };
  };

  const previewEntries: Array<{ key: string; load: any }> = [];

  if (Array.isArray(body.loads) && body.loads.length > 0) {
    for (const entry of body.loads.slice(0, 50)) {
      const key = String(entry?.key ?? "").trim();
      if (!key) continue;

      let previewLoad: any = entry?.load ?? null;
      if (entry?.loadId) {
        previewLoad = await Load.findOne({
          _id: entry.loadId,
          organizationId,
        }).lean();
      }
      if (!previewLoad) continue;
      previewEntries.push({ key, load: await normalizePreviewLoad(previewLoad) });
    }
  } else {
    let previewLoad: any = body.load ?? null;
    if (body.loadId) {
      previewLoad = await Load.findOne({
        _id: body.loadId,
        organizationId,
      }).lean();
      if (!previewLoad) throw new ApiError(404, "Load not found");
    }

    if (!previewLoad || typeof previewLoad !== "object") {
      throw new ApiError(400, "Load details are required for compatibility preview");
    }

    previewEntries.push({ key: "single", load: await normalizePreviewLoad(previewLoad) });
  }

  if (previewEntries.length === 0) {
    throw new ApiError(400, "No valid loads were supplied for compatibility preview");
  }

  // Drivers are a shared platform-wide pool — not restricted to this org.
  const [drivers, profiles] = await Promise.all([
    User.find({
      _id: { $in: requestedDriverIds },
      role: "driver",
      isActive: true,
    })
      .select("_id")
      .lean(),
    DriverProfile.find({
      userId: { $in: requestedDriverIds },
    }).lean(),
  ]);

  const allowedDriverIds = new Set(
    drivers.map((driver: any) => String(driver._id)),
  );
  const profileById = new Map(
    profiles.map((profile: any) => [String(profile.userId), profile]),
  );

  const compatibilityByLoadKey: Record<string, Record<string, any>> = {};

  const PREVIEW_CONCURRENCY = 8;
  for (const entry of previewEntries) {
    const compatibilityByDriverId: Record<string, any> = {};
    const validDriverIds = requestedDriverIds.filter((driverId) =>
      allowedDriverIds.has(driverId),
    );

    // Home-base city/state geocoding is cached, but the first lookup for many
    // drivers can still touch an external geocoder. Keep that work bounded so
    // the read-only recommendation endpoint cannot create a request burst.
    for (let index = 0; index < validDriverIds.length; index += PREVIEW_CONCURRENCY) {
      const batch = validDriverIds.slice(index, index + PREVIEW_CONCURRENCY);
      await Promise.all(
        batch.map(async (driverId) => {
          compatibilityByDriverId[driverId] =
            await evaluateDriverLoadCompatibilityWithRecommendations(
              profileById.get(driverId) ?? null,
              entry.load,
              // Pre-assignment compatibility must not use the driver's live
              // GPS. Dispatch can evaluate equipment, availability, home base,
              // service radius, preferred routes, and the load route without
              // gaining location visibility before an accepted relationship
              // exists.
              null,
            );
        }),
      );
    }

    compatibilityByLoadKey[entry.key] = compatibilityByDriverId;
  }

  const singleCompatibility =
    previewEntries.length === 1 && previewEntries[0].key === "single"
      ? compatibilityByLoadKey.single
      : undefined;

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        compatibilityByLoadKey,
        ...(singleCompatibility
          ? { compatibilityByDriverId: singleCompatibility }
          : {}),
      },
      "Driver compatibility preview generated",
    ),
  );
});

// GET /api/driver-tracking/available-loads
// Drivers receive the operational load data needed to evaluate a Posted load
// (route/contact details, dates, instructions, pricing, trailer and vehicles),
// while staff-only notes, other drivers' requests, private file keys and raw
// signatures are stripped by sanitizeLoadForDriver().
const getAvailableLoads = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  // Drivers are a shared platform-wide pool, not tied to one org — default to
  // loads across every dealership. An explicit ?organizationId= narrows to one.
  const requestedOrgId = req.query.organizationId as string | undefined;
  const filter: any = {
    status: "Posted",
    $or: [{ assignedDriverId: null }, { assignedDriverId: { $exists: false } }],
  };
  if (requestedOrgId && mongoose.isValidObjectId(requestedOrgId)) {
    filter.organizationId = requestedOrgId;
  }

  const [loads, total, profile, location] = await Promise.all([
    Load.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Load.countDocuments(filter),
    DriverProfile.findOne({ userId: user._id }).lean(),
    DriverLocation.findOne({ userId: user._id })
      .select("coords isSharing lastSeenAt")
      .lean(),
  ]);

  const myId = user._id.toString();
  const data = await Promise.all(
    (loads as any[]).map(async (l) => ({
      ...sanitizeAvailableLoadForDriver(l, myId),
      compatibility: await evaluateDriverLoadCompatibilityWithRecommendations(
        profile,
        l,
        location,
      ),
    })),
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        loads: data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
      },
      "Available loads fetched",
    ),
  );
});

// GET /api/driver-tracking/my-requests
// Loads this driver has requested that are still awaiting a dispatcher
// decision. There's no persisted "rejected" state — rejectLoadRequest
// removes the entry outright — so every driverRequests match here is
// inherently pending.
const getMyRequests = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  const loads = await Load.find({
    status: "Posted",
    "driverRequests.driverId": user._id,
  })
    .sort({ createdAt: -1 })
    .lean();

  const myId = user._id.toString();
  const data = (loads as any[]).map((l) => {
    const mine = (l.driverRequests ?? []).find((r: any) => String(r.driverId) === myId);
    return {
      ...sanitizeAvailableLoadForDriver(l, myId),
      myRequestStatus: "pending",
      myRequestedAt: mine?.requestedAt ?? null,
    };
  });

  return res.status(200).json(new ApiResponse(200, data, "My requests fetched"));
});

// GET /api/driver-tracking/loads/:id
// Driver-facing detail keeps the operational Load shape but enforces exact
// object-level access and strips staff-only/internal fields before returning.
const getLoadDetail = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  // Staff callers still need org isolation (a dispatcher shouldn't see
  // another dealership's load) — drivers are a shared pool with no org to
  // scope by, so the constraint only applies when the caller is staff.
  const lookup: any = { _id: req.params.id };
  if (user.role !== "driver") {
    lookup.organizationId = req.orgId as string;
  }

  const load = await Load.findOne(lookup)
    .populate("assignedDriverId", "name email phone avatar")
    .lean();
  if (!load) throw new ApiError(404, "Load not found");

  if (user.role !== "driver") {
    return res.status(200).json(new ApiResponse(200, load, "Load fetched"));
  }

  const driverId = user._id.toString();
  const isAssignedDriver =
    String((load as any).assignedDriverId?._id ?? (load as any).assignedDriverId ?? "") === driverId;
  const hasRequested =
    Array.isArray((load as any).driverRequests) &&
    (load as any).driverRequests.some(
      (request: any) => String(request?.driverId ?? "") === driverId,
    );
  const isAvailableBoardLoad =
    load.status === "Posted" && !(load as any).assignedDriverId;

  // Object-level authorization: knowing a Load id is never enough. A driver
  // can read a load only when they are the assigned participant, have an
  // existing request on it, or the load is legitimately visible on the shared
  // Available Loads board.
  if (!isAssignedDriver && !hasRequested && !isAvailableBoardLoad) {
    throw new ApiError(404, "Load not found");
  }

  const [profile, location] = await Promise.all([
    DriverProfile.findOne({ userId: user._id }).lean(),
    DriverLocation.findOne({ userId: user._id })
      .select("coords isSharing lastSeenAt")
      .lean(),
  ]);

  const compatibility =
    await evaluateDriverLoadCompatibilityWithRecommendations(
      profile,
      load,
      location,
    );

  const driverLoadView = isAssignedDriver
    ? sanitizeLoadForDriver(load, driverId)
    : sanitizeAvailableLoadForDriver(load, driverId);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        ...driverLoadView,
        compatibility,
      },
      "Load fetched",
    ),
  );
});

// ─── Available-load request / approval flow ──────────────────────────────────

// POST /api/driver-tracking/loads/:id/request
const requestLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const {
    note,
    overrideAvailability = false,
  } = req.body as {
    note?: string;
    overrideAvailability?: boolean;
  };
  const signature = parseDriverSignature(req.body);

  // Drivers are a shared pool with no org of their own — the load being
  // requested determines which dealership's rules apply, not req.orgId.
  let load = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  if (load.status !== "Posted" || load.assignedDriverId) {
    throw new ApiError(400, "This load is no longer available");
  }
  const organizationId = load.organizationId as unknown as string;

  await assertDriverCanTakeNewWork(
    user._id.toString(),
    organizationId,
    "request",
  );

  // Vehicle capacity is a per-load equipment constraint. It must never be
  // compared with the number of active load records. Existing active loads are
  // left untouched; this check evaluates only whether this specific load fits.
  await assertDriverLoadCompatibility({
    driverId: user._id.toString(),
    organizationId,
    load,
    actor: "driver",
    overrides: { overrideAvailability },
  });
  await assertNoDriverCommitmentConflict({
    driverId: user._id.toString(),
    targetLoad: load,
    excludeLoadId: load._id.toString(),
    actor: "driver",
  });

  const driverId = user._id.toString();
  const driverName =
    String(user.name || "Driver").trim() || "Driver";
  const creatorDispatcher = await findActiveDispatcherForLoad(
    load,
    String((load as any).createdBy ?? ""),
  );
  const creatorDispatcherId = creatorDispatcher
    ? String(creatorDispatcher._id)
    : "";
  const creatorDispatcherName = creatorDispatcher
    ? String(creatorDispatcher.name || "Dispatch").trim() || "Dispatch"
    : "";

  const requestChatEvents = creatorDispatcher
    ? [
        lifecycleDispatchChatEvent({
          organizationId,
          dispatcherId: creatorDispatcherId,
          driverId,
          eventType: "driver_load_requested",
          title: "Load Request",
          message: `${driverName} requested load ${load.loadNumber}.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            action: "request_created",
            actorId: driverId,
            actorName: driverName,
            actorRole: "driver",
            driverId,
            driverName,
            dispatcherId: creatorDispatcherId,
            dispatcherName: creatorDispatcherName,
            unreadForParticipantIds: [
              creatorDispatcherId,
              driverId,
            ],
            audienceMessages: {
              dispatcher: `${driverName} requested load ${load.loadNumber}.`,
              driver: `You requested load ${load.loadNumber}.`,
            },
          },
          performedByUserId: driverId,
          performedByName: driverName,
          performedByRole: "driver",
        }),
      ]
    : [];

  if (!creatorDispatcher) {
    logger.warn(
      {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        createdBy: String((load as any).createdBy ?? ""),
        driverId,
      },
      "Load request has no safe active creator dispatcher for a private Dispatch Chat event",
    );
  }

  const requestedAt = new Date();
  const requestedLoad = await Load.findOneAndUpdate(
    {
      _id: load._id,
      organizationId,
      status: "Posted",
      assignedDriverId: null,
      "driverRequests.driverId": { $ne: user._id },
    },
    appendLoadLifecycleOutbox(
      {
        $push: {
          driverRequests: {
            driverId: user._id,
            requestedAt,
            note: (note ?? "").slice(0, 500),
          },
        },
        $set: {
          driverContract: {
            agreedToTerms: true,
            signedAt: requestedAt,
            signatureDataUrl: signature.signatureDataUrl,
            signerName: signature.signerName || user.name || "",
          },
        },
      },
      requestChatEvents,
    ) as any,
    { new: true, runValidators: true },
  );

  if (!requestedLoad) {
    const alreadyRequested = await Load.exists({
      _id: load._id,
      status: "Posted",
      assignedDriverId: null,
      "driverRequests.driverId": user._id,
    });
    throw new ApiError(
      409,
      alreadyRequested
        ? "You have already requested this load"
        : "This load changed while your request was being submitted. Refresh Available Loads and try again.",
    );
  }
  load = requestedLoad;

  if (requestChatEvents.length > 0) {
    await flushLifecycleOutbox(load._id.toString());
  }

  emitLoadSync(organizationId, [], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "driver_request",
      "Load Request",
      `${user.name} requested load ${load.loadNumber}`,
      {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        driverId: user._id.toString(),
      },
      user._id.toString(),
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, null, "Load requested"));
});

// POST /api/driver-tracking/loads/:id/approve-request  { driverId }
const approveLoadRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const {
    driverId,
    overrideAvailability = false,
    overrideCapacity = false,
  } = req.body as {
    driverId?: string;
    overrideAvailability?: boolean;
    overrideCapacity?: boolean;
  };

  if (!driverId) throw new ApiError(400, "driverId is required");

  let load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (load.status !== "Posted" || load.assignedDriverId) {
    throw new ApiError(400, "This load is no longer available");
  }

  const requests: any[] = (load as any).driverRequests ?? [];
  if (!requests.some((r) => String(r.driverId) === driverId)) {
    throw new ApiError(400, "That driver has not requested this load");
  }

  await assertDriverCanTakeNewWork(driverId, organizationId, "approve");
  await assertDriverLoadCompatibility({
    driverId,
    organizationId,
    load,
    actor: "dispatcher",
    overrides: { overrideAvailability, overrideCapacity },
  });

  const validatedLoad = load;
  const requestingDriver: any = await User.findOne({
    _id: driverId,
    role: "driver",
  })
    .select("_id name")
    .lean();
  const requestingDriverName =
    String(requestingDriver?.name || "Driver").trim() || "Driver";
  const approvingDispatcherId = user._id.toString();
  const approvingDispatcherName =
    String(user.name || "Dispatch").trim() || "Dispatch";

  const approvalOutbox = [
    lifecycleSyncEvent(organizationId, [driverId], load._id.toString()),
    lifecycleUserNotificationEvent({
      userId: driverId,
      organizationId,
      type: "driver_request_approved",
      title: "Load Request Approved",
      message: `Your request for load ${load.loadNumber} was approved`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    }),
    lifecycleDispatchChatEvent({
      organizationId,
      dispatcherId: approvingDispatcherId,
      driverId,
      eventType: "driver_load_request_approved",
      title: "Load Request Approved",
      message: `${approvingDispatcherName} approved ${requestingDriverName}'s request and assigned load ${load.loadNumber}.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        action: "request_approved_assigned",
        actorId: approvingDispatcherId,
        actorName: approvingDispatcherName,
        actorRole: "dispatcher",
        driverId,
        driverName: requestingDriverName,
        dispatcherId: approvingDispatcherId,
        dispatcherName: approvingDispatcherName,
        unreadForParticipantIds: [
          approvingDispatcherId,
          driverId,
        ],
        audienceMessages: {
          dispatcher: `You approved ${requestingDriverName}'s request and assigned load ${load.loadNumber} to ${requestingDriverName}.`,
          driver: `${approvingDispatcherName} approved your request and assigned load ${load.loadNumber} to you.`,
        },
      },
    }),
    lifecycleActivityEvent({
      userId: user._id.toString(),
      organizationId,
      type: "load_assigned",
      title: "Driver Request Approved",
      description: `Approved driver request for load ${load.loadNumber}`,
      loadId: load._id.toString(),
      metadata: { driverId },
    }),
  ];

  load = await withDriverCommitmentLock(driverId, async () => {
    await assertDriverCanTakeNewWork(driverId, organizationId, "approve");
    await assertNoDriverCommitmentConflict({
      driverId,
      targetLoad: validatedLoad,
      excludeLoadId: validatedLoad._id.toString(),
      actor: "dispatcher",
    });

    return updateLoadIfCurrent({
      load: validatedLoad,
      expected: {
        organizationId,
        status: "Posted",
        assignedDriverId: null,
        "driverRequests.driverId": driverId,
      },
      update: appendLoadLifecycleOutbox(
        {
          $set: {
            assignedDriverId: driverId,
            dispatchOwnerId: user._id,
            status: "Assigned",
            assignedAt: new Date(),
            driverRequests: [],
            assignmentMaterialFingerprint: getLoadAcceptanceMaterialVersion(validatedLoad),
            assignmentCompatibilityOverrides: {
              overrideAvailability: Boolean(overrideAvailability),
              overrideCapacity: Boolean(overrideCapacity),
            },
          },
        },
        approvalOutbox,
      ),
      action: "approving the driver request",
    });
  });

  await flushLifecycleOutbox(load._id.toString());

  return res.status(200).json(new ApiResponse(200, load, "Request approved"));
});

// POST /api/driver-tracking/loads/:id/reject-request  { driverId }
const rejectLoadRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const dispatcher = getUser(req);
  const organizationId = req.orgId as string;
  const { driverId } = req.body as { driverId?: string };

  if (!driverId) throw new ApiError(400, "driverId is required");

  let load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");

  const updatedLoad = await Load.findOneAndUpdate(
    {
      _id: load._id,
      organizationId,
      status: "Posted",
      assignedDriverId: null,
      "driverRequests.driverId": driverId,
    },
    { $pull: { driverRequests: { driverId } } } as any,
    { new: true, runValidators: true },
  );
  if (!updatedLoad) {
    throw new ApiError(
      409,
      "This driver request is no longer pending on an available load. Refresh the request list and try again.",
    );
  }
  load = updatedLoad;

  const rejectedDriver: any = await User.findOne({
    _id: driverId,
    role: "driver",
  })
    .select("_id name")
    .lean();
  const rejectedDriverName =
    String(rejectedDriver?.name || "Driver").trim() || "Driver";
  const rejectingDispatcherId = dispatcher._id.toString();
  const rejectingDispatcherName =
    String(dispatcher.name || "Dispatch").trim() || "Dispatch";

  emitLoadSync(organizationId, [driverId], load._id.toString());

  // Preserve the driver's normal Notification Center update, but record the
  // acting dispatcher as explicit ownership metadata. The generic notification
  // itself is never used as the private-chat source.
  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "driver_request_rejected",
    title: "Load Request Declined",
    message: `Your request for load ${load.loadNumber} was declined`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      driverId,
      dispatcherId: dispatcher._id.toString(),
      sentByUserId: dispatcher._id.toString(),
      sentByName: dispatcher.name || "Dispatch",
    },
  });

  // Dispatch Chat receives a separate persisted system message owned by the
  // exact dispatcher↔driver thread. This mirrors assignment/reassignment and
  // prevents the rejection card from appearing under another dispatcher tab.
  await persistDispatcherLoadChatEvent({
    dispatcher,
    organizationId,
    driverId,
    eventType: "driver_load_request_rejected",
    title: "Load Request Declined",
    message: `${rejectingDispatcherName} declined ${rejectedDriverName}'s request for load ${load.loadNumber}.`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      action: "request_rejected",
      actorId: rejectingDispatcherId,
      actorName: rejectingDispatcherName,
      actorRole: "dispatcher",
      driverId,
      driverName: rejectedDriverName,
      dispatcherId: rejectingDispatcherId,
      dispatcherName: rejectingDispatcherName,
      unreadForParticipantIds: [
        rejectingDispatcherId,
        driverId,
      ],
      audienceMessages: {
        dispatcher: `You declined ${rejectedDriverName}'s request for load ${load.loadNumber}.`,
        driver: `${rejectingDispatcherName} declined your request for load ${load.loadNumber}.`,
      },
    },
  });

  return res.status(200).json(new ApiResponse(200, load, "Request rejected"));
});


// ─── Pending Load Requests (dispatcher view) ─────────────────────────────────
// GET /api/driver-tracking/load-requests

const getPendingLoadRequests = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const organizationId = req.orgId as string;

  const loads = await Load.find({
    organizationId,
    assignedDriverId: null,
    status: "Posted",
    "driverRequests.0": { $exists: true },
  })
    .select("loadNumber pickupLocation deliveryLocation vehicles trailerType dates pricing driverRequests")
    .lean();

  const driverIds: string[] = [
    ...new Set<string>(
      loads.flatMap((load: any) =>
        (load.driverRequests ?? []).map((request: any) => String(request.driverId)),
      ),
    ),
  ];

  // Drivers are a shared platform-wide pool — not restricted to this org.
  // P1 #14: pending requests are still pre-assignment, so this endpoint must
  // not fetch or use exact DriverLocation coordinates for compatibility.
  const [drivers, profiles, eligibilityPairs] = await Promise.all([
    User.find({
      _id: { $in: driverIds },
      role: "driver",
    })
      .select("name email avatar")
      .lean(),
    DriverProfile.find({ userId: { $in: driverIds } }).lean(),
    Promise.all(
      driverIds.map(async (driverId) => [
        driverId,
        await getDriverWorkEligibility(driverId, organizationId),
      ] as const),
    ),
  ]);

  const driverById = new Map(drivers.map((driver: any) => [String(driver._id), driver]));
  const profileById = new Map(profiles.map((profile: any) => [String(profile.userId), profile]));
  const eligibilityById = new Map<string, any>(eligibilityPairs as any);

  const requestRows = loads.flatMap((load: any) =>
    (load.driverRequests ?? []).map((request: any) => ({ load, request })),
  );

  const requests = await Promise.all(
    requestRows.map(async ({ load, request }: any) => {
      const driverId = String(request.driverId);
      const driver: any = driverById.get(driverId);
      const profile: any = profileById.get(driverId) ?? null;
      const eligibility = eligibilityById.get(driverId);
      return {
        id: `${load._id}:${request.driverId}`,
        loadId: String(load._id),
        loadNumber: load.loadNumber,
        trackingNumber: load.loadNumber,
        driverId: String(request.driverId),
        driverName: driver?.name ?? "Unknown Driver",
        driverEmail: driver?.email ?? "",
        driverAvatar: driver?.avatar ?? null,
        requestedAt: request.requestedAt,
        note: request.note ?? "",
        origin: [load.pickupLocation?.city, load.pickupLocation?.state].filter(Boolean).join(", "),
        destination: [load.deliveryLocation?.city, load.deliveryLocation?.state].filter(Boolean).join(", "),
        vehicleCount: Array.isArray(load.vehicles) ? load.vehicles.length : 0,
        trailerType: load.trailerType ?? null,
        trailerTypeRequired: load.trailerType ?? null,
        requestedPickupDate:
          load.dates?.firstAvailable ?? load.dates?.pickupDeadline ?? null,
        carrierPayAmount: load.pricing?.carrierPayAmount ?? null,
        compatibility: await evaluateDriverLoadCompatibilityWithRecommendations(
          profile,
          load,
          // P1 #14: a request does not create an active tracking relationship.
          // Compatibility may use profile/schedule/equipment data, but never
          // the driver's exact live GPS before assignment/acceptance.
          null,
        ),
        equipment: profile
          ? {
              trailerType: profile.trailerType ?? undefined,
              maxVehicleCapacity: profile.maxVehicleCapacity ?? undefined,
              operationalStatus: profile.operationalStatus ?? "active",
              isComplianceExpired: Boolean(profile.isComplianceExpired),
              truckMake: profile.truckMake ?? undefined,
              truckModel: profile.truckModel ?? undefined,
              profileCompletionScore: Number(profile.profileCompletionScore ?? 0),
            }
          : null,
        workEligible: eligibility?.eligible ?? true,
        workEligibilityReason: eligibility?.reason ?? null,
      };
    }),
  );

  requests.sort(
    (a: any, b: any) =>
      new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
  );

  return res
    .status(200)
    .json(new ApiResponse(200, requests, "Pending load requests fetched"));
});

// ─── Dispatcher → Driver Alert ───────────────────────────────────────────────
// POST /api/driver-tracking/drivers/:driverId/alert

const sendDriverAlert = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const sender = getUser(req);
  const organizationId = req.orgId as string;
  const { driverId } = req.params;
  const { destinationType, destinationName, address, message } = req.body as {
    destinationType?: "site" | "carshop" | "specific-shop";
    destinationName?: string;
    address?: string;
    message?: string;
  };

  const allowedDestinationTypes = ["site", "carshop", "specific-shop"];
  if (!destinationType || !allowedDestinationTypes.includes(destinationType)) {
    throw new ApiError(400, "A valid destinationType is required");
  }
  if (!destinationName?.trim()) {
    throw new ApiError(400, "destinationName is required");
  }

  if (!organizationId) {
    throw new ApiError(403, "Organization access is required");
  }
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    // Keep the response indistinguishable from an inaccessible shared driver.
    throw new ApiError(404, "Driver is unavailable for this Dispatch Alert");
  }

  // P1 #15 — shared-driver-safe authorization.
  //
  // Driver Users are a platform-wide pool, so their home organization is not
  // an authorization boundary. A Dispatch Alert is an operational instruction,
  // though, so merely knowing a global driver id (or having an old chat thread)
  // is not enough. The sender must currently be the exact responsible
  // dispatcher on this organization's active assignment.
  const [driver, alertRelationship] = await Promise.all([
    User.findOne({
      _id: driverId,
      role: "driver",
      isActive: true,
    })
      .select("name email")
      .lean(),
    Load.findOne({
      organizationId,
      assignedDriverId: driverId,
      dispatchOwnerId: sender._id,
      status: { $in: DRIVER_ACTIVE_LOAD_STATUSES },
    })
      .select("_id loadNumber status dispatchOwnerId")
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
  ]);

  // Deliberately use one generic 404 for both cases. Staff who do not own an
  // active relationship must not be able to probe whether a global driver id
  // exists on the platform.
  if (!driver || !alertRelationship) {
    throw new ApiError(404, "Driver is unavailable for this Dispatch Alert");
  }

  const cleanDestinationName = destinationName.trim().slice(0, 160);
  const cleanAddress = address?.trim().slice(0, 300) || "";
  const cleanMessage = message?.trim().slice(0, 500) || "";
  const alertMessage = cleanMessage
    ? `${cleanMessage} Destination: ${cleanDestinationName}.`
    : `Please proceed to ${cleanDestinationName}.`;

  const notification: any = await notificationService.createNotification({
    userId: driverId,
    organizationId,
    type: "driver_dispatch_alert",
    title: "Dispatch Alert",
    message: alertMessage,
    metadata: {
      driverId,
      driverName: driver.name,
      loadId: String(alertRelationship._id),
      loadNumber: alertRelationship.loadNumber,
      loadStatus: alertRelationship.status,
      dispatchOwnerId: sender._id.toString(),
      destinationType,
      destinationName: cleanDestinationName,
      address: cleanAddress,
      dispatcherMessage: cleanMessage,
      sentByUserId: sender._id.toString(),
      sentByName: sender.name,
      response: "pending",
      playSound: true,
      soundFile: "/sounds/warning_sound.wav",
      route: "/driver/notifications",
      pushSource: "Driver Tracker",
    },
  });

  if (!notification) {
    throw new ApiError(409, "The driver has disabled Driver Tracker notifications");
  }

  // Every manual Dispatch Alert belongs to the exact dispatcher↔driver pair
  // that created it. This persistence is deliberately non-fatal because the
  // notification has already been created; a chat-side problem must not turn a
  // successfully delivered safety alert into an HTTP 500 or duplicate on retry.
  try {
    const thread: any = await ensureDispatchChatThread({
      organizationId,
      dispatcherId: sender._id,
      driverId,
    });

    const chatAlert: any = await DispatchChatMessage.create({
      organizationId,
      threadId: thread._id,
      dispatcherId: sender._id,
      driverId,
      senderId: sender._id,
      senderRole: "dispatcher",
      messageType: "system",
      systemEvent: {
        type: "driver_dispatch_alert",
        title: notification.title,
        message: notification.message,
        metadata: {
          ...(notification.metadata ?? {}),
          alertId: notification._id.toString(),
        },
      },
      content: notification.message,
      attachments: [],
      readBy: [sender._id],
    });

    await touchDispatchChatThread({
      threadId: thread._id,
      senderId: sender._id,
      messageType: "system",
      content: notification.message,
      fallbackPreview: "Dispatch Alert",
      at: chatAlert.createdAt,
    });

    const dispatchChatPayload = {
      id: String(chatAlert._id),
      threadId: String(thread._id),
      dispatcherId: sender._id.toString(),
      driverId,
      sender: {
        id: sender._id.toString(),
        name: sender.name || "Dispatcher",
        email: sender.email || "",
        role: sender.role,
      },
      senderRole: "dispatcher" as const,
      messageType: "system" as const,
      systemEvent: chatAlert.systemEvent,
      content: notification.message,
      attachments: [],
      readBy: [sender._id.toString()],
      createdAt: chatAlert.createdAt,
      updatedAt: chatAlert.updatedAt,
    };

    emitToDispatchChatThreadParticipants(
      thread,
      "dispatch-chat:message",
      dispatchChatPayload,
    );
  } catch (err) {
    logger.error(
      { err, driverId, dispatcherId: sender._id.toString() },
      "Non-fatal: failed to persist Dispatch Alert into private Dispatch Chat",
    );
  }

  const payload = {
    alertId: notification._id.toString(),
    title: notification.title,
    message: notification.message,
    metadata: notification.metadata,
    createdAt: notification.createdAt,
  };

  // Keep the driver's existing alert event and sound path. The sender receives
  // the corresponding sent event for UI synchronization, but other dispatchers
  // no longer receive the private alert content.
  emitToUser(driverId, "driver:dispatch_alert", payload);
  emitToUser(sender._id.toString(), "driver:dispatch_alert_sent", {
    ...payload,
    driverId,
    driverName: driver.name,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, notification, "Driver alert sent"));
});

// POST /api/driver-tracking/alerts/:alertId/respond
const respondToDriverAlert = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const { alertId } = req.params;
  const { response } = req.body as {
    response?: "acknowledged" | "on_my_way" | "unable";
  };

  const allowedResponses = ["acknowledged", "on_my_way", "unable"];
  if (!response || !allowedResponses.includes(response)) {
    throw new ApiError(400, "A valid response is required");
  }

  // Drivers have no org of their own — userId+alertId is already a unique,
  // secure lookup, so the alert's own organizationId is used for the
  // dispatcher-side notify below instead of req.orgId.
  const notification: any = await Notification.findOne({
    _id: alertId,
    userId: user._id,
    type: "driver_dispatch_alert",
  });

  if (!notification) throw new ApiError(404, "Driver alert not found");
  const organizationId = notification.organizationId as string;

  const respondedAt = new Date();
  notification.metadata = {
    ...(notification.metadata ?? {}),
    response,
    respondedAt: respondedAt.toISOString(),
    respondedByUserId: user._id.toString(),
  };
  notification.isRead = true;
  notification.markModified("metadata");
  await notification.save();

  const responseLabel =
    response === "on_my_way"
      ? "On My Way"
      : response === "unable"
        ? "Unable"
        : "Acknowledged";

  const destinationName =
    String(notification.metadata?.destinationName || "").trim();

  const responseMessage =
    response === "on_my_way"
      ? destinationName
        ? `${user.name || "Driver"} is on the way to ${destinationName}.`
        : `${user.name || "Driver"} is on the way.`
      : response === "unable"
        ? destinationName
          ? `${user.name || "Driver"} is unable to proceed to ${destinationName}.`
          : `${user.name || "Driver"} is unable to proceed with the dispatch request.`
        : destinationName
          ? `${user.name || "Driver"} acknowledged the dispatch request for ${destinationName}.`
          : `${user.name || "Driver"} acknowledged the dispatch request.`;

  const dispatcherId = String(notification.metadata?.sentByUserId || "").trim();

  // Older malformed alert records may not identify a dispatcher. Never guess a
  // private recipient. The alert response is still saved on the notification,
  // but it is only inserted into Dispatch Chat when ownership is explicit.
  if (dispatcherId) {
    const dispatcher = await User.findOne({
      _id: dispatcherId,
      organizationId,
      role: { $in: ["employee", "admin", "super_admin"] },
    })
      .select("_id name email role")
      .lean();

    if (dispatcher) {
      try {
        const thread: any = await ensureDispatchChatThread({
          organizationId,
          dispatcherId,
          driverId: user._id,
        });

        const chatResponse: any = await DispatchChatMessage.create({
          organizationId,
          threadId: thread._id,
          dispatcherId,
          driverId: user._id,
          senderId: user._id,
          senderRole: "driver",
          messageType: "system",
          systemEvent: {
            type: "driver_dispatch_alert_response",
            title: `Driver Response: ${responseLabel}`,
            message: responseMessage,
            metadata: {
              alertId: notification._id.toString(),
              driverId: user._id.toString(),
              driverName: user.name,
              response,
              responseLabel,
              respondedAt: respondedAt.toISOString(),
              destinationName:
                notification.metadata?.destinationName ?? null,
              sentByUserId: dispatcherId,
            },
          },
          content: responseMessage,
          attachments: [],
          // The responding driver has already seen their own response. Only the
          // dispatcher who sent the alert remains unread.
          readBy: [user._id],
        });

        await touchDispatchChatThread({
          threadId: thread._id,
          senderId: user._id,
          messageType: "system",
          content: responseMessage,
          fallbackPreview: `Driver Response: ${responseLabel}`,
          at: chatResponse.createdAt,
        });

        const dispatchChatPayload = {
          id: String(chatResponse._id),
          threadId: String(thread._id),
          dispatcherId,
          driverId: user._id.toString(),
          sender: {
            id: user._id.toString(),
            name: user.name ?? "Driver",
            email: user.email ?? "",
            role: "driver",
          },
          senderRole: "driver" as const,
          messageType: "system" as const,
          systemEvent: chatResponse.systemEvent,
          content: responseMessage,
          attachments: [],
          readBy: [user._id.toString()],
          createdAt: chatResponse.createdAt,
          updatedAt: chatResponse.updatedAt,
        };

        emitToDispatchChatThreadParticipants(
          thread,
          "dispatch-chat:message",
          dispatchChatPayload,
        );

      } catch (err) {
        logger.error(
          { err, alertId, driverId: user._id.toString(), dispatcherId },
          "Non-fatal: failed to persist driver alert response into private Dispatch Chat",
        );
      }

      // Preserve the existing acknowledgement feedback even if chat persistence
      // temporarily fails. Only the dispatcher who sent the alert receives it.
      emitToUser(dispatcherId, "driver:dispatch_alert_acknowledged", {
        alertId: notification._id.toString(),
        driverId: user._id.toString(),
        driverName: user.name,
        response,
        respondedAt: respondedAt.toISOString(),
        destinationName: notification.metadata?.destinationName,
        sentByUserId: dispatcherId,
      });
    }
  }

  emitToUser(user._id.toString(), "notification:updated", notification);

  return res
    .status(200)
    .json(new ApiResponse(200, notification, "Driver alert response saved"));
});

// ─── Driver status transitions ───────────────────────────────────────────────

const requireAssignedDriver = (load: any, userId: string) => {
  if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) {
    throw new ApiError(403, "You are not the assigned driver for this load");
  }
};

// A pending release request temporarily pauses forward lifecycle progression.
// The driver is still assigned to the load, but Dispatch must either resolve
// the request or the driver must explicitly cancel it before Accept/Pickup/
// Start Route can continue. Complete Delivery remains a deliberate terminal
// exception: the existing delivery flow closes a still-pending release request
// as delivery_completed after proof of delivery is submitted.
async function assertNoPendingReleaseRequestForProgression(
  load: any,
  driverId: string,
  actionLabel: string,
) {
  const pendingReleaseRequest = await LoadReleaseRequest.exists({
    loadId: load._id,
    driverId,
    status: "pending",
  });

  if (pendingReleaseRequest) {
    throw new ApiError(
      409,
      `Your release request is still awaiting Dispatch. Cancel the release request or wait for Dispatch before ${actionLabel}.`,
    );
  }
}

// POST /api/driver-tracking/loads/:id/accept  { signatureDataUrl, signerName }
const acceptLoad = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const signature = parseDriverSignature(req.body);

  let load = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  const organizationId = load.organizationId as unknown as string;
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Assigned") {
    throw new ApiError(400, `Cannot accept a load in ${load.status} status`);
  }

  const pendingReleaseRequest = await LoadReleaseRequest.findOne({
    loadId: load._id,
    driverId: user._id,
    status: "pending",
  }).lean();
  if (pendingReleaseRequest) {
    throw new ApiError(
      409,
      "Your release request is still awaiting Dispatch. The load cannot be accepted until Dispatch resolves that request.",
    );
  }

  await assertDriverCanTakeNewWork(
    user._id.toString(),
    organizationId,
    "accept",
  );

  const currentMaterialVersion = getLoadAcceptanceMaterialVersion(load);
  const assignmentMaterialFingerprint = String(
    (load as any).assignmentMaterialFingerprint ?? "",
  ).trim();

  if (
    assignmentMaterialFingerprint &&
    assignmentMaterialFingerprint !== currentMaterialVersion
  ) {
    throw new ApiError(
      409,
      "This load's route, vehicles, schedule, compensation, or instructions changed after Dispatch assigned it. Dispatch must reconfirm the assignment before you can accept it.",
      [
        {
          type: "load_assignment_material_changed",
          requiresDispatchReconfirmation: true,
          loadId: load._id.toString(),
        },
      ],
    );
  }

  // Backward-compatible safety for legacy Assigned rows created before P1 #5.
  // If no assignment fingerprint exists, a later Load update means we cannot
  // prove that the current material terms are the terms Dispatch validated.
  if (!assignmentMaterialFingerprint) {
    const assignedAtMs = (load as any).assignedAt
      ? new Date((load as any).assignedAt).getTime()
      : Number.NaN;
    const updatedAtMs = (load as any).updatedAt
      ? new Date((load as any).updatedAt).getTime()
      : Number.NaN;

    if (
      Number.isFinite(assignedAtMs) &&
      Number.isFinite(updatedAtMs) &&
      updatedAtMs > assignedAtMs + 2000
    ) {
      throw new ApiError(
        409,
        "This legacy assignment was updated after it was assigned. Dispatch must reconfirm the assignment before you can accept it.",
        [
          {
            type: "legacy_load_assignment_changed",
            requiresDispatchReconfirmation: true,
            loadId: load._id.toString(),
          },
        ],
      );
    }
  }

  const reviewedMaterialVersion = String(
    (req.body as any)?.reviewedMaterialVersion ?? "",
  ).trim();

  if (
    reviewedMaterialVersion &&
    !/^[a-f0-9]{64}$/i.test(reviewedMaterialVersion)
  ) {
    throw new ApiError(400, "The reviewed load version is invalid. Refresh the load and try again.");
  }

  if (
    reviewedMaterialVersion &&
    reviewedMaterialVersion !== currentMaterialVersion
  ) {
    throw new ApiError(
      409,
      "This load changed since you reviewed it. Your signature was not accepted. Review the latest route, vehicles, schedule, compensation, and instructions before accepting.",
      [
        {
          type: "load_reviewed_material_version_mismatch",
          requiresFreshReview: true,
          loadId: load._id.toString(),
        },
      ],
    );
  }

  // Acceptance starts the exact dispatcher↔driver operational/GPS
  // relationship. Do not allow an Accepted load to exist without a valid,
  // active responsible dispatcher.
  const dispatchOwnership = await requireDispatchOwnerBeforeAcceptance(
    load,
    user._id.toString(),
  );
  const dispatchOwner = dispatchOwnership.dispatcher;
  const dispatchOwnerId = dispatchOwner._id;

  const storedOverrides = assignmentCompatibilityOverrides(load);
  await assertDriverLoadCompatibility({
    driverId: user._id.toString(),
    organizationId,
    load,
    actor: "dispatcher",
    overrides: {
      overrideAvailability: storedOverrides.overrideAvailability,
      overrideCapacity: storedOverrides.overrideCapacity,
    },
  });

  const acceptedAt = new Date();
  const acceptSet: Record<string, unknown> = {
    status: "Accepted",
    acceptedAt,
    driverContract: {
      agreedToTerms: true,
      signedAt: acceptedAt,
      signatureDataUrl: signature.signatureDataUrl,
      signerName: signature.signerName || user.name || "",
    },
  };
  acceptSet.dispatchOwnerId = dispatchOwnerId;

  const validatedLoad = load;


  const acceptanceOutbox = [
    lifecycleSyncEvent(
      organizationId,
      [user._id.toString()],
      load._id.toString(),
    ),
    lifecycleUserNotificationEvent({
      userId: dispatchOwner._id.toString(),
      organizationId,
      type: "load_accepted",
      title: "Load Accepted",
      message: `${user.name} accepted load ${load.loadNumber}. Live GPS sharing is now required for this load.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        driverId: user._id.toString(),
        route: `/driver-tracker?driverId=${encodeURIComponent(user._id.toString())}`,
      },
    }),
    lifecycleUserNotificationEvent({
      userId: user._id.toString(),
      organizationId,
      type: "general",
      title: "Location Sharing Required",
      message: `Load ${load.loadNumber} is accepted. Location sharing is now required until this load is delivered, released by Dispatch, cancelled, or reassigned. Only the dispatcher responsible for your accepted active load can view your live location.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        route: "/driver",
        requiresLocationSharing: true,
      },
    }),
  ];

  load = await withDriverCommitmentLock(user._id.toString(), async () => {
    await assertDriverCanTakeNewWork(
      user._id.toString(),
      organizationId,
      "accept",
    );
    await assertNoDriverCommitmentConflict({
      driverId: user._id.toString(),
      targetLoad: validatedLoad,
      excludeLoadId: validatedLoad._id.toString(),
      actor: "driver",
    });

    return updateLoadIfCurrent({
      load: validatedLoad,
      expected: {
        organizationId,
        status: "Assigned",
        assignedDriverId: user._id,
        ...(dispatchOwnership.recoveredFromHistory
          ? {}
          : { dispatchOwnerId }),
      },
      update: appendLoadLifecycleOutbox(
        { $set: acceptSet },
        acceptanceOutbox,
      ),
      action: "accepting it",
    });
  });

  await flushLifecycleOutbox(load._id.toString());

  // Compatibility warnings are derived informational notices rather than the
  // authoritative lifecycle event. Keep them best-effort; the durable outbox
  // above owns the acceptance/GPS-required notifications.
  try {
    const profile = await DriverProfile.findOne({ userId: user._id }).lean();
    const compatibility = await evaluateDriverLoadCompatibilityWithRecommendations(
      profile,
      load,
      null,
    );
    const notices = compatibilityNoticeMessages(compatibility);
    if (notices.length) {
      await safeCreateNotificationLoose({
        userId: user._id.toString(),
        organizationId,
        type: "general",
        title: "Load Compatibility Notice",
        message: notices.join(" ").slice(0, 1200),
        metadata: {
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
          route: "/driver",
          compatibilityWarnings: compatibility.warnings,
        },
      });
    }
  } catch (err) {
    logger.error({ err }, "Non-fatal: driver acceptance notice failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Load accepted"));
});

// POST /api/driver-tracking/loads/:id/pickup
const markPickedUp = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  let load = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  const organizationId = load.organizationId as unknown as string;
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Accepted") {
    throw new ApiError(400, `Cannot mark pickup from ${load.status} status`);
  }

  assertNoPendingLoadAmendments(load, user._id.toString());
  await assertNoPendingReleaseRequestForProgression(
    load,
    user._id.toString(),
    "recording pickup",
  );

  const pickupOutbox = [
    lifecycleSyncEvent(
      organizationId,
      [user._id.toString()],
      load._id.toString(),
    ),
    lifecycleAdminNotificationEvent({
      organizationId,
      type: "load_picked_up",
      title: "Vehicles Picked Up",
      message: `${user.name} picked up load ${load.loadNumber}`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
      excludeUserId: user._id.toString(),
    }),
  ];

  load = await updateLoadIfCurrent({
    load,
    expected: {
      organizationId,
      status: "Accepted",
      assignedDriverId: user._id,
    },
    update: appendLoadLifecycleOutbox(
      {
        $set: {
          status: "Picked Up",
          pickedUpAt: new Date(),
        },
      },
      pickupOutbox,
    ),
    action: "recording pickup",
  });

  await flushLifecycleOutbox(load._id.toString());

  return res.status(200).json(new ApiResponse(200, load, "Pickup recorded"));
});

// POST /api/driver-tracking/loads/:id/start-route
const startRoute = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  let load = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  const organizationId = load.organizationId as unknown as string;
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Picked Up") {
    throw new ApiError(400, `Cannot start route from ${load.status} status`);
  }

  assertNoPendingLoadAmendments(load, user._id.toString());
  await assertNoPendingReleaseRequestForProgression(
    load,
    user._id.toString(),
    "starting the route",
  );

  const routeOutbox = [
    lifecycleSyncEvent(
      organizationId,
      [user._id.toString()],
      load._id.toString(),
    ),
    lifecycleAdminNotificationEvent({
      organizationId,
      type: "load_in_transit",
      title: "Load In Transit",
      message: `${user.name} started the route for load ${load.loadNumber}`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
      excludeUserId: user._id.toString(),
    }),
  ];

  load = await updateLoadIfCurrent({
    load,
    expected: {
      organizationId,
      status: "Picked Up",
      assignedDriverId: user._id,
    },
    update: appendLoadLifecycleOutbox(
      {
        $set: {
          status: "In-Transit",
          inTransitAt: new Date(),
        },
      },
      routeOutbox,
    ),
    action: "starting the route",
  });

  await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    { $set: { status: "on-route", lastSeenAt: new Date() } },
  );

  await flushLifecycleOutbox(load._id.toString());

  return res.status(200).json(new ApiResponse(200, load, "Route started"));
});

// POST /api/driver-tracking/loads/:id/deliver
// Driver completes an in-transit load only after the existing proof-of-delivery
// upload flow has successfully stored a proof image. Proof verification remains
// available to Dispatch through the existing confirm-delivery workflow.
const completeDelivery = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);

  let load = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  const organizationId = load.organizationId as unknown as string;
  requireAssignedDriver(load, user._id.toString());

  // Make delivery completion safe to retry if the browser lost the first
  // successful response after the server had already persisted Delivered.
  if (load.status === "Delivered") {
    return res
      .status(200)
      .json(new ApiResponse(200, load, "Load already delivered"));
  }

  if (load.status !== "In-Transit") {
    throw new ApiError(
      400,
      `Cannot complete delivery from ${load.status} status`,
    );
  }

  if (!(load as any).proofOfDelivery?.imageUrl) {
    throw new ApiError(
      400,
      "A proof-of-delivery photo is required before completing this load",
    );
  }

  assertNoPendingLoadAmendments(load, user._id.toString());

  const pendingReleaseRequest = await LoadReleaseRequest.findOne({
    organizationId,
    loadId: load._id,
    driverId: user._id,
    status: "pending",
  });

  const deliveryOutbox = [
    lifecycleSyncEvent(
      organizationId,
      [user._id.toString()],
      load._id.toString(),
    ),
    lifecycleAdminNotificationEvent({
      organizationId,
      type: "load_delivered",
      title: "Load Delivered",
      message: `${user.name} completed load ${load.loadNumber} and submitted proof of delivery`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        proofSubmitted: true,
      },
      excludeUserId: user._id.toString(),
    }),
    lifecycleActivityEvent({
      userId: user._id.toString(),
      organizationId,
      type: "load_delivered",
      title: "Load Delivered",
      description: `Driver completed load ${load.loadNumber} with proof of delivery`,
      loadId: load._id.toString(),
      metadata: { proofSubmitted: true },
    }),
    ...(pendingReleaseRequest
      ? [
          lifecycleReleaseResolutionEvent({
            request: pendingReleaseRequest,
            organizationId,
            loadId: load._id.toString(),
            driverId: user._id.toString(),
            status: "cancelled",
            decision: "delivery_completed",
          }),
        ]
      : []),
  ];

  const deliveredLoad = await Load.findOneAndUpdate(
    expectedLoadRevisionFilter(load, {
      organizationId,
      status: "In-Transit",
      assignedDriverId: user._id,
      "proofOfDelivery.imageUrl": { $exists: true, $ne: "" },
    }),
    appendLoadLifecycleOutbox(
      {
        $set: {
          status: "Delivered",
          deliveredAt: new Date(),
        },
      },
      deliveryOutbox,
    ) as any,
    { new: true, runValidators: true },
  );

  if (!deliveredLoad) {
    const current = await Load.findOne({ _id: load._id });
    if (
      current &&
      current.status === "Delivered" &&
      String(current.assignedDriverId ?? "") === user._id.toString()
    ) {
      return res
        .status(200)
        .json(new ApiResponse(200, current, "Load already delivered"));
    }
    throw new ApiError(
      409,
      "This load changed while delivery was being completed. Refresh the load before trying again.",
    );
  }
  load = deliveredLoad;

  await flushLifecycleOutbox(load._id.toString());

  try {
    await clearDriverExactLocationIfUnneeded(
      user._id.toString(),
      "load_delivered",
    );
  } catch (err) {
    logger.error(
      { err, driverId: user._id.toString(), loadId: load._id.toString() },
      "Non-fatal: failed to clear exact GPS after delivery",
    );
  }

  // Keep the driver's delivery completion separate from Dispatch proof
  // confirmation. We intentionally do not set proofOfDelivery.confirmedAt or
  // confirmedBy here; the existing staff confirmation workflow still owns
  // those fields.
  try {
    await finalizeDriverStatusChangeIfClear(
      user._id.toString(),
      organizationId,
    );
  } catch (err) {
    logger.error(
      { err, driverId: user._id },
      "Non-fatal: failed to finalize driver status transition after delivery",
    );
  }

  return res
    .status(200)
    .json(new ApiResponse(200, load, "Delivery completed"));
});

// POST /api/driver-tracking/loads/:id/release-request
// POST /api/driver-tracking/loads/:id/drop (compatibility alias)
// A driver can request release, but only Dispatch can change ownership/state.
const createReleaseRequest = async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const { reason, message, priority } = req.body as {
    reason?: string;
    message?: string;
    priority?: "standard" | "emergency";
  };

  const load: any = await Load.findOne({ _id: req.params.id });
  if (!load) throw new ApiError(404, "Load not found");
  const organizationId = String(load.organizationId);
  requireAssignedDriver(load, user._id.toString());

  if (!RELEASE_REQUEST_ELIGIBLE_STATUSES.includes(load.status as any)) {
    throw new ApiError(
      400,
      `A release request cannot be submitted for a load in ${load.status} status`,
    );
  }

  const normalizedReason = String(reason ?? "").trim() as LoadReleaseRequestReason;
  if (!LOAD_RELEASE_REQUEST_REASONS.includes(normalizedReason as any)) {
    throw new ApiError(400, "Select a valid reason for requesting release");
  }

  const existing = await LoadReleaseRequest.findOne({
    loadId: load._id,
    driverId: user._id,
    status: "pending",
  });
  if (existing) {
    throw new ApiError(
      409,
      "A release request for this load is already waiting for Dispatch review.",
    );
  }

  const dispatcher = await resolveActiveDispatcherForLoad(
    load,
    user._id.toString(),
  );
  const emergencyLifecycle = ["Picked Up", "In-Transit"].includes(load.status);
  const requestPriority = emergencyLifecycle || priority === "emergency"
    ? "emergency"
    : "standard";

  let request: any;
  try {
    request = await LoadReleaseRequest.create({
      organizationId,
      loadId: load._id,
      driverId: user._id,
      dispatcherId: dispatcher?._id,
      priority: requestPriority,
      reason: normalizedReason,
      message: String(message ?? "").trim().slice(0, 1500),
      loadStatusAtRequest: load.status,
      status: "pending",
      requestedAt: new Date(),
    });
  } catch (error: any) {
    if (Number(error?.code) === 11000) {
      throw new ApiError(
        409,
        "A release request for this load is already waiting for Dispatch review.",
      );
    }
    throw error;
  }

  const loadStillMatchesRequest = await Load.exists(
    expectedLoadRevisionFilter(load, {
      organizationId,
      status: load.status,
      assignedDriverId: user._id,
    }),
  );
  if (!loadStillMatchesRequest) {
    await LoadReleaseRequest.deleteOne({ _id: request._id, status: "pending" });
    throw new ApiError(
      409,
      "This load changed while the release request was being submitted. Refresh the load and try again.",
    );
  }

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  const reasonLabel = normalizedReason.replace(/_/g, " ");
  const requestMessage =
    `${user.name} requested ${requestPriority === "emergency" ? "an emergency " : ""}` +
    `release from load ${load.loadNumber}. Reason: ${reasonLabel}. ` +
    "The load remains assigned until Dispatch decides.";

  try {
    if (dispatcher) {
      await safeCreateNotificationLoose({
        userId: dispatcher._id.toString(),
        organizationId,
        type: "general",
        title: requestPriority === "emergency"
          ? "Emergency Load Release Requested"
          : "Load Release Requested",
        message: requestMessage,
        metadata: {
          releaseRequestId: request._id.toString(),
          loadId: load._id.toString(),
          loadNumber: load.loadNumber,
          driverId: user._id.toString(),
          priority: requestPriority,
          reason: normalizedReason,
          route:
            `/driver-tracker?driverId=${encodeURIComponent(user._id.toString())}`,
          requiresAttention: true,
        },
      });
    } else {
      await notifyOrgAdminsLoose(
        organizationId,
        "general",
        "Load Release Request Needs Review",
        `${requestMessage} No active dispatcher owner was available, so an administrator must review it.`,
        {
          releaseRequestId: request._id.toString(),
          loadId: load._id.toString(),
          driverId: user._id.toString(),
        },
        user._id.toString(),
      );
    }

    await safeCreateNotificationLoose({
      userId: user._id.toString(),
      organizationId,
      type: "general",
      title: "Release Request Sent",
      message:
        `Dispatch has been asked to review your release request for load ${load.loadNumber}. ` +
        "The load remains assigned to you until Dispatch decides. If location sharing is already required for this load, it remains required while the request is pending.",
      metadata: {
        releaseRequestId: request._id.toString(),
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        route: "/driver",
      },
    });
  } catch (err) {
    logger.error({ err }, "Non-fatal: release-request notification failed");
  }

  return res.status(202).json(
    new ApiResponse(
      202,
      releaseRequestSummary(request),
      "Release request sent to Dispatch. The load remains assigned until a decision is made.",
    ),
  );
};

const requestLoadRelease = asyncHandler(createReleaseRequest);
const dropLoad = asyncHandler(createReleaseRequest);

// POST /api/driver-tracking/loads/:id/release-request/cancel
// Driver withdraws only their own still-pending request. This does not mutate
// the Load assignment/status. The status:"pending" predicate makes the action
// safe against a dispatcher approval/rejection racing the driver's click.
const cancelReleaseRequest = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);
    const driverId = user._id.toString();

    const load: any = await Load.findOne({ _id: req.params.id });
    if (!load) throw new ApiError(404, "Load not found");

    const organizationId = String(load.organizationId);
    requireAssignedDriver(load, driverId);

    if (!RELEASE_REQUEST_ELIGIBLE_STATUSES.includes(load.status as any)) {
      throw new ApiError(
        409,
        `This load is now in ${load.status} status. Refresh before changing the release request.`,
      );
    }

    const request: any = await LoadReleaseRequest.findOne({
      organizationId,
      loadId: load._id,
      driverId,
      status: "pending",
    });

    if (!request) {
      throw new ApiError(
        409,
        "This release request is no longer pending. Dispatch or another load action may already have resolved it. Refresh the load before trying again.",
      );
    }

    const cancelledAt = new Date();
    const cancelledRequest: any = await LoadReleaseRequest.findOneAndUpdate(
      {
        _id: request._id,
        organizationId,
        loadId: load._id,
        driverId,
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
          // Reuse the existing, schema-safe keep_assigned outcome: cancelling
          // the request means the underlying Load remains exactly as it was.
          decision: "keep_assigned",
          reviewedAt: cancelledAt,
          reviewedBy: user._id,
        },
        $unset: {
          decisionReason: "",
          replacementDriverId: "",
        },
      },
      { new: true, runValidators: true },
    );

    if (!cancelledRequest) {
      throw new ApiError(
        409,
        "This release request was resolved while you were cancelling it. Refresh the load to see the current decision.",
      );
    }

    // Re-check the ownership relationship after the request write. Load and
    // release-request records are separate collections, so this catches the
    // practical dispatcher-reassign race without pretending they are one DB
    // transaction. The existing lifecycle outbox remains canonical if a
    // reassignment committed concurrently.
    const loadStillAssignedToDriver = await Load.exists({
      _id: load._id,
      organizationId,
      assignedDriverId: user._id,
      status: { $in: [...RELEASE_REQUEST_ELIGIBLE_STATUSES] },
    });

    emitLoadSync(organizationId, [driverId], load._id.toString());

    if (!loadStillAssignedToDriver) {
      throw new ApiError(
        409,
        "The load changed while the release request was being cancelled. Refresh the Current Load card to see the final assignment state.",
      );
    }

    // Keep the notification private to the dispatcher tied to this exact
    // release request/load relationship. Never broadcast the request details
    // to unrelated organization members when an explicit dispatcher exists.
    let dispatcherId = String(request.dispatcherId ?? "").trim();
    let dispatcher: any = dispatcherId
      ? await User.findOne({
          _id: dispatcherId,
          organizationId,
          role: { $in: ["employee", "admin", "super_admin"] },
          isActive: true,
        })
          .select("_id name email role")
          .lean()
      : null;

    if (!dispatcher) {
      dispatcher = await resolveActiveDispatcherForLoad(load, driverId);
      dispatcherId = dispatcher?._id ? String(dispatcher._id) : "";
    }

    const dispatcherMessage =
      `${user.name || "Driver"} cancelled their release request for load ${load.loadNumber}. ` +
      `The load remains assigned to ${user.name || "the driver"}.`;
    const driverMessage =
      `You cancelled your release request for load ${load.loadNumber}. ` +
      "The load remains assigned to you and its normal workflow is available again.";

    try {
      if (dispatcherId) {
        await safeCreateNotificationLoose({
          userId: dispatcherId,
          organizationId,
          type: "general",
          title: "Release Request Cancelled",
          message: dispatcherMessage,
          metadata: {
            releaseRequestId: cancelledRequest._id.toString(),
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            driverId,
            route: `/driver-tracker?driverId=${encodeURIComponent(driverId)}`,
            requiresAttention: false,
          },
        });

        // Persist one driver-authored system row in the exact private
        // dispatcher↔driver thread. The driver has already seen the action, so
        // only the dispatcher remains unread.
        const thread: any = await ensureDispatchChatThread({
          organizationId,
          dispatcherId,
          driverId,
        });

        const chatMessage: any = await DispatchChatMessage.create({
          organizationId,
          threadId: thread._id,
          dispatcherId,
          driverId,
          senderId: user._id,
          senderRole: "driver",
          messageType: "system",
          systemEvent: {
            type: "driver_load_release_cancelled",
            title: "Release Request Cancelled",
            message: dispatcherMessage,
            metadata: {
              releaseRequestId: cancelledRequest._id.toString(),
              loadId: load._id.toString(),
              loadNumber: load.loadNumber,
              driverId,
              driverName: user.name || "Driver",
              dispatcherId,
              action: "release_request_cancelled",
              audienceMessages: {
                driver: driverMessage,
                dispatcher: dispatcherMessage,
                threadDispatcher: dispatcherMessage,
              },
            },
          },
          content: dispatcherMessage,
          attachments: [],
          readBy: [user._id],
        });

        await touchDispatchChatThread({
          threadId: thread._id,
          senderId: user._id,
          messageType: "system",
          content: dispatcherMessage,
          fallbackPreview: "Release Request Cancelled",
          at: chatMessage.createdAt,
        });

        emitToDispatchChatThreadParticipants(
          thread,
          "dispatch-chat:message",
          {
            id: String(chatMessage._id),
            threadId: String(thread._id),
            dispatcherId,
            driverId,
            sender: {
              id: driverId,
              name: user.name || "Driver",
              email: user.email || "",
              role: "driver",
            },
            senderRole: "driver" as const,
            messageType: "system" as const,
            systemEvent: chatMessage.systemEvent,
            content: dispatcherMessage,
            attachments: [],
            readBy: [driverId],
            createdAt: chatMessage.createdAt,
            updatedAt: chatMessage.updatedAt,
          },
        );
      } else {
        await notifyOrgAdminsLoose(
          organizationId,
          "general",
          "Release Request Cancelled",
          dispatcherMessage,
          {
            releaseRequestId: cancelledRequest._id.toString(),
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            driverId,
          },
          driverId,
        );
      }
    } catch (err) {
      logger.error(
        { err, loadId: load._id.toString(), driverId, dispatcherId },
        "Non-fatal: failed to publish release-request cancellation notification",
      );
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        releaseRequestSummary(cancelledRequest),
        "Release request cancelled. The load remains assigned to you.",
      ),
    );
  },
);

// POST /api/driver-tracking/loads/:id/release-request/reject
const rejectReleaseRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const decisionReason = String(req.body?.decisionReason ?? "").trim().slice(0, 1000);

  const load: any = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId) throw new ApiError(409, "This load no longer has an assigned driver");

  let request: any = await LoadReleaseRequest.findOne({
    organizationId,
    loadId: load._id,
    driverId: load.assignedDriverId,
    status: "pending",
  });
  if (!request) throw new ApiError(404, "No pending release request was found for this load");

  assertCanReviewReleaseRequest(req, load, request);

  const rejectedRequest = await LoadReleaseRequest.findOneAndUpdate(
    {
      _id: request._id,
      organizationId,
      loadId: load._id,
      driverId: load.assignedDriverId,
      status: "pending",
    },
    {
      $set: {
        status: "rejected",
        decision: "keep_assigned",
        reviewedAt: new Date(),
        reviewedBy: user._id,
        decisionReason,
      },
    },
    { new: true },
  );
  if (!rejectedRequest) {
    throw new ApiError(
      409,
      "This release request was already resolved by another action. Refresh the load before trying again.",
    );
  }
  request = rejectedRequest;

  const driverId = String(load.assignedDriverId);
  emitLoadSync(organizationId, [driverId], load._id.toString());

  try {
    await safeCreateNotificationLoose({
      userId: driverId,
      organizationId,
      type: "general",
      title: "Release Request Not Approved",
      message:
        `Dispatch kept load ${load.loadNumber} assigned to you.` +
        (decisionReason ? ` ${decisionReason}` : "") +
        (["Accepted", "Picked Up", "In-Transit"].includes(load.status)
          ? " Location sharing remains required while this accepted active load is assigned to you."
          : ""),
      metadata: {
        releaseRequestId: request._id.toString(),
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        route: "/driver",
      },
    });

    await persistDispatcherLoadChatEvent({
      dispatcher: user,
      organizationId,
      driverId,
      eventType: "driver_load_release_rejected",
      title: "Release Request Not Approved",
      message: `Dispatch kept load ${load.loadNumber} assigned to you.${decisionReason ? ` ${decisionReason}` : ""}`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        releaseRequestId: request._id.toString(),
        action: "keep_assigned",
      },
    });
  } catch (err) {
    logger.error({ err }, "Non-fatal: release rejection notification failed");
  }

  return res.status(200).json(
    new ApiResponse(200, releaseRequestSummary(request), "Load remains assigned"),
  );
});

// POST /api/driver-tracking/loads/:id/amendments/:amendmentId/acknowledge
const acknowledgeLoadAmendment = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);
    if (user.role !== "driver") {
      throw new ApiError(403, "Only the assigned driver can acknowledge a Load Update");
    }

    const { id: loadId, amendmentId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(loadId) ||
      !mongoose.Types.ObjectId.isValid(amendmentId)
    ) {
      throw new ApiError(400, "Invalid load or amendment identifier");
    }

    const acknowledgedAt = new Date();
    const load: any = await Load.findOneAndUpdate(
      {
        _id: loadId,
        assignedDriverId: user._id,
        driverAmendments: {
          $elemMatch: {
            _id: amendmentId,
            driverId: user._id,
            status: "pending",
          },
        },
      },
      {
        $set: {
          "driverAmendments.$[amendment].status": "acknowledged",
          "driverAmendments.$[amendment].acknowledgedAt": acknowledgedAt,
          "driverAmendments.$[amendment].acknowledgedBy": user._id,
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [
          {
            "amendment._id": new mongoose.Types.ObjectId(amendmentId),
            "amendment.driverId": user._id,
            "amendment.status": "pending",
          },
        ],
      },
    );

    if (!load) {
      const existing: any = await Load.findOne({
        _id: loadId,
        assignedDriverId: user._id,
        "driverAmendments._id": amendmentId,
      })
        .select("driverAmendments")
        .lean();
      const amendment = Array.isArray(existing?.driverAmendments)
        ? existing.driverAmendments.find(
            (entry: any) => String(entry?._id ?? "") === amendmentId,
          )
        : null;

      if (amendment?.status === "acknowledged") {
        return res.status(200).json(
          new ApiResponse(
            200,
            { amendmentId, acknowledgedAt: amendment.acknowledgedAt ?? null },
            "Load Update already acknowledged",
          ),
        );
      }

      throw new ApiError(
        404,
        "This Load Update is unavailable or is no longer assigned to your account",
      );
    }

    const acknowledged = Array.isArray(load.driverAmendments)
      ? load.driverAmendments.find(
          (entry: any) => String(entry?._id ?? "") === amendmentId,
        )
      : null;

    try {
      const dispatcher = await resolveActiveDispatcherForLoad(
        load,
        user._id.toString(),
      );
      if (dispatcher) {
        await safeCreateNotificationLoose({
          userId: dispatcher._id.toString(),
          organizationId: String(load.organizationId),
          type: "load_amendment_acknowledged",
          title: "Driver Acknowledged Load Update",
          message: `${user.name} acknowledged the latest material changes for load ${load.loadNumber}.`,
          metadata: {
            loadId: load._id.toString(),
            loadNumber: load.loadNumber,
            amendmentId,
            driverId: user._id.toString(),
            route: `/transportation/load/${encodeURIComponent(load._id.toString())}`,
          },
        });
      }
    } catch (error) {
      logger.error(
        { error, loadId, amendmentId },
        "Non-fatal: failed to notify dispatcher about Load Update acknowledgement",
      );
    }

    emitToUser(user._id.toString(), "driver:loads_updated", {
      loadId: load._id.toString(),
      amendmentId,
      amendmentStatus: "acknowledged",
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          amendmentId,
          acknowledgedAt: acknowledged?.acknowledgedAt ?? acknowledgedAt,
        },
        "Load Update acknowledged",
      ),
    );
  },
);

// GET /api/driver-tracking/drivers/:driverId/profile
// Permission-aware Driver Review Center projection. The server decides exactly
// which fields can leave the API for this viewer; React never receives secrets
// that the viewer is not authorized to access.
const getDriverComplianceProfile = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  assertDriverReviewCenterAccess(access);

  const profile: any = await DriverProfile.findOne({ userId: driverId })
    .populate("userId", "name email avatar personalInfo.phone")
    .lean();

  if (!profile) throw new ApiError(404, "Driver profile not found");

  const rawDocuments = Array.isArray(profile.documents) ? profile.documents : [];
  const uploadedTypes = new Set(rawDocuments.map((document: any) => document.type));
  const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter((type) =>
    uploadedTypes.has(type),
  ).length;
  const complianceSummary = {
    uploadedCount,
    totalRequired: REQUIRED_COMPLIANCE_DOCS.length,
    percentage: Math.round(
      (uploadedCount / Math.max(1, REQUIRED_COMPLIANCE_DOCS.length)) * 100,
    ),
    missingTypes: REQUIRED_COMPLIANCE_DOCS.filter(
      (type) => !uploadedTypes.has(type),
    ),
  };

  const documentFact = (type: string) => {
    const candidates = rawDocuments.filter((document: any) => document.type === type);
    const approved = candidates.find(
      (document: any) => document.verified || document.reviewStatus === "approved",
    );
    const rejected = candidates.find(
      (document: any) => document.reviewStatus === "rejected",
    );
    const document = approved || rejected || candidates[0];
    if (!document) return { status: "missing" as const, expiresAt: null };
    return {
      status: document.verified || document.reviewStatus === "approved"
        ? ("approved" as const)
        : document.reviewStatus === "rejected"
          ? ("rejected" as const)
          : ("pending" as const),
      expiresAt: document.expiresAt ?? null,
    };
  };

  const daysUntil = (value: unknown) => {
    if (!value) return null;
    const time = new Date(String(value)).getTime();
    if (!Number.isFinite(time)) return null;
    return Math.ceil((time - Date.now()) / 86_400_000);
  };

  const expiringSoon = [
    profile.licenseExpirationDate,
    profile.medicalCardExpirationDate,
    profile.insuranceExpirationDate,
  ].some((value) => {
    const days = daysUntil(value);
    return days != null && days >= 0 && days <= 30;
  });

  const requiredReviewNeedsAttention = REQUIRED_COMPLIANCE_DOCS.some(
    (type) => documentFact(type).status !== "approved",
  );
  const complianceState = profile.isComplianceExpired || requiredReviewNeedsAttention
    ? "needs_attention"
    : expiringSoon
      ? "expiring_soon"
      : "valid";

  const userObject = profile.userId && typeof profile.userId === "object"
    ? profile.userId
    : null;
  const driverName = userObject?.name || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Driver";

  const accessProjection = {
    level: access.level,
    canOpenReviewCenter: access.canOpenReviewCenter,
    canReviewDocuments: access.canReviewDocuments,
    canViewDocumentContents: access.canViewDocumentContents,
    canViewReviewHistory: access.canViewReviewHistory,
    canFinalizeVerification: access.canFinalizeVerification,
    hasActiveLoadRelationship: access.hasActiveLoadRelationship,
    activeLoads: access.activeLoads,
    reason: access.reason,
  };

  const baseData: Record<string, any> = {
    access: accessProjection,
    driver: {
      id: driverId,
      name: driverName,
      avatar: userObject?.avatar ?? null,
    },
    verificationStatus: profile.verificationStatus,
    operationalStatus: profile.operationalStatus,
    profileCompletionScore: Number(profile.profileCompletionScore ?? 0),
    isComplianceExpired: Boolean(profile.isComplianceExpired),
    complianceState,
    equipment: {
      trailerType: profile.trailerType,
      maxVehicleCapacity: profile.maxVehicleCapacity,
      truckMake: profile.truckMake,
      truckModel: profile.truckModel,
      trailerMake: profile.trailerMake,
      trailerModel: profile.trailerModel,
      specialFeatures: Array.isArray(profile.specialFeatures) ? profile.specialFeatures : [],
    },
  };

  if (access.level === "DISPATCH_LIMITED") {
    return res.status(200).json(
      new ApiResponse(200, baseData, "Driver Review Center limited profile fetched"),
    );
  }

  if (access.level === "DISPATCH_ACTIVE_LOAD" || access.level === "OPERATIONAL_ONLY") {
    const protectedData = {
      ...baseData,
      contact: {
        email: userObject?.email || undefined,
        phone: profile.phone || userObject?.personalInfo?.phone || undefined,
      },
      credentialFacts: {
        cdl: {
          review: documentFact("drivers_license"),
          state: profile.licenseState,
          expiresAt: profile.licenseExpirationDate ?? null,
        },
        medicalCard: {
          review: documentFact("medical_card"),
          expiresAt: profile.medicalCardExpirationDate ?? null,
        },
        insurance: {
          review: documentFact("insurance_certificate"),
          provider: profile.insuranceProvider,
          expiresAt: profile.insuranceExpirationDate ?? null,
        },
      },
      complianceWarnings: [
        ...(profile.isComplianceExpired ? ["One or more compliance credentials are expired"] : []),
        ...(requiredReviewNeedsAttention ? ["One or more required compliance documents need review or correction"] : []),
        ...(expiringSoon ? ["One or more compliance credentials expire within 30 days"] : []),
      ],
    };

    const relationshipLoad = access.activeLoads[0];
    await recordDriverReviewEvent({
      driverId,
      actor: viewer,
      action: "protected_compliance_opened",
      targetType: "access",
      organizationId: req.orgId,
      loadId: relationshipLoad?.id,
      loadNumber: relationshipLoad?.loadNumber,
      metadata: { accessLevel: access.level },
    });

    return res.status(200).json(
      new ApiResponse(200, protectedData, "Driver Review Center operational profile fetched"),
    );
  }

  const documents = rawDocuments.map((document: any) => ({
    _id: document._id ? String(document._id) : undefined,
    type: document.type,
    label: document.label,
    fileName: document.fileName,
    fileSize: Number(document.fileSize || 0),
    mimeType: document.mimeType,
    uploadedAt: document.uploadedAt ?? null,
    expiresAt: document.expiresAt ?? null,
    verified: Boolean(document.verified),
    reviewStatus: document.reviewStatus,
    verifiedBy: document.verifiedBy ? String(document.verifiedBy) : undefined,
    verifiedAt: document.verifiedAt ?? null,
    rejectionReason: document.rejectionReason ?? undefined,
    rejectedAt: document.rejectedAt ?? null,
    fileAvailable: Boolean(document.fileKey || document.fileUrl),
    fileEndpoint: document._id
      ? `/api/driver-tracking/drivers/${encodeURIComponent(driverId)}/documents/${encodeURIComponent(String(document._id))}/file`
      : undefined,
  }));

  const baseEligibility = evaluateDriverVerificationEligibility(profile);
  const latestDriverRequest: any = await DriverRequest.findOne({
    driverUserId: driverId,
  })
    .sort({ createdAt: -1 })
    .select("status reviewedAt")
    .lean();
  const accountRequestRejected = latestDriverRequest?.status === "rejected";
  const eligibility = accountRequestRejected
    ? {
        ...baseEligibility,
        eligible: false,
        blockers: [
          ...baseEligibility.blockers,
          "Latest Driver Account application is rejected; a new pending application is required",
        ],
      }
    : baseEligibility;
  const reviewHistory = await listDriverReviewEvents(driverId);

  const adminData = {
    ...baseData,
    driver: {
      ...baseData.driver,
      email: userObject?.email || undefined,
      phone: profile.phone || userObject?.personalInfo?.phone || undefined,
    },
    information: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone,
      address: profile.address,
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      ssnLast4: profile.ssnLast4,
      backgroundCheckConsent: Boolean(profile.backgroundCheckConsent),
      backgroundCheckConsentDate: profile.backgroundCheckConsentDate ?? null,
    },
    agreement: {
      accepted: Boolean(profile.verificationAgreement),
      acceptedAt: profile.verificationAgreementDate ?? null,
    },
    credentialFacts: {
      cdl: {
        review: documentFact("drivers_license"),
        state: profile.licenseState,
        expiresAt: profile.licenseExpirationDate ?? null,
      },
      medicalCard: {
        review: documentFact("medical_card"),
        expiresAt: profile.medicalCardExpirationDate ?? null,
      },
      insurance: {
        review: documentFact("insurance_certificate"),
        provider: profile.insuranceProvider,
        expiresAt: profile.insuranceExpirationDate ?? null,
      },
    },
    credentials: {
      driversLicenseNumber: profile.driversLicenseNumber,
      licenseState: profile.licenseState,
      licenseExpirationDate: profile.licenseExpirationDate ?? null,
      medicalCardExpirationDate: profile.medicalCardExpirationDate ?? null,
      insuranceProvider: profile.insuranceProvider,
      insurancePolicyNumber: profile.insurancePolicyNumber,
      insuranceExpirationDate: profile.insuranceExpirationDate ?? null,
      dotNumber: profile.dotNumber,
      mcNumber: profile.mcNumber,
    },
    equipment: {
      ...baseData.equipment,
      customTrailerName: profile.customTrailerName,
      truckYear: profile.truckYear,
      truckColor: profile.truckColor,
      vin: profile.vin,
      plateNumber: profile.plateNumber,
      gvwr: profile.gvwr,
      engineType: profile.engineType,
      trailerYear: profile.trailerYear,
      trailerLength: profile.trailerLength,
      trailerAxles: profile.trailerAxles,
      trailerGvwr: profile.trailerGvwr,
      hitchType: profile.hitchType,
    },
    logistics: {
      serviceRadius: profile.serviceRadius ?? null,
      preferredRoutes: Array.isArray(profile.preferredRoutes) ? profile.preferredRoutes : [],
      availableDays: Array.isArray(profile.availableDays) ? profile.availableDays : [],
      homeBase: profile.homeBase
        ? {
            address: profile.homeBase.address || "",
            city: profile.homeBase.city || "",
            state: profile.homeBase.state || "",
            zip: profile.homeBase.zip || "",
          }
        : undefined,
    },
    complianceSummary,
    documents,
    eligibility,
    accountApplicationStatus: latestDriverRequest?.status ?? null,
    reviewHistory,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };

  return res.status(200).json(
    new ApiResponse(200, adminData, "Driver Review Center admin profile fetched"),
  );
});

// GET /api/driver-tracking/drivers/:driverId/documents/:documentId/file
// Document bytes are streamed only after server-side reviewer authorization.
const getDriverReviewDocumentFile = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  const documentId = String(req.params.documentId || "").trim();
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  if (!access.canViewDocumentContents || access.level !== "ADMIN_REVIEW") {
    throw new ApiError(403, "Document contents are restricted to an authorized Driver Verification reviewer");
  }

  const profile: any = await DriverProfile.findOne({ userId: driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");
  const document: any = profile.documents.find(
    (item: any) => item._id?.toString() === documentId,
  );
  if (!document) throw new ApiError(404, "Document not found");

  const storageKey = String(document.fileKey || document.fileUrl || "").trim();
  if (!storageKey) throw new ApiError(404, "Document file is unavailable");

  if (/^https?:\/\//i.test(storageKey)) {
    await recordDriverReviewEvent({
      driverId,
      actor: viewer,
      action: "document_viewed",
      targetType: "document",
      targetId: documentId,
      organizationId: req.orgId,
      metadata: { documentType: document.type, documentLabel: document.label },
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.redirect(storageKey);
  }

  const file = await storageService.streamPrivateFile(storageKey);
  if (!file) throw new ApiError(404, "Document file could not be opened");

  await recordDriverReviewEvent({
    driverId,
    actor: viewer,
    action: "document_viewed",
    targetType: "document",
    targetId: documentId,
    organizationId: req.orgId,
    metadata: { documentType: document.type, documentLabel: document.label },
  });

  const safeFileName = String(
    document.fileName || document.label || "driver-document",
  ).replace(/[\r\n"]/g, "_");
  res.setHeader(
    "Content-Type",
    document.mimeType || file.contentType || "application/octet-stream",
  );
  res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  file.stream.on("error", (error) => {
    logger.error(
      { error, driverId, documentId, viewerId: viewer._id.toString() },
      "Driver Review document stream failed",
    );
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  file.stream.pipe(res);
});

const approveDriverReviewDocument = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  const documentId = String(req.params.documentId || "").trim();
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  assertDriverReviewMutationAccess(access);

  const profile = await reviewDriverDocument({
    driverId,
    documentId,
    reviewer: viewer,
    organizationId: req.orgId,
    decision: "approved",
    expectedUploadedAt: req.body?.expectedUploadedAt,
  });
  return res.status(200).json(
    new ApiResponse(200, profile, "Document approved"),
  );
});

const rejectDriverReviewDocument = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  const documentId = String(req.params.documentId || "").trim();
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  assertDriverReviewMutationAccess(access);

  const reason = String(req.body?.reason || "").trim();
  const profile = await reviewDriverDocument({
    driverId,
    documentId,
    reviewer: viewer,
    organizationId: req.orgId,
    decision: "rejected",
    reason,
    expectedUploadedAt: req.body?.expectedUploadedAt,
  });
  return res.status(200).json(
    new ApiResponse(200, profile, "Document rejected"),
  );
});

const approveDriverReview = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const viewer = getUser(req);
  const driverId = String(req.params.driverId || "").trim();
  const access = await resolveDriverReviewAccess({
    viewer,
    organizationId: req.orgId,
    organizationRole: req.orgRole,
    driverId,
  });
  assertDriverReviewMutationAccess(access);

  const result = await approveDriverVerification({
    driverId,
    reviewer: viewer,
    organizationId: req.orgId,
    expectedUpdatedAt: req.body?.expectedUpdatedAt,
  });
  return res.status(200).json(
    new ApiResponse(200, result, "Driver Verification approved"),
  );
});

export default {
  heartbeat,
  markLocationOffline,
  getActiveDrivers,
  getDriverComplianceProfile,
  getDriverReviewDocumentFile,
  approveDriverReviewDocument,
  rejectDriverReviewDocument,
  approveDriverReview,
  getDashboardStats,
  getPendingLoadRequests,
  previewDriverLoadCompatibility,
  sendDriverAlert,
  respondToDriverAlert,
  assignLoad,
  reassignLoad,
  removeLoad,
  getMyLoads,
  getMyRequests,
  getAvailableLoads,
  getLoadDetail,
  requestLoad,
  approveLoadRequest,
  rejectLoadRequest,
  acceptLoad,
  markPickedUp,
  startRoute,
  completeDelivery,
  requestLoadRelease,
  cancelReleaseRequest,
  rejectReleaseRequest,
  acknowledgeLoadAmendment,
  dropLoad,
};