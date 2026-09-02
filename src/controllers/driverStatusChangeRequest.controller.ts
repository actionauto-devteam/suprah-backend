import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { randomUUID } from "crypto";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import User, { IUser } from "../models/User.model";
import Load from "../models/Load.model";
import DriverStatusChangeRequest, {
  DRIVER_STATUS_REQUEST_PRIORITIES,
  DRIVER_STATUS_REQUEST_REASONS,
  DRIVER_STATUS_LOAD_HANDLING_OPTIONS,
  DriverStatusLoadHandlingDecision,
  RequestedDriverOperationalStatus,
} from "../models/DriverStatusChangeRequest.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
import storageService, { BucketType } from "../services/storage.service";
import notificationService from "../services/notification.service";
import {
  emitToDispatchChatThreadParticipants,
  ensureDispatchChatThread,
  touchDispatchChatThread,
} from "../services/dispatchChat.service";
import {
  ACTIVE_DRIVER_LOAD_STATUSES,
  applyDriverOperationalStatus,
  finalizeDriverStatusChangeIfClear,
  finalizeDriverStatusTransitionGroup,
  finalizeResolvedDriverStatusGroups,
  getDriverStatusContext,
  OPEN_DRIVER_STATUS_REQUEST_STATES,
} from "../services/driverStatusTransition.service";
import { emitToOrg, emitToUser } from "../utils/socketEmitter";
import logger from "../utils/logger";

const STAFF_ROLES = ["employee", "admin", "super_admin"];

const getUser = (req: ExpressRequest) => req.user as IUser;

const assertDriver = (user: IUser) => {
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") {
    throw new ApiError(403, "Only drivers can submit status change requests");
  }
};

const assertStaff = (user: IUser) => {
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (!STAFF_ROLES.includes(user.role)) {
    throw new ApiError(403, "Staff access required");
  }
};

const parseOptionalDate = (value: unknown) => {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, "A valid date/time is required");
  }
  return parsed;
};

const statusLabel = (status: RequestedDriverOperationalStatus) =>
  status === "maintenance" ? "In Shop" : "On Leave";


function coordinatedStatus(requests: any[]) {
  if (requests.some((request) => request.status === "rejected")) return "rejected";
  if (requests.some((request) => request.status === "cancelled")) return "cancelled";
  if (requests.some((request) => request.status === "pending")) return "pending";
  if (requests.some((request) => request.status === "approved_awaiting_reassignment")) {
    return "approved_awaiting_reassignment";
  }
  return "completed";
}

async function getCoordinatedRequests(request: any) {
  const transitionGroupId = String(request?.transitionGroupId ?? "").trim();
  if (!transitionGroupId) return [request];
  return DriverStatusChangeRequest.find({
    driverId: request.driverId?._id ?? request.driverId,
    transitionGroupId,
  }).sort({ createdAt: 1 });
}

async function addCoordinationSummary(serialized: any, request: any, options: {
  aggregateStatus?: boolean;
} = {}) {
  const transitionGroupId = String(request?.transitionGroupId ?? "").trim();
  if (!transitionGroupId) return serialized;

  const siblings: any[] = await getCoordinatedRequests(request);
  const openCount = siblings.filter((row) =>
    OPEN_DRIVER_STATUS_REQUEST_STATES.includes(row.status as any),
  ).length;

  serialized.transitionGroupId = transitionGroupId;
  serialized.coordinatedOrganizationCount = new Set(
    siblings.map((row) => String(row.organizationId ?? "")).filter(Boolean),
  ).size;
  serialized.coordinatedOpenOrganizationCount = openCount;
  serialized.coordinatedRequests = siblings.map((row) => ({
    id: String(row._id),
    organizationId: row.organizationId,
    status: row.status,
    loadHandlingDecision: row.loadHandlingDecision ?? null,
    retainedGpsRequired:
      row.loadHandlingDecision === "keep_assigned"
        ? Boolean(row.retainedGpsRequired)
        : null,
    affectedLoadCount: Array.isArray(row.affectedLoadIds)
      ? row.affectedLoadIds.length
      : 0,
  }));

  if (options.aggregateStatus) {
    serialized.status = coordinatedStatus(siblings);
  }

  return serialized;
}

/**
 * Persist a dispatcher decision into the exact private dispatcher↔driver chat.
 *
 * This is intentionally non-fatal to the status-request workflow: the approval
 * or rejection remains authoritative even if chat persistence is temporarily
 * unavailable. The existing Notification is still created separately.
 */
