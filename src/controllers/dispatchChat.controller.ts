import { Request, Response } from "express";
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

function getRequestedThreadId(req: Request): string | null {
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
  req: Request,
  driverId: string,
  options: { createForDispatcher?: boolean; requireActiveDispatcher?: boolean } = {},
): Promise<ResolvedPrivateThread> {
  const authorized = await authorizeDispatchChat(req, driverId);
  const { actor, organizationId, driver } = authorized;
  const actorId = actor._id.toString();
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

    thread = await DispatchChatThread.findOne({
      _id: requestedThreadId,
      organizationId,
      driverId: actor._id,
    }).lean();

    if (!thread) {
      throw new ApiError(404, "Dispatch Chat conversation not found");
    }
  } else if (requestedThreadId) {
    // Staff cannot use another dispatcher's thread id, even inside the same org.
    thread = await DispatchChatThread.findOne({
      _id: requestedThreadId,
      organizationId,
      driverId: driver._id,
      dispatcherId: actor._id,
    }).lean();

    if (!thread) {
      throw new ApiError(403, "You do not have access to this Dispatch Chat conversation");
    }
  } else if (options.createForDispatcher !== false) {
    thread = await ensureDispatchChatThread({
      organizationId,
      dispatcherId: actor._id,
      driverId: driver._id,
    });
  } else {
    thread = await DispatchChatThread.findOne({
      organizationId,
      dispatcherId: actor._id,
      driverId: driver._id,
    }).lean();

    if (!thread) {
      // An unread check for a never-started conversation is simply zero.
      throw new ApiError(404, "Dispatch Chat conversation not found");
    }
  }

  const dispatcherId = String(thread.dispatcherId);
  const dispatcher = await User.findOne({
    _id: dispatcherId,
    organizationId,
    role: { $in: STAFF_ROLES },
  })
    .select("_id name email avatar isActive")
    .lean();

  if (!dispatcher) {
    throw new ApiError(404, "Dispatcher for this conversation is no longer available");
  }

  if (options.requireActiveDispatcher && dispatcher.isActive === false) {
    throw new ApiError(409, "This dispatcher is no longer active");
  }

  return {
    ...authorized,
    thread,
    dispatcher: dispatcher as ResolvedPrivateThread["dispatcher"],
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

async function serializeMessage(message: any) {
  const sender = message?.senderId;
  const attachments = await Promise.all(
    (Array.isArray(message?.attachments) ? message.attachments : []).map(
      signAttachment,
    ),
  );

  return {
    id: String(message._id),
    threadId: message.threadId ? String(message.threadId) : null,
    dispatcherId: message.dispatcherId ? String(message.dispatcherId) : null,
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
const openLoadCreatorThread = asyncHandler(async (req: Request, res: Response) => {
  const actor = getUser(req);
  const organizationId = req.orgId as string;
  const loadId = String(req.params.loadId ?? '').trim();

  if (!organizationId) {
    throw new ApiError(403, 'Organization access is required');
  }
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
    organizationId,
    status: 'Posted',
    $or: [
      { assignedDriverId: null },
      { assignedDriverId: { $exists: false } },
    ],
  })
    .select('_id loadNumber createdBy')
    .lean();

  if (!load) {
    throw new ApiError(409, 'This load is no longer available on the Load Board');
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
      organizationId,
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
    senderId: { $ne: actor._id },
    readBy: { $ne: actor._id },
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
const getThreads = asyncHandler(async (req: Request, res: Response) => {
  const actor = getUser(req);
  const organizationId = req.orgId as string;

  if (!organizationId) throw new ApiError(403, "Organization access is required");
  const actorIsDriver = actor.role === "driver";
  const actorIsStaff = STAFF_ROLES.includes(String(actor.role));
  if (!actorIsDriver && !actorIsStaff) {
    throw new ApiError(403, "Dispatch Chat is limited to drivers and dispatch staff");
  }

  if (actorIsDriver) {
    await backfillSafeDriverThreads(organizationId, actor._id);
  }

  const threadFilter = actorIsDriver
    ? { organizationId, driverId: actor._id, lastMessageAt: { $ne: null } }
    : { organizationId, dispatcherId: actor._id, lastMessageAt: { $ne: null } };

  const threads: any[] = await DispatchChatThread.find(threadFilter)
    .populate("dispatcherId", "_id name email avatar isActive role")
    .populate("driverId", "_id name email avatar isActive role")
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .lean();

  const threadIds = threads.map((thread) => thread._id);
  const unreadRows = threadIds.length
    ? await DispatchChatMessage.aggregate([
        {
          $match: {
            organizationId,
            threadId: { $in: threadIds },
            senderId: { $ne: actor._id },
            readBy: { $ne: actor._id },
          },
        },
        { $group: { _id: "$threadId", unreadCount: { $sum: 1 } } },
      ])
    : [];

  const unreadByThread = new Map(
    unreadRows.map((row: any) => [String(row._id), Number(row.unreadCount || 0)]),
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
          avatar: await resolveParticipantAvatar(dispatcher?.avatar),
          isActive: dispatcher?.isActive !== false,
        },
        driver: {
          id: String(driver?._id ?? ""),
          name: driver?.name || "Driver",
          email: driver?.email || "",
          avatar: await resolveParticipantAvatar(driver?.avatar),
          isActive: driver?.isActive !== false,
        },
        unreadCount: unreadByThread.get(String(thread._id)) ?? 0,
        lastMessageAt: thread.lastMessageAt ?? null,
        lastMessagePreview: thread.lastMessagePreview || "",
        lastMessageType: thread.lastMessageType ?? null,
      };
    }),
  );

  return res
    .status(200)
    .json(new ApiResponse(200, { threads: data }, "Dispatch Chat conversations fetched"));
});

