import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import User, { IUser } from "../models/User.model";
import Load from "../models/Load.model";
import Notification from "../models/Notification.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
import { emitToUser } from "../utils/socketEmitter";
import { storageService, BucketType } from "../services/storage.service";
import logger from "../utils/logger";

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ACTIVE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"];

const TIMELINE_NOTIFICATION_TYPES = [
  "driver_dispatch_alert",
  "driver_assigned",
  "driver_request_approved",
  "driver_request_rejected",
  "driver_tracker_geofence_alert",
  "driver_tracker_offline_alert",
  "driver_tracker_place_visit",
  "proof_submitted",
  "delivery_confirmed",
];

const getUser = (req: Request) => req.user as IUser;

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

async function authorizeDispatchChat(
  req: Request,
  driverId: string,
): Promise<AuthorizedChat> {
  const actor = getUser(req);
  const organizationId = req.orgId as string;

  if (!organizationId) {
    throw new ApiError(403, "Organization access is required");
  }

  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "A valid driverId is required");
  }

  const actorRole = actor.role;
  const actorId = actor._id.toString();

  if (actorRole === "driver") {
    if (actorId !== driverId) {
      throw new ApiError(403, "Drivers can only access their own Dispatch Chat");
    }
  } else if (!STAFF_ROLES.includes(String(actorRole))) {
    throw new ApiError(
      403,
      "Dispatch Chat is limited to drivers and dispatch staff",
    );
  }

  const driver = await User.findOne({
    _id: driverId,
    organizationId,
    role: "driver",
    isActive: true,
  })
    .select("_id name email avatar")
    .lean();

  if (!driver) {
    throw new ApiError(404, "Driver not found in this organization");
  }

  return {
    actor,
    organizationId,
    driver: driver as AuthorizedChat["driver"],
  };
}

async function signAttachment(attachment: any) {
  const rawUrl = attachment?.url || "";
  const key = attachment?.fileKey || rawUrl;
  let url = rawUrl;

  if (key && !String(key).startsWith("http")) {
    try {
      const signed = await storageService.getSignedUrl(String(key), 3600);
      if (signed) url = signed;
    } catch {
      // Leave the persisted key untouched. A temporary signing failure must
      // not make the entire chat history fail to load.
    }
  }

  return {
    url,
    originalName: attachment?.originalName || "Attachment",
    mimeType: attachment?.mimeType || "application/octet-stream",
    size: Number(attachment?.size || 0),
  };
}

