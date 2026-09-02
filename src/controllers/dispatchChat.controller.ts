import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import User, { IUser } from "../models/User.model";
import Load from "../models/Load.model";
import Notification from "../models/Notification.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
import DispatchChatThread from "../models/DispatchChatThread.model";
import { storageService, BucketType } from "../services/storage.service";
import {
  emitToDispatchChatThreadParticipants,
  ensureDispatchChatThread,
  touchDispatchChatThread,
} from "../services/dispatchChat.service";
import logger from "../utils/logger";

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ACTIVE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"];

const EXPLICIT_THREAD_SCOPED_NOTIFICATION_TYPES = [
  "driver_tracker_geofence_alert",
  "driver_tracker_place_visit",
  "proof_submitted",
  "delivery_confirmed",
] as const;

const TIMELINE_NOTIFICATION_TYPES = [
  "driver_dispatch_alert",
  "driver_tracker_offline_alert",
  ...EXPLICIT_THREAD_SCOPED_NOTIFICATION_TYPES,
];

// driver_assigned, driver_request_approved and driver_request_rejected are
// intentionally absent. Their Dispatch Chat copies are persisted as exact
// private-thread DispatchChatMessage system events by the load controller.

const getUser = (req: ExpressRequest) => req.user as IUser;

function dispatchChatUnreadPredicate(
  actorId: mongoose.Types.ObjectId | string,
) {
  const actorIdString = String(actorId);
  return {
    readBy: { $ne: actorId },
    $or: [
      { senderId: { $ne: actorId } },
      {
        messageType: "system",
        "systemEvent.metadata.unreadForParticipantIds": actorIdString,
      },
    ],
  };
}

type AuthorizedChat = {
  actor: IUser;
  organizationId: string;
  driver: {
    _id: mongoose.Types.ObjectId;
    name?: string;
    email?: string;
    avatar?: string;
  };
};

type ResolvedPrivateThread = AuthorizedChat & {
  thread: any;
  dispatcher: {
    _id: mongoose.Types.ObjectId;
    name?: string;
    email?: string;
    avatar?: string;
    isActive?: boolean;
  };
};

type PopulatedDispatchChatUser = {
  _id?: mongoose.Types.ObjectId;
  organizationId?: string | mongoose.Types.ObjectId;
  role?: string;
  isActive?: boolean;
  name?: string;
  email?: string;
  avatar?: string;
};

function isActiveDriverReference(
  user: PopulatedDispatchChatUser | null | undefined,
): boolean {
  return Boolean(
    user?._id &&
      String(user.role ?? "") === "driver" &&
      user.isActive === true,
  );
}

function isValidDispatcherReferenceForThread(
  user: PopulatedDispatchChatUser | null | undefined,
  threadOrganizationId: string,
): boolean {
  if (
    !user?._id ||
    !STAFF_ROLES.includes(String(user.role ?? ""))
  ) {
    return false;
  }

  // A super-admin can legitimately own a thread while impersonating another
  // organization. Normal staff must belong to the organization that owns the
  // private thread.
  if (String(user.role) === "super_admin") {
    return true;
  }

  return (
    String(user.organizationId ?? "") === String(threadOrganizationId)
  );
}

function isVisibleDispatchChatThread(
  thread: any,
  actor: IUser,
  requestOrganizationId?: string,
): boolean {
  const driver = thread?.driverId as PopulatedDispatchChatUser | null;
  const dispatcher =
    thread?.dispatcherId as PopulatedDispatchChatUser | null;
  const threadOrganizationId = String(thread?.organizationId ?? "");

  if (
    !threadOrganizationId ||
    !isActiveDriverReference(driver) ||
    !isValidDispatcherReferenceForThread(
      dispatcher,
      threadOrganizationId,
    )
  ) {
    return false;
  }

  if (actor.role === "driver") {
    // Drivers can read only threads that explicitly name their own User id.
    // Their home organization does not have to equal the dispatcher's
    // organization because Driver Tracker intentionally uses a shared driver
    // pool across organizations.
    return String(driver?._id ?? "") === String(actor._id);
  }

  // Staff retain the existing strict privacy boundary: the thread must belong
  // to the staff member, and to the organization context they are currently
  // operating in.
  return (
    String(dispatcher?._id ?? "") === String(actor._id) &&
    Boolean(requestOrganizationId) &&
    threadOrganizationId === String(requestOrganizationId)
  );
}

async function authorizeDispatchChat(
  req: ExpressRequest,
  driverId: string,
): Promise<AuthorizedChat> {
  const actor = getUser(req);
  const requestOrganizationId = String(req.orgId ?? "");

  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "A valid driverId is required");
  }

  const actorRole = actor.role;
  const actorId = actor._id.toString();
  const actorIsDriver = actorRole === "driver";

  if (actorIsDriver) {
    if (actorId !== driverId) {
      throw new ApiError(
        403,
        "Drivers can only access their own Dispatch Chat",
      );
    }
  } else {
    if (!STAFF_ROLES.includes(String(actorRole))) {
      throw new ApiError(
        403,
        "Dispatch Chat is limited to drivers and dispatch staff",
      );
    }

    if (!requestOrganizationId) {
      throw new ApiError(403, "Organization access is required");
    }
  }

  // The Driver Tracker directory is intentionally a shared platform-wide
  // driver pool. Staff may therefore start a private thread with any active
  // Driver User. We still require the exact User id, active state and driver
  // role; only the driver.organizationId equality check is removed.
  const driver = await User.findOne({
    _id: driverId,
    role: "driver",
    isActive: true,
  })
    .select("_id name email avatar organizationId role isActive")
    .lean();

  if (!driver) {
    throw new ApiError(
      404,
      actorIsDriver
        ? "Driver account is unavailable for Suprah Dispatch Chat"
        : "Driver is no longer available for Suprah Dispatch Chat",
    );
  }

  return {
    actor,
    // For staff this is the organization that owns a newly-created thread.
    // For drivers, resolvePrivateThread replaces this value with the
    // organization stored on the exact selected private thread.
    organizationId: requestOrganizationId,
    driver: driver as AuthorizedChat["driver"],
  };
}

