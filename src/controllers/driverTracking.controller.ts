import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation, { DriverStatus } from "../models/DriverLocation.model";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import AuditLog from "../models/AuditLog.model";
import DriverProfile from "../models/DriverProfile.model";
import {
  safeCreateNotification,
  notifyOrgAdmins,
} from "../utils/safeNotification";
import { notificationTemplates } from "../utils/notificationTemplates";
import { getSocketIO } from "../utils/socketEmitter";
import { getSignedProofUrl } from "../utils/signedUrlCache";
import { maskLoadForDriver } from "../utils/loadMask";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) {
    throw new ApiError(401, "User not authenticated");
  }
  return user._id.toString();
};

const hasShipmentSchedule = (shipment: any) =>
  Boolean(shipment?.scheduledPickup && shipment?.scheduledDelivery);

const hasLoadSchedule = (load: any) =>
  Boolean(load?.dates?.pickupDeadline && load?.dates?.deliveryDeadline);

const updateLocation = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");

  if (user.role !== "driver") {
    throw new ApiError(403, "Only drivers can share location");
  }

  if (!user.organizationId) {
    throw new ApiError(403, "Driver must be assigned to an organization");
  }

  const userId = user._id.toString();
  const orgId = user.organizationId.toString();
  const { lat, lng, status } = req.body as {
    lat: number;
    lng: number;
    status?: DriverStatus;
  };

  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new ApiError(400, "Latitude and longitude are required");
  }

  if (
    status &&
    !["on-route", "idle", "on-break", "waiting", "offline"].includes(status)
  ) {
    throw new ApiError(400, "Invalid driver status");
  }

  const updateData: any = {
    userId,
    organizationId: orgId,
    coords: { lat, lng },
    lastSeenAt: new Date(),
    offlineAlertSentAt: null, // fresh ping — clear so a future silence gap can alert again
  };

  if (status) {
    updateData.status = status;
  }

  const location = await DriverLocation.findOneAndUpdate(
    { userId },
    { $set: updateData },
    { new: true, upsert: true },
  );

  const io = getSocketIO();
  if (io) {
    io.to(`org:${orgId}`).emit("driver:location_update", {
      driverId: userId,
      coords: { lat, lng },
      status: location.status,
      lastSeenAt: location.lastSeenAt,
    });

    const driverLocation = await DriverLocation.findOne({ userId }).populate(
      "shipmentIds",
    );
    if (driverLocation?.shipmentIds?.length) {
      for (const shipmentId of driverLocation.shipmentIds) {
        io.to(`shipment:${shipmentId.toString()}`).emit(
          "driver:location_update",
          {
            driverId: userId,
            coords: { lat, lng },
            status: location.status,
            lastSeenAt: location.lastSeenAt,
          },
        );
      }
    }
  }

  res.json(new ApiResponse(200, location, "Driver location updated"));

  if (status) {
    await AuditLog.create({
      entityType: "Driver",
      entityId: userId,
      action: "UPDATE",
      reason: "Driver status updated",
      performedBy: userId,
      changes: { status, lat, lng },
    });
  }
});

const getActiveDrivers = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status } = req.query;

  const activeLoads = await Load.find(
    {
      organizationId: orgId,
      assignedDriverId: { $exists: true, $ne: null },
      status: { $in: ["Assigned", "Accepted", "Picked Up", "In-Transit"] },
    },
    "_id assignedDriverId loadNumber status pickupLocation deliveryLocation proofOfDelivery",
  ).sort({ assignedAt: -1 });

  // 2. Fetch driver user IDs for this org first, then filter locations at the DB level
  const driverUsers = await User.find({ organizationId: orgId, role: "driver", isActive: true })
    .select("_id")
    .lean();
  const driverUserIds = driverUsers.map((u: any) => u._id);

  const locationFilter: any = {
    organizationId: orgId,
    userId: { $in: driverUserIds },
  };
  if (status && status !== "all") {
    locationFilter.status = status;
  }

  const locations = await DriverLocation.find(locationFilter)
    .populate("userId", "name email avatar role")
    .sort({ lastSeenAt: -1 });

  const loadsByDriver = new Map<string, any[]>();

  // Build a map of driverId → their active loads (all already scoped to this org)
  for (const load of activeLoads) {
    const assignedDriverId = (load as any).assignedDriverId?.toString();
    if (!assignedDriverId) continue;

    if (!loadsByDriver.has(assignedDriverId)) {
      loadsByDriver.set(assignedDriverId, []);
    }

    const pickup = (load as any).pickupLocation;
    const delivery = (load as any).deliveryLocation;
    const origin = `${pickup?.city || ""}${pickup?.state ? `, ${pickup.state}` : ""}`.trim();
    const destination = `${delivery?.city || ""}${delivery?.state ? `, ${delivery.state}` : ""}`.trim();
    const proof = (load as any).proofOfDelivery;
    loadsByDriver.get(assignedDriverId)!.push({
      id: (load as any)._id.toString(),
      trackingNumber: (load as any).loadNumber,
      status: (load as any).status,
      origin,
      destination,
      __docType: "load",
      proofPending: !!(proof?.imageUrl && !proof?.confirmedAt),
    });
  }

  const profilesByUserId = await DriverProfile.find(
    { userId: { $in: driverUserIds } },
    "userId trailerType maxVehicleCapacity operationalStatus profileCompletionScore isComplianceExpired truckMake truckModel",
  ).lean();

  const profileByUserId = new Map(
    profilesByUserId.map((p: any) => [p.userId.toString(), p]),
  );

  const data = locations
    .filter((location: any) => location.userId != null)
    .map((location: any) => {
      const dProfile = profileByUserId.get(location.userId._id.toString());
      return {
        id: location._id.toString(),
        status: location.status,
        coords: location.coords,
        lastSeenAt: location.lastSeenAt,
        driver: {
          id: location.userId._id.toString(),
          name: location.userId.name,
          email: location.userId.email,
          avatar: location.userId.avatar,
        },
        equipment: dProfile
          ? {
            trailerType: dProfile.trailerType,
            maxVehicleCapacity: dProfile.maxVehicleCapacity,
            operationalStatus: dProfile.operationalStatus,
            truckMake: dProfile.truckMake,
            truckModel: dProfile.truckModel,
            isComplianceExpired: dProfile.isComplianceExpired,
            profileCompletionScore: dProfile.profileCompletionScore,
          }
          : null,
        shipments: loadsByDriver.get(location.userId._id.toString()) || [],
      };
    });

  res.json(
    new ApiResponse(
      200,
      data,
      "Driver locations fetched (redacted for privacy)",
    ),
  );
});

const assignLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, loadId, driverId } = req.body as {
    shipmentId?: string;
    loadId?: string;
    driverId?: string;
  };

  const targetLoadId = loadId || shipmentId;

  if (!targetLoadId || !driverId) {
    throw new ApiError(400, "Load ID and driver ID are required");
  }

  const driver = await User.findById(driverId);
  if (!driver) {
    throw new ApiError(404, "Driver not found");
  }
  if (driver.role !== "driver") {
    throw new ApiError(400, "User is not a driver");
  }

  const driverLocation = await DriverLocation.findOne({ userId: driverId });
  const driverOrgId =
    driver.organizationId?.toString() ||
    driverLocation?.organizationId?.toString();
  if (driverOrgId !== orgId) {
    throw new ApiError(403, "Driver does not belong to your organization");
  }

  const load = await Load.findOne({ _id: targetLoadId, organizationId: orgId });
  if (load) {
    const alreadyAssigned = load.assignedDriverId;
    const unassignableStatuses = ["Posted", "Draft"];
    if (alreadyAssigned && !unassignableStatuses.includes(load.status)) {
      throw new ApiError(409, "This load is already assigned to a driver. Remove the current assignment first.");
    }
  }

  const updatedLoad = await Load.findOneAndUpdate(
    { _id: targetLoadId, organizationId: orgId },
    {
      $set: {
        assignedDriverId: driver._id,
        assignedAt: new Date(),
        status: "Assigned",
      },
    },
    { new: true },
  );

  if (!updatedLoad) {
    throw new ApiError(404, "Load not found");
  }

  await DriverLocation.findOneAndUpdate(
    { userId: driver._id },
    { $addToSet: { shipmentIds: updatedLoad._id } },
    { new: true },
  );

  const { title: loadTitle, message: loadMessage } =
    notificationTemplates.shipment_assigned({
      trackingNumber: updatedLoad.loadNumber || "N/A",
    });

  await safeCreateNotification({
    userId: driver._id.toString(),
    organizationId: orgId || "global",
    type: "shipment_assigned",
    title: loadTitle,
    message: loadMessage,
    metadata: {
      loadId: updatedLoad._id.toString(),
      loadNumber: updatedLoad.loadNumber,
    },
  });

  await notifyOrgAdmins(
    orgId,
    "driver_assigned",
    "Load Assigned to Driver",
    `${updatedLoad.loadNumber} assigned to ${driver.name || driver.email}`,
    {
      loadId: updatedLoad._id.toString(),
      loadNumber: updatedLoad.loadNumber,
      driverId: driver._id.toString(),
      driverName: driver.name || driver.email,
    },
    (req.user as any)?._id?.toString(),
  );

  const _ioLoadAssign = getSocketIO();
  if (_ioLoadAssign) {
    _ioLoadAssign
      .to(`org:${orgId}`)
      .emit("driver:loads_updated", {
        action: "assigned",
        loadId: updatedLoad._id.toString(),
        driverId: driver._id.toString(),
      });
  }

  res.json(new ApiResponse(200, updatedLoad, "Load assigned"));

  await AuditLog.create({
    entityType: "Load",
    entityId: updatedLoad._id,
    action: "UPDATE",
    reason: "Load assigned to driver",
    performedBy: (req.user as any)?._id,
    changes: { assignedDriverId: driver._id, status: "Assigned" },
  });
});

