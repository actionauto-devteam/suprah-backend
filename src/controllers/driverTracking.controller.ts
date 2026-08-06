import { Request, Response } from "express";
// c
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import logger from "../utils/logger";
import { getSocketIO } from "../utils/socketEmitter";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";
import activityService from "../services/activity.service";

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

  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new ApiError(400, "lat and lng are required numbers");
  }

  const allowedStatuses = ["on-route", "idle", "on-break", "waiting", "offline"];
  const nextStatus =
    status && allowedStatuses.includes(status) ? status : undefined;

  const location = await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        organizationId,
        coords: { lat, lng },
        lastSeenAt: new Date(),
        ...(nextStatus ? { status: nextStatus } : {}),
      },
      $setOnInsert: { status: nextStatus ?? "idle" },
    },
    { new: true, upsert: true },
  );

  const io = getSocketIO();
  if (io) {
    io.to(`org:${organizationId}`).emit("driver:location", {
      driverId: user._id.toString(),
      coords: location.coords,
      status: location.status,
      lastSeenAt: location.lastSeenAt,
    });
  }

  return res
    .status(200)
    .json(new ApiResponse(200, { ok: true }, "Location updated"));
});

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

      return {
        id: key,
        status: loc.status ?? "idle",
        coords: loc.coords ?? null,
        lastSeenAt: loc.lastSeenAt ?? null,
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
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot assign a load in ${load.status} status`);
  }

  load.assignedDriverId = driver._id as any;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  (load as any).driverRequests = [];
  await load.save();

  emitLoadSync(organizationId, [driverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "load_assigned",
    title: "New Load Assigned",
    message: `You've been assigned load ${load.loadNumber}`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
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
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot reassign a load in ${load.status} status`);
  }

  const previousDriverId = load.assignedDriverId
    ? load.assignedDriverId.toString()
    : null;

  load.assignedDriverId = driver._id as any;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  await load.save();

  emitLoadSync(organizationId, [previousDriverId, driverId], load._id.toString());

  if (previousDriverId && previousDriverId !== driverId) {
    await safeCreateNotificationLoose({
      userId: previousDriverId,
      organizationId,
      type: "load_reassigned",
      title: "Load Reassigned",
      message: `Load ${load.loadNumber} has been reassigned to another driver`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    });
  }
  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "load_assigned",
    title: "New Load Assigned",
    message: `You've been assigned load ${load.loadNumber}`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
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
  load.status = "Posted";
  await load.save();

  emitLoadSync(organizationId, [previousDriverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: previousDriverId,
    organizationId,
    type: "load_removed",
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

  return res.status(200).json(new ApiResponse(200, load, "Driver removed from load"));
});

// ─── Driver's Account: my loads / available loads / detail ───────────────────

// GET /api/driver-tracking/my-loads
const getMyLoads = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const loads = await Load.find({
    organizationId,
    assignedDriverId: user._id,
    status: { $nin: ["Cancelled"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  return res.status(200).json(new ApiResponse(200, loads, "My loads fetched"));
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
  await load.save();

  emitLoadSync(organizationId, [], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_requested",
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

  load.assignedDriverId = driverId as any;
  load.status = "Assigned";
  (load as any).assignedAt = new Date();
  (load as any).driverRequests = [];
  await load.save();

  emitLoadSync(organizationId, [driverId], load._id.toString());

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "load_request_approved",
    title: "Load Request Approved",
    message: `Your request for load ${load.loadNumber} was approved`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
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

  await safeCreateNotificationLoose({
    userId: driverId,
    organizationId,
    type: "load_request_rejected",
    title: "Load Request Declined",
    message: `Your request for load ${load.loadNumber} was declined`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  return res.status(200).json(new ApiResponse(200, load, "Request rejected"));
});

// ─── Driver status transitions ───────────────────────────────────────────────

const requireAssignedDriver = (load: any, userId: string) => {
  if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) {
    throw new ApiError(403, "You are not the assigned driver for this load");
  }
};

// POST /api/driver-tracking/loads/:id/accept
const acceptLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");
  requireAssignedDriver(load, user._id.toString());
  if (load.status !== "Assigned") {
    throw new ApiError(400, `Cannot accept a load in ${load.status} status`);
  }

  load.status = "Accepted";
  (load as any).acceptedAt = new Date();
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
// Driver declines an assigned load → returns to the available pool
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
      `Cannot drop a load in ${load.status} status — contact dispatch`,
    );
  }

  load.assignedDriverId = undefined as any;
  load.status = "Posted";
  await load.save();

  emitLoadSync(organizationId, [user._id.toString()], load._id.toString());

  // Non-fatal: the state change + socket emit already succeeded —
  // a logging/notification failure must not turn success into a 500
  try {
    await notifyOrgAdminsLoose(
      organizationId,
      "load_dropped",
      "Load Dropped",
      `${user.name} dropped load ${load.loadNumber}${reason ? `: ${String(reason).slice(0, 200)}` : ""}`,
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
      `Driver dropped load ${load.loadNumber} — returned to available pool`,
    );
  } catch (err) {
    logger.error({ err }, "Non-fatal: post-update side effect failed");
  }

  return res.status(200).json(new ApiResponse(200, load, "Load dropped"));
});

export default {
  heartbeat,
  getActiveDrivers,
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