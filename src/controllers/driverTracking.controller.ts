import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation, { DriverStatus } from "../models/DriverLocation.model";
import Shipment from "../models/Shipment.model";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import AuditLog from "../models/AuditLog.model";
import DriverProfile from "../models/DriverProfile.model";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";
import { notificationTemplates } from "../utils/notificationTemplates";
import { getSocketIO } from "../utils/socketEmitter";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) {
    throw new ApiError(401, "User not authenticated");
  }
  return user._id.toString();
};

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

  if (status && !["on-route", "idle", "on-break", "waiting", "offline"].includes(status)) {
    throw new ApiError(400, "Invalid driver status");
  }

  const updateData: any = {
    userId,
    organizationId: orgId,
    coords: { lat, lng },
    lastSeenAt: new Date(),
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

    const driverLocation = await DriverLocation.findOne({ userId }).populate("shipmentIds");
    if (driverLocation?.shipmentIds?.length) {
      for (const shipmentId of driverLocation.shipmentIds) {
        io.to(`shipment:${shipmentId.toString()}`).emit("driver:location_update", {
          driverId: userId,
          coords: { lat, lng },
          status: location.status,
          lastSeenAt: location.lastSeenAt,
        });
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

  // 1. Fetch ALL active shipments globally to determine driver availability
  const activeShipments = await Shipment.find(
    {
      assignedDriverId: { $exists: true, $ne: null },
      status: { $nin: ["Delivered", "Cancelled"] },
    },
    "_id assignedDriverId trackingNumber status organizationId origin destination",
  ).sort({ assignedAt: -1 });

  const filter: any = { organizationId: orgId };
  if (status && status !== "all") {
    filter.status = status;
  }

  // 2. Fetch all drivers who are currently sharing their location (global list)
  const locations = await DriverLocation.find(filter)
    .populate("userId", "name email avatar role")
    .sort({ lastSeenAt: -1 });

  const shipmentsByDriver = new Map<string, any[]>();

  // 3. Populate shipments for each driver, redacting if it belongs to another organization
  for (const shipment of activeShipments) {
    const assignedDriverId = shipment.assignedDriverId?.toString();
    if (!assignedDriverId) continue;

    if (!shipmentsByDriver.has(assignedDriverId)) {
      shipmentsByDriver.set(assignedDriverId, []);
    }

    const isOurShipment = shipment.organizationId?.toString() === orgId;

    if (isOurShipment) {
      shipmentsByDriver.get(assignedDriverId)!.push({
        id: shipment._id.toString(),
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        origin: shipment.origin,
        destination: shipment.destination,
        owned: true,
      });
    } else {
      // Redacted entry for competitor shipments
      shipmentsByDriver.get(assignedDriverId)!.push({
        id: "redacted", // Hide the actual shipment ID
        status: "Occupied (External Load)",
        owned: false,
        // Sensitive fields (trackingNumber, origin, destination) are OMITTED
      });
    }
  }

  const driverUserIds = locations
    .filter((location: any) => location.userId && location.userId.role === "driver")
    .map((location: any) => location.userId._id);

  const driverProfiles = await DriverProfile.find(
    { userId: { $in: driverUserIds } },
    "userId trailerType maxVehicleCapacity operationalStatus profileCompletionScore isComplianceExpired truckMake truckModel"
  ).lean();

  const profileByUserId = new Map(
    driverProfiles.map((p: any) => [p.userId.toString(), p])
  );

  const data = locations
    .filter((location: any) => location.userId && location.userId.role === "driver")
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
        equipment: dProfile ? {
          trailerType: dProfile.trailerType,
          maxVehicleCapacity: dProfile.maxVehicleCapacity,
          operationalStatus: dProfile.operationalStatus,
          truckMake: dProfile.truckMake,
          truckModel: dProfile.truckModel,
          isComplianceExpired: dProfile.isComplianceExpired,
          profileCompletionScore: dProfile.profileCompletionScore,
        } : null,
        shipments:
          shipmentsByDriver.get(location.userId._id.toString()) || [],
      };
    });

  res.json(new ApiResponse(200, data, "Driver locations fetched (redacted for privacy)"));
});

const assignLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, driverId } = req.body as {
    shipmentId?: string;
    driverId?: string;
  };

  if (!shipmentId || !driverId) {
    throw new ApiError(400, "Shipment ID and driver ID are required");
  }

  const driver = await User.findById(driverId);
  if (!driver) {
    throw new ApiError(404, "Driver not found");
  }
  if (driver.role !== "driver") {
    throw new ApiError(400, "User is not a driver");
  }

  const driverLocation = await DriverLocation.findOne({ userId: driverId });
  const driverOrgId = driver.organizationId?.toString() || driverLocation?.organizationId?.toString();
  if (driverOrgId !== orgId) {
    throw new ApiError(403, "Driver does not belong to your organization");
  }

  const shipment = await Shipment.findOneAndUpdate(
    { _id: shipmentId, organizationId: orgId },
    { $set: { assignedDriverId: driver._id, assignedAt: new Date(), status: "Dispatched" } },
    { new: true },
  );

  if (!shipment) {
    throw new ApiError(404, "Shipment not found");
  }

  await DriverLocation.findOneAndUpdate(
    { userId: driver._id },
    { $addToSet: { shipmentIds: shipment._id } },
    { new: true },
  );

  // Notify the driver about the new load assignment
  const loadInfo = `${shipment.origin} → ${shipment.destination}`;
  const { title, message } = notificationTemplates.shipment_assigned({
    trackingNumber: shipment.trackingNumber || 'N/A',
    customerName: (shipment.preservedQuoteData as any)?.firstName
      ? `${(shipment.preservedQuoteData as any).firstName} ${(shipment.preservedQuoteData as any).lastName || ''}`
      : undefined,
  });

  await safeCreateNotification({
    userId: driver._id.toString(),
    organizationId: orgId || 'global',
    type: 'shipment_assigned',
    title,
    message,
    metadata: {
      shipmentId: shipment._id.toString(),
      trackingNumber: shipment.trackingNumber,
      origin: shipment.origin,
      destination: shipment.destination,
      loadInfo,
    },
  });

  // Also notify org admins that a load was assigned
  await notifyOrgAdmins(
    orgId,
    'driver_assigned',
    'Load Assigned to Driver',
    `${shipment.trackingNumber} assigned to ${driver.name || driver.email}`,
    {
      shipmentId: shipment._id.toString(),
      trackingNumber: shipment.trackingNumber,
      driverId: driver._id.toString(),
      driverName: driver.name || driver.email,
    },
    (req.user as any)?._id?.toString() // Exclude the user who assigned
  );

  const io = getSocketIO();
  if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "assigned", shipmentId, driverId });

  res.json(new ApiResponse(200, shipment, "Load assigned"));

  await AuditLog.create({
    entityType: "Shipment",
    entityId: shipment._id,
    action: "UPDATE",
    reason: "Load assigned to driver",
    performedBy: (req.user as any)?._id,
    changes: { assignedDriverId: driver._id, status: "Dispatched" },
  });
});

// POST /accept-load — driver accepts a load (no org required)
const acceptLoad = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { shipmentId, loadId } = req.body as { shipmentId?: string; loadId?: string };

  if (!shipmentId && !loadId) {
    throw new ApiError(400, "A shipment ID or load ID is required");
  }

  if (loadId) {
    const load = await Load.findById(loadId);
    if (!load) throw new ApiError(404, "Load not found");
    if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) {
      throw new ApiError(403, "You are not assigned to this load");
    }
    load.driverAcceptedAt = new Date();
    if (load.status === "Assigned") load.status = "Assigned";
    await load.save();

    const driver = await User.findById(userId).select('name email');
    if (load.organizationId) {
      await notifyOrgAdmins(load.organizationId.toString(), 'shipment_status_changed', 'Load Accepted by Driver',
        `${driver?.name || driver?.email || 'Driver'} accepted load ${load.loadNumber}`,
        { loadId: load._id.toString(), loadNumber: load.loadNumber, driverId: userId, driverName: driver?.name || driver?.email, status: load.status });
      const io = getSocketIO();
      if (io) io.to(`org:${load.organizationId.toString()}`).emit("driver:loads_updated", { action: "accepted", loadId, driverId: userId });
    }
    res.json(new ApiResponse(200, load, "Load accepted"));
    await AuditLog.create({ entityType: "Load", entityId: load._id, action: "UPDATE", reason: "Driver accepted load", performedBy: userId, changes: { driverAcceptedAt: load.driverAcceptedAt } });
    return;
  }

  const shipment = await Shipment.findById(shipmentId);
  if (!shipment) {
    throw new ApiError(404, "Shipment not found");
  }

  if (
    !shipment.assignedDriverId ||
    shipment.assignedDriverId.toString() !== userId
  ) {
    throw new ApiError(403, "You are not assigned to this load");
  }

  shipment.driverAcceptedAt = new Date();
  if (shipment.status === "Available for Pickup") {
    shipment.status = "Dispatched";
  }
  await shipment.save();

  // Get driver info for notification
  const driver = await User.findById(userId).select('name email');

  // Notify org admins that driver accepted the load
  if (shipment.organizationId) {
    await notifyOrgAdmins(
      shipment.organizationId.toString(),
      'shipment_status_changed',
      'Load Accepted by Driver',
      `${driver?.name || driver?.email || 'Driver'} accepted shipment ${shipment.trackingNumber}`,
      {
        shipmentId: shipment._id.toString(),
        trackingNumber: shipment.trackingNumber,
        driverId: userId,
        driverName: driver?.name || driver?.email,
        status: shipment.status,
      }
    );
  }

  const io = getSocketIO();
  if (io && shipment.organizationId) {
    io.to(`org:${shipment.organizationId.toString()}`).emit("driver:loads_updated", { action: "accepted", shipmentId, driverId: userId });
  }

  res.json(new ApiResponse(200, shipment, "Load accepted"));

  await AuditLog.create({
    entityType: "Shipment",
    entityId: shipment._id,
    action: "UPDATE",
    reason: "Driver accepted load",
    performedBy: userId,
    changes: {
      status: shipment.status,
      driverAcceptedAt: shipment.driverAcceptedAt,
    },
  });
});