// POST /accept-load — driver accepts a load (no org required)
const acceptLoad = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { loadId } = req.body as { loadId?: string };

  if (!loadId) {
    throw new ApiError(400, "Load ID is required");
  }

  const driverProfile = await DriverProfile.findOne({ userId });
  const maxCap = driverProfile?.maxVehicleCapacity || 12;
  const activeLoadCount = await Load.countDocuments({
    assignedDriverId: userId,
    status: { $nin: ["Delivered", "Cancelled"] },
  });

  if (activeLoadCount >= maxCap) {
    throw new ApiError(
      400,
      `You've reached your active load limit (${activeLoadCount}/${maxCap}). Complete or drop a load first.`,
    );
  }

  const load = await Load.findById(loadId);
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) {
    throw new ApiError(403, "You are not assigned to this load");
  }
  if (load.status !== "Assigned") throw new ApiError(400, "Load must be in Assigned status to accept");

  load.driverAcceptedAt = new Date();
  load.acceptedAt = new Date();
  load.status = "Accepted";
  await load.save();

  const driver = await User.findById(userId).select('name email');

  await safeCreateNotification({
    userId,
    organizationId: load.organizationId?.toString() || 'global',
    type: 'shipment_assigned',
    title: 'Load Accepted',
    message: `You accepted load ${load.loadNumber}. Head to the pickup location.`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  if (load.organizationId) {
    await notifyOrgAdmins(load.organizationId.toString(), 'shipment_status_changed', 'Load Accepted by Driver',
      `${driver?.name || driver?.email || 'Driver'} accepted load ${load.loadNumber}`,
      { loadId: load._id.toString(), loadNumber: load.loadNumber, driverId: userId, driverName: driver?.name || driver?.email, status: "Accepted" });
    const io = getSocketIO();
    if (io) io.to(`org:${load.organizationId.toString()}`).emit("driver:loads_updated", { action: "accepted", loadId, driverId: userId, status: "Accepted" });
  }
  res.json(new ApiResponse(200, load, "Load accepted"));
  await AuditLog.create({ entityType: "Load", entityId: load._id, action: "UPDATE", reason: "Driver accepted load", performedBy: userId, changes: { status: "Accepted", acceptedAt: load.acceptedAt } });
});

// GET /my-loads — driver fetches their assigned loads (no org required)
const getMyLoads = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
  const skip = (page - 1) * limit;

  const [loads, total, driverProfile] = await Promise.all([
    Load.find({ assignedDriverId: userId }).sort({ assignedAt: -1 }).skip(skip).limit(limit).lean(),
    Load.countDocuments({ assignedDriverId: userId }),
    DriverProfile.findOne({ userId }, "maxVehicleCapacity trailerType").lean(),
  ]);

  // Normalize Load documents to a consistent shape for the frontend
  const normalizedLoads = loads.map((l: any) => ({
    ...l,
    __docType: "load",
    origin: l.pickupLocation ? `${l.pickupLocation.city}, ${l.pickupLocation.state}` : undefined,
    destination: l.deliveryLocation ? `${l.deliveryLocation.city}, ${l.deliveryLocation.state}` : undefined,
    trackingNumber: l.loadNumber,
  }));

  const signProofUrl = async (item: any) => {
    const url = item?.proofOfDelivery?.imageUrl;
    if (!url) return item;
    const signed = await getSignedProofUrl(url);
    if (!signed) return item;
    return { ...item, proofOfDelivery: { ...item.proofOfDelivery, imageUrl: signed } };
  };

  const signedLoads = await Promise.all((normalizedLoads as any[]).map(signProofUrl));

  const activeCount = signedLoads.filter(
    (l: any) => l.status !== "Delivered" && l.status !== "Cancelled",
  ).length;

  res.json(
    new ApiResponse(
      200,
      {
        loads: signedLoads,
        activeLoadCount: activeCount,
        maxLoadCapacity: driverProfile?.maxVehicleCapacity || 12,
        trailerType: driverProfile?.trailerType || null,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
      },
      "Assigned loads fetched",
    ),
  );
});

const removeLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, loadId: bLoadId } = req.body as { shipmentId?: string; loadId?: string };
  const loadId = bLoadId || shipmentId;

  if (!loadId) throw new ApiError(400, "Load ID is required");

  const load = await Load.findOne({ _id: loadId, organizationId: orgId });
  if (!load) throw new ApiError(404, "Load not found");

  const previousDriverId = load.assignedDriverId?.toString();

  await Load.findByIdAndUpdate(loadId, {
    $set: { status: "Posted" },
    $unset: { assignedDriverId: 1, assignedAt: 1, driverAcceptedAt: 1 },
  });

  if (previousDriverId) {
    await DriverLocation.findOneAndUpdate(
      { userId: previousDriverId },
      { $pull: { shipmentIds: load._id } },
    );
    const driver = await User.findById(previousDriverId).select("name email");
    await safeCreateNotification({
      userId: previousDriverId,
      organizationId: orgId,
      type: "shipment_removed",
      title: "Load Removed",
      message: `Load ${load.loadNumber || "N/A"} has been removed from your assignments`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    });
    await notifyOrgAdmins(
      orgId,
      "shipment_status_changed",
      "Load Removed from Driver",
      `Load ${load.loadNumber} removed from ${driver?.name || driver?.email || "driver"}`,
      { loadId: load._id.toString(), driverId: previousDriverId },
      (req.user as any)?._id?.toString(),
    );
  }

  const ioLoad = getSocketIO();
  if (ioLoad)
    ioLoad
      .to(`org:${orgId}`)
      .emit("driver:loads_updated", {
        action: "removed",
        loadId: load._id.toString(),
      });

  res.json(new ApiResponse(200, null, "Load removed from driver"));

  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Load removed from driver by admin",
    performedBy: (req.user as any)?._id,
    changes: { assignedDriverId: null, status: "Posted" },
  });
});

