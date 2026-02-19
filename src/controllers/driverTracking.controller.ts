import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverLocation, { DriverStatus } from "../models/DriverLocation.model";
import Shipment from "../models/Shipment.model";
import User, { IUser } from "../models/User.model";
import AuditLog from "../models/AuditLog.model";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) {
    throw new ApiError(401, "User not authenticated");
  }
  return user._id.toString();
};

// POST /location — driver updates their own GPS coords (no org required)
const updateLocation = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { lat, lng, status } = req.body as {
    lat: number;
    lng: number;
    status?: DriverStatus;
  };

  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new ApiError(400, "Latitude and longitude are required");
  }

  if (status && !["on-route", "idle", "offline"].includes(status)) {
    throw new ApiError(400, "Invalid driver status");
  }

  const updateData: any = {
    userId,
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

// GET /active — admin fetches all sharing drivers (global), with org-scoped shipment context
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

  const filter: any = {};
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

// POST /assign-load — admin assigns a shipment to a driver (requireOrg applied in routes)
const assignLoad = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { shipmentId, driverId } = req.body as {
    shipmentId?: string;
    driverId?: string;
  };

  if (!shipmentId || !driverId) {
    throw new ApiError(400, "Shipment ID and driver ID are required");
  }

  // Drivers are global; validate role only
  const driver = await User.findOne({ _id: driverId, role: "driver" });
  if (!driver) {
    throw new ApiError(404, "Driver not found");
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

export default {
  updateLocation,
  getActiveDrivers,
  assignLoad,
  acceptLoad,
  getMyLoads,
};
