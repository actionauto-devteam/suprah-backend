import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation, { DriverStatus } from "../models/DriverLocation.model";
import Shipment from "../models/Shipment.model";
import User, { IUser } from "../models/User.model";
import AuditLog from "../models/AuditLog.model";
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

  const orgShipments = await Shipment.find(
    {
      organizationId: orgId,
      assignedDriverId: { $exists: true, $ne: null },
      status: { $nin: ["Delivered", "Cancelled"] },
    },
    "_id assignedDriverId trackingNumber status origin destination",
  ).sort({ assignedAt: -1 });

  const filter: any = { organizationId: orgId };
  if (status && status !== "all") {
    filter.status = status;
  }

  const locations = await DriverLocation.find(filter)
    .populate("userId", "name email avatar role")
    .sort({ lastSeenAt: -1 });

  const shipmentsByDriver = new Map<
    string,
    Array<{
      id: string;
      trackingNumber?: string;
      status: string;
      origin: string;
      destination: string;
    }>
  >();

  for (const shipment of orgShipments) {
    const assignedDriverId = shipment.assignedDriverId?.toString();
    if (!assignedDriverId) continue;

    if (!shipmentsByDriver.has(assignedDriverId)) {
      shipmentsByDriver.set(assignedDriverId, []);
    }

    shipmentsByDriver.get(assignedDriverId)!.push({
      id: shipment._id.toString(),
      trackingNumber: shipment.trackingNumber,
      status: shipment.status,
      origin: shipment.origin,
      destination: shipment.destination,
    });
  }

  const data = locations
    .map((location: any) => ({
      id: location._id.toString(),
      status: location.status,
      coords: location.coords,
      lastSeenAt: location.lastSeenAt,
      driver: location.userId
        ? {
          id: location.userId._id.toString(),
          name: location.userId.name,
          email: location.userId.email,
          avatar: location.userId.avatar,
        }
        : null,
      shipments:
        shipmentsByDriver.get(location.userId?._id?.toString() || "") || [],
    }))
    .filter((item: any) => item.driver);

  res.json(new ApiResponse(200, data, "Driver locations fetched"));
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

  const driverLocation = await DriverLocation.findOne({ userId: driverId });
  const driverOrgId = driver.organizationId?.toString() || driverLocation?.organizationId?.toString();
  if (driverOrgId !== orgId) {
    throw new ApiError(403, "Driver does not belong to your organization");
  }

  const shipment = await Shipment.findOneAndUpdate(
    { _id: shipmentId, organizationId: orgId },
    { $set: { assignedDriverId: driver._id, assignedAt: new Date() } },
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

  res.json(new ApiResponse(200, shipment, "Load assigned"));

  await AuditLog.create({
    entityType: "Shipment",
    entityId: shipment._id,
    action: "UPDATE",
    reason: "Load assigned to driver",
    performedBy: (req.user as any)?._id,
    changes: { assignedDriverId: driver._id },
  });
});

// POST /accept-load — driver accepts a load (no org required)
const acceptLoad = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { shipmentId } = req.body as { shipmentId?: string };

  if (!shipmentId) {
    throw new ApiError(400, "Shipment ID is required");
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

  const shipments = await Shipment.find({
    assignedDriverId: userId,
  }).sort({ assignedAt: -1 });

  res.json(new ApiResponse(200, shipments, "Assigned loads fetched"));
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
  const { shipmentId } = req.body as { shipmentId?: string };
  if (!shipmentId) throw new ApiError(400, "Shipment ID is required");

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

export default {
  updateLocation,
  getActiveDrivers,
  assignLoad,
  acceptLoad,
  getMyLoads,
  removeLoad,
  dropLoad,
  reassignLoad,
};