const dropLoad = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { loadId } = req.body as { loadId?: string };
  if (!loadId) throw new ApiError(400, "Load ID is required");

  const load = await Load.findById(loadId);
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId)
    throw new ApiError(403, "You are not assigned to this load");

  const orgId = load.organizationId?.toString();
  // Revert to Assigned (not Posted) so dispatcher keeps visibility — driver stays linked
  await Load.findByIdAndUpdate(loadId, {
    $set: { status: "Assigned", droppedAt: new Date() },
    $unset: { driverAcceptedAt: 1, acceptedAt: 1, pickedUpAt: 1 },
  });

  const driver = await User.findById(userId).select("name email");
  if (orgId) {
    await notifyOrgAdmins(
      orgId,
      "shipment_status_changed",
      "Load Dropped by Driver",
      `${driver?.name || driver?.email || "Driver"} dropped load ${load.loadNumber || "N/A"} — assignment reverted to Assigned. Remove or reassign the driver.`,
      {
        loadId: load._id.toString(),
        driverId: userId,
        driverName: driver?.name,
      },
    );
    const io = getSocketIO();
    if (io)
      io.to(`org:${orgId}`).emit("driver:loads_updated", {
        action: "dropped",
        loadId,
        driverId: userId,
      });
  }
  res.json(new ApiResponse(200, null, "Load dropped"));
  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Driver dropped load",
    performedBy: userId,
    changes: { assignedDriverId: null, status: "Posted" },
  });
});

const reassignLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, loadId: bLoadId, newDriverId } = req.body as {
    shipmentId?: string;
    loadId?: string;
    newDriverId?: string;
  };
  const loadId = bLoadId || shipmentId;
  if (!loadId || !newDriverId)
    throw new ApiError(400, "Load ID and new driver ID are required");

  const newDriver = await User.findById(newDriverId);
  if (!newDriver) throw new ApiError(404, "Driver not found");
  if (newDriver.role !== "driver")
    throw new ApiError(400, "User is not a driver");

  const driverLocation = await DriverLocation.findOne({ userId: newDriverId });
  const driverOrgId =
    newDriver.organizationId?.toString() ||
    driverLocation?.organizationId?.toString();
  if (driverOrgId !== orgId)
    throw new ApiError(403, "Driver does not belong to your organization");

  const load = await Load.findOne({ _id: loadId, organizationId: orgId });
  if (!load) throw new ApiError(404, "Load not found");

  const previousLoadDriverId = load.assignedDriverId?.toString();
  if (previousLoadDriverId) {
    await DriverLocation.findOneAndUpdate({ userId: previousLoadDriverId }, { $pull: { shipmentIds: load._id } });
    await safeCreateNotification({
      userId: previousLoadDriverId, organizationId: orgId, type: "shipment_reassigned",
      title: "Load Reassigned",
      message: `Load ${load.loadNumber || "N/A"} has been reassigned to another driver`,
      metadata: { loadId: load._id.toString() },
    });
  }

  const updatedLoad = await Load.findByIdAndUpdate(loadId, {
    $set: { assignedDriverId: newDriver._id, assignedAt: new Date(), status: "Assigned" },
    $unset: { driverAcceptedAt: 1, acceptedAt: 1, pickedUpAt: 1 },
  }, { new: true });

  await DriverLocation.findOneAndUpdate(
    { userId: newDriver._id },
    { $addToSet: { shipmentIds: load._id } },
    { new: true },
  );

  const loadOrigin = `${load.pickupLocation?.city || ""}, ${load.pickupLocation?.state || ""}`;
  const loadDest = `${load.deliveryLocation?.city || ""}, ${load.deliveryLocation?.state || ""}`;

  await safeCreateNotification({
    userId: newDriverId, organizationId: orgId, type: "shipment_assigned",
    title: "New Load Assigned",
    message: `Load ${load.loadNumber || "N/A"}: ${loadOrigin} → ${loadDest}`,
    metadata: { loadId: load._id.toString() },
  });

  await notifyOrgAdmins(
    orgId, "shipment_status_changed", "Load Reassigned",
    `Load ${load.loadNumber} reassigned to ${newDriver.name || newDriver.email}`,
    { loadId: load._id.toString(), newDriverId },
    (req.user as any)?._id?.toString(),
  );

  const ioLoad = getSocketIO();
  if (ioLoad) ioLoad.to(`org:${orgId}`).emit("driver:loads_updated", { action: "reassigned", loadId: load._id.toString() });

  res.json(new ApiResponse(200, updatedLoad, "Load reassigned"));

  await AuditLog.create({
    entityType: "Load", entityId: load._id, action: "UPDATE",
    reason: "Load reassigned to another driver", performedBy: (req.user as any)?._id,
    changes: { previousDriverId: previousLoadDriverId, newDriverId },
  });
});

const startRoute = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver")
    throw new ApiError(403, "Only drivers can access this");

  const { loadId } = req.body as { loadId?: string };
  if (!loadId)
    throw new ApiError(400, "Load ID is required");

  const load = await Load.findById(loadId);
  if (!load) throw new ApiError(404, "Load not found");
  if (
    !load.assignedDriverId ||
    load.assignedDriverId.toString() !== user._id.toString()
  ) {
    throw new ApiError(403, "You are not assigned to this load");
  }
  if (load.status === "In-Transit") return res.json(new ApiResponse(200, load, "Already in transit"));
  if (load.status !== "Picked Up") throw new ApiError(400, "Load must be in Picked Up status to start route");

  load.status = "In-Transit";
  load.inTransitAt = new Date();
  await load.save();

  await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    { $set: { status: "on-route" as DriverStatus } },
  );

  const orgId = load.organizationId?.toString();
  if (orgId) {
    await notifyOrgAdmins(
      orgId,
      "shipment_status_changed",
      "Driver Started Route",
      `${user.name || user.email} started route for load ${load.loadNumber || "N/A"}`,
      {
        loadId: load._id.toString(),
        driverId: user._id.toString(),
        driverName: user.name || user.email,
        status: "In-Transit",
      },
    );
    const io = getSocketIO();
    if (io)
      io.to(`org:${orgId}`).emit("driver:loads_updated", {
        action: "in-route",
        loadId,
        driverId: user._id.toString(),
        status: "In-Transit",
      });
  }
  res.json(
    new ApiResponse(
      200,
      load,
      "Route started — status updated to In-Transit",
    ),
  );
  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Driver started route",
    performedBy: user._id,
    changes: { status: "In-Transit", inTransitAt: load.inTransitAt },
  });
});