async function publishStatusDecisionToPrivateDispatchChat(params: {
  organizationId: string;
  dispatcher: IUser;
  request: any;
  decision: "approved" | "rejected";
  activeLoads?: Array<{
    _id: any;
    loadNumber?: string;
    status?: string;
  }>;
  decisionReason?: string | null;
}) {
  const {
    organizationId,
    dispatcher,
    request,
    decision,
    activeLoads = [],
    decisionReason,
  } = params;

  try {
    const driverId = String(request.driverId);
    const dispatcherId = dispatcher._id.toString();
    const requestedStatusLabel = statusLabel(request.requestedStatus);
    const activeLoadCount = activeLoads.length;
    const coordinated = Boolean(request.transitionGroupId);
    const awaitingReassignment =
      decision === "approved" &&
      request.status === "approved_awaiting_reassignment" &&
      request.loadHandlingDecision === "reassign" &&
      activeLoadCount > 0;
    const keptAssigned =
      decision === "approved" &&
      request.loadHandlingDecision === "keep_assigned" &&
      activeLoadCount > 0;
    const returnedAvailable =
      decision === "approved" &&
      request.loadHandlingDecision === "return_available" &&
      activeLoadCount > 0;

    const loadNumbers = activeLoads
      .map((load) => String(load.loadNumber || "").trim())
      .filter(Boolean);

    const title = coordinated
      ? decision === "approved"
        ? `${requestedStatusLabel} Request — This Dispatch Team Resolved Its Loads`
        : `${requestedStatusLabel} Request Not Approved`
      : decision === "approved"
        ? awaitingReassignment
          ? `${requestedStatusLabel} Request Approved — Reassignment Required`
          : keptAssigned
            ? `${requestedStatusLabel} Request Approved — Loads Kept Assigned`
            : returnedAvailable
              ? `${requestedStatusLabel} Request Approved — Loads Returned to Available`
              : `${requestedStatusLabel} Request Approved`
        : `${requestedStatusLabel} Request Not Approved`;

    const message = coordinated
      ? decision === "approved"
        ? `This Dispatch team completed its part of your ${requestedStatusLabel} request. Your global Work Availability will update only after every affected Dispatch team resolves its own loads.`
        : `This Dispatch team did not approve your ${requestedStatusLabel} request.${decisionReason ? ` Reason: ${decisionReason}` : ""} Your global Work Availability will remain unchanged.`
      : decision === "approved"
        ? awaitingReassignment
          ? `Dispatch approved your ${requestedStatusLabel} request. New work is blocked while Dispatch reassigns your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}. Your Dispatch Status will change automatically after those loads are moved.`
          : keptAssigned
            ? `Dispatch approved your ${requestedStatusLabel} request and kept your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} assigned to you. ${request.retainedGpsRequired ? "GPS is required by Dispatch while those retained loads remain active." : "GPS remains optional while you are in this Dispatch Status."}`
            : returnedAvailable
              ? `Dispatch approved your ${requestedStatusLabel} request and returned your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} to Available. Your Dispatch Status is now ${requestedStatusLabel}.`
              : `Dispatch approved your ${requestedStatusLabel} request. Your Dispatch Status is now ${requestedStatusLabel}.`
        : `Dispatch did not approve your ${requestedStatusLabel} request.${decisionReason ? ` Reason: ${decisionReason}` : ""}`;

    const thread = await ensureDispatchChatThread({
      organizationId,
      dispatcherId,
      driverId,
    });

    const chatMessage: any = await DispatchChatMessage.create({
      organizationId,
      threadId: thread._id,
      dispatcherId,
      driverId,
      senderId: dispatcher._id,
      senderRole: "dispatcher",
      messageType: "system",
      systemEvent: {
        type:
          decision === "approved"
            ? "driver_status_request_approved"
            : "driver_status_request_rejected",
        title,
        message,
        metadata: {
          statusRequestId: String(request._id),
          requestedStatus: request.requestedStatus,
          requestedStatusLabel,
          decision,
          status: request.status,
          awaitingReassignment,
          loadHandlingDecision: request.loadHandlingDecision ?? null,
          retainedGpsRequired:
            request.loadHandlingDecision === "keep_assigned"
              ? Boolean(request.retainedGpsRequired)
              : null,
          activeLoadCount,
          loadIds: activeLoads.map((load) => String(load._id)),
          loadNumbers,
          decisionReason: decisionReason || null,
          reviewedByUserId: dispatcherId,
          reviewedByName: dispatcher.name || "Dispatcher",
          reviewedAt:
            request.reviewedAt?.toISOString?.() ??
            new Date().toISOString(),
        },
      },
      content: message,
      attachments: [],
      readBy: [dispatcher._id],
    });

    await chatMessage.populate("senderId", "name email role");

    await touchDispatchChatThread({
      threadId: thread._id,
      senderId: dispatcher._id,
      messageType: "system",
      content: message,
      fallbackPreview: title,
      at: chatMessage.createdAt,
    });

    const sender: any = chatMessage.senderId;
    const payload = {
      id: String(chatMessage._id),
      threadId: String(thread._id),
      dispatcherId,
      driverId,
      sender: {
        id: String(sender?._id ?? dispatcher._id),
        name: sender?.name ?? dispatcher.name ?? "Dispatcher",
        email: sender?.email ?? dispatcher.email ?? "",
        role: sender?.role ?? dispatcher.role,
      },
      senderRole: "dispatcher" as const,
      messageType: "system" as const,
      systemEvent: chatMessage.systemEvent,
      content: chatMessage.content || message,
      attachments: [],
      readBy: [dispatcherId],
      createdAt: chatMessage.createdAt,
      updatedAt: chatMessage.updatedAt,
    };

    emitToDispatchChatThreadParticipants(
      thread,
      "dispatch-chat:message",
      payload,
    );
  } catch (error) {
    logger.error(
      {
        error,
        requestId: String(params.request?._id ?? ""),
        driverId: String(params.request?.driverId ?? ""),
        dispatcherId: String(params.dispatcher?._id ?? ""),
        decision: params.decision,
      },
      "[DriverStatusRequest] Non-fatal: failed to persist decision in private Dispatch Chat",
    );
  }
}