function getRequestedThreadId(req: ExpressRequest): string | null {
  const candidate =
    (typeof req.query.threadId === "string" ? req.query.threadId : null) ??
    (typeof req.body?.threadId === "string" ? req.body.threadId : null);

  const value = String(candidate ?? "").trim();
  if (!value) return null;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, "A valid Dispatch Chat threadId is required");
  }
  return value;
}

async function resolvePrivateThread(
  req: ExpressRequest,
  driverId: string,
  options: { createForDispatcher?: boolean; requireActiveDispatcher?: boolean } = {},
): Promise<ResolvedPrivateThread> {
  const authorized = await authorizeDispatchChat(req, driverId);
  const {
    actor,
    organizationId: requestOrganizationId,
    driver,
  } = authorized;
  const actorIsDriver = actor.role === "driver";
  const requestedThreadId = getRequestedThreadId(req);

  let thread: any = null;

  if (actorIsDriver) {
    if (!requestedThreadId) {
      throw new ApiError(
        400,
        "Select a dispatcher conversation before opening or sending messages",
      );
    }

    // Critical shared-pool rule:
    // The driver's HOME organization must not be used as the thread privacy
    // boundary. The exact thread id + exact driver membership is the boundary.
    thread = await DispatchChatThread.findOne({
      _id: requestedThreadId,
      driverId: actor._id,
    }).lean();

    if (!thread) {
      throw new ApiError(
        404,
        "Dispatch Chat conversation not found",
      );
    }
  } else if (requestedThreadId) {
    // Staff still cannot use another dispatcher's thread id, even when the
    // selected driver comes from the shared platform-wide driver pool.
    thread = await DispatchChatThread.findOne({
      _id: requestedThreadId,
      organizationId: requestOrganizationId,
      driverId: driver._id,
      dispatcherId: actor._id,
    }).lean();

    if (!thread) {
      throw new ApiError(
        403,
        "You do not have access to this Dispatch Chat conversation",
      );
    }
  } else if (options.createForDispatcher !== false) {
    thread = await ensureDispatchChatThread({
      organizationId: requestOrganizationId,
      dispatcherId: actor._id,
      driverId: driver._id,
    });
  } else {
    thread = await DispatchChatThread.findOne({
      organizationId: requestOrganizationId,
      dispatcherId: actor._id,
      driverId: driver._id,
    }).lean();

    if (!thread) {
      throw new ApiError(
        404,
        "Dispatch Chat conversation not found",
      );
    }
  }

  const conversationOrganizationId = String(
    thread.organizationId ?? "",
  );

  if (!conversationOrganizationId) {
    throw new ApiError(
      409,
      "Dispatch Chat conversation has invalid organization ownership",
    );
  }

  const dispatcherId = String(thread.dispatcherId);
  const dispatcher: any = await User.findOne({
    _id: dispatcherId,
    role: { $in: STAFF_ROLES },
  })
    .select(
      "_id name email avatar isActive role organizationId",
    )
    .lean();

  if (
    !dispatcher ||
    !isValidDispatcherReferenceForThread(
      dispatcher,
      conversationOrganizationId,
    )
  ) {
    throw new ApiError(
      404,
      "Dispatcher for this conversation is no longer available",
    );
  }

  if (
    options.requireActiveDispatcher &&
    dispatcher.isActive === false
  ) {
    throw new ApiError(
      409,
      "This dispatcher is no longer active",
    );
  }

  return {
    ...authorized,
    // All message/history/read operations use the organization stored on the
    // selected private thread. This lets a shared-pool driver participate in a
    // thread owned by another organization without exposing any other thread.
    organizationId: conversationOrganizationId,
    thread,
    dispatcher:
      dispatcher as ResolvedPrivateThread["dispatcher"],
  };
}