// GET /my-loads — driver fetches their assigned loads (no org required)
const getMyLoads = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);

  const [shipments, loads] = await Promise.all([
    Shipment.find({ assignedDriverId: userId })
      .sort({ assignedAt: -1 })
      .limit(50)
      .lean(),
    Load.find({ assignedDriverId: userId })
      .sort({ assignedAt: -1 })
      .limit(20)
      .lean(),
  ]);

  const mappedLoads = loads.map((l: any) => {
    const firstVehicle = l.vehicles?.[0];
    const vehicleName = firstVehicle ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim() : undefined;
    return {
      _id: l._id,
      __docType: "load",
      origin: `${l.pickupLocation?.city || ""}${l.pickupLocation?.state ? `, ${l.pickupLocation.state}` : ""}`,
      destination: `${l.deliveryLocation?.city || ""}${l.deliveryLocation?.state ? `, ${l.deliveryLocation.state}` : ""}`,
      trackingNumber: l.loadNumber,
      status: l.status === "Assigned" ? "Dispatched" : l.status === "In-Transit" ? "In-Route" : l.status,
      assignedDriverId: l.assignedDriverId,
      assignedAt: l.assignedAt,
      driverAcceptedAt: l.driverAcceptedAt,
      trailerTypeRequired: firstVehicle?.trailerType,
      vehicleCount: l.vehicles?.length || 0,
      carrierPayAmount: l.pricing?.carrierPayAmount,
      vehicles: l.vehicles,
      preservedQuoteData: vehicleName ? { vehicleName, units: l.vehicles?.length } : undefined,
      proofOfDelivery: l.proofOfDelivery,
      createdAt: l.createdAt,
    };
  });

  res.json(new ApiResponse(200, [...shipments, ...mappedLoads], "Assigned loads fetched"));
});

const removeLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId } = req.body as { shipmentId?: string };
  if (!shipmentId) throw new ApiError(400, "Shipment ID is required");

  const shipment = await Shipment.findOne({ _id: shipmentId, organizationId: orgId });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const previousDriverId = shipment.assignedDriverId?.toString();

  await Shipment.findByIdAndUpdate(shipmentId, {
    $set: { status: "Available for Pickup" },
    $unset: { assignedDriverId: 1, assignedAt: 1, driverAcceptedAt: 1 },
  });

  if (previousDriverId) {
    await DriverLocation.findOneAndUpdate(
      { userId: previousDriverId },
      { $pull: { shipmentIds: shipment._id } },
    );
    const driver = await User.findById(previousDriverId).select("name email");
    await safeCreateNotification({
      userId: previousDriverId,
      organizationId: orgId,
      type: "shipment_removed",
      title: "Load Removed",
      message: `Load ${shipment.trackingNumber || "N/A"} has been removed from your assignments`,
      metadata: { shipmentId: shipment._id.toString(), trackingNumber: shipment.trackingNumber },
    });
    await notifyOrgAdmins(
      orgId, "shipment_status_changed", "Load Removed from Driver",
      `${shipment.trackingNumber} removed from ${driver?.name || driver?.email || "driver"}`,
      { shipmentId: shipment._id.toString(), driverId: previousDriverId },
      (req.user as any)?._id?.toString(),
    );
  }

  const io = getSocketIO();
  if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "removed", shipmentId });

  res.json(new ApiResponse(200, null, "Load removed from driver"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Load removed from driver by admin", performedBy: (req.user as any)?._id,
    changes: { assignedDriverId: null, status: "Available for Pickup" },
  });
});

const dropLoad = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { shipmentId, loadId } = req.body as { shipmentId?: string; loadId?: string };
  if (!shipmentId && !loadId) throw new ApiError(400, "A shipment ID or load ID is required");

  if (loadId) {
    const load = await Load.findById(loadId);
    if (!load) throw new ApiError(404, "Load not found");
    if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) throw new ApiError(403, "You are not assigned to this load");

    const orgId = load.organizationId?.toString();
    await Load.findByIdAndUpdate(loadId, { $set: { status: "Posted" }, $unset: { assignedDriverId: 1, assignedAt: 1, driverAcceptedAt: 1 } });
    await DriverLocation.findOneAndUpdate({ userId }, { $pull: { shipmentIds: load._id } });

    const driver = await User.findById(userId).select("name email");
    if (orgId) {
      await notifyOrgAdmins(orgId, "shipment_status_changed", "Load Dropped by Driver",
        `${driver?.name || driver?.email || "Driver"} dropped load ${load.loadNumber || "N/A"}`,
        { loadId: load._id.toString(), driverId: userId, driverName: driver?.name });
      const io = getSocketIO();
      if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "dropped", loadId, driverId: userId });
    }
    res.json(new ApiResponse(200, null, "Load dropped"));
    await AuditLog.create({ entityType: "Load", entityId: load._id, action: "UPDATE", reason: "Driver dropped load", performedBy: userId, changes: { assignedDriverId: null, status: "Posted" } });
    return;
  }

  const shipment = await Shipment.findById(shipmentId);
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (!shipment.assignedDriverId || shipment.assignedDriverId.toString() !== userId) {
    throw new ApiError(403, "You are not assigned to this load");
  }

  const orgId = shipment.organizationId?.toString();

  await Shipment.findByIdAndUpdate(shipmentId, {
    $set: { status: "Available for Pickup" },
    $unset: { assignedDriverId: 1, assignedAt: 1, driverAcceptedAt: 1 },
  });

  await DriverLocation.findOneAndUpdate({ userId }, { $pull: { shipmentIds: shipment._id } });

  const driver = await User.findById(userId).select("name email");
  if (orgId) {
    await notifyOrgAdmins(
      orgId, "shipment_status_changed", "Load Dropped by Driver",
      `${driver?.name || driver?.email || "Driver"} dropped load ${shipment.trackingNumber || "N/A"}`,
      { shipmentId: shipment._id.toString(), driverId: userId, driverName: driver?.name },
    );
    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "dropped", shipmentId, driverId: userId });
  }

  res.json(new ApiResponse(200, null, "Load dropped"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Driver dropped load", performedBy: userId,
    changes: { assignedDriverId: null, status: "Available for Pickup" },
  });
});

const reassignLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, newDriverId } = req.body as { shipmentId?: string; newDriverId?: string };
  if (!shipmentId || !newDriverId) throw new ApiError(400, "Shipment ID and new driver ID are required");

  const newDriver = await User.findById(newDriverId);
  if (!newDriver) throw new ApiError(404, "Driver not found");
  if (newDriver.role !== "driver") throw new ApiError(400, "User is not a driver");

  const driverLocation = await DriverLocation.findOne({ userId: newDriverId });
  const driverOrgId = newDriver.organizationId?.toString() || driverLocation?.organizationId?.toString();
  if (driverOrgId !== orgId) throw new ApiError(403, "Driver does not belong to your organization");

  const shipment = await Shipment.findOne({ _id: shipmentId, organizationId: orgId });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const previousDriverId = shipment.assignedDriverId?.toString();
  if (previousDriverId) {
    await DriverLocation.findOneAndUpdate({ userId: previousDriverId }, { $pull: { shipmentIds: shipment._id } });
    await safeCreateNotification({
      userId: previousDriverId, organizationId: orgId, type: "shipment_reassigned",
      title: "Load Reassigned",
      message: `Load ${shipment.trackingNumber || "N/A"} has been reassigned to another driver`,
      metadata: { shipmentId: shipment._id.toString() },
    });
  }

  const updatedShipment = await Shipment.findByIdAndUpdate(shipmentId, {
    $set: {
      assignedDriverId: newDriver._id,
      assignedAt: new Date(),
      status: shipment.status === "In-Route" ? "Dispatched" : shipment.status,
    },
    $unset: { driverAcceptedAt: 1 },
  }, { new: true });

  await DriverLocation.findOneAndUpdate(
    { userId: newDriver._id },
    { $addToSet: { shipmentIds: shipment._id } },
    { new: true },
  );

  await safeCreateNotification({
    userId: newDriverId, organizationId: orgId, type: "shipment_assigned",
    title: "New Load Assigned",
    message: `Load ${shipment.trackingNumber || "N/A"}: ${shipment.origin} → ${shipment.destination}`,
    metadata: { shipmentId: shipment._id.toString() },
  });

  await notifyOrgAdmins(
    orgId, "shipment_status_changed", "Load Reassigned",
    `${shipment.trackingNumber} reassigned to ${newDriver.name || newDriver.email}`,
    { shipmentId: shipment._id.toString(), newDriverId },
    (req.user as any)?._id?.toString(),
  );

  const io = getSocketIO();
  if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "reassigned", shipmentId });

  res.json(new ApiResponse(200, updatedShipment, "Load reassigned"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Load reassigned to another driver", performedBy: (req.user as any)?._id,
    changes: { previousDriverId, newDriverId },
  });
});

const startRoute = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const { shipmentId, loadId } = req.body as { shipmentId?: string; loadId?: string };
  if (!shipmentId && !loadId) throw new ApiError(400, "A shipment ID or load ID is required");

  if (loadId) {
    const load = await Load.findById(loadId);
    if (!load) throw new ApiError(404, "Load not found");
    if (!load.assignedDriverId || load.assignedDriverId.toString() !== user._id.toString()) {
      throw new ApiError(403, "You are not assigned to this load");
    }
    if (load.status === "In-Transit") return res.json(new ApiResponse(200, load, "Already in transit"));
    if (load.status !== "Assigned") throw new ApiError(400, "Load must be in Assigned status to start route");

    load.status = "In-Transit";
    await load.save();

    await DriverLocation.findOneAndUpdate({ userId: user._id }, { $set: { status: "on-route" as DriverStatus } });

    const orgId = load.organizationId?.toString();
    if (orgId) {
      await notifyOrgAdmins(orgId, "shipment_status_changed", "Driver Started Route",
        `${user.name || user.email} started route for load ${load.loadNumber || "N/A"}`,
        { loadId: load._id.toString(), driverId: user._id.toString(), driverName: user.name || user.email });
      const io = getSocketIO();
      if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "in-route", loadId, driverId: user._id.toString() });
    }
    res.json(new ApiResponse(200, load, "Route started — status updated to In-Transit"));
    await AuditLog.create({ entityType: "Load", entityId: load._id, action: "UPDATE", reason: "Driver started route", performedBy: user._id, changes: { status: "In-Transit" } });
    return;
  }

  const shipment = await Shipment.findById(shipmentId);
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (!shipment.assignedDriverId || shipment.assignedDriverId.toString() !== user._id.toString()) {
    throw new ApiError(403, "You are not assigned to this load");
  }

  if (shipment.status === "In-Route") {
    return res.json(new ApiResponse(200, shipment, "Already in route"));
  }

  if (shipment.status !== "Dispatched") {
    throw new ApiError(400, "Load must be in Dispatched status to start route");
  }

  shipment.status = "In-Route";
  shipment.pickedUp = new Date();
  await shipment.save();

  await DriverLocation.findOneAndUpdate(
    { userId: user._id },
    { $set: { status: "on-route" as DriverStatus } },
  );

  const orgId = shipment.organizationId?.toString();
  if (orgId) {
    await notifyOrgAdmins(
      orgId, "shipment_status_changed", "Driver Started Route",
      `${user.name || user.email} started route for ${shipment.trackingNumber || "N/A"}`,
      { shipmentId: shipment._id.toString(), driverId: user._id.toString(), driverName: user.name || user.email },
    );

    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "in-route", shipmentId, driverId: user._id.toString() });
  }

  res.json(new ApiResponse(200, shipment, "Route started — status updated to In-Route"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Driver started route", performedBy: user._id,
    changes: { status: "In-Route", pickedUp: shipment.pickedUp },
  });
});