async function uploadAttachments(
  files: Express.Multer.File[],
  organizationId: string,
  driverId: string,
) {
  if (!files.length) return [];

  const uploaded: Array<{
    fileKey: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    uploadedAt: Date;
  }> = [];

  try {
    for (const file of files) {
      const fileKey = await storageService.upload(
        file,
        `driver-status-requests/${organizationId}/${driverId}`,
        BucketType.PRIVATE,
      );

      uploaded.push({
        fileKey,
        fileName: file.originalname.slice(0, 255),
        fileSize: file.size,
        mimeType: file.mimetype,
        uploadedAt: new Date(),
      });
    }

    return uploaded;
  } catch (error) {
    await Promise.allSettled(
      uploaded.map((attachment) =>
        storageService.delete(attachment.fileKey, BucketType.PRIVATE),
      ),
    );
    throw error;
  }
}

async function serializeRequest(request: any) {
  const obj = request?.toJSON ? request.toJSON() : { ...request };
  obj.id = String(obj._id);

  if (Array.isArray(obj.attachments)) {
    obj.attachments = await Promise.all(
      obj.attachments.map(async (attachment: any) => {
        const localUrl = String(attachment.fileKey || "").startsWith("/uploads/")
          ? attachment.fileKey
          : null;
        const signedUrl = localUrl
          ? null
          : await storageService.getSignedUrl(attachment.fileKey);

        return {
          id: String(attachment._id ?? ""),
          fileName: attachment.fileName || "Attachment",
          fileSize: Number(attachment.fileSize || 0),
          mimeType: attachment.mimeType || "application/octet-stream",
          uploadedAt: attachment.uploadedAt ?? null,
          // Private object keys are server-side implementation details and
          // must never be exposed to browsers, even when URL signing fails.
          url: localUrl || signedUrl || null,
        };
      }),
    );
  }

  return obj;
}

async function notifyDispatchers(params: {
  organizationId: string;
  driverId: string;
  driverName: string;
  requestId: string;
  requestedStatus: RequestedDriverOperationalStatus;
  priority: "standard" | "emergency";
  activeLoadCount: number;
}) {
  const {
    organizationId,
    driverId,
    driverName,
    requestId,
    requestedStatus,
    priority,
    activeLoadCount,
  } = params;

  const dispatchers = await User.find({
    organizationId,
    role: { $in: STAFF_ROLES },
    isActive: true,
  })
    .select("_id")
    .lean();

  const emergency = priority === "emergency";
  const title = emergency
    ? "URGENT DRIVER REQUEST"
    : "Driver Status Change Request";
  const message = emergency
    ? `${driverName} reported that they are unable to continue. Requested Status: ${statusLabel(requestedStatus)}. Current Loads: ${activeLoadCount} require Dispatch attention.`
    : `${driverName} requested ${statusLabel(requestedStatus)} while carrying ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}.`;

  await Promise.allSettled(
    dispatchers.map((dispatcher: any) =>
      notificationService.createNotification({
        userId: String(dispatcher._id),
        organizationId,
        type: emergency
          ? "driver_emergency_request"
          : "driver_status_request",
        title,
        message,
        metadata: {
          requestId,
          statusRequestId: requestId,
          driverId,
          requestedStatus,
          priority,
          activeLoadCount,
          route:
            `/driver-tracker?driverId=${encodeURIComponent(driverId)}` +
            `&statusRequestId=${encodeURIComponent(requestId)}`,
          pushSource: "Driver Tracker",
          requiresAttention: true,
        },
      }),
    ),
  );
}

