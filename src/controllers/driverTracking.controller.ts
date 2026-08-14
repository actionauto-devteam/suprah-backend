import { Request, Response } from "express";
// t
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverPayout from "../models/DriverPayout.model";
import logger from "../utils/logger";
import { getSocketIO, emitToOrg, emitToUser } from "../utils/socketEmitter";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";
import activityService from "../services/activity.service";
import Notification from "../models/Notification.model";
import DispatchChatMessage from "../models/DispatchChatMessage.model";
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

const getUser = (req: Request) => req.user as IUser;

// Statuses that count against a driver's active workload
const ACTIVE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"];

// Conservative capacity fallback for drivers with no profile yet. Drivers
// who haul more raise their own limit in Driver's Account (up to 20).
const DEFAULT_MAX_CAPACITY = 12;

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
      // The dispatcher performed the action and has already seen it. The
      // driver remains unread so their private Dispatch Chat badge updates.
      readBy: [dispatcher._id],
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
        readBy: [dispatcher._id.toString()],
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

// ─── Location Heartbeat ───────────────────────────────────────────────────────
// POST /api/driver-tracking/heartbeat  { lat, lng, status? }

const heartbeat = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { lat, lng, status } = req.body as {
    lat?: number;
    lng?: number;
    status?: string;
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

  const allowedStatuses = ["on-route", "idle", "on-break", "waiting", "offline"];
  const requestedStatus =
    status && allowedStatuses.includes(status) ? status : undefined;

  // Dispatch Status controls the Live Status label, but it does NOT control
  // whether GPS may be shared. On Leave drivers may voluntarily share their
  // coordinates while remaining Live: Offline; In Shop drivers may voluntarily
  // share while remaining Live: Waiting.
  const statusContext = await getDriverStatusContext(
    user._id.toString(),
    organizationId,
  );
  const nextStatus =
    statusContext.operationalStatus === "on_leave"
      ? "offline"
      : statusContext.operationalStatus === "maintenance"
        ? "waiting"
        : requestedStatus;

  const locationUpdate: Record<string, any> = {
    $set: {
      organizationId,
      coords: { lat, lng },
      lastSeenAt: new Date(),
      isSharing: true,

      // Any successful coordinate heartbeat ends the previous GPS-silence
      // incident. This remains relevant only to Active drivers that are under
      // the existing active-load monitoring policy.
      offlineAlertSentAt: null,

      ...(nextStatus ? { status: nextStatus } : {}),
    },
  };

  if (!nextStatus) {
    locationUpdate.$setOnInsert = { status: "idle" };
  }

  const location = await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    locationUpdate,
    { new: true, upsert: true },
  );

  const io = getSocketIO();
  if (io) {
    io.to(`org:${organizationId}`).emit("driver:location", {
      driverId: user._id.toString(),
      coords: location.coords,
      status: location.status,
      isSharing: true,
      lastSeenAt: location.lastSeenAt,
    });
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        ok: true,
        locationAccepted: true,
        isSharing: true,
        status: location.status,
      },
      statusContext.operationalStatus === "maintenance"
        ? "Location shared while driver remains In Shop"
        : statusContext.operationalStatus === "on_leave"
          ? "Location shared while driver remains On Leave"
          : "Location updated",
    ),
  );
});