const getAvailableLoads = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver")
    throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString();
  if (!orgId) {
    return res.json(
      new ApiResponse(
        200,
        [],
        "No organization assigned — contact your dispatcher",
      ),
    );
  }

  const userId = user._id.toString();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
  const skip = (page - 1) * limit;

  const loadFilter: any = {
    organizationId: orgId,
    status: "Posted",
    $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
  };

  const [loads, total] = await Promise.all([
    Load.find(loadFilter)
      .select(
        "_id loadNumber status pickupLocation deliveryLocation vehicles dates pricing pendingDriverRequests createdAt trailerType",
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Load.countDocuments(loadFilter),
  ]);

  const mappedLoads = loads.map((l: any) => {
    const myRequest = l.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === userId,
    );
    const firstVehicle = l.vehicles?.[0];
    const vehicleName = firstVehicle
      ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim()
      : undefined;
    return {
      _id: l._id,
      __docType: "load",
      origin: `${l.pickupLocation?.city || ""}${l.pickupLocation?.state ? `, ${l.pickupLocation.state}` : ""}`,
      destination: `${l.deliveryLocation?.city || ""}${l.deliveryLocation?.state ? `, ${l.deliveryLocation.state}` : ""}`,
      trackingNumber: l.loadNumber,
      status: l.status,
      requestedPickupDate: l.dates?.firstAvailable,
      scheduledDelivery: l.dates?.deliveryDeadline,
      trailerTypeRequired: l.trailerType,
      vehicleCount: l.vehicles?.length || 0,
      carrierPayAmount: l.pricing?.carrierPayAmount,
      estimatedRate: l.pricing?.estimatedRate,
      miles: l.pricing?.miles,
      vehicles: l.vehicles,
      preservedQuoteData: vehicleName
        ? { vehicleName, units: l.vehicles?.length }
        : undefined,
      pendingDriverRequests: l.pendingDriverRequests,
      createdAt: l.createdAt,
      myRequestStatus: myRequest?.status || null,
      myRequestedAt: myRequest?.requestedAt || null,
    };
  });

  res.json(
    new ApiResponse(
      200,
      {
        loads: mappedLoads,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
      },
      "Available loads fetched",
    ),
  );
});

const requestLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver")
    throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString();
  if (!orgId)
    throw new ApiError(403, "Driver must be assigned to an organization");

  const { loadId } = req.body as { loadId?: string };
  if (!loadId)
    throw new ApiError(400, "Load ID is required");

  const driverProfile = await DriverProfile.findOne({ userId: user._id });
  if (driverProfile?.isComplianceExpired) {
    throw new ApiError(
      403,
      "Your compliance documents are expired. Please update before requesting loads.",
    );
  }
  if (
    driverProfile?.operationalStatus &&
    driverProfile.operationalStatus !== "active"
  ) {
    throw new ApiError(
      403,
      "Your operational status must be Active to request loads",
    );
  }

  const maxCap = driverProfile?.maxVehicleCapacity || 12;
  const activeLoadCount = await Load.countDocuments({
    assignedDriverId: user._id,
    status: { $nin: ["Delivered", "Cancelled"] },
  });

  if (activeLoadCount >= maxCap) {
    throw new ApiError(
      400,
      `You've reached your active load limit (${activeLoadCount}/${maxCap}). Complete or drop a load first.`,
    );
  }

  // Pre-check vehicle capacity requires reading the load first — fetch it once
  const loadForCapCheck = await Load.findOne({
    _id: loadId,
    organizationId: orgId,
    status: "Posted",
    $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
  }).select("vehicles loadNumber _id").lean();
  if (!loadForCapCheck) throw new ApiError(404, "Load not available");

  if (
    driverProfile?.maxVehicleCapacity &&
    (loadForCapCheck as any).vehicles?.length > driverProfile.maxVehicleCapacity
  ) {
    throw new ApiError(
      400,
      `This load has ${(loadForCapCheck as any).vehicles.length} vehicles. Your trailer supports ${driverProfile.maxVehicleCapacity}.`,
    );
  }

  // Atomic: push request only if load is still Posted, unassigned, and driver hasn't already requested
  const requestEntry = {
    driverId: user._id,
    driverName: user.name || user.email,
    requestedAt: new Date(),
    status: "pending" as const,
  };

  const load = await Load.findOneAndUpdate(
    {
      _id: loadId,
      organizationId: orgId,
      status: "Posted",
      $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
      "pendingDriverRequests.driverId": { $ne: user._id },
    },
    { $push: { pendingDriverRequests: requestEntry } },
    { new: true },
  );
  if (!load) throw new ApiError(400, "Load unavailable or already requested");

  await notifyOrgAdmins(
    orgId,
    "shipment_status_changed",
    "Load Requested by Driver",
    `${user.name || user.email} requested load ${load.loadNumber}`,
    {
      loadId: load._id.toString(),
      driverId: user._id.toString(),
      driverName: user.name || user.email,
    },
  );

  const io = getSocketIO();
  if (io)
    io.to(`org:${orgId}`).emit("driver:load_requested", {
      loadId,
      driverId: user._id.toString(),
      driverName: user.name || user.email,
    });

  res.json(
    new ApiResponse(
      200,
      null,
      "Load request submitted — pending dispatcher approval",
    ),
  );

  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Driver requested load from board",
    performedBy: user._id,
    changes: { requestedBy: user._id.toString() },
  });
});

