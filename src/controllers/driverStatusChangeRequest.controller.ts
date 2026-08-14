import { Request, Response } from "express";
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
  getDriverStatusContext,
  OPEN_DRIVER_STATUS_REQUEST_STATES,
} from "../services/driverStatusTransition.service";
import { emitToOrg, emitToUser } from "../utils/socketEmitter";
import logger from "../utils/logger";

const STAFF_ROLES = ["employee", "admin", "super_admin"];

const getUser = (req: Request) => req.user as IUser;

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

    const title =
      decision === "approved"
        ? awaitingReassignment
          ? `${requestedStatusLabel} Request Approved — Reassignment Required`
          : keptAssigned
            ? `${requestedStatusLabel} Request Approved — Loads Kept Assigned`
            : returnedAvailable
              ? `${requestedStatusLabel} Request Approved — Loads Returned to Available`
              : `${requestedStatusLabel} Request Approved`
        : `${requestedStatusLabel} Request Not Approved`;

    const message =
      decision === "approved"
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
          ...attachment,
          id: String(attachment._id ?? ""),
          // Never expose a raw private R2 key if signing fails. Local-dev
          // fallback paths are intentionally returned as-is.
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
  async (req: Request, res: Response) => {
    const user = getUser(req);
    assertDriver(user);
    const organizationId = req.orgId as string;

    await finalizeDriverStatusChangeIfClear(
      user._id.toString(),
      organizationId,
    );

    const request = await DriverStatusChangeRequest.findOne({
      organizationId,
      driverId: user._id,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    }).sort({ createdAt: -1 });

    return res.status(200).json(
      new ApiResponse(
        200,
        request ? await serializeRequest(request) : null,
        "Current driver status request fetched",
      ),
    );
  },
);

const getOrganizationRequests = asyncHandler(
  async (req: Request, res: Response) => {
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

const getRequestById = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  const organizationId = req.orgId as string;

  const request = await DriverStatusChangeRequest.findOne({
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

  return res.status(200).json(
    new ApiResponse(
      200,
      serialized,
      "Driver status request fetched",
    ),
  );
});

const createRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  assertDriver(user);
  const organizationId = req.orgId as string;
  const driverId = user._id.toString();

  const requestedStatus = req.body
    .requestedStatus as RequestedDriverOperationalStatus;
  const priority = (req.body.priority || "standard") as
    | "standard"
    | "emergency";
  const reason = req.body.reason ? String(req.body.reason) : undefined;
  const message = req.body.message
    ? String(req.body.message).trim().slice(0, 1500)
    : undefined;

  if (!(["on_leave", "maintenance"] as string[]).includes(requestedStatus)) {
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

  const statusContext = await getDriverStatusContext(driverId, organizationId);
  if (statusContext.operationalStatus !== "active") {
    throw new ApiError(
      409,
      "Dispatch Status requests can only be submitted while you are Active. Return to Active before requesting On Leave or In Shop.",
    );
  }

  const existing = await DriverStatusChangeRequest.findOne({
    organizationId,
    driverId,
    status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
  });
  if (existing) {
    throw new ApiError(409, "You already have an active status change request");
  }

  const activeLoads = await Load.find({
    organizationId,
    assignedDriverId: user._id,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  })
    .select("_id loadNumber status")
    .lean();

  const files = ((req.files || []) as Express.Multer.File[]).slice(0, 5);
  const attachments = await uploadAttachments(
    files,
    organizationId,
    driverId,
  );

  const hasActiveLoads = activeLoads.length > 0;
  const immediateSafetyRelease = priority === "emergency";
  const initialStatus = !hasActiveLoads
    ? "completed"
    : immediateSafetyRelease
      ? "approved_awaiting_reassignment"
      : "pending";

  const request = await DriverStatusChangeRequest.create({
    organizationId,
    driverId: user._id,
    requestedStatus,
    priority,
    status: initialStatus,
    reason,
    message,
    effectiveAt: parseOptionalDate(req.body.effectiveAt),
    estimatedReturnAt: parseOptionalDate(req.body.estimatedReturnAt),
    affectedLoadIds: activeLoads.map((load: any) => load._id),
    attachments,
    submittedAt: new Date(),
    ...(initialStatus === "completed" ? { completedAt: new Date() } : {}),
  });

  if (!hasActiveLoads) {
    await applyDriverOperationalStatus({
      driverId,
      organizationId,
      status: requestedStatus,
    });
  }

  await notifyDispatchers({
    organizationId,
    driverId,
    driverName: user.name || "Driver",
    requestId: request._id.toString(),
    requestedStatus,
    priority,
    activeLoadCount: activeLoads.length,
  });

  const payload = {
    requestId: request._id.toString(),
    driverId,
    requestedStatus,
    priority,
    status: request.status,
  };
  emitToUser(driverId, "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  return res.status(201).json(
    new ApiResponse(
      201,
      await serializeRequest(request),
      immediateSafetyRelease && hasActiveLoads
        ? "Emergency request sent. Dispatch has been notified and new work is blocked immediately."
        : request.status === "completed"
          ? `Dispatch Status changed to ${statusLabel(requestedStatus)}`
          : "Status change request submitted",
    ),
  );
});

const updateRequestDetails = asyncHandler(
  async (req: Request, res: Response) => {
    const user = getUser(req);
    assertDriver(user);
    const organizationId = req.orgId as string;

    const request = await DriverStatusChangeRequest.findOne({
      _id: req.params.requestId,
      organizationId,
      driverId: user._id,
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    });
    if (!request) throw new ApiError(404, "Active status request not found");

    if (req.body.reason) {
      const reason = String(req.body.reason);
      if (!DRIVER_STATUS_REQUEST_REASONS.includes(reason as any)) {
        throw new ApiError(400, "Invalid status request reason");
      }
      request.reason = reason as any;
    }
    if (req.body.message !== undefined) {
      request.message = String(req.body.message).trim().slice(0, 1500);
    }
    if (req.body.effectiveAt !== undefined) {
      request.effectiveAt = parseOptionalDate(req.body.effectiveAt);
    }
    if (req.body.estimatedReturnAt !== undefined) {
      request.estimatedReturnAt = parseOptionalDate(req.body.estimatedReturnAt);
    }

    const files = ((req.files || []) as Express.Multer.File[]).slice(0, 5);
    if (files.length) {
      const remainingSlots = Math.max(0, 5 - request.attachments.length);
      if (remainingSlots === 0) {
        throw new ApiError(400, "A status request can have up to 5 attachments");
      }
      const attachments = await uploadAttachments(
        files.slice(0, remainingSlots),
        organizationId,
        user._id.toString(),
      );
      request.attachments.push(...(attachments as any));
    }

    await request.save();

    const payload = {
      requestId: request._id.toString(),
      driverId: user._id.toString(),
      status: request.status,
      detailsUpdated: true,
    };
    emitToUser(user._id.toString(), "driver:status_request_updated", payload);
    emitToOrg(organizationId, "driver:status_request_updated", payload);

    return res.status(200).json(
      new ApiResponse(
        200,
        await serializeRequest(request),
        "Status request details updated",
      ),
    );
  },
);

const cancelRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  assertDriver(user);
  const organizationId = req.orgId as string;

  const request = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
    driverId: user._id,
    status: "pending",
    priority: "standard",
  });

  if (!request) {
    throw new ApiError(
      409,
      "Only a pending standard status request can be cancelled directly. Contact Dispatch for an active emergency or approved transition.",
    );
  }

  request.status = "cancelled";
  request.cancelledAt = new Date();
  await request.save();

  const payload = {
    requestId: request._id.toString(),
    driverId: user._id.toString(),
    status: request.status,
  };
  emitToUser(user._id.toString(), "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  return res
    .status(200)
    .json(new ApiResponse(200, request, "Status request cancelled"));
});

const approveRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  assertStaff(user);
  const organizationId = req.orgId as string;

  const request = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
  });
  if (!request) throw new ApiError(404, "Status change request not found");
  if (request.priority === "emergency") {
    throw new ApiError(
      409,
      "Emergency release requests are active immediately and do not require approval. Clear or reassign the driver's active loads.",
    );
  }
  if (request.status !== "pending") {
    throw new ApiError(409, `This request is already ${request.status.replace(/_/g, " ")}`);
  }

  const activeLoads = await Load.find({
    organizationId,
    assignedDriverId: request.driverId,
    status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
  })
    .select("_id loadNumber status")
    .lean();
  const activeLoadCount = activeLoads.length;

  // Backward compatibility: older clients that do not send a load-handling
  // choice keep the previous behavior (approve, then await reassignment).
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

  // Persist the policy before applying the operational status. The GPS context
  // may refresh immediately from the operational-status socket event, so the
  // retained-load policy must already be queryable at that point.
  request.status = "approved_awaiting_reassignment";
  await request.save();

  if (activeLoadCount === 0) {
    await applyDriverOperationalStatus({
      driverId: request.driverId.toString(),
      organizationId,
      status: request.requestedStatus,
    });
    request.status = "completed";
    request.completedAt = new Date();
    await request.save();
  } else if (loadHandling === "keep_assigned") {
    // Keep the exact assignments intact and make the requested status effective
    // immediately. Work eligibility is then blocked by On Leave / In Shop.
    await applyDriverOperationalStatus({
      driverId: request.driverId.toString(),
      organizationId,
      status: request.requestedStatus,
    });
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

    for (const load of activeLoads as any[]) {
      emitToOrg(organizationId, "load:change", {
        action: "updated",
        loadId: String(load._id),
      });
      emitToUser(request.driverId.toString(), "driver:loads_updated", {
        loadId: String(load._id),
      });
    }

    await applyDriverOperationalStatus({
      driverId: request.driverId.toString(),
      organizationId,
      status: request.requestedStatus,
    });
    request.status = "completed";
    request.completedAt = new Date();
    await request.save();
  }
  // "reassign" intentionally preserves the existing proven workflow:
  // request remains approved_awaiting_reassignment and the current per-load
  // reassignment controls move loads safely. The finalizer applies the status
  // automatically once no active loads remain with this driver.

  const decisionMessage =
    activeLoadCount === 0
      ? `Your request was approved. Your Dispatch Status is now ${statusLabel(request.requestedStatus)}.`
      : loadHandling === "keep_assigned"
        ? `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch kept your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} assigned to you. ${retainedGpsRequired ? "GPS is required while those retained loads remain active." : "GPS remains optional while you are in this Dispatch Status."}`
        : loadHandling === "return_available"
          ? `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch returned your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"} to Available.`
          : `Your request for ${statusLabel(request.requestedStatus)} was approved. Dispatch will reassign your ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}; your requested status will take effect automatically after those loads are moved.`;

  await notificationService.createNotification({
    userId: request.driverId.toString(),
    organizationId,
    type: "driver_status_request_approved",
    title: "Status Change Approved",
    message: decisionMessage,
    metadata: {
      statusRequestId: request._id.toString(),
      requestedStatus: request.requestedStatus,
      status: request.status,
      loadHandlingDecision: request.loadHandlingDecision,
      retainedGpsRequired:
        request.loadHandlingDecision === "keep_assigned"
          ? Boolean(request.retainedGpsRequired)
          : null,
      activeLoadCount,
      route: "/driver",
      pushSource: "Driver Tracker",
    },
  });

  await publishStatusDecisionToPrivateDispatchChat({
    organizationId,
    dispatcher: user,
    request,
    decision: "approved",
    activeLoads: activeLoads as any[],
  });

  const payload = {
    requestId: request._id.toString(),
    driverId: request.driverId.toString(),
    requestedStatus: request.requestedStatus,
    status: request.status,
    loadHandlingDecision: request.loadHandlingDecision,
    retainedGpsRequired:
      request.loadHandlingDecision === "keep_assigned"
        ? Boolean(request.retainedGpsRequired)
        : null,
  };
  emitToUser(request.driverId.toString(), "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  const responseMessage =
    activeLoadCount === 0
      ? "Request approved and status updated"
      : loadHandling === "keep_assigned"
        ? `Request approved — loads kept assigned${retainedGpsRequired ? " with GPS required" : " with optional GPS"}`
        : loadHandling === "return_available"
          ? "Request approved — loads returned to Available"
          : "Request approved — awaiting load reassignment";

  return res.status(200).json(
    new ApiResponse(
      200,
      await serializeRequest(request),
      responseMessage,
    ),
  );
});

const rejectRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  assertStaff(user);
  const organizationId = req.orgId as string;
  const reason = String(req.body.reason || "").trim();

  if (reason.length < 3) {
    throw new ApiError(400, "A rejection reason is required");
  }

  const request = await DriverStatusChangeRequest.findOne({
    _id: req.params.requestId,
    organizationId,
  });
  if (!request) throw new ApiError(404, "Status change request not found");
  if (request.priority === "emergency") {
    throw new ApiError(
      409,
      "Emergency release requests cannot be rejected from the normal review flow. Coordinate with the driver and clear their active loads.",
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

  await notificationService.createNotification({
    userId: request.driverId.toString(),
    organizationId,
    type: "driver_status_request_rejected",
    title: "Status Change Request Not Approved",
    message: `Dispatch did not approve your ${statusLabel(request.requestedStatus)} request. Reason: ${request.decisionReason}`,
    metadata: {
      statusRequestId: request._id.toString(),
      requestedStatus: request.requestedStatus,
      decisionReason: request.decisionReason,
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
    driverId: request.driverId.toString(),
    requestedStatus: request.requestedStatus,
    status: request.status,
  };
  emitToUser(request.driverId.toString(), "driver:status_request_updated", payload);
  emitToOrg(organizationId, "driver:status_request_updated", payload);

  return res.status(200).json(
    new ApiResponse(
      200,
      await serializeRequest(request),
      "Status request rejected",
    ),
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