// POST /api/driver-tracking/location-offline
const markLocationOffline = asyncHandler(
  async (req: Request, res: Response) => {
    const user = getUser(req);
    const organizationId = req.orgId as string;

    if (user.role !== "driver") {
      throw new ApiError(
        403,
        "Only driver accounts can publish Driver Tracker presence",
      );
    }

    const statusContext = await getDriverStatusContext(
      user._id.toString(),
      organizationId,
    );
    const locationRequirement = await getDriverLocationRequirement(
      user._id.toString(),
      organizationId,
      {
        operationalStatus: statusContext.operationalStatus,
        emergencyReleaseActive: statusContext.emergencyReleaseActive,
      },
    );

    const forcedStatus =
      statusContext.operationalStatus === "maintenance" ? "waiting" : "offline";

    // GPS can be required for either the normal Active + active-load policy or
    // an explicit dispatcher decision to keep loads assigned while On Leave /
    // In Shop with GPS required. Emergency Release remains non-blocking.
    const locationRequired = locationRequirement.required;

    const now = new Date();
    const existing: any = await DriverLocation.findOne({
      userId: user._id,
      organizationId,
    });

    let location: any = existing;
    let silenceStartedAt: Date | null =
      existing?.lastSeenAt ? new Date(existing.lastSeenAt) : null;

    if (existing) {
      const update: Record<string, any> = {
        status: forcedStatus,
        isSharing: false,
        offlineAlertSentAt: null,
      };

      // For a required active-load GPS stop, start the 10-minute silence window
      // at the moment sharing becomes unavailable, preserving existing behavior.
      // Optional stops keep the last actual coordinate timestamp untouched.
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
      // A location row cannot be created without coordinates. The monitor
      // already handles active-load drivers who have never sent a heartbeat.
      silenceStartedAt = now;
    }

    const io = getSocketIO();
    if (io) {
      io.to(`org:${organizationId}`).emit("driver:location", {
        driverId: user._id.toString(),
        coords: location?.coords ?? null,
        status: forcedStatus,
        isSharing: false,
        lastSeenAt: location?.lastSeenAt ?? silenceStartedAt,
      });
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          ok: true,
          required: locationRequired,
          requirementReason: locationRequirement.reason,
          status: forcedStatus,
          isSharing: false,
          silenceStartedAt: locationRequired
            ? silenceStartedAt?.toISOString() ?? now.toISOString()
            : null,
        },
        locationRequired
          ? locationRequirement.reason === "dispatch_retained_load"
            ? "GPS is required by Dispatch while retained loads remain assigned"
            : "Driver location marked offline; required GPS silence monitoring remains active"
          : statusContext.operationalStatus === "maintenance"
            ? "GPS sharing turned off while driver remains In Shop"
            : statusContext.operationalStatus === "on_leave"
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

const getActiveDrivers = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const locations = await DriverLocation.find({ organizationId }).lean();
  const userIds = locations.map((l: any) => l.userId);

  const [users, profiles, loads] = await Promise.all([
    User.find({ _id: { $in: userIds }, role: "driver", isActive: true })
      .select("name email avatar phone")
      .lean(),
    DriverProfile.find({ userId: { $in: userIds } }).lean(),
    Load.find({
      organizationId,
      assignedDriverId: { $in: userIds },
      status: { $in: ACTIVE_LOAD_STATUSES },
    })
      .select("loadNumber status pickupLocation deliveryLocation assignedDriverId")
      .lean(),
  ]);

  const userById = new Map(users.map((u: any) => [String(u._id), u]));
  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const loadsByDriver = new Map<string, any[]>();
  for (const l of loads as any[]) {
    const key = String(l.assignedDriverId);
    if (!loadsByDriver.has(key)) loadsByDriver.set(key, []);
    loadsByDriver.get(key)!.push(l);
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
        typeof loc.isSharing === "boolean"
          ? loc.isSharing
          : loc.status !== "offline";
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
        coords: loc.coords ?? null,
        lastSeenAt: loc.lastSeenAt ?? null,
        isSharing: effectiveSharing,
        driver: {
          id: key,
          name: u.name ?? "",
          email: u.email ?? "",
          avatar: u.avatar ?? undefined,
        },
        equipment: p
          ? {
              trailerType: p.trailerType ?? null,
              maxVehicleCapacity: p.maxVehicleCapacity ?? DEFAULT_MAX_CAPACITY,
              operationalStatus: p.operationalStatus ?? "active",
              truckMake: p.truckMake ?? undefined,
              truckModel: p.truckModel ?? undefined,
              isComplianceExpired: Boolean(p.isComplianceExpired),
            }
          : null,
        shipments: driverLoads.map((l: any) => ({
          id: String(l._id),
          trackingNumber: l.loadNumber,
          status: l.status,
          origin: `${l.pickupLocation?.city ?? ""}, ${l.pickupLocation?.state ?? ""}`,
          destination: `${l.deliveryLocation?.city ?? ""}, ${l.deliveryLocation?.state ?? ""}`,
        })),
      };
    });

  return res
    .status(200)
    .json(new ApiResponse(200, data, "Active drivers fetched"));
});