const getMyRequests = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");

  const orgId = user.organizationId?.toString();
  if (!orgId)
    throw new ApiError(403, "Driver must be assigned to an organization");

  const loads = await Load.find({
    organizationId: orgId,
    "pendingDriverRequests.driverId": user._id,
  })
    .select(
      "_id loadNumber status pickupLocation deliveryLocation vehicles dates pricing pendingDriverRequests createdAt",
    )
    .sort({ createdAt: -1 });

  const userId = user._id.toString();

  const mappedLoads = loads.map((l: any) => {
    const myReq = l.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === userId,
    );
    const firstVehicle = l.vehicles?.[0];
    const vehicleName = firstVehicle
      ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim()
      : undefined;
    return {
      _id: l._id,
      __docType: "load",
      origin: `${l.pickupLocation?.city || ""}${l.pickupLocation?.state ? `, ${l.pickupLocation.state}` : ""}`,
      destination: `${l.deliveryLocation?.city || ""}${l.deliveryLocation?.state ? `, ${l.deliveryLocation.state}` : ""}`,
      trackingNumber: l.loadNumber,
      status: l.status,
      requestedPickupDate: l.dates?.firstAvailable,
      trailerTypeRequired: firstVehicle?.trailerType,
      vehicleCount: l.vehicles?.length || 0,
      carrierPayAmount: l.pricing?.carrierPayAmount,
      vehicles: l.vehicles,
      preservedQuoteData: vehicleName
        ? { vehicleName, units: l.vehicles?.length }
        : undefined,
      pendingDriverRequests: l.pendingDriverRequests,
      createdAt: l.createdAt,
      myRequestStatus: myReq?.status || null,
      myRequestedAt: myReq?.requestedAt || null,
      rejectionReason: myReq?.rejectionReason || null,
    };
  });

  res.json(
    new ApiResponse(
      200,
      mappedLoads,
      "My load requests fetched",
    ),
  );
});

const getLoadDetail = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { loadId } = req.params;

  if (!loadId) {
    throw new ApiError(400, "Load ID is required");
  }

  const user = req.user as IUser;
  const load = await Load.findById(loadId)
    .populate("assignedDriverId", "name email phone avatar")
    .lean();

  if (!load) {
    throw new ApiError(404, "Load not found");
  }

  const loadOrgId = load.organizationId?.toString();
  const userOrgId = user.organizationId?.toString();
  if (loadOrgId !== userOrgId) {
    throw new ApiError(403, "You do not have access to this load");
  }

  const isDriver = user.role === "driver";
  if (isDriver) {
    const isAssignedToMe = load.assignedDriverId && (load.assignedDriverId as any)._id?.toString() === userId;
    const isPosted = load.status === "Posted";
    const hasRequested = load.pendingDriverRequests?.some(
      (r: any) => r.driverId.toString() === userId,
    );

    if (!isAssignedToMe && !isPosted && !hasRequested) {
      throw new ApiError(403, "You are not assigned to this load");
    }
  }

  const processedLoad = isDriver
    ? maskLoadForDriver(load as unknown as Record<string, unknown>)
    : load;

  const loadObj = processedLoad as any;
  if (loadObj.proofOfDelivery?.imageUrl) {
    const signed = await getSignedProofUrl(loadObj.proofOfDelivery.imageUrl);
    if (signed) {
      loadObj.proofOfDelivery.imageUrl = signed;
    }
  }

  const myRequest = load.pendingDriverRequests?.find(
    (r: any) => r.driverId.toString() === userId,
  );

  const firstVehicle = load.vehicles?.[0];
  const vehicleName = firstVehicle
    ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim()
    : undefined;

  const normalized = {
    ...loadObj,
    __docType: "load",
    origin: `${load.pickupLocation?.city || ""}${load.pickupLocation?.state ? `, ${load.pickupLocation.state}` : ""}`,
    destination: `${load.deliveryLocation?.city || ""}${load.deliveryLocation?.state ? `, ${load.deliveryLocation.state}` : ""}`,
    trackingNumber: load.loadNumber,
    requestedPickupDate: load.dates?.firstAvailable,
    scheduledDelivery: load.dates?.deliveryDeadline,
    trailerTypeRequired: load.trailerType,
    vehicleCount: load.vehicles?.length || 0,
    carrierPayAmount: loadObj.pricing?.carrierPayAmount,
    estimatedRate: load.pricing?.estimatedRate,
    miles: load.pricing?.miles,
    vehicles: load.vehicles,
    preservedQuoteData: vehicleName
      ? { vehicleName, units: load.vehicles?.length }
      : undefined,
    myRequestStatus: myRequest?.status || null,
    myRequestedAt: myRequest?.requestedAt || null,
    rejectionReason: myRequest?.rejectionReason || null,
  };

  res.json(new ApiResponse(200, normalized, "Load details fetched"));
});

const approveLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const adminId = (req.user as any)?._id;
  const { loadId, driverId } = req.body as {
    loadId?: string;
    driverId?: string;
  };

  if (!loadId || !driverId)
    throw new ApiError(400, "Load ID and driver ID are required");

  const driver = await User.findById(driverId).select("name email");
  if (!driver) throw new ApiError(404, "Driver not found");

  const now = new Date();

  const load = await Load.findOneAndUpdate(
    {
      _id: loadId,
      organizationId: orgId,
      "pendingDriverRequests": {
        $elemMatch: { driverId: driver._id, status: "pending" },
      },
    },
    {
      $set: {
        "pendingDriverRequests.$.status": "approved",
        "pendingDriverRequests.$.reviewedAt": now,
        "pendingDriverRequests.$.reviewedBy": adminId,
        assignedDriverId: driver._id,
        assignedAt: now,
        status: "Assigned",
      },
    },
    { new: true },
  );

  if (!load) {
    throw new ApiError(
      409,
      "Load no longer available or this request was already processed",
    );
  }

  await Load.updateOne(
    { _id: loadId },
    {
      $set: {
        "pendingDriverRequests.$[el].status": "rejected",
        "pendingDriverRequests.$[el].reviewedAt": now,
        "pendingDriverRequests.$[el].reviewedBy": adminId,
        "pendingDriverRequests.$[el].rejectionReason":
          "Another driver was approved for this load",
      },
    },
    {
      arrayFilters: [
        {
          "el.status": "pending",
          "el.driverId": { $ne: driver._id },
        },
      ],
    },
  );

  const finalLoad = await Load.findById(loadId).lean();
  const rejectedDriverIds = (finalLoad?.pendingDriverRequests || [])
    .filter(
      (r: any) =>
        r.status === "rejected" && r.driverId.toString() !== driverId,
    )
    .map((r: any) => r.driverId.toString());

  await DriverLocation.findOneAndUpdate(
    { userId: driverId },
    { $addToSet: { shipmentIds: load._id } },
  );

  await Promise.allSettled([
    safeCreateNotification({
      userId: driverId,
      organizationId: orgId,
      type: "shipment_assigned",
      title: "Load Request Approved",
      message: `Your request for ${load.loadNumber} has been approved. You are now assigned.`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    }),
    ...rejectedDriverIds.map((rejDriverId) =>
      safeCreateNotification({
        userId: rejDriverId,
        organizationId: orgId,
        type: "shipment_status_changed",
        title: "Load Request Update",
        message: `Your request for load ${load.loadNumber} was not approved — another driver was selected.`,
        metadata: { loadId: load._id.toString() },
      }),
    ),
  ]);

  const io = getSocketIO();
  if (io)
    io.to(`org:${orgId}`).emit("driver:loads_updated", {
      action: "approved",
      loadId,
      driverId,
    });

  res.json(
    new ApiResponse(200, load, "Load request approved — driver assigned"),
  );

  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Admin approved driver load request",
    performedBy: adminId,
    changes: { assignedDriverId: driverId, status: "Assigned" },
  });
});

const rejectLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const adminId = (req.user as any)?._id;
  const { loadId, driverId, reason } = req.body as {
    loadId?: string;
    driverId?: string;
    reason?: string;
  };

  if (!loadId || !driverId)
    throw new ApiError(400, "Load ID and driver ID are required");

  const load = await Load.findOne({ _id: loadId, organizationId: orgId });
  if (!load) throw new ApiError(404, "Load not found");

  const pendingReq = load.pendingDriverRequests?.find(
    (r: any) => r.driverId.toString() === driverId && r.status === "pending",
  );
  if (!pendingReq)
    throw new ApiError(404, "No pending request from this driver");

  load.pendingDriverRequests = (load.pendingDriverRequests || []).map(
    (r: any) => {
      if (r.driverId.toString() === driverId && r.status === "pending") {
        r.status = "rejected";
        r.reviewedAt = new Date();
        r.reviewedBy = adminId;
        r.rejectionReason = reason || "Request declined by dispatcher";
      }
      return r;
    },
  ) as any;
  await load.save();

  await safeCreateNotification({
    userId: driverId,
    organizationId: orgId,
    type: "shipment_status_changed",
    title: "Load Request Declined",
    message: `Your request for ${load.loadNumber} was declined${reason ? `: ${reason}` : ""}.`,
    metadata: { loadId: load._id.toString() },
  });

  const io = getSocketIO();
  if (io)
    io.to(`org:${orgId}`).emit("driver:load_request_updated", {
      loadId,
      driverId,
      action: "rejected",
    });

  res.json(new ApiResponse(200, null, "Load request rejected"));

  await AuditLog.create({
    entityType: "Load",
    entityId: load._id,
    action: "UPDATE",
    reason: "Admin rejected driver load request",
    performedBy: adminId,
    changes: { rejectedDriverId: driverId, reason },
  });
});