async function signAttachment(attachment: any) {
  const rawUrl = String(attachment?.url ?? "").trim();
  const explicitFileKey = String(attachment?.fileKey ?? "").trim();
  const originalName = attachment?.originalName || "Attachment";
  const mimeType =
    attachment?.mimeType || "application/octet-stream";
  const size = Number(attachment?.size || 0);

  let safeUrl = "";

  // Legacy records may contain an already-public/external URL and no private
  // fileKey. Keep those working. New Dispatch Chat attachments always persist
  // a private key because upload() uses BucketType.PRIVATE.
  if (/^https?:\/\//i.test(rawUrl) && !explicitFileKey) {
    safeUrl = rawUrl;
  } else {
    const privateKey = explicitFileKey || rawUrl;

    if (privateKey) {
      try {
        const signed = await storageService.getSignedUrl(
          privateKey,
          3600,
        );

        // getSignedUrl() should return either an expiring HTTPS URL or the
        // explicit local-development /uploads/ path. Never return an unsigned
        // private object key if signing returns null or an unexpected value.
        if (
          signed &&
          (
            /^https?:\/\//i.test(signed) ||
            signed.startsWith("/uploads/")
          )
        ) {
          safeUrl = signed;
        } else {
          logger.warn(
            { attachmentName: originalName },
            "[DispatchChat] Private attachment URL signing was unavailable",
          );
        }
      } catch (error) {
        logger.warn(
          {
            attachmentName: originalName,
            error:
              error instanceof Error
                ? error.message
                : "unknown signing error",
          },
          "[DispatchChat] Private attachment URL signing failed",
        );
      }
    }
  }

  return {
    // Empty string is deliberate: the persisted private key remains
    // server-side and cannot leak through history, socket or upload responses.
    url: safeUrl,
    available: Boolean(safeUrl),
    originalName,
    mimeType,
    size,
  };
}

async function resolveParticipantAvatar(
  raw: string | null | undefined,
): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) {
    return value;
  }

  try {
    const signed = await storageService.getSignedUrl(value, 7 * 24 * 60 * 60);
    return signed || value;
  } catch {
    // Some profiles use a public/relative path rather than a private storage
    // key. Return it unchanged and let resolveImageUrl() handle it client-side.
    return value;
  }
}