const getMyCurrentRequest = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);
    assertDriver(user);
    const driverId = user._id.toString();

    // Retry a previously-resolved coordinated group if the final global status
    // apply failed after all organization rows had already completed.
    await finalizeResolvedDriverStatusGroups(driverId);

    const request: any = await DriverStatusChangeRequest.findOne({
      driverId: user._id,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    }).sort({ priority: 1, createdAt: -1 });

    if (!request) {
      return res.status(200).json(
        new ApiResponse(200, null, "Current driver status request fetched"),
      );
    }

    const serialized = await serializeRequest(request);
    await addCoordinationSummary(serialized, request, { aggregateStatus: true });
    serialized.coordinatedActiveLoadCount = await Load.countDocuments({
      assignedDriverId: user._id,
      status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
    });

    return res.status(200).json(
      new ApiResponse(200, serialized, "Current driver status request fetched"),
    );
  },
);

const getOrganizationRequests = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);
    assertStaff(user);
    const organizationId = req.orgId as string;
    const includeClosed = req.query.includeClosed === "true";

    const filter: Record<string, any> = { organizationId };
    if (!includeClosed) {
      filter.status = { $in: OPEN_DRIVER_STATUS_REQUEST_STATES };
    }

    const requests = await DriverStatusChangeRequest.find(filter)
      .populate("driverId", "name email phone avatar")
      .populate(
        "affectedLoadIds",
        "loadNumber status pickupLocation deliveryLocation assignedDriverId",
      )
      .sort({
        // "emergency" sorts before "standard" alphabetically. Keep urgent
        // requests at the top, then newest first within each priority.
        priority: 1,
        createdAt: -1,
      })
      .limit(includeClosed ? 100 : 50);

    return res.status(200).json(
      new ApiResponse(
        200,
        await Promise.all(requests.map(serializeRequest)),
        "Driver status requests fetched",
      ),
    );
  },
);

const getRequestById = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  const organizationId = req.orgId as string;

  const request: any = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
  })
    .populate("driverId", "name email phone avatar")
    .populate(
      "affectedLoadIds",
      "loadNumber status pickupLocation deliveryLocation assignedDriverId",
    );

  if (!request) throw new ApiError(404, "Status change request not found");

  const populatedDriverId: any = request.driverId as any;
  const isOwner = String(populatedDriverId?._id ?? populatedDriverId) === String(user._id);
  const isStaff = STAFF_ROLES.includes(user.role);
  if (!isOwner && !isStaff) {
    throw new ApiError(403, "Access denied");
  }

  // Staff may review only this organization's loads. Other organizations'
  // loads are represented only by coordination counts, never by their private
  // route/contact details.
  const currentActiveLoads = await Load.find({
    organizationId,
    assignedDriverId: populatedDriverId?._id ?? populatedDriverId,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  })
    .select("_id loadNumber status pickupLocation deliveryLocation assignedDriverId")
    .sort({ createdAt: -1 })
    .lean();

  const serialized = await serializeRequest(request);
  serialized.currentActiveLoads = currentActiveLoads;
  await addCoordinationSummary(serialized, request);

  return res.status(200).json(
    new ApiResponse(200, serialized, "Driver status request fetched"),
  );
});

const createRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  assertDriver(user);
  const driverId = user._id.toString();
  const requestContextOrganizationId = String(req.orgId ?? "").trim();

  const requestedStatus = req.body
    .requestedStatus as RequestedDriverOperationalStatus;
  const priority = (req.body.priority || "standard") as
    | "standard"
    | "emergency";
  const reason = req.body.reason ? String(req.body.reason) : undefined;
  const message = req.body.message
    ? String(req.body.message).trim().slice(0, 1500)
    : undefined;

  if (!( ["on_leave", "maintenance"] as string[]).includes(requestedStatus)) {
    throw new ApiError(400, "Requested status must be On Leave or In Shop");
  }
  if (!DRIVER_STATUS_REQUEST_PRIORITIES.includes(priority)) {
    throw new ApiError(400, "Invalid status request priority");
  }
  if (reason && !DRIVER_STATUS_REQUEST_REASONS.includes(reason as any)) {
    throw new ApiError(400, "Invalid status request reason");
  }
  if (priority === "standard" && !reason) {
    throw new ApiError(400, "A reason is required for a standard status change request");
  }

  const statusContext = await getDriverStatusContext(
    driverId,
    requestContextOrganizationId || undefined,
  );
  if (statusContext.operationalStatus !== "active") {
    throw new ApiError(
      409,
      "Work Availability requests can only be submitted while you are Active. Return to Active before requesting On Leave or In Shop.",
    );
  }

  // Only one global Work Availability transition may be open for a shared
  // driver, regardless of how many organizations are involved.
  const existing = await DriverStatusChangeRequest.findOne({
    driverId,
    status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
  });
  if (existing) {
    throw new ApiError(409, "You already have an active Work Availability request");
  }

  const activeLoads: any[] = await Load.find({
    assignedDriverId: user._id,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  })
    .select("_id organizationId loadNumber status")
    .lean();

  // The Driver Command Center normally changes status directly when there are
  // no active loads. Keep this API safe if it is called directly anyway.
  if (activeLoads.length === 0) {
    await applyDriverOperationalStatus({
      driverId,
      organizationId: requestContextOrganizationId || undefined,
      status: requestedStatus,
    });
    return res.status(201).json(
      new ApiResponse(
        201,
        {
          requestedStatus,
          priority,
          status: "completed",
          coordinatedOrganizationCount: 0,
          coordinatedActiveLoadCount: 0,
        },
        `Work Availability changed to ${statusLabel(requestedStatus)}`,
      ),
    );
  }

  const loadsByOrganization = new Map<string, any[]>();
  for (const load of activeLoads) {
    const organizationId = String(load.organizationId ?? "").trim();
    if (!organizationId) {
      throw new ApiError(
        409,
        `Load ${load.loadNumber || load._id} is missing organization ownership. Dispatch must correct the load before Work Availability can change safely.`,
      );
    }
    const current = loadsByOrganization.get(organizationId) ?? [];
    current.push(load);
    loadsByOrganization.set(organizationId, current);
  }

  const transitionGroupId = randomUUID();
  const files = ((req.files || []) as Express.Multer.File[]).slice(0, 5);
  const attachments = await uploadAttachments(
    files,
    `shared-${transitionGroupId}`,
    driverId,
  );
  const immediateSafetyRelease = priority === "emergency";
  const initialStatus = immediateSafetyRelease
    ? "approved_awaiting_reassignment"
    : "pending";
  const submittedAt = new Date();

  const docs = [...loadsByOrganization.entries()].map(
    ([organizationId, organizationLoads]) => ({
      organizationId,
      transitionGroupId,
      driverId: user._id,
      requestedStatus,
      priority,
      status: initialStatus,
      reason,
      message,
      effectiveAt: parseOptionalDate(req.body.effectiveAt),
      estimatedReturnAt: parseOptionalDate(req.body.estimatedReturnAt),
      affectedLoadIds: organizationLoads.map((load: any) => load._id),
      attachments,
      submittedAt,
    }),
  );

  const requests: any[] = await DriverStatusChangeRequest.create(docs);

  await Promise.all(
    requests.map(async (request: any) => {
      const organizationLoads = loadsByOrganization.get(request.organizationId) ?? [];
      await notifyDispatchers({
        organizationId: request.organizationId,
        driverId,
        driverName: user.name || "Driver",
        requestId: request._id.toString(),
        requestedStatus,
        priority,
        activeLoadCount: organizationLoads.length,
      });

      const payload = {
        requestId: request._id.toString(),
        transitionGroupId,
        driverId,
        requestedStatus,
        priority,
        status: request.status,
        coordinated: true,
        coordinatedOrganizationCount: requests.length,
      };
      emitToOrg(request.organizationId, "driver:status_request_updated", payload);
    }),
  );

  const driverPayload = {
    transitionGroupId,
    driverId,
    requestedStatus,
    priority,
    status: initialStatus,
    coordinated: true,
    coordinatedOrganizationCount: requests.length,
    coordinatedActiveLoadCount: activeLoads.length,
  };
  emitToUser(driverId, "driver:status_request_updated", driverPayload);

  const serialized = await serializeRequest(requests[0]);
  await addCoordinationSummary(serialized, requests[0], { aggregateStatus: true });
  serialized.coordinatedActiveLoadCount = activeLoads.length;

  return res.status(201).json(
    new ApiResponse(
      201,
      serialized,
      immediateSafetyRelease
        ? `Emergency request sent to ${requests.length} affected Dispatch team${requests.length === 1 ? "" : "s"}. New work is blocked immediately.`
        : requests.length > 1
          ? `Work Availability request sent to ${requests.length} affected Dispatch teams. New work is paused until the coordinated transition is resolved.`
          : "Work Availability request submitted",
    ),
  );
});