const getLoadRequests = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const loads = await Load.find({
    organizationId: orgId,
    "pendingDriverRequests.status": "pending",
  })
    .select(
      "_id loadNumber status pickupLocation deliveryLocation vehicles pricing pendingDriverRequests createdAt dates",
    )
    .sort({ createdAt: -1 })
    .limit(40)
    .lean();

  const allDriverIds = new Set<string>();
  for (const l of loads) {
    (l.pendingDriverRequests || [])
      .filter((r: any) => r.status === "pending")
      .forEach((r: any) => allDriverIds.add(r.driverId.toString()));
  }

  const profiles = await DriverProfile.find(
    { userId: { $in: Array.from(allDriverIds) } },
    "userId trailerType maxVehicleCapacity operationalStatus isComplianceExpired truckMake truckModel profileCompletionScore",
  ).lean();
  const profileMap = new Map(
    profiles.map((p: any) => [p.userId.toString(), p]),
  );

  const requests: any[] = [];

  for (const l of loads) {
    const pending = (l.pendingDriverRequests || []).filter(
      (r: any) => r.status === "pending",
    );
    for (const r of pending) {
      const prof = profileMap.get(r.driverId.toString());
      requests.push({
        loadId: l._id.toString(),
        trackingNumber: (l as any).loadNumber,
        origin: `${(l as any).pickupLocation?.city || ""}${(l as any).pickupLocation?.state ? `, ${(l as any).pickupLocation.state}` : ""}`,
        destination: `${(l as any).deliveryLocation?.city || ""}${(l as any).deliveryLocation?.state ? `, ${(l as any).deliveryLocation.state}` : ""}`,
        trailerTypeRequired: (l as any).vehicles?.[0]?.trailerType,
        vehicleCount: (l as any).vehicles?.length || 0,
        carrierPayAmount: (l as any).pricing?.carrierPayAmount,
        requestedPickupDate: (l as any).dates?.firstAvailable,
        driverId: r.driverId.toString(),
        driverName: r.driverName,
        requestedAt: r.requestedAt,
        equipment: prof
          ? {
            trailerType: prof.trailerType,
            maxVehicleCapacity: prof.maxVehicleCapacity,
            operationalStatus: prof.operationalStatus,
            isComplianceExpired: prof.isComplianceExpired,
            truckMake: prof.truckMake,
            truckModel: prof.truckModel,
            profileCompletionScore: prof.profileCompletionScore,
          }
          : null,
      });
    }
  }

  res.json(new ApiResponse(200, requests, "Pending load requests fetched"));
});

const getDriverDashboardStats = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as IUser;
    if (!user?._id) throw new ApiError(401, "User not authenticated");
    if (user.role !== "driver")
      throw new ApiError(403, "Only drivers can access this");

    const orgId = user.organizationId?.toString();
    if (!orgId)
      throw new ApiError(403, "Driver must be assigned to an organization");

    const [assigned, requestedLoads, profile] = await Promise.all([
      Load.find({ assignedDriverId: user._id })
        .select("status pricing assignedAt driverAcceptedAt")
        .lean(),
      Load.find({
        organizationId: orgId,
        "pendingDriverRequests.driverId": user._id,
        "pendingDriverRequests.status": "pending",
      })
        .select("_id")
        .lean(),
      DriverProfile.findOne({ userId: user._id })
        .select("profileCompletionScore isComplianceExpired operationalStatus")
        .lean(),
    ]);

    const active = assigned.filter(
      (l: any) => l.status !== "Delivered" && l.status !== "Cancelled",
    );
    const completed = assigned.filter((l: any) => l.status === "Delivered");
    const totalEarnings = completed.reduce(
      (sum: number, l: any) => sum + (l.pricing?.carrierPayAmount || 0),
      0,
    );
    const pendingRequestsCount = requestedLoads.length;

    res.json(new ApiResponse(200, {
      totalLoads: assigned.length,
      activeLoads: active.length,
      completedLoads: completed.length,
      pendingRequests: pendingRequestsCount,
      totalEarnings,
      profileCompletionScore: profile?.profileCompletionScore || 0,
      isComplianceExpired: profile?.isComplianceExpired || false,
      operationalStatus: profile?.operationalStatus || "inactive",
    }, "Dashboard stats fetched"));
  });


const markPickedUp = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const { loadId } = req.body as { loadId?: string };
  if (!loadId) throw new ApiError(400, "Load ID is required");

  const load = await Load.findById(loadId);
  if (!load) throw new ApiError(404, "Load not found");
  if (!load.assignedDriverId || load.assignedDriverId.toString() !== user._id.toString()) {
    throw new ApiError(403, "You are not assigned to this load");
  }
  if (load.status === "Picked Up" || load.status === "In-Transit") {
    return res.json(new ApiResponse(200, load, "Already picked up"));
  }
  if (load.status !== "Accepted") {
    throw new ApiError(400, "Load must be in Accepted status before marking pickup");
  }

  load.status = "Picked Up";
  load.pickedUpAt = new Date();
  await load.save();

  await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    { $set: { status: "on-route" as DriverStatus } },
  );

  await safeCreateNotification({
    userId: user._id.toString(),
    organizationId: load.organizationId?.toString() || 'global',
    type: 'shipment_status_changed',
    title: 'Pickup Confirmed',
    message: `Load ${load.loadNumber} marked as picked up. Start your route when ready.`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
  });

  const orgId = load.organizationId?.toString();
  if (orgId) {
    await notifyOrgAdmins(
      orgId, "shipment_status_changed", "Vehicle Picked Up",
      `${user.name || user.email} picked up load ${load.loadNumber || "N/A"}`,
      { loadId: load._id.toString(), driverId: user._id.toString(), driverName: user.name || user.email, status: "Picked Up" },
    );
    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "picked-up", loadId, driverId: user._id.toString(), status: "Picked Up" });
  }

  res.json(new ApiResponse(200, load, "Vehicle picked up — status updated to Picked Up"));

  await AuditLog.create({
    entityType: "Load", entityId: load._id, action: "UPDATE",
    reason: "Driver marked vehicle as picked up", performedBy: user._id,
    changes: { status: "Picked Up", pickedUpAt: load.pickedUpAt },
  });
});

export default {
  updateLocation,
  getActiveDrivers,
  assignLoad,
  acceptLoad,
  markPickedUp,
  getMyLoads,
  removeLoad,
  dropLoad,
  reassignLoad,
  startRoute,
  getAvailableLoads,
  requestLoad,
  getMyRequests,
  approveLoadRequest,
  rejectLoadRequest,
  getLoadRequests,
  getLoadDetail,
  getDriverDashboardStats,
};