// ─── Assign / Reassign / Remove (dispatcher actions) ─────────────────────────

// POST /api/driver-tracking/assign-load  { loadId, driverId }
const assignLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { loadId, driverId } = req.body as { loadId?: string; driverId?: string };

  if (!loadId || !driverId) throw new ApiError(400, "loadId and driverId are required");

  const [load, driver] = await Promise.all([
    Load.findOne({ _id: loadId, organizationId }),
    User.findOne({ _id: driverId, organizationId, role: "driver", isActive: true }).lean(),
  ]);

  if (!load) throw new ApiError(404, "Load not found");
  if (!driver) throw new ApiError(404, "Driver not found in this organization");
  await assertDriverCanTakeNewWork(driverId, organizationId, "assign");
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot assign a load in ${load.status} status`);
  }

  load.assignedDriverId = driver._id as any;
  (load as any).dispatchOwnerId = user._id;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  (load as any).driverRequests = [];
  await load.save();

  emitLoadSync(organizationId, [driverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "driver_assigned",
    title: "New Load Assigned",
    message: `You've been assigned load ${load.loadNumber}`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  await persistDispatcherLoadChatEvent({
    dispatcher: user,
    organizationId,
    driverId,
    eventType: "driver_load_assigned",
    title: "New Load Assigned",
    message: `Dispatch assigned load ${load.loadNumber} to you.`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      action: "assigned",
    },
  });

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await logLoadActivityLoose(
      user._id.toString(),
      organizationId,
      "load_assigned",
      load._id.toString(),
      `Assigned load ${load.loadNumber} to ${(driver as any).name}`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  logger.info({ loadId, driverId, orgId: organizationId }, "Load assigned to driver");

  return res.status(200).json(new ApiResponse(200, load, "Load assigned successfully"));
});