const updateRequestDetails = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const user = getUser(req);
    assertDriver(user);

    const request: any = await DriverStatusChangeRequest.findOne({
      _id: req.params.requestId,
      driverId: user._id,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    });
    if (!request) throw new ApiError(404, "Active Work Availability request not found");

    const siblings: any[] = request.transitionGroupId
      ? await DriverStatusChangeRequest.find({
          driverId: user._id,
          transitionGroupId: request.transitionGroupId,
          status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
        })
      : [request];

    let nextReason: any = undefined;
    if (req.body.reason) {
      const reason = String(req.body.reason);
      if (!DRIVER_STATUS_REQUEST_REASONS.includes(reason as any)) {
        throw new ApiError(400, "Invalid status request reason");
      }
      nextReason = reason;
    }
    const nextMessage =
      req.body.message !== undefined
        ? String(req.body.message).trim().slice(0, 1500)
        : undefined;
    const nextEffectiveAt =
      req.body.effectiveAt !== undefined
        ? parseOptionalDate(req.body.effectiveAt)
        : undefined;
    const nextEstimatedReturnAt =
      req.body.estimatedReturnAt !== undefined
        ? parseOptionalDate(req.body.estimatedReturnAt)
        : undefined;

    const files = ((req.files || []) as Express.Multer.File[]).slice(0, 5);
    const currentAttachmentCount = request.attachments?.length ?? 0;
    const remainingSlots = Math.max(0, 5 - currentAttachmentCount);
    if (files.length && remainingSlots === 0) {
      throw new ApiError(400, "A Work Availability request can have up to 5 attachments");
    }

    const newAttachments = files.length
      ? await uploadAttachments(
          files.slice(0, remainingSlots),
          request.transitionGroupId
            ? `shared-${request.transitionGroupId}`
            : request.organizationId,
          user._id.toString(),
        )
      : [];

    for (const sibling of siblings) {
      if (nextReason !== undefined) sibling.reason = nextReason;
      if (nextMessage !== undefined) sibling.message = nextMessage;
      if (req.body.effectiveAt !== undefined) sibling.effectiveAt = nextEffectiveAt;
      if (req.body.estimatedReturnAt !== undefined) {
        sibling.estimatedReturnAt = nextEstimatedReturnAt;
      }
      if (newAttachments.length) {
        sibling.attachments.push(...(newAttachments as any));
      }
      await sibling.save();

      emitToOrg(sibling.organizationId, "driver:status_request_updated", {
        requestId: sibling._id.toString(),
        transitionGroupId: sibling.transitionGroupId ?? null,
        driverId: user._id.toString(),
        status: sibling.status,
        detailsUpdated: true,
        coordinated: Boolean(sibling.transitionGroupId),
      });
    }

    emitToUser(user._id.toString(), "driver:status_request_updated", {
      requestId: request._id.toString(),
      transitionGroupId: request.transitionGroupId ?? null,
      driverId: user._id.toString(),
      status: coordinatedStatus(siblings),
      detailsUpdated: true,
      coordinated: Boolean(request.transitionGroupId),
    });

    const serialized = await serializeRequest(siblings[0]);
    await addCoordinationSummary(serialized, siblings[0], { aggregateStatus: true });

    return res.status(200).json(
      new ApiResponse(200, serialized, "Work Availability request details updated"),
    );
  },
);

const cancelRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  assertDriver(user);

  const request: any = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    driverId: user._id,
  });
  if (!request) throw new ApiError(404, "Work Availability request not found");

  const siblings: any[] = request.transitionGroupId
    ? await DriverStatusChangeRequest.find({
        driverId: user._id,
        transitionGroupId: request.transitionGroupId,
      })
    : [request];

  if (
    siblings.some(
      (row) => row.priority !== "standard" || row.status !== "pending",
    )
  ) {
    throw new ApiError(
      409,
      "A coordinated Work Availability request can be cancelled only while every affected Dispatch team is still pending review. Contact Dispatch after any team has acted.",
    );
  }

  const cancelledAt = new Date();
  for (const sibling of siblings) {
    sibling.status = "cancelled";
    sibling.cancelledAt = cancelledAt;
    await sibling.save();
    emitToOrg(sibling.organizationId, "driver:status_request_updated", {
      requestId: sibling._id.toString(),
      transitionGroupId: sibling.transitionGroupId ?? null,
      driverId: user._id.toString(),
      status: "cancelled",
      coordinated: Boolean(sibling.transitionGroupId),
    });
  }

  emitToUser(user._id.toString(), "driver:status_request_updated", {
    requestId: request._id.toString(),
    transitionGroupId: request.transitionGroupId ?? null,
    driverId: user._id.toString(),
    status: "cancelled",
    coordinated: Boolean(request.transitionGroupId),
  });

  const serialized = await serializeRequest(siblings[0]);
  await addCoordinationSummary(serialized, siblings[0], { aggregateStatus: true });

  return res.status(200).json(
    new ApiResponse(200, serialized, "Work Availability request cancelled"),
  );
});

const approveRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  assertStaff(user);
  const organizationId = req.orgId as string;

  const request: any = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
  });
  if (!request) throw new ApiError(404, "Work Availability request not found");
  if (request.priority === "emergency") {
    throw new ApiError(
      409,
      "Emergency requests are active immediately and do not require normal approval. Clear or reassign this organization's active loads.",
    );
  }
  if (request.status !== "pending") {
    throw new ApiError(409, `This request is already ${request.status.replace(/_/g, " ")}`);
  }

  const activeLoads: any[] = await Load.find({
    organizationId,
    assignedDriverId: request.driverId,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  })
    .select("_id loadNumber status")
    .lean();
  const activeLoadCount = activeLoads.length;

  const rawLoadHandling = String(req.body?.loadHandling || "reassign");
  if (!DRIVER_STATUS_LOAD_HANDLING_OPTIONS.includes(rawLoadHandling as any)) {
    throw new ApiError(400, "Choose a valid load handling option");
  }
  const loadHandling = rawLoadHandling as DriverStatusLoadHandlingDecision;
  const retainedGpsRequired =
    loadHandling === "keep_assigned"
      ? req.body?.retainedGpsRequired !== false
      : false;

  request.reviewedBy = user._id as any;
  request.reviewedAt = new Date();
  request.affectedLoadIds = activeLoads.map((load: any) => load._id) as any;
  request.loadHandlingDecision = loadHandling as any;
  request.retainedGpsRequired = retainedGpsRequired;
  request.loadHandlingResolvedAt = new Date();

  const coordinated = Boolean(request.transitionGroupId);

  if (activeLoadCount === 0) {
    request.status = "completed";
    request.completedAt = new Date();
    await request.save();
  } else if (loadHandling === "keep_assigned") {
    // This organization explicitly accepts keeping its own loads with the
    // driver. The global Work Availability status still waits for all sibling
    // organizations to resolve their parts.
    request.status = "completed";
    request.completedAt = new Date();
    await request.save();
  } else if (loadHandling === "return_available") {
    const loadIds = activeLoads.map((load: any) => load._id);
    await Load.updateMany(
      {
        _id: { $in: loadIds },
        organizationId,
        assignedDriverId: request.driverId,
        status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
      },
      {
        $set: { status: "Posted" },
        $unset: {
          assignedDriverId: "",
          dispatchOwnerId: "",
          assignedAt: "",
        },
      },
    );

    for (const load of activeLoads) {
      emitToOrg(organizationId, "load:change", {
        action: "updated",
        loadId: String(load._id),
      });
      emitToUser(request.driverId.toString(), "driver:loads_updated", {
        loadId: String(load._id),
      });
    }

    request.status = "completed";
    request.completedAt = new Date();
    await request.save();
  } else {
    request.status = "approved_awaiting_reassignment";
    await request.save();
  }

  if (coordinated) {
    await finalizeDriverStatusTransitionGroup({
      driverId: request.driverId.toString(),
      transitionGroupId: request.transitionGroupId,
      fallbackOrganizationId: organizationId,
    });
  } else {
    // Preserve the legacy single-org behavior for older request rows.
    if (
      request.status === "completed" &&
      (activeLoadCount === 0 ||
        loadHandling === "keep_assigned" ||
        loadHandling === "return_available")
    ) {
      await applyDriverOperationalStatus({
        driverId: request.driverId.toString(),
        organizationId,
        status: request.requestedStatus,
      });
    }
  }

  const localDecision =
    activeLoadCount === 0
      ? "This Dispatch team had no remaining active loads."
      : loadHandling === "keep_assigned"
        ? `This Dispatch team kept ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} assigned${retainedGpsRequired ? " with GPS required" : " with optional GPS"}.`
        : loadHandling === "return_available"
          ? `This Dispatch team returned ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} to Available.`
          : `This Dispatch team approved the request and will reassign ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}.`;

  const decisionMessage = coordinated
    ? `${localDecision} Your global Work Availability will update after every affected Dispatch team resolves its own loads.`
    : activeLoadCount === 0
      ? `Your request was approved. Your Work Availability is now ${statusLabel(request.requestedStatus)}.`
      : loadHandling === "keep_assigned"
        ? `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch kept your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} assigned to you.`
        : loadHandling === "return_available"
          ? `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch returned your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} to Available.`
          : `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch will reassign your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}; your requested status will take effect automatically after those loads are moved.`;

  await notificationService.createNotification({
    userId: request.driverId.toString(),
    organizationId,
    type: "driver_status_request_approved",
    title: coordinated ? "Dispatch Team Review Completed" : "Work Availability Approved",
    message: decisionMessage,
    metadata: {
      statusRequestId: request._id.toString(),
      transitionGroupId: request.transitionGroupId ?? null,
      requestedStatus: request.requestedStatus,
      status: request.status,
      loadHandlingDecision: request.loadHandlingDecision,
      retainedGpsRequired:
        request.loadHandlingDecision === "keep_assigned"
          ? Boolean(request.retainedGpsRequired)
          : null,
      activeLoadCount,
      coordinated,
      route: "/driver",
      pushSource: "Driver Tracker",
    },
  });

  await publishStatusDecisionToPrivateDispatchChat({
    organizationId,
    dispatcher: user,
    request,
    decision: "approved",
    activeLoads,
  });

  const payload = {
    requestId: request._id.toString(),
    transitionGroupId: request.transitionGroupId ?? null,
    driverId: request.driverId.toString(),
    requestedStatus: request.requestedStatus,
    status: request.status,
    loadHandlingDecision: request.loadHandlingDecision,
    retainedGpsRequired:
      request.loadHandlingDecision === "keep_assigned"
        ? Boolean(request.retainedGpsRequired)
        : null,
    coordinated,
  };
  emitToUser(request.driverId.toString(), "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  const serialized = await serializeRequest(request);
  await addCoordinationSummary(serialized, request);

  return res.status(200).json(
    new ApiResponse(
      200,
      serialized,
      coordinated
        ? "This Dispatch team completed its part of the coordinated Work Availability request"
        : request.status === "completed"
          ? "Request approved and Work Availability updated"
          : "Request approved — awaiting load reassignment",
    ),
  );
});