async function serializeMessage(message: any, viewer?: IUser) {
  const sender = message?.senderId;
  const attachments = await Promise.all(
    (Array.isArray(message?.attachments) ? message.attachments : []).map(
      signAttachment,
    ),
  );

  let serializedSender = {
    id: String(sender?._id ?? message.senderId),
    name: sender?.name ?? "User",
    email: sender?.email ?? "",
    role: sender?.role ?? message.senderRole,
  };
  let serializedSystemEvent = message.systemEvent ?? null;
  let serializedContent = message.content || "";

  const hidePerformerIdentityFromDriver = Boolean(
    viewer?.role === "driver" &&
      message?.messageType === "system" &&
      message?.systemEvent?.metadata?.hidePerformerIdentityFromDriver === true,
  );

  if (hidePerformerIdentityFromDriver) {
    const driverSafeMessage = String(
      message.systemEvent?.metadata?.audienceMessages?.driver ??
        message.systemEvent?.message ??
        message.content ??
        "Dispatch updated your load",
    );
    const safeMetadata = {
      ...(message.systemEvent?.metadata ?? {}),
    } as Record<string, any>;

    // A same-organization support member is authorized to perform the action,
    // but the affected driver has no direct relationship with that staff user.
    // Do not merely hide the name in React: remove the identity from the API
    // payload too so it is not recoverable through DevTools/network inspection.
    for (const key of [
      "actorId",
      "actorName",
      "performedByUserId",
      "performedByName",
      "sentByUserId",
      "sentByName",
      "newDriverId",
      "newDriverName",
    ]) {
      delete safeMetadata[key];
    }
    safeMetadata.audienceMessages = {
      driver: driverSafeMessage,
    };
    safeMetadata.privacyRedacted = true;

    serializedSender = {
      id: "organization-dispatch",
      name: "Another dispatcher",
      email: "",
      role: "dispatcher",
    };
    serializedSystemEvent = {
      ...(message.systemEvent ?? {}),
      message: driverSafeMessage,
      metadata: safeMetadata,
    };
    serializedContent = driverSafeMessage;
  }

  return {
    id: String(message._id),
    threadId: message.threadId ? String(message.threadId) : null,
    dispatcherId: message.dispatcherId ? String(message.dispatcherId) : null,
    driverId: String(message.driverId),
    sender: serializedSender,
    senderRole: message.senderRole,
    messageType: message.messageType || "message",
    systemEvent: serializedSystemEvent,
    content: serializedContent,
    attachments,
    readBy: Array.isArray(message.readBy)
      ? message.readBy.map((id: any) => String(id))
      : [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function serializeNotification(notification: any) {
  const isAlert =
    notification.type === "driver_dispatch_alert" ||
    String(notification.type).includes("alert") ||
    String(notification.type).includes("geofence") ||
    String(notification.type).includes("offline");

  const eventIdentity =
    notification.metadata?.incidentId ?? String(notification._id);

  return {
    id: `notification:${String(eventIdentity)}`,
    kind: isAlert ? "alert" : "notification",
    notificationType: notification.type,
    title: notification.title,
    message: notification.message,
    metadata: notification.metadata ?? {},
    createdAt: notification.createdAt,
  };
}

async function getThreadContext(
  organizationId: string,
  driver: AuthorizedChat["driver"],
  dispatcher: ResolvedPrivateThread["dispatcher"],
  thread: any,
) {
  const activeLoads = await Load.find({
    organizationId,
    assignedDriverId: driver._id,
    status: { $in: ACTIVE_LOAD_STATUSES },
  })
    .select("_id loadNumber status pickupLocation deliveryLocation dates vehicles")
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(5)
    .lean();

  const [resolvedDriverAvatar, resolvedDispatcherAvatar] = await Promise.all([
    resolveParticipantAvatar(driver.avatar),
    resolveParticipantAvatar(dispatcher.avatar),
  ]);

  return {
    threadId: String(thread._id),
    driver: {
      id: String(driver._id),
      name: driver.name || "Driver",
      email: driver.email || "",
      avatar: resolvedDriverAvatar,
    },
    dispatcher: {
      id: String(dispatcher._id),
      name: dispatcher.name || "Dispatcher",
      email: dispatcher.email || "",
      avatar: resolvedDispatcherAvatar,
    },
    loads: (activeLoads as any[]).map((load) => ({
      id: String(load._id),
      loadNumber: load.loadNumber || String(load._id),
      status: load.status,
      vehicleCount: Array.isArray(load.vehicles) ? load.vehicles.length : 0,
      origin: [load.pickupLocation?.city, load.pickupLocation?.state]
        .filter(Boolean)
        .join(", "),
      destination: [load.deliveryLocation?.city, load.deliveryLocation?.state]
        .filter(Boolean)
        .join(", "),
      pickupDate: load.dates?.firstAvailable ?? null,
    })),
  };
}

async function getSafeLegacyRows(params: {
  organizationId: string;
  driverId: mongoose.Types.ObjectId;
  dispatcherId: mongoose.Types.ObjectId;
  before?: Date | null;
  limit: number;
}) {
  const { organizationId, driverId, dispatcherId, before, limit } = params;
  const createdAt = before ? { $lt: before } : undefined;

  // Legacy shared-driver records have no threadId/dispatcherId. Only records
  // whose dispatcher ownership is explicit are safe to carry into the new
  // private timeline. Ordinary historical driver replies are intentionally not
  // guessed into a dispatcher thread.
  return DispatchChatMessage.find({
    organizationId,
    driverId,
    threadId: { $exists: false },
    ...(createdAt ? { createdAt } : {}),
    $or: [
      {
        senderRole: "dispatcher",
        senderId: dispatcherId,
      },
      {
        senderRole: "driver",
        messageType: "system",
        "systemEvent.metadata.sentByUserId": String(dispatcherId),
      },
    ],
  })
    .populate("senderId", "name email role")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

async function seedThreadActivityFromSafeLegacy(thread: any) {
  if (thread?.lastMessageAt) return thread;

  const [legacyMessage, legacyAlert] = await Promise.all([
    DispatchChatMessage.findOne({
      organizationId: thread.organizationId,
      driverId: thread.driverId,
      threadId: { $exists: false },
      senderRole: "dispatcher",
      senderId: thread.dispatcherId,
    })
      .sort({ createdAt: -1 })
      .lean(),
    Notification.findOne({
      organizationId: thread.organizationId,
      userId: thread.driverId,
      type: "driver_dispatch_alert",
      "metadata.sentByUserId": String(thread.dispatcherId),
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const legacyMessageAt = legacyMessage?.createdAt
    ? new Date(legacyMessage.createdAt)
    : null;
  const legacyAlertAt = legacyAlert?.createdAt
    ? new Date(legacyAlert.createdAt)
    : null;

  const latestIsMessage =
    legacyMessageAt && (!legacyAlertAt || legacyMessageAt >= legacyAlertAt);
  const latestAt = latestIsMessage ? legacyMessageAt : legacyAlertAt;

  if (!latestAt) return thread;

  const preview = latestIsMessage
    ? String(legacyMessage?.content || "Legacy Dispatch Chat message")
    : String(legacyAlert?.message || "Dispatch Alert");

  await DispatchChatThread.updateOne(
    { _id: thread._id, lastMessageAt: null },
    {
      $set: {
        lastMessageAt: latestAt,
        lastMessagePreview: preview.replace(/\s+/g, " ").slice(0, 280),
        lastMessageSenderId: latestIsMessage
          ? legacyMessage?.senderId
          : thread.dispatcherId,
        lastMessageType: latestIsMessage
          ? legacyMessage?.messageType || "message"
          : "system",
      },
    },
  );

  return DispatchChatThread.findById(thread._id).lean();
}

async function backfillSafeDriverThreads(
  organizationId: string,
  driverId: mongoose.Types.ObjectId,
) {
  const [legacyDispatcherIds, alertDispatcherIds] = await Promise.all([
    DispatchChatMessage.distinct("senderId", {
      organizationId,
      driverId,
      threadId: { $exists: false },
      senderRole: "dispatcher",
    }),
    Notification.distinct("metadata.sentByUserId", {
      organizationId,
      userId: driverId,
      type: "driver_dispatch_alert",
      "metadata.sentByUserId": { $exists: true, $ne: null },
    }),
  ]);

  const ids = new Set<string>([
    ...legacyDispatcherIds.map((id: any) => String(id)),
    ...alertDispatcherIds.map((id: any) => String(id)),
  ]);

  for (const dispatcherId of ids) {
    if (!mongoose.Types.ObjectId.isValid(dispatcherId)) continue;
    const dispatcher = await User.exists({
      _id: dispatcherId,
      organizationId,
      role: { $in: STAFF_ROLES },
    });
    if (!dispatcher) continue;

    const thread = await ensureDispatchChatThread({
      organizationId,
      dispatcherId,
      driverId,
    });
    await seedThreadActivityFromSafeLegacy(thread);
  }
}

// POST /api/driver-tracking/dispatch-chat/load/:loadId/open
// Driver-only entry point for the Load Board. The server derives the exact
// dispatcher from Load.createdBy instead of trusting a client-supplied staff id,
// so a driver cannot use this route to open arbitrary staff conversations.
// ensureDispatchChatThread reuses the same exact dispatcher↔driver thread when
// one already exists, preserving the previous Suprah Dispatch Chat history.
const openLoadCreatorThread = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const actor = getUser(req);
  const loadId = String(req.params.loadId ?? '').trim();
  if (actor.role !== 'driver') {
    throw new ApiError(403, 'Only drivers can open a load creator conversation');
  }
  if (!mongoose.Types.ObjectId.isValid(loadId)) {
    throw new ApiError(400, 'A valid loadId is required');
  }

  // This action is intentionally limited to loads that are still on the
  // driver's Available Loads board. If assignment state changes between the
  // card render and the click, do not open a stale load-board conversation.
  const load: any = await Load.findOne({
    _id: loadId,
    status: 'Posted',
    $or: [
      { assignedDriverId: null },
      { assignedDriverId: { $exists: false } },
    ],
  })
    .select('_id loadNumber createdBy organizationId')
    .lean();

  if (!load) {
    throw new ApiError(409, 'This load is no longer available on the Load Board');
  }

  const organizationId = String(load.organizationId ?? '').trim();
  if (!organizationId) {
    throw new ApiError(409, 'This load has invalid organization ownership');
  }

  const creatorId = String(load.createdBy ?? '').trim();
  if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
    throw new ApiError(
      409,
      'The creator of this load is unavailable for Suprah Dispatch Chat',
    );
  }

  const [dispatcher, driver] = await Promise.all([
    User.findOne({
      _id: creatorId,
      organizationId,
      role: { $in: STAFF_ROLES },
      isActive: true,
    })
      .select('_id name email avatar isActive role')
      .lean(),
    User.findOne({
      _id: actor._id,
      role: 'driver',
      isActive: true,
    })
      .select('_id name email avatar isActive role')
      .lean(),
  ]);

  if (!dispatcher) {
    throw new ApiError(
      409,
      'The creator of this load is no longer available for Suprah Dispatch Chat',
    );
  }
  if (!driver) {
    throw new ApiError(403, 'Driver account is unavailable for Suprah Dispatch Chat');
  }

  const ensuredThread = await ensureDispatchChatThread({
    organizationId,
    dispatcherId: dispatcher._id,
    driverId: driver._id,
  });
  const thread: any = await seedThreadActivityFromSafeLegacy(ensuredThread);

  const unreadCount = await DispatchChatMessage.countDocuments({
    organizationId,
    threadId: thread._id,
    ...dispatchChatUnreadPredicate(actor._id),
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        load: {
          id: String(load._id),
          loadNumber: load.loadNumber || String(load._id),
        },
        thread: {
          id: String(thread._id),
          dispatcher: {
            id: String(dispatcher._id),
            name: dispatcher.name || 'Dispatcher',
            email: dispatcher.email || '',
            avatar: await resolveParticipantAvatar(dispatcher.avatar),
            isActive: dispatcher.isActive !== false,
          },
          driver: {
            id: String(driver._id),
            name: driver.name || 'Driver',
            email: driver.email || '',
            avatar: await resolveParticipantAvatar(driver.avatar),
            isActive: driver.isActive !== false,
          },
          unreadCount,
          lastMessageAt: thread.lastMessageAt ?? null,
          lastMessagePreview: thread.lastMessagePreview || '',
          lastMessageType: thread.lastMessageType ?? null,
        },
      },
      'Load creator Dispatch Chat ready',
    ),
  );
});

// GET /api/driver-tracking/dispatch-chat/threads
const getThreads = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const actor = getUser(req);
  const requestOrganizationId = String(req.orgId ?? "");

  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0",
  );

  const actorIsDriver = actor.role === "driver";
  const actorIsStaff = STAFF_ROLES.includes(String(actor.role));

  if (!actorIsDriver && !actorIsStaff) {
    throw new ApiError(
      403,
      "Dispatch Chat is limited to drivers and dispatch staff",
    );
  }

  if (actorIsStaff && !requestOrganizationId) {
    throw new ApiError(403, "Organization access is required");
  }

  // Legacy private data can only be backfilled safely inside the driver's
  // current/home organization. New cross-organization private threads already
  // carry explicit threadId + dispatcherId ownership and need no backfill.
  if (actorIsDriver && requestOrganizationId) {
    await backfillSafeDriverThreads(
      requestOrganizationId,
      actor._id,
    );
  }

  const threadFilter = actorIsDriver
    ? {
        driverId: actor._id,
        lastMessageAt: { $ne: null },
      }
    : {
        organizationId: requestOrganizationId,
        dispatcherId: actor._id,
        lastMessageAt: { $ne: null },
      };

  const candidateThreads: any[] =
    await DispatchChatThread.find(threadFilter)
      .populate(
        "dispatcherId",
        "_id name email avatar isActive role organizationId",
      )
      .populate(
        "driverId",
        "_id name email avatar isActive role organizationId",
      )
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .lean();

  const threads = candidateThreads.filter(
    (thread: any) => {
      const visible = isVisibleDispatchChatThread(
        thread,
        actor,
        requestOrganizationId || undefined,
      );

      if (!visible) {
        logger.warn(
          {
            threadId: String(thread?._id ?? ""),
            driverId: String(
              thread?.driverId?._id ??
                thread?.driverId ??
                "",
            ),
            dispatcherId: String(
              thread?.dispatcherId?._id ??
                thread?.dispatcherId ??
                "",
            ),
            threadOrganizationId: String(
              thread?.organizationId ?? "",
            ),
            requestOrganizationId,
          },
          "Skipping stale Dispatch Chat thread with invalid current membership",
        );
      }

      return visible;
    },
  );

  const threadPairs = threads.map((thread: any) => ({
    organizationId: String(thread.organizationId),
    threadId: thread._id,
  }));

  const unreadRows = threadPairs.length
    ? await DispatchChatMessage.aggregate([
        {
          $match: {
      $and: [
        { $or: threadPairs },
        dispatchChatUnreadPredicate(actor._id),
      ],
    },
        },
        {
          $group: {
            _id: "$threadId",
            unreadCount: { $sum: 1 },
          },
        },
      ])
    : [];

  const unreadByThread = new Map(
    unreadRows.map((row: any) => [
      String(row._id),
      Number(row.unreadCount || 0),
    ]),
  );

  const data = await Promise.all(
    threads.map(async (thread: any) => {
      const dispatcher: any = thread.dispatcherId;
      const driver: any = thread.driverId;

      return {
        id: String(thread._id),
        dispatcher: {
          id: String(dispatcher?._id ?? ""),
          name: dispatcher?.name || "Dispatcher",
          email: dispatcher?.email || "",
          avatar: await resolveParticipantAvatar(
            dispatcher?.avatar,
          ),
          isActive: dispatcher?.isActive !== false,
        },
        driver: {
          id: String(driver?._id ?? ""),
          name: driver?.name || "Driver",
          email: driver?.email || "",
          avatar: await resolveParticipantAvatar(
            driver?.avatar,
          ),
          isActive: driver?.isActive === true,
        },
        unreadCount:
          unreadByThread.get(String(thread._id)) ?? 0,
        lastMessageAt: thread.lastMessageAt ?? null,
        lastMessagePreview:
          thread.lastMessagePreview || "",
        lastMessageType: thread.lastMessageType ?? null,
      };
    }),
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      { threads: data },
      "Dispatch Chat conversations fetched",
    ),
  );
});