const getAvailableLoads = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString();
  if (!orgId) {
    return res.json(new ApiResponse(200, [], "No organization assigned — contact your dispatcher"));
  }

  const driverProfile = await DriverProfile.findOne({ userId: user._id });
  const userId = user._id.toString();

  const shipmentFilter: any = {
    organizationId: orgId,
    status: "Available for Pickup",
    isPostedToBoard: true,
    $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
  };

  const loadFilter: any = {
    organizationId: orgId,
    status: "Posted",
    $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
  };

  // DEMO MODE: trailer type + capacity filters disabled so all org loads show for any driver
  // REVERT: restore the trailer/capacity filter blocks here after demo

  const [shipments, loads] = await Promise.all([
    Shipment.find(shipmentFilter)
      .select("_id origin destination trackingNumber status requestedPickupDate scheduledPickup scheduledDelivery desiredDeliveryDate trailerTypeRequired vehicleCount carrierPayAmount preservedQuoteData pendingDriverRequests createdAt")
      .sort({ createdAt: -1 })
      .limit(40)
      .lean(),
    Load.find(loadFilter)
      .select("_id loadNumber status pickupLocation deliveryLocation vehicles dates pricing pendingDriverRequests createdAt")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);


  const mappedShipments = shipments.map((s: any) => {
    const myRequest = s.pendingDriverRequests?.find((r: any) => r.driverId.toString() === userId);
    return {
      ...s,
      __docType: "shipment",
      myRequestStatus: myRequest?.status || null,
      myRequestedAt: myRequest?.requestedAt || null,
    };
  });

  const mappedLoads = loads.map((l: any) => {
    const myRequest = l.pendingDriverRequests?.find((r: any) => r.driverId.toString() === userId);
    const firstVehicle = l.vehicles?.[0];
    const vehicleName = firstVehicle ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim() : undefined;
    return {
      _id: l._id,
      __docType: "load",
      origin: `${l.pickupLocation?.city || ""}${l.pickupLocation?.state ? `, ${l.pickupLocation.state}` : ""}`,
      destination: `${l.deliveryLocation?.city || ""}${l.deliveryLocation?.state ? `, ${l.deliveryLocation.state}` : ""}`,
      trackingNumber: l.loadNumber,
      status: l.status,
      requestedPickupDate: l.dates?.firstAvailable,
      scheduledDelivery: l.dates?.deliveryDeadline,
      trailerTypeRequired: firstVehicle?.trailerType,
      vehicleCount: l.vehicles?.length || 0,
      carrierPayAmount: l.pricing?.carrierPayAmount,
      estimatedRate: l.pricing?.estimatedRate,
      miles: l.pricing?.miles,
      vehicles: l.vehicles,
      preservedQuoteData: vehicleName ? { vehicleName, units: l.vehicles?.length } : undefined,
      pendingDriverRequests: l.pendingDriverRequests,
      createdAt: l.createdAt,
      myRequestStatus: myRequest?.status || null,
      myRequestedAt: myRequest?.requestedAt || null,
    };
  });

  res.json(new ApiResponse(200, [...mappedShipments, ...mappedLoads], "Available loads fetched"));
});

const requestLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString();
  if (!orgId) throw new ApiError(403, "Driver must be assigned to an organization");

  const { shipmentId, loadId } = req.body as { shipmentId?: string; loadId?: string };
  if (!shipmentId && !loadId) throw new ApiError(400, "A shipment ID or load ID is required");

  const driverProfile = await DriverProfile.findOne({ userId: user._id });
  if (driverProfile?.isComplianceExpired) {
    throw new ApiError(403, "Your compliance documents are expired. Please update before requesting loads.");
  }
  if (driverProfile?.operationalStatus && driverProfile.operationalStatus !== "active") {
    throw new ApiError(403, "Your operational status must be Active to request loads");
  }

  const requestEntry = {
    driverId: user._id,
    driverName: user.name || user.email,
    requestedAt: new Date(),
    status: "pending" as const,
  };

  if (loadId) {
    const load = await Load.findOne({
      _id: loadId,
      organizationId: orgId,
      status: "Posted",
      $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
    });
    if (!load) throw new ApiError(404, "Load not available");

    const alreadyRequested = load.pendingDriverRequests?.some(
      (r: any) => r.driverId.toString() === user._id.toString() && r.status === "pending"
    );
    if (alreadyRequested) throw new ApiError(400, "You have already requested this load");

    if (driverProfile?.maxVehicleCapacity && load.vehicles?.length > driverProfile.maxVehicleCapacity) {
      throw new ApiError(400, `This load has ${load.vehicles.length} vehicles. Your trailer supports ${driverProfile.maxVehicleCapacity}.`);
    }

    await Load.findByIdAndUpdate(loadId, { $push: { pendingDriverRequests: requestEntry } });

    await notifyOrgAdmins(orgId, "shipment_status_changed", "Load Requested by Driver",
      `${user.name || user.email} requested load ${load.loadNumber}`,
      { loadId: load._id.toString(), driverId: user._id.toString(), driverName: user.name || user.email });

    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:load_requested", { loadId, driverId: user._id.toString(), driverName: user.name || user.email });

    res.json(new ApiResponse(200, null, "Load request submitted — pending dispatcher approval"));

    await AuditLog.create({
      entityType: "Load", entityId: load._id, action: "UPDATE",
      reason: "Driver requested load from board", performedBy: user._id,
      changes: { requestedBy: user._id.toString() },
    });
    return;
  }

  const shipment = await Shipment.findOne({
    _id: shipmentId,
    organizationId: orgId,
    status: "Available for Pickup",
    isPostedToBoard: true,
    $or: [{ assignedDriverId: { $exists: false } }, { assignedDriverId: null }],
  });
  if (!shipment) throw new ApiError(404, "Load not available");

  const alreadyRequested = shipment.pendingDriverRequests?.some(
    (r: any) => r.driverId.toString() === user._id.toString() && r.status === "pending"
  );
  if (alreadyRequested) throw new ApiError(400, "You have already requested this load");

  if (shipment.vehicleCount && driverProfile?.maxVehicleCapacity) {
    if (shipment.vehicleCount > driverProfile.maxVehicleCapacity) {
      throw new ApiError(400, `This load requires ${shipment.vehicleCount} vehicle capacity. Your trailer supports ${driverProfile.maxVehicleCapacity}.`);
    }
  }

  await Shipment.findByIdAndUpdate(shipmentId, { $push: { pendingDriverRequests: requestEntry } });

  await notifyOrgAdmins(orgId, "shipment_status_changed", "Load Requested by Driver",
    `${user.name || user.email} requested shipment ${shipment.trackingNumber || "N/A"}`,
    { shipmentId: shipment._id.toString(), driverId: user._id.toString(), driverName: user.name || user.email });

  const io = getSocketIO();
  if (io) io.to(`org:${orgId}`).emit("driver:load_requested", { shipmentId, driverId: user._id.toString(), driverName: user.name || user.email });

  res.json(new ApiResponse(200, null, "Load request submitted — pending dispatcher approval"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Driver requested load from board", performedBy: user._id,
    changes: { requestedBy: user._id.toString() },
  });
});

const getMyRequests = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");

  const orgId = user.organizationId?.toString();
  if (!orgId) throw new ApiError(403, "Driver must be assigned to an organization");

  const [shipments, loads] = await Promise.all([
    Shipment.find({
      organizationId: orgId,
      "pendingDriverRequests.driverId": user._id,
    })
      .select("_id origin destination trackingNumber status requestedPickupDate scheduledPickup scheduledDelivery trailerTypeRequired vehicleCount carrierPayAmount preservedQuoteData pendingDriverRequests createdAt")
      .sort({ createdAt: -1 }),
    Load.find({
      organizationId: orgId,
      "pendingDriverRequests.driverId": user._id,
    })
      .select("_id loadNumber status pickupLocation deliveryLocation vehicles dates pricing pendingDriverRequests createdAt")
      .sort({ createdAt: -1 }),
  ]);

  const userId = user._id.toString();

  const mappedShipments = shipments.map((s: any) => {
    const myReq = s.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === userId
    );
    return {
      ...s.toObject(),
      __docType: "shipment",
      myRequestStatus: myReq?.status || null,
      myRequestedAt: myReq?.requestedAt || null,
      rejectionReason: myReq?.rejectionReason || null,
    };
  });

  const mappedLoads = loads.map((l: any) => {
    const myReq = l.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === userId
    );
    const firstVehicle = l.vehicles?.[0];
    const vehicleName = firstVehicle ? `${firstVehicle.year || ""} ${firstVehicle.make || ""} ${firstVehicle.model || ""}`.trim() : undefined;
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
      preservedQuoteData: vehicleName ? { vehicleName, units: l.vehicles?.length } : undefined,
      pendingDriverRequests: l.pendingDriverRequests,
      createdAt: l.createdAt,
      myRequestStatus: myReq?.status || null,
      myRequestedAt: myReq?.requestedAt || null,
      rejectionReason: myReq?.rejectionReason || null,
    };
  });

  res.json(new ApiResponse(200, [...mappedShipments, ...mappedLoads], "My load requests fetched"));
});

const approveLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const adminId = (req.user as any)?._id;
  const { shipmentId, loadId, driverId } = req.body as { shipmentId?: string; loadId?: string; driverId?: string };

  if ((!shipmentId && !loadId) || !driverId) throw new ApiError(400, "A shipment/load ID and driver ID are required");

  if (loadId) {
    const load = await Load.findOne({ _id: loadId, organizationId: orgId });
    if (!load) throw new ApiError(404, "Load not found");

    const pendingReq = load.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driverId && r.status === "pending"
    );
    if (!pendingReq) throw new ApiError(404, "No pending request from this driver");

    const driver = await User.findById(driverId).select("name email");
    if (!driver) throw new ApiError(404, "Driver not found");

    load.pendingDriverRequests = (load.pendingDriverRequests || []).map((r: any) => {
      if (r.driverId.toString() === driverId) {
        r.status = "approved"; r.reviewedAt = new Date(); r.reviewedBy = adminId;
      } else if (r.status === "pending") {
        r.status = "rejected"; r.reviewedAt = new Date(); r.reviewedBy = adminId;
        r.rejectionReason = "Another driver was approved for this load";
      }
      return r;
    }) as any;

    load.assignedDriverId = driver._id as any;
    load.assignedAt = new Date();
    load.status = "Assigned";
    await load.save();

    await DriverLocation.findOneAndUpdate(
      { userId: driverId },
      { $addToSet: { shipmentIds: load._id } },
    );

    await safeCreateNotification({
      userId: driverId, organizationId: orgId, type: "shipment_assigned",
      title: "Load Request Approved",
      message: `Your request for ${load.loadNumber} has been approved. You are now assigned.`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    });

    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "approved", loadId, driverId });

    res.json(new ApiResponse(200, load, "Load request approved — driver assigned"));

    await AuditLog.create({
      entityType: "Load", entityId: load._id, action: "UPDATE",
      reason: "Admin approved driver load request", performedBy: adminId,
      changes: { assignedDriverId: driverId, status: "Assigned" },
    });
    return;
  }

  const shipment = await Shipment.findOne({ _id: shipmentId, organizationId: orgId });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const pendingReq = shipment.pendingDriverRequests?.find(
    (r: any) => r.driverId.toString() === driverId && r.status === "pending"
  );
  if (!pendingReq) throw new ApiError(404, "No pending request from this driver");

  const driver = await User.findById(driverId).select("name email");
  if (!driver) throw new ApiError(404, "Driver not found");

  shipment.pendingDriverRequests = (shipment.pendingDriverRequests || []).map((r: any) => {
    if (r.driverId.toString() === driverId) {
      r.status = "approved";
      r.reviewedAt = new Date();
      r.reviewedBy = adminId;
      return r;
    }
    if (r.status === "pending") {
      r.status = "rejected";
      r.reviewedAt = new Date();
      r.reviewedBy = adminId;
      r.rejectionReason = "Another driver was approved for this load";
      return r;
    }
    return r;
  }) as any;

  shipment.assignedDriverId = driver._id as any;
  shipment.assignedAt = new Date();
  shipment.status = "Dispatched";
  await shipment.save();

  await DriverLocation.findOneAndUpdate(
    { userId: driverId },
    { $addToSet: { shipmentIds: shipment._id } },
  );

  const loadInfo = `${shipment.origin} → ${shipment.destination}`;
  await safeCreateNotification({
    userId: driverId,
    organizationId: orgId,
    type: "shipment_assigned",
    title: "Load Request Approved",
    message: `Your request for ${shipment.trackingNumber || "N/A"} (${loadInfo}) has been approved. You are now dispatched.`,
    metadata: { shipmentId: shipment._id.toString(), trackingNumber: shipment.trackingNumber },
  });

  const rejectedDrivers = (shipment.pendingDriverRequests || []).filter(
    (r: any) => r.status === "rejected" && r.driverId.toString() !== driverId
  );
  for (const rej of rejectedDrivers) {
    await safeCreateNotification({
      userId: rej.driverId.toString(),
      organizationId: orgId,
      type: "shipment_status_changed",
      title: "Load Request Update",
      message: `Your request for ${shipment.trackingNumber || "N/A"} was not approved — another driver was selected.`,
      metadata: { shipmentId: shipment._id.toString() },
    });
  }

  const io = getSocketIO();
  if (io) {
    io.to(`org:${orgId}`).emit("driver:loads_updated", { action: "approved", shipmentId, driverId });
  }

  res.json(new ApiResponse(200, shipment, "Load request approved — driver dispatched"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Admin approved driver load request", performedBy: adminId,
    changes: { assignedDriverId: driverId, status: "Dispatched" },
  });
});

const rejectLoadRequest = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const adminId = (req.user as any)?._id;
  const { shipmentId, loadId, driverId, reason } = req.body as { shipmentId?: string; loadId?: string; driverId?: string; reason?: string };

  if ((!shipmentId && !loadId) || !driverId) throw new ApiError(400, "A shipment/load ID and driver ID are required");

  if (loadId) {
    const load = await Load.findOne({ _id: loadId, organizationId: orgId });
    if (!load) throw new ApiError(404, "Load not found");

    const pendingReq = load.pendingDriverRequests?.find(
      (r: any) => r.driverId.toString() === driverId && r.status === "pending"
    );
    if (!pendingReq) throw new ApiError(404, "No pending request from this driver");

    load.pendingDriverRequests = (load.pendingDriverRequests || []).map((r: any) => {
      if (r.driverId.toString() === driverId && r.status === "pending") {
        r.status = "rejected"; r.reviewedAt = new Date(); r.reviewedBy = adminId;
        r.rejectionReason = reason || "Request declined by dispatcher";
      }
      return r;
    }) as any;
    await load.save();

    await safeCreateNotification({
      userId: driverId, organizationId: orgId, type: "shipment_status_changed",
      title: "Load Request Declined",
      message: `Your request for ${load.loadNumber} was declined${reason ? `: ${reason}` : ""}.`,
      metadata: { loadId: load._id.toString() },
    });

    const io = getSocketIO();
    if (io) io.to(`org:${orgId}`).emit("driver:load_request_updated", { loadId, driverId, action: "rejected" });

    res.json(new ApiResponse(200, null, "Load request rejected"));

    await AuditLog.create({
      entityType: "Load", entityId: load._id, action: "UPDATE",
      reason: "Admin rejected driver load request", performedBy: adminId,
      changes: { rejectedDriverId: driverId, reason },
    });
    return;
  }

  const shipment = await Shipment.findOne({ _id: shipmentId, organizationId: orgId });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const pendingReq = shipment.pendingDriverRequests?.find(
    (r: any) => r.driverId.toString() === driverId && r.status === "pending"
  );
  if (!pendingReq) throw new ApiError(404, "No pending request from this driver");

  shipment.pendingDriverRequests = (shipment.pendingDriverRequests || []).map((r: any) => {
    if (r.driverId.toString() === driverId && r.status === "pending") {
      r.status = "rejected";
      r.reviewedAt = new Date();
      r.reviewedBy = adminId;
      r.rejectionReason = reason || "Request declined by dispatcher";
      return r;
    }
    return r;
  }) as any;
  await shipment.save();

  await safeCreateNotification({
    userId: driverId,
    organizationId: orgId,
    type: "shipment_status_changed",
    title: "Load Request Declined",
    message: `Your request for ${shipment.trackingNumber || "N/A"} was declined${reason ? `: ${reason}` : ""}.`,
    metadata: { shipmentId: shipment._id.toString() },
  });

  const io = getSocketIO();
  if (io) io.to(`org:${orgId}`).emit("driver:load_request_updated", { shipmentId, driverId, action: "rejected" });

  res.json(new ApiResponse(200, null, "Load request rejected"));

  await AuditLog.create({
    entityType: "Shipment", entityId: shipment._id, action: "UPDATE",
    reason: "Admin rejected driver load request", performedBy: adminId,
    changes: { rejectedDriverId: driverId, reason },
  });
});