// GET /api/driver-tracking/dispatch-chat/unread-total
const getUnreadTotal = asyncHandler(async (req: Request, res: Response) => {
  const actor = getUser(req);
  const organizationId = req.orgId as string;

  if (!organizationId) throw new ApiError(403, "Organization access is required");

  const actorIsDriver = actor.role === "driver";
  const actorIsStaff = STAFF_ROLES.includes(String(actor.role));
  if (!actorIsDriver && !actorIsStaff) {
    throw new ApiError(403, "Dispatch Chat is limited to drivers and dispatch staff");
  }

  const unreadTotal = await DispatchChatMessage.countDocuments({
    organizationId,
    threadId: { $exists: true },
    ...(actorIsDriver
      ? { driverId: actor._id }
      : { dispatcherId: actor._id }),
    senderId: { $ne: actor._id },
    readBy: { $ne: actor._id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { unreadTotal }, "Dispatch Chat unread total fetched"));
});

// GET /api/driver-tracking/dispatch-chat/:driverId/messages
const getMessages = asyncHandler(async (req: Request, res: Response) => {
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
        senderId: { $ne: actor._id },
        readBy: { $ne: actor._id },
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
  const messages = await Promise.all(chronologicalRows.map(serializeMessage));

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
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const authorized = await authorizeDispatchChat(req, req.params.driverId);
  const { actor, organizationId, driver } = authorized;

  let thread: any;
  if (actor.role === "driver") {
    ({ thread } = await resolvePrivateThread(req, req.params.driverId, {
      createForDispatcher: false,
    }));
  } else {
    thread = await DispatchChatThread.findOne({
      organizationId,
      dispatcherId: actor._id,
      driverId: driver._id,
    }).lean();

    if (!thread) {
      return res
        .status(200)
        .json(new ApiResponse(200, { unreadCount: 0 }, "Unread count fetched"));
    }
  }

  const unreadCount = await DispatchChatMessage.countDocuments({
    organizationId,
    threadId: thread._id,
    senderId: { $ne: actor._id },
    readBy: { $ne: actor._id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { unreadCount }, "Unread count fetched"));
});

// POST /api/driver-tracking/dispatch-chat/:driverId/messages
const sendMessage = asyncHandler(async (req: Request, res: Response) => {
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
  const payload = await serializeMessage(message.toObject());

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
  async (req: Request, res: Response) => {
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
    const payload = await serializeMessage(message.toObject());

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
const markRead = asyncHandler(async (req: Request, res: Response) => {
  const { actor, organizationId, thread } = await resolvePrivateThread(
    req,
    req.params.driverId,
    { createForDispatcher: true },
  );

  await DispatchChatMessage.updateMany(
    {
      organizationId,
      threadId: thread._id,
      senderId: { $ne: actor._id },
      readBy: { $ne: actor._id },
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