// GET /api/driver-tracking/dispatch-chat/unread-total
const getUnreadTotal = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const actor = getUser(req);
  const requestOrganizationId = String(req.orgId ?? "");

  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0",
  );

  const actorIsDriver = actor.role === "driver";
  const actorIsStaff = STAFF_ROLES.includes(String(actor.role));

  if (!actorIsDriver && !actorIsStaff) {
    throw new ApiError(
      403,
      "Dispatch Chat is limited to drivers and dispatch staff",
    );
  }

  if (actorIsStaff && !requestOrganizationId) {
    throw new ApiError(403, "Organization access is required");
  }

  const threadFilter = actorIsDriver
    ? { driverId: actor._id }
    : {
        organizationId: requestOrganizationId,
        dispatcherId: actor._id,
      };

  const candidateThreads: any[] =
    await DispatchChatThread.find(threadFilter)
      .populate(
        "dispatcherId",
        "_id isActive role organizationId",
      )
      .populate(
        "driverId",
        "_id isActive role organizationId",
      )
      .lean();

  const visibleThreads = candidateThreads.filter(
    (thread: any) =>
      isVisibleDispatchChatThread(
        thread,
        actor,
        requestOrganizationId || undefined,
      ),
  );

  if (visibleThreads.length === 0) {
    return res.status(200).json(
      new ApiResponse(
        200,
        { unreadTotal: 0 },
        "Dispatch Chat unread total fetched",
      ),
    );
  }

  const threadPairs = visibleThreads.map(
    (thread: any) => ({
      organizationId: String(thread.organizationId),
      threadId: thread._id,
    }),
  );

  const unreadTotal =
    await DispatchChatMessage.countDocuments({
      $and: [
        { $or: threadPairs },
        dispatchChatUnreadPredicate(actor._id),
      ],
    });

  return res.status(200).json(
    new ApiResponse(
      200,
      { unreadTotal },
      "Dispatch Chat unread total fetched",
    ),
  );
});