const getLoadRequests = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const [shipments, loads] = await Promise.all([
    Shipment.find({ organizationId: orgId, "pendingDriverRequests.status": "pending" })
      .select("_id origin destination trackingNumber status trailerTypeRequired vehicleCount carrierPayAmount pendingDriverRequests createdAt requestedPickupDate")
      .sort({ createdAt: -1 }).limit(40).lean(),
    Load.find({ organizationId: orgId, "pendingDriverRequests.status": "pending" })
      .select("_id loadNumber status pickupLocation deliveryLocation vehicles pricing pendingDriverRequests createdAt dates")
      .sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const allDriverIds = new Set<string>();
  for (const s of shipments) {
    (s.pendingDriverRequests || []).filter((r: any) => r.status === "pending").forEach((r: any) => allDriverIds.add(r.driverId.toString()));
  }
  for (const l of loads) {
    (l.pendingDriverRequests || []).filter((r: any) => r.status === "pending").forEach((r: any) => allDriverIds.add(r.driverId.toString()));
  }

  const profiles = await DriverProfile.find(
    { userId: { $in: Array.from(allDriverIds) } },
    "userId trailerType maxVehicleCapacity operationalStatus isComplianceExpired truckMake truckModel profileCompletionScore"
  ).lean();
  const profileMap = new Map(profiles.map((p: any) => [p.userId.toString(), p]));

  const requests: any[] = [];

  for (const s of shipments) {
    const pending = (s.pendingDriverRequests || []).filter((r: any) => r.status === "pending");
    for (const r of pending) {
      const prof = profileMap.get(r.driverId.toString());
      requests.push({
        shipmentId: s._id.toString(),
        trackingNumber: (s as any).trackingNumber,
        origin: (s as any).origin,
        destination: (s as any).destination,
        trailerTypeRequired: (s as any).trailerTypeRequired,
        vehicleCount: (s as any).vehicleCount,
        carrierPayAmount: (s as any).carrierPayAmount,
        requestedPickupDate: (s as any).requestedPickupDate,
        driverId: r.driverId.toString(),
        driverName: r.driverName,
        requestedAt: r.requestedAt,
        equipment: prof ? { trailerType: prof.trailerType, maxVehicleCapacity: prof.maxVehicleCapacity, operationalStatus: prof.operationalStatus, isComplianceExpired: prof.isComplianceExpired, truckMake: prof.truckMake, truckModel: prof.truckModel, profileCompletionScore: prof.profileCompletionScore } : null,
      });
    }
  }

  for (const l of loads) {
    const pending = (l.pendingDriverRequests || []).filter((r: any) => r.status === "pending");
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
        equipment: prof ? { trailerType: prof.trailerType, maxVehicleCapacity: prof.maxVehicleCapacity, operationalStatus: prof.operationalStatus, isComplianceExpired: prof.isComplianceExpired, truckMake: prof.truckMake, truckModel: prof.truckModel, profileCompletionScore: prof.profileCompletionScore } : null,
      });
    }
  }

  res.json(new ApiResponse(200, requests, "Pending load requests fetched"));
});

const getDriverDashboardStats = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString();
  if (!orgId) throw new ApiError(403, "Driver must be assigned to an organization");

  const [assigned, requestedShipments, profile] = await Promise.all([
    Shipment.find({ assignedDriverId: user._id })
      .select("status carrierPayAmount assignedAt driverAcceptedAt")
      .lean(),
    Shipment.find({
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

  const active = assigned.filter((s: any) => s.status !== "Delivered" && s.status !== "Cancelled");
  const completed = assigned.filter((s: any) => s.status === "Delivered");
  const totalEarnings = completed.reduce((sum: number, s: any) => sum + (s.carrierPayAmount || 0), 0);
  const pendingRequestsCount = requestedShipments.length;

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

export default {
  updateLocation,
  getActiveDrivers,
  assignLoad,
  acceptLoad,
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
  getDriverDashboardStats,
};