async function resolveParticipantAvatar(
  raw: string | null | undefined,
): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  if (
    /^https?:\/\//i.test(value) ||
    value.startsWith("data:")
  ) {
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

async function serializeMessage(message: any) {
  const sender = message?.senderId;
  const attachments = await Promise.all(
    (Array.isArray(message?.attachments) ? message.attachments : []).map(
      signAttachment,
    ),
  );

  return {
    id: String(message._id),
    driverId: String(message.driverId),
    sender: {
      id: String(sender?._id ?? message.senderId),
      name: sender?.name ?? "User",
      email: sender?.email ?? "",
      role: sender?.role ?? message.senderRole,
    },
    senderRole: message.senderRole,
    messageType: message.messageType || "message",
    systemEvent: message.systemEvent ?? null,
    content: message.content || "",
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
  actor: IUser,
  organizationId: string,
  driver: AuthorizedChat["driver"],
) {
  const [activeLoads, latestDispatcherMessage, latestDispatchAlert] =
    await Promise.all([
      Load.find({
        organizationId,
        assignedDriverId: driver._id,
        status: { $in: ACTIVE_LOAD_STATUSES },
      })
        .select(
          "_id loadNumber status pickupLocation deliveryLocation dates vehicles",
        )
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(5)
        .lean(),

      DispatchChatMessage.findOne({
        organizationId,
        driverId: driver._id,
        senderRole: "dispatcher",
      })
        .populate("senderId", "_id name email avatar")
        .sort({ createdAt: -1 })
        .lean(),

      Notification.findOne({
        organizationId,
        userId: driver._id,
        type: "driver_dispatch_alert",
      })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

  let dispatcher: {
    id: string | null;
    name: string;
    email?: string;
    avatar?: string | null;
  };

  if (actor.role !== "driver") {
    // Resolve the current dispatcher from the main User record so the chat
    // header uses the same stored profile picture as the rest of SUPRAH.
    const actorProfile: any = await User.findOne({
      _id: actor._id,
      organizationId,
      isActive: true,
    })
      .select("_id name email avatar")
      .lean();

    dispatcher = {
      id: actor._id.toString(),
      name: actorProfile?.name || actor.name || "Dispatcher",
      email: actorProfile?.email || actor.email || "",
      avatar: actorProfile?.avatar || null,
    };
  } else {
    const sender: any = (latestDispatcherMessage as any)?.senderId;
    const alertMetadata: any = (latestDispatchAlert as any)?.metadata ?? {};

    let fallbackDispatcher: any = null;

    if (!sender?._id && alertMetadata.sentByUserId) {
      fallbackDispatcher = await User.findOne({
        _id: alertMetadata.sentByUserId,
        organizationId,
        role: { $in: STAFF_ROLES },
        isActive: true,
      })
        .select("_id name email avatar")
        .lean();
    }

    dispatcher = sender?._id
      ? {
          id: String(sender._id),
          name: sender.name || "Dispatch Team",
          email: sender.email || "",
          avatar: sender.avatar || null,
        }
      : fallbackDispatcher?._id
        ? {
            id: String(fallbackDispatcher._id),
            name:
              fallbackDispatcher.name ||
              alertMetadata.sentByName ||
              "Dispatch Team",
            email: fallbackDispatcher.email || "",
            avatar: fallbackDispatcher.avatar || null,
          }
        : {
            id: alertMetadata.sentByUserId
              ? String(alertMetadata.sentByUserId)
              : null,
            name: alertMetadata.sentByName || "Dispatch Team",
            avatar: null,
          };
  }

  const [resolvedDriverAvatar, resolvedDispatcherAvatar] =
    await Promise.all([
      resolveParticipantAvatar(driver.avatar),
      resolveParticipantAvatar(dispatcher.avatar),
    ]);

  return {
    driver: {
      id: String(driver._id),
      name: driver.name || "Driver",
      email: driver.email || "",
      avatar: resolvedDriverAvatar,
    },
    dispatcher: {
      ...dispatcher,
      avatar: resolvedDispatcherAvatar,
    },
    loads: (activeLoads as any[]).map((load) => ({
      id: String(load._id),
      loadNumber: load.loadNumber || String(load._id),
      status: load.status,
      vehicleCount: Array.isArray(load.vehicles) ? load.vehicles.length : 0,
      origin: [
        load.pickupLocation?.city,
        load.pickupLocation?.state,
      ]
        .filter(Boolean)
        .join(", "),
      destination: [
        load.deliveryLocation?.city,
        load.deliveryLocation?.state,
      ]
        .filter(Boolean)
        .join(", "),
      pickupDate: load.dates?.firstAvailable ?? null,
    })),
  };
}

async function emitToDispatchChatParticipants(
  organizationId: string,
  driverId: string,
  event: string,
  payload: unknown,
) {
  const staff = await User.find({
    organizationId,
    role: { $in: STAFF_ROLES },
    isActive: true,
  })
    .select("_id")
    .lean();

  const participantIds = new Set<string>([
    driverId,
    ...staff.map((member: any) => String(member._id)),
  ]);

  participantIds.forEach((userId) => {
    emitToUser(userId, event, payload);
  });
}

// GET /api/driver-tracking/dispatch-chat/:driverId/messages
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const { actor, organizationId, driver } = await authorizeDispatchChat(
    req,
    req.params.driverId,
  );

  const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit))
    : DEFAULT_PAGE_SIZE;

  const filter: Record<string, unknown> = {
    organizationId,
    driverId: req.params.driverId,
  };

  if (typeof req.query.before === "string" && req.query.before.trim()) {
    const before = new Date(req.query.before);
    if (!Number.isNaN(before.getTime())) {
      filter.createdAt = { $lt: before };
    }
  }

  const [rows, unreadCount, notifications, context] = await Promise.all([
    DispatchChatMessage.find(filter)
      .populate("senderId", "name email role")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),

    DispatchChatMessage.countDocuments({
      organizationId,
      driverId: req.params.driverId,
      senderId: { $ne: actor._id },
      readBy: { $ne: actor._id },
    }),

    Notification.find({
      organizationId,
      type: { $in: TIMELINE_NOTIFICATION_TYPES },
      $or: [
        // Existing driver-facing operational notifications.
        { userId: driver._id },

        // The 10-minute location-silence alert is sent to Dispatch staff, not
        // to the driver. Pull it into this driver's private Dispatch Chat by
        // its explicit driverId metadata.
        {
          type: "driver_tracker_offline_alert",
          "metadata.driverId": String(driver._id),
        },
      ],
    })
      .select("_id type title message metadata createdAt")
      .sort({ createdAt: -1 })
      .limit(120)
      .lean(),

    getThreadContext(actor, organizationId, driver),
  ]);

  const messages = await Promise.all(rows.reverse().map(serializeMessage));
  // Multiple dispatchers each receive their own notification record for the
  // same safety incident. Collapse copies with the same metadata.incidentId
  // so Suprah Dispatch Chat displays one centered alert card.
  const systemEventMap = new Map<string, ReturnType<typeof serializeNotification>>();

  for (const notification of (notifications as any[]).reverse()) {
    const event = serializeNotification(notification);
    systemEventMap.set(event.id, event);
  }

  const systemEvents = [...systemEventMap.values()];

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        messages,
        systemEvents,
        context,
        unreadCount,
        hasMore: rows.length === limit,
      },
      "Dispatch Chat messages fetched",
    ),
  );
});