// POST /api/driver-tracking/reassign-load  { loadId, driverId }
const reassignLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { loadId, driverId } = req.body as { loadId?: string; driverId?: string };

  if (!loadId || !driverId) throw new ApiError(400, "loadId and driverId are required");

  const [load, driver] = await Promise.all([
    Load.findOne({ _id: loadId, organizationId }),
    User.findOne({ _id: driverId, organizationId, role: "driver", isActive: true }).lean(),
  ]);

  if (!load) throw new ApiError(404, "Load not found");
  if (!driver) throw new ApiError(404, "Driver not found in this organization");
  await assertDriverCanTakeNewWork(driverId, organizationId, "reassign");
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot reassign a load in ${load.status} status`);
  }

  const previousDriverId = load.assignedDriverId
    ? load.assignedDriverId.toString()
    : null;

  load.assignedDriverId = driver._id as any;
  (load as any).dispatchOwnerId = user._id;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  await load.save();

  emitLoadSync(organizationId, [previousDriverId, driverId], load._id.toString());

  if (previousDriverId && previousDriverId !== driverId) {
    await safeCreateNotificationLoose({
      userId: previousDriverId,
      organizationId,
      type: "driver_assigned",
      title: "Load Reassigned",
      message: `Load ${load.loadNumber} has been reassigned to another driver`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    });

    await persistDispatcherLoadChatEvent({
      dispatcher: user,
      organizationId,
      driverId: previousDriverId,
      eventType: "driver_load_reassigned",
      title: "Load Reassigned",
      message: `Load ${load.loadNumber} has been reassigned to another driver by Dispatch.`,
      metadata: {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        previousDriverId,
        newDriverId: driverId,
        action: "reassigned_away",
      },
    });
  }

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "driver_assigned",
    title: "New Load Assigned",
    message: `You've been assigned load ${load.loadNumber}`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  await persistDispatcherLoadChatEvent({
    dispatcher: user,
    organizationId,
    driverId,
    eventType: "driver_load_assigned",
    title: previousDriverId && previousDriverId !== driverId
      ? "Load Reassigned to You"
      : "New Load Assigned",
    message: previousDriverId && previousDriverId !== driverId
      ? `Dispatch reassigned load ${load.loadNumber} to you.`
      : `Dispatch assigned load ${load.loadNumber} to you.`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      previousDriverId,
      newDriverId: driverId,
      action:
        previousDriverId && previousDriverId !== driverId
          ? "reassigned_to"
          : "assigned_to",
    },
  });

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await logLoadActivityLoose(
      user._id.toString(),
      organizationId,
      "load_reassigned",
      load._id.toString(),
      `Reassigned load ${load.loadNumber} to ${(driver as any).name}`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  if (previousDriverId && previousDriverId !== driverId) {
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
const removeLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { loadId } = req.body as { loadId?: string };

  if (!loadId) throw new ApiError(400, "loadId is required");

  const load = await Load.findOne({ _id: loadId, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId) throw new ApiError(400, "Load has no assigned driver");
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot remove driver from a load in ${load.status} status`);
  }

  const previousDriverId = load.assignedDriverId.toString();

  load.assignedDriverId = undefined as any;
  (load as any).dispatchOwnerId = undefined;
  load.status = "Posted";
  await load.save();

  emitLoadSync(organizationId, [previousDriverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: previousDriverId,
    organizationId,
    type: "general",
    title: "Load Removed",
    message: `Load ${load.loadNumber} has been removed from your assignments`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await logLoadActivityLoose(
      user._id.toString(),
      organizationId,
      "load_removed",
      load._id.toString(),
      `Removed driver from load ${load.loadNumber}`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
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
// - Total earnings come from PAID DriverPayout records, not quoted/carrier pay.
// - Every query is scoped to both the authenticated driver and organization.
// - No load, payout, profile, notification, GPS, or messaging records are changed.
const getDashboardStats = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  if (user.role !== "driver") {
    throw new ApiError(403, "Only driver accounts can view driver dashboard statistics");
  }

  const [pendingRequests, completedLoads, profile, payoutTotals] =
    await Promise.all([
      // A request is pending only while the load is still Posted and the
      // driver's request entry still exists. Approved/rejected requests are
      // removed by the existing workflow, so this mirrors getMyRequests().
      Load.countDocuments({
        organizationId,
        status: "Posted",
        "driverRequests.driverId": user._id,
      }),

      // Completed means a Delivered load that is actually assigned to this
      // authenticated driver in this organization.
      Load.countDocuments({
        organizationId,
        assignedDriverId: user._id,
        status: "Delivered",
      }),

      // Profile data is optional; a driver without a profile should still be
      // able to load the dashboard with safe defaults.
      DriverProfile.findOne({
        userId: user._id,
        organizationId,
      })
        .select("profileCompletionScore isComplianceExpired")
        .lean(),

      // Earnings are authoritative only after the payout reached "paid".
      // Pending/processing/failed payouts are intentionally excluded.
      DriverPayout.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            organizationId,
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
const getMyLoads = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  await finalizeDriverStatusChangeIfClear(user._id.toString(), organizationId);

  const [loads, statusContext] = await Promise.all([
    Load.find({
      organizationId,
      assignedDriverId: user._id,
      status: { $nin: ["Cancelled"] },
    })
      .sort({ createdAt: -1 })
      .lean(),
    getDriverStatusContext(user._id.toString(), organizationId),
  ]);

  const activeLoadIds = (loads as any[])
    .filter((load) => ACTIVE_LOAD_STATUSES.includes(String(load.status)))
    .map((load) => String(load._id));

  const locationRequirement = await getDriverLocationRequirement(
    user._id.toString(),
    organizationId,
    {
      operationalStatus: statusContext.operationalStatus,
      emergencyReleaseActive: statusContext.emergencyReleaseActive,
      activeLoadIds,
    },
  );

  const retainedRequiredIds = new Set(locationRequirement.retainedLoadIds);
  const data = (loads as any[]).map((load) => ({
    ...load,
    // Frontend GPS enforcement reads this policy from the same load refresh it
    // already performs. No extra endpoint or competing policy source is needed.
    dispatchGpsRequired:
      locationRequirement.reason === "dispatch_retained_load" &&
      retainedRequiredIds.has(String(load._id)),
  }));

  return res.status(200).json(new ApiResponse(200, data, "My loads fetched"));
});

// GET /api/driver-tracking/available-loads
// BUSINESS RULE CHANGE: drivers see the COMPLETE load record for available
// loads — pickup/delivery contacts, dates, notes, pricing, trailer type and
// every other field captured during Create Load. The previous restrictive
// .select() has been removed.
const getAvailableLoads = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  const filter = {
    organizationId,
    status: "Posted",
    $or: [{ assignedDriverId: null }, { assignedDriverId: { $exists: false } }],
  };

  const [loads, total] = await Promise.all([
    Load.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Load.countDocuments(filter),
  ]);

  const myId = user._id.toString();
  const data = (loads as any[]).map((l) => ({
    ...l,
    hasRequested: Array.isArray(l.driverRequests)
      ? l.driverRequests.some((r: any) => String(r.driverId) === myId)
      : false,
  }));

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
const getMyRequests = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const loads = await Load.find({
    organizationId,
    status: "Posted",
    "driverRequests.driverId": user._id,
  })
    .sort({ createdAt: -1 })
    .lean();

  const myId = user._id.toString();
  const data = (loads as any[]).map((l) => {
    const mine = (l.driverRequests ?? []).find((r: any) => String(r.driverId) === myId);
    return { ...l, myRequestStatus: "pending", myRequestedAt: mine?.requestedAt ?? null };
  });

  return res.status(200).json(new ApiResponse(200, data, "My requests fetched"));
});

// GET /api/driver-tracking/loads/:id
// BUSINESS RULE CHANGE: no driver masking — the full load record is
// returned. maskLoadForDriver is no longer used anywhere.
const getLoadDetail = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId })
    .populate("assignedDriverId", "name email phone avatar")
    .lean();
  if (!load) throw new ApiError(404, "Load not found");

  return res.status(200).json(new ApiResponse(200, load, "Load fetched"));
});

// ─── Available-load request / approval flow ──────────────────────────────────

// POST /api/driver-tracking/loads/:id/request
const requestLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { note } = req.body as { note?: string };
  const signature = parseDriverSignature(req.body);

  await assertDriverCanTakeNewWork(
    user._id.toString(),
    organizationId,
    "request",
  );

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (load.status !== "Posted" || load.assignedDriverId) {
    throw new ApiError(400, "This load is no longer available");
  }

  const profile = await DriverProfile.findOne({ userId: user._id }).lean();
  const maxCapacity = (profile as any)?.maxVehicleCapacity ?? DEFAULT_MAX_CAPACITY;
  const activeCount = await Load.countDocuments({
    organizationId,
    assignedDriverId: user._id,
    status: { $in: ACTIVE_LOAD_STATUSES },
  });
  if (activeCount >= maxCapacity) {
    throw new ApiError(400, "You are at your active load capacity");
  }

  const requests: any[] = (load as any).driverRequests ?? [];
  if (requests.some((r) => String(r.driverId) === user._id.toString())) {
    throw new ApiError(400, "You have already requested this load");
  }

  requests.push({
    driverId: user._id,
    requestedAt: new Date(),
    note: (note ?? "").slice(0, 500),
  });
  (load as any).driverRequests = requests;
  (load as any).driverContract = {
    agreedToTerms: true,
    signedAt: new Date(),
    signatureDataUrl: signature.signatureDataUrl,
    signerName: signature.signerName || user.name || "",
  };
  await load.save();

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
const approveLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { driverId } = req.body as { driverId?: string };

  if (!driverId) throw new ApiError(400, "driverId is required");

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  if (load.status !== "Posted" || load.assignedDriverId) {
    throw new ApiError(400, "This load is no longer available");
  }

  const requests: any[] = (load as any).driverRequests ?? [];
  if (!requests.some((r) => String(r.driverId) === driverId)) {
    throw new ApiError(400, "That driver has not requested this load");
  }

  await assertDriverCanTakeNewWork(driverId, organizationId, "approve");

  load.assignedDriverId = driverId as any;
  (load as any).dispatchOwnerId = user._id;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  (load as any).driverRequests = [];
  await load.save();

  emitLoadSync(organizationId, [driverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "driver_request_approved",
    title: "Load Request Approved",
    message: `Your request for load ${load.loadNumber} was approved`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  await persistDispatcherLoadChatEvent({
    dispatcher: user,
    organizationId,
    driverId,
    eventType: "driver_load_request_approved",
    title: "Load Request Approved",
    message: `Dispatch approved your request and assigned load ${load.loadNumber} to you.`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      action: "request_approved_assigned",
    },
  });

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await logLoadActivityLoose(
      user._id.toString(),
      organizationId,
      "load_assigned",
      load._id.toString(),
      `Approved driver request for load ${load.loadNumber}`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Request approved"));
});

// POST /api/driver-tracking/loads/:id/reject-request  { driverId }
const rejectLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const dispatcher = getUser(req);
  const organizationId = req.orgId as string;
  const { driverId } = req.body as { driverId?: string };

  if (!driverId) throw new ApiError(400, "driverId is required");

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");

  const requests: any[] = (load as any).driverRequests ?? [];
  (load as any).driverRequests = requests.filter(
    (r) => String(r.driverId) !== driverId,
  );
  await load.save();

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
    message: `Dispatch declined your request for load ${load.loadNumber}.`,
    metadata: {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      action: "request_rejected",
    },
  });

  return res.status(200).json(new ApiResponse(200, load, "Request rejected"));
});


// ─── Pending Load Requests (dispatcher view) ─────────────────────────────────
// GET /api/driver-tracking/load-requests

const getPendingLoadRequests = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const loads = await Load.find({
    organizationId,
    assignedDriverId: null,
    status: "Posted",
    "driverRequests.0": { $exists: true },
  })
    .select("loadNumber pickupLocation deliveryLocation vehicles trailerType driverRequests")
    .lean();

  const driverIds: string[] = [
    ...new Set<string>(
      loads.flatMap((load: any) =>
        (load.driverRequests ?? []).map((request: any) => String(request.driverId)),
      ),
    ),
  ];

  const [drivers, profiles, eligibilityPairs] = await Promise.all([
    User.find({
      _id: { $in: driverIds },
      organizationId,
      role: "driver",
    })
      .select("name email avatar")
      .lean(),
    DriverProfile.find({ userId: { $in: driverIds }, organizationId }).lean(),
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

  const requests = loads.flatMap((load: any) =>
    (load.driverRequests ?? []).map((request: any) => {
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

const sendDriverAlert = asyncHandler(async (req: Request, res: Response) => {
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

  const driver = await User.findOne({
    _id: driverId,
    organizationId,
    role: "driver",
    isActive: true,
  })
    .select("name email")
    .lean();

  if (!driver) throw new ApiError(404, "Driver not found in this organization");

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
const respondToDriverAlert = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { alertId } = req.params;
  const { response } = req.body as {
    response?: "acknowledged" | "on_my_way" | "unable";
  };

  const allowedResponses = ["acknowledged", "on_my_way", "unable"];
  if (!response || !allowedResponses.includes(response)) {
    throw new ApiError(400, "A valid response is required");
  }

  const notification: any = await Notification.findOne({
    _id: alertId,
    userId: user._id,
    organizationId,
    type: "driver_dispatch_alert",
  });

  if (!notification) throw new ApiError(404, "Driver alert not found");

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

// POST /api/driver-tracking/loads/:id/accept  { signatureDataUrl, signerName }
const acceptLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const signature = parseDriverSignature(req.body);

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Assigned") {
    throw new ApiError(400, `Cannot accept a load in ${load.status} status`);
  }

  await assertDriverCanTakeNewWork(
    user._id.toString(),
    organizationId,
    "accept",
  );

  if (!(load as any).dispatchOwnerId) {
    const explicitOwner =
      await resolveExplicitDispatchOwnerFromAssignmentHistory({
        organizationId,
        driverId: user._id.toString(),
        loadId: load._id.toString(),
      });
    if (explicitOwner) {
      (load as any).dispatchOwnerId = explicitOwner;
    }
  }

  load.status = "Accepted";
  (load as any).acceptedAt = new Date();
  (load as any).driverContract = {
    agreedToTerms: true,
    signedAt: new Date(),
    signatureDataUrl: signature.signatureDataUrl,
    signerName: signature.signerName || user.name || "",
  };
  await load.save();

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_accepted",
      "Load Accepted",
      `${user.name} accepted load ${load.loadNumber}`,
      { loadId: load._id.toString(), loadNumber: load.loadNumber },
      user._id.toString(),
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Load accepted"));
});

// POST /api/driver-tracking/loads/:id/pickup
const markPickedUp = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Accepted") {
    throw new ApiError(400, `Cannot mark pickup from ${load.status} status`);
  }

  load.status = "Picked Up";
  (load as any).pickedUpAt = new Date();
  await load.save();

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_picked_up",
      "Vehicles Picked Up",
      `${user.name} picked up load ${load.loadNumber}`,
      { loadId: load._id.toString(), loadNumber: load.loadNumber },
      user._id.toString(),
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Pickup recorded"));
});

// POST /api/driver-tracking/loads/:id/start-route
const startRoute = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Picked Up") {
    throw new ApiError(400, `Cannot start route from ${load.status} status`);
  }

  load.status = "In-Transit";
  (load as any).inTransitAt = new Date();
  await load.save();

  await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    { $set: { status: "on-route", lastSeenAt: new Date() } },
  );

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_in_transit",
      "Load In Transit",
      `${user.name} started the route for load ${load.loadNumber}`,
      { loadId: load._id.toString(), loadNumber: load.loadNumber },
      user._id.toString(),
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Route started"));
});

// POST /api/driver-tracking/loads/:id/drop
// Driver releases an assigned load → returns the same Transportation load to the available pool
const dropLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  const { reason } = req.body as { reason?: string };

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  requireAssignedDriver(load, user._id.toString());
  if (!["Assigned", "Accepted"].includes(load.status)) {
    throw new ApiError(
      400,
      `Cannot release a load in ${load.status} status — contact dispatch`,
    );
  }

  // Release only the current operational assignment. The original creator
  // (`createdBy`) and the rest of the Transportation load record are preserved.
  load.assignedDriverId = undefined as any;
  (load as any).dispatchOwnerId = undefined;
  load.status = "Posted";
  await load.save();

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_dropped",
      "Load Released",
      `${user.name} released load ${load.loadNumber} back to Available Loads${reason ? `: ${String(reason).slice(0, 200)}` : ""}`,
      { loadId: load._id.toString(), loadNumber: load.loadNumber },
      user._id.toString(),
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await logLoadActivityLoose(
      user._id.toString(),
      organizationId,
      "load_dropped",
      load._id.toString(),
      `Driver released load ${load.loadNumber} — returned to Transportation Available Loads`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  try {
    await finalizeDriverStatusChangeIfClear(user._id.toString(), organizationId);
  } catch (err) {
    logger.error({ err, driverId: user._id }, "Non-fatal: failed to finalize driver status transition after load release");
  }

  return res.status(200).json(new ApiResponse(200, load, "Load released"));
});

export default {
  heartbeat,
  markLocationOffline,
  getActiveDrivers,
  getDashboardStats,
  getPendingLoadRequests,
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
  dropLoad,
};