const rejectRequest = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  assertStaff(user);
  const organizationId = req.orgId as string;
  const reason = String(req.body.reason || "").trim();

  if (reason.length < 3) {
    throw new ApiError(400, "A rejection reason is required");
  }

  const request: any = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
  });
  if (!request) throw new ApiError(404, "Work Availability request not found");
  if (request.priority === "emergency") {
    throw new ApiError(
      409,
      "Emergency requests cannot be rejected from the normal review flow. Coordinate with the driver and clear this organization's active loads.",
    );
  }
  if (request.status !== "pending") {
    throw new ApiError(409, "Only pending requests can be rejected");
  }

  request.status = "rejected";
  request.reviewedBy = user._id as any;
  request.reviewedAt = new Date();
  request.decisionReason = reason.slice(0, 1000);
  await request.save();

  // One affected organization declining a coordinated standard transition
  // prevents the global driver status from changing. Cancel only still-open
  // sibling rows; completed load moves are never silently reversed.
  if (request.transitionGroupId) {
    const openSiblings: any[] = await DriverStatusChangeRequest.find({
      driverId: request.driverId,
      transitionGroupId: request.transitionGroupId,
      _id: { $ne: request._id },
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    });
    for (const sibling of openSiblings) {
      sibling.status = "cancelled";
      sibling.cancelledAt = new Date();
      await sibling.save();
      emitToOrg(sibling.organizationId, "driver:status_request_updated", {
        requestId: sibling._id.toString(),
        transitionGroupId: request.transitionGroupId,
        driverId: request.driverId.toString(),
        status: "cancelled",
        coordinated: true,
      });
    }
  }

  await notificationService.createNotification({
    userId: request.driverId.toString(),
    organizationId,
    type: "driver_status_request_rejected",
    title: "Work Availability Request Not Approved",
    message: request.transitionGroupId
      ? `One affected Dispatch team did not approve your ${statusLabel(request.requestedStatus)} request. Your global Work Availability remains Active. Reason: ${request.decisionReason}`
      : `Dispatch did not approve your ${statusLabel(request.requestedStatus)} request. Reason: ${request.decisionReason}`,
    metadata: {
      statusRequestId: request._id.toString(),
      transitionGroupId: request.transitionGroupId ?? null,
      requestedStatus: request.requestedStatus,
      decisionReason: request.decisionReason,
      coordinated: Boolean(request.transitionGroupId),
      route: "/driver",
      pushSource: "Driver Tracker",
    },
  });

  await publishStatusDecisionToPrivateDispatchChat({
    organizationId,
    dispatcher: user,
    request,
    decision: "rejected",
    decisionReason: request.decisionReason,
  });

  const payload = {
    requestId: request._id.toString(),
    transitionGroupId: request.transitionGroupId ?? null,
    driverId: request.driverId.toString(),
    requestedStatus: request.requestedStatus,
    status: request.status,
    coordinated: Boolean(request.transitionGroupId),
  };
  emitToUser(request.driverId.toString(), "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  const serialized = await serializeRequest(request);
  await addCoordinationSummary(serialized, request);

  return res.status(200).json(
    new ApiResponse(200, serialized, "Work Availability request rejected"),
  );
});

export default {
  getMyCurrentRequest,
  getOrganizationRequests,
  getRequestById,
  createRequest,
  updateRequestDetails,
  cancelRequest,
  approveRequest,
  rejectRequest,
};