// GET /api/driver-tracking/dispatch-chat/:driverId/unread
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const { actor, organizationId } = await authorizeDispatchChat(
    req,
    req.params.driverId,
  );

  const unreadCount = await DispatchChatMessage.countDocuments({
    organizationId,
    driverId: req.params.driverId,
    senderId: { $ne: actor._id },
    readBy: { $ne: actor._id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { unreadCount }, "Unread count fetched"));
});

// POST /api/driver-tracking/dispatch-chat/:driverId/messages
const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { actor, organizationId } = await authorizeDispatchChat(
    req,
    req.params.driverId,
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
    driverId: req.params.driverId,
    senderId: actor._id,
    senderRole: actor.role === "driver" ? "driver" : "dispatcher",
    content,
    attachments: [],
    readBy: [actor._id],
  });

  await message.populate("senderId", "name email role");
  const payload = await serializeMessage(message.toObject());

  await emitToDispatchChatParticipants(
    organizationId,
    req.params.driverId,
    "dispatch-chat:message",
    payload,
  );

  return res
    .status(201)
    .json(new ApiResponse(201, payload, "Dispatch Chat message sent"));
});

// POST /api/driver-tracking/dispatch-chat/:driverId/attachments
const uploadAttachments = asyncHandler(
  async (req: Request, res: Response) => {
    const { actor, organizationId } = await authorizeDispatchChat(
      req,
      req.params.driverId,
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
        driverId: req.params.driverId,
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

    await message.populate("senderId", "name email role");
    const payload = await serializeMessage(message.toObject());

    await emitToDispatchChatParticipants(
      organizationId,
      req.params.driverId,
      "dispatch-chat:message",
      payload,
    );

    return res
      .status(201)
      .json(new ApiResponse(201, payload, "Dispatch Chat files sent"));
  },
);

// POST /api/driver-tracking/dispatch-chat/:driverId/read
const markRead = asyncHandler(async (req: Request, res: Response) => {
  const { actor, organizationId } = await authorizeDispatchChat(
    req,
    req.params.driverId,
  );

  await DispatchChatMessage.updateMany(
    {
      organizationId,
      driverId: req.params.driverId,
      senderId: { $ne: actor._id },
      readBy: { $ne: actor._id },
    },
    {
      $addToSet: { readBy: actor._id },
    },
  );

  const payload = {
    driverId: req.params.driverId,
    readerId: actor._id.toString(),
    readAt: new Date().toISOString(),
  };

  await emitToDispatchChatParticipants(
    organizationId,
    req.params.driverId,
    "dispatch-chat:read",
    payload,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, payload, "Dispatch Chat marked read"));
});

export default {
  getMessages,
  getUnreadCount,
  sendMessage,
  uploadAttachments,
  markRead,
};