// GET /api/driver-tracking/dispatch-chat/:driverId/messages
const getMessages = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { actor, organizationId, driver, dispatcher, thread: rawThread } =
    await resolvePrivateThread(req, req.params.driverId, {
      createForDispatcher: true,
    });

  const thread = await seedThreadActivityFromSafeLegacy(rawThread);
  const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit))
    : DEFAULT_PAGE_SIZE;

  let before: Date | null = null;
  if (typeof req.query.before === "string" && req.query.before.trim()) {
    const candidate = new Date(req.query.before);
    if (!Number.isNaN(candidate.getTime())) before = candidate;
  }

  const privateFilter: Record<string, unknown> = {
    organizationId,
    threadId: thread._id,
  };
  if (before) privateFilter.createdAt = { $lt: before };

  const notificationVisibility: Record<string, unknown>[] = [
    // Manual Dispatch Alerts belong only to the exact dispatcher who sent them.
    {
      userId: driver._id,
      type: "driver_dispatch_alert",
      "metadata.sentByUserId": String(dispatcher._id),
    },
    // Driver-facing operational notifications may enter a private conversation
    // only when their metadata explicitly names this dispatcher as the owner.
    // Ambiguous legacy/generic notifications remain available in the normal
    // Notification Center but are never guessed into a private chat.
    {
      userId: driver._id,
      type: { $in: EXPLICIT_THREAD_SCOPED_NOTIFICATION_TYPES },
      $or: [
        { "metadata.dispatcherId": String(dispatcher._id) },
        { "metadata.dispatchOwnerId": String(dispatcher._id) },
        { "metadata.sentByUserId": String(dispatcher._id) },
      ],
    },
  ];

  if (actor.role !== "driver") {
    // Dispatcher-facing operational events are already recipient-isolated by
    // userId. Requiring the exact driver id prevents them from leaking into a
    // different driver's conversation owned by the same dispatcher.
    notificationVisibility.push({
      userId: dispatcher._id,
      type: { $in: EXPLICIT_THREAD_SCOPED_NOTIFICATION_TYPES },
      "metadata.driverId": String(driver._id),
    });

    // GPS-silence alerts are safety notifications for Dispatch. They require
    // both the exact dispatcher recipient and exact driver ownership metadata.
    notificationVisibility.push({
      userId: dispatcher._id,
      type: "driver_tracker_offline_alert",
      "metadata.driverId": String(driver._id),
      "metadata.dispatcherId": String(dispatcher._id),
    });
  }

  const [privateRows, safeLegacyRows, unreadCount, notifications, context] =
    await Promise.all([
      DispatchChatMessage.find(privateFilter)
        .populate("senderId", "name email role")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),

      getSafeLegacyRows({
        organizationId,
        driverId: driver._id,
        dispatcherId: dispatcher._id,
        before,
        limit,
      }),

      DispatchChatMessage.countDocuments({
        organizationId,
        threadId: thread._id,
        ...dispatchChatUnreadPredicate(actor._id),
      }),

      Notification.find({
        organizationId,
        type: { $in: TIMELINE_NOTIFICATION_TYPES },
        $or: notificationVisibility,
      })
        .select("_id userId type title message metadata createdAt")
        .sort({ createdAt: -1 })
        .limit(120)
        .lean(),

      getThreadContext(organizationId, driver, dispatcher, thread),
    ]);

  // New private rows win. Safe legacy rows are merged only when their ownership
  // is explicit and their ids are not already present.
  const rowMap = new Map<string, any>();
  for (const row of [...privateRows, ...safeLegacyRows]) {
    rowMap.set(String((row as any)._id), row);
  }
  const rows = [...rowMap.values()]
    .sort(
      (a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit);

  const chronologicalRows = rows.reverse();
  const messages = await Promise.all(
    chronologicalRows.map((row) => serializeMessage(row, actor)),
  );

  const persistedAlertIds = new Set<string>();
  for (const row of chronologicalRows as any[]) {
    const alertId = row?.systemEvent?.metadata?.alertId;
    if (alertId) persistedAlertIds.add(String(alertId));
  }

  const systemEventMap = new Map<
    string,
    ReturnType<typeof serializeNotification>
  >();

  for (const notification of (notifications as any[]).reverse()) {
    // New Dispatch Alerts are persisted as thread system messages, so suppress
    // the notification copy to avoid rendering the same alert twice. Historical
    // alerts remain available because they have no persisted private system row.
    if (
      notification.type === "driver_dispatch_alert" &&
      persistedAlertIds.has(String(notification._id))
    ) {
      continue;
    }

    const event = serializeNotification(notification);
    systemEventMap.set(event.id, event);
  }

  const systemEvents = [...systemEventMap.values()];

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        thread: {
          id: String(thread._id),
          dispatcherId: String(thread.dispatcherId),
          driverId: String(thread.driverId),
        },
        messages,
        systemEvents,
        context,
        unreadCount,
        hasMore:
          privateRows.length === limit || safeLegacyRows.length === limit,
      },
      "Dispatch Chat messages fetched",
    ),
  );
});

// GET /api/driver-tracking/dispatch-chat/:driverId/unread
const getUnreadCount = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const actor = getUser(req);

  if (actor.role === "driver") {
    const {
      organizationId,
      thread,
    } = await resolvePrivateThread(
      req,
      req.params.driverId,
      { createForDispatcher: false },
    );

    const unreadCount =
      await DispatchChatMessage.countDocuments({
        organizationId,
        threadId: thread._id,
        ...dispatchChatUnreadPredicate(actor._id),
      });

    return res.status(200).json(
      new ApiResponse(
        200,
        { unreadCount },
        "Unread count fetched",
      ),
    );
  }

  const {
    organizationId,
    driver,
  } = await authorizeDispatchChat(
    req,
    req.params.driverId,
  );

  const thread = await DispatchChatThread.findOne({
    organizationId,
    dispatcherId: actor._id,
    driverId: driver._id,
  }).lean();

  if (!thread) {
    return res.status(200).json(
      new ApiResponse(
        200,
        { unreadCount: 0 },
        "Unread count fetched",
      ),
    );
  }

  const unreadCount =
    await DispatchChatMessage.countDocuments({
      organizationId,
      threadId: thread._id,
      senderId: { $ne: actor._id },
      readBy: { $ne: actor._id },
    });

  return res.status(200).json(
    new ApiResponse(
      200,
      { unreadCount },
      "Unread count fetched",
    ),
  );
});

// POST /api/driver-tracking/dispatch-chat/:driverId/messages
const sendMessage = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { actor, organizationId, thread } = await resolvePrivateThread(
    req,
    req.params.driverId,
    { createForDispatcher: true, requireActiveDispatcher: true },
  );

  const rawContent =
    typeof req.body?.content === "string" ? req.body.content : "";
  const content = rawContent.trim();

  if (!content) {
    throw new ApiError(400, "Message cannot be empty");
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(
      400,
      `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
    );
  }

  const message = await DispatchChatMessage.create({
    organizationId,
    threadId: thread._id,
    dispatcherId: thread.dispatcherId,
    driverId: thread.driverId,
    senderId: actor._id,
    senderRole: actor.role === "driver" ? "driver" : "dispatcher",
    content,
    attachments: [],
    readBy: [actor._id],
  });

  await touchDispatchChatThread({
    threadId: thread._id,
    senderId: actor._id,
    messageType: "message",
    content,
    at: message.createdAt,
  });

  await message.populate("senderId", "name email role");
  const payload = await serializeMessage(message.toObject(), actor);

  emitToDispatchChatThreadParticipants(
    thread,
    "dispatch-chat:message",
    payload,
  );

  return res
    .status(201)
    .json(new ApiResponse(201, payload, "Dispatch Chat message sent"));
});

// POST /api/driver-tracking/dispatch-chat/:driverId/attachments
const uploadAttachments = asyncHandler(
  async (req: ExpressRequest, res: ExpressResponse) => {
    const { actor, organizationId, thread } = await resolvePrivateThread(
      req,
      req.params.driverId,
      { createForDispatcher: true, requireActiveDispatcher: true },
    );

    const files = (req.files || []) as Express.Multer.File[];
    const content =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (!files.length) {
      throw new ApiError(400, "Select at least one file to send");
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new ApiError(
        400,
        `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
      );
    }

    const attachments: Array<{
      url: string;
      fileKey: string;
      originalName: string;
      mimeType: string;
      size: number;
    }> = [];

    try {
      for (const file of files) {
        const fileUrl = await storageService.upload(
          file,
          "dispatch-chat-attachments",
          BucketType.PRIVATE,
          { allowLocalFallback: false },
        );

        attachments.push({
          url: fileUrl,
          fileKey: storageService.getKeyFromUrl(fileUrl) || fileUrl,
          originalName: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
        });
      }
    } catch (error) {
      await Promise.allSettled(
        attachments.map((attachment) =>
          storageService.delete(attachment.fileKey, BucketType.PRIVATE),
        ),
      );
      logger.error(
        { error, driverId: req.params.driverId },
        "[DispatchChat] Attachment upload failed",
      );
      throw new ApiError(
        503,
        "File upload is temporarily unavailable. Please try again.",
      );
    }

    let message: any;
    try {
      message = await DispatchChatMessage.create({
        organizationId,
        threadId: thread._id,
        dispatcherId: thread.dispatcherId,
        driverId: thread.driverId,
        senderId: actor._id,
        senderRole: actor.role === "driver" ? "driver" : "dispatcher",
        content,
        attachments,
        readBy: [actor._id],
      });
    } catch (error) {
      await Promise.allSettled(
        attachments.map((attachment) =>
          storageService.delete(attachment.fileKey, BucketType.PRIVATE),
        ),
      );
      throw error;
    }

    await touchDispatchChatThread({
      threadId: thread._id,
      senderId: actor._id,
      messageType: "message",
      content,
      fallbackPreview:
        attachments.length === 1
          ? `Attachment: ${attachments[0].originalName}`
          : `${attachments.length} attachments`,
      at: message.createdAt,
    });

    await message.populate("senderId", "name email role");
    const payload = await serializeMessage(message.toObject(), actor);

    emitToDispatchChatThreadParticipants(
      thread,
      "dispatch-chat:message",
      payload,
    );

    return res
      .status(201)
      .json(new ApiResponse(201, payload, "Dispatch Chat files sent"));
  },
);

// POST /api/driver-tracking/dispatch-chat/:driverId/read
const markRead = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const { actor, organizationId, thread } = await resolvePrivateThread(
    req,
    req.params.driverId,
    { createForDispatcher: true },
  );

  await DispatchChatMessage.updateMany(
    {
      organizationId,
      threadId: thread._id,
      ...dispatchChatUnreadPredicate(actor._id),
    },
    {
      $addToSet: { readBy: actor._id },
    },
  );

  const payload = {
    threadId: String(thread._id),
    dispatcherId: String(thread.dispatcherId),
    driverId: String(thread.driverId),
    readerId: actor._id.toString(),
    readAt: new Date().toISOString(),
  };

  emitToDispatchChatThreadParticipants(
    thread,
    "dispatch-chat:read",
    payload,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, payload, "Dispatch Chat marked read"));
});

export default {
  openLoadCreatorThread,
  getThreads,
  getUnreadTotal,
  getMessages,
  getUnreadCount,
  sendMessage,
  uploadAttachments,
  markRead,
};