import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import Vehicle from "../models/Vehicle.model";
import Lead from "../models/lead.model";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import {
  safeCreateNotification,
  notifyOrgAdmins,
} from "../utils/safeNotification";
import { SavedVehicle } from "../models/SavedVehicle.model";
import { notificationTemplates } from "../utils/notificationTemplates";
import { IUser } from "../models/User.model";
import cacheService from "../services/cache.service";
import logger from "../utils/logger";
import activityService from "../services/activity.service";
import membershipService from "../services/membership.service";

const VEH_CACHE_TTL = 60 * 60;

const getUserId = (req: Request): string | undefined => {
  return (req.user as IUser)?._id?.toString();
};

const DAY_MS = 24 * 60 * 60 * 1000;

const getVehicleAgeDays = (vehicle: any) => {
  const storedDays = Number(vehicle.daysOnLot);
  if (Number.isFinite(storedDays) && storedDays > 0) {
    return Math.max(0, Math.floor(storedDays));
  }

  const startValue = vehicle.dateAdded || vehicle.createdAt;
  const startMs = startValue ? new Date(startValue).getTime() : Number.NaN;
  if (!Number.isFinite(startMs)) return 0;

  const endValue =
    vehicle.isArchived === true
      ? vehicle.archivedAt || vehicle.dateSold || new Date()
      : new Date();
  const endMs = new Date(endValue).getTime();

  return Math.max(0, Math.floor((endMs - startMs) / DAY_MS));
};

const getPriceUpdatedAt = (vehicle: any) =>
  vehicle.priceUpdatedAt || undefined;

const normalizeVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || "",
  color: vehicle.exteriorColor || "N/A",
  exteriorColor: vehicle.exteriorColor || "N/A",
  interiorColor: vehicle.interiorColor || "N/A",
  stockNumber: vehicle.stockNumber || "N/A",
  price: vehicle.price || 0,
  cost: vehicle.cost || 0,
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || "Automatic",
  fuelType: vehicle.fuelType || "Gasoline",
  engine: vehicle.engine || "",
  bodyStyle: vehicle.bodyStyle || "",
  driveTrain: vehicle.driveTrain || "",
  cylinders: vehicle.cylinders || 0,
  doors: vehicle.doors || 0,
  options: vehicle.options || "",
  vehicleType: vehicle.vehicleType || "",
  featured: vehicle.featured || false,
  certified: vehicle.certified || false,
  isNewVehicle: vehicle.isNewVehicle || false,
  videoUrl: vehicle.vdpUrl || "",
  location: vehicle.dealerCity
    ? `${vehicle.dealerCity}${vehicle.dealerState ? ", " + vehicle.dealerState : ""}${vehicle.dealerZip ? ", " + vehicle.dealerZip : ""}`
    : "Unknown",
  dealerName: vehicle.dealerName || "",
  dealerAddress: vehicle.dealerAddress || "",
  image:
    vehicle.images && vehicle.images.length > 0
      ? vehicle.images[0]
      : "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop",
  images: vehicle.images || [],
  status: vehicle.status,
  currentStep: vehicle.currentStep,
  reconStartDate: vehicle.reconStartDate,
  stepEnteredAt: vehicle.stepEnteredAt,
  daysOnLot: vehicle.daysOnLot || 0,
  ageDays: getVehicleAgeDays(vehicle),
  priceUpdatedAt: getPriceUpdatedAt(vehicle),
  dateAdded: vehicle.dateAdded,
  dateSold: vehicle.dateSold,
  assignedTo: vehicle.assignedTo,
  notes: vehicle.notes || [],
  comments: vehicle.comments || (vehicle as any).description || "",
  leadCount: vehicle.leadCount || 0,
  isArchived: vehicle.isArchived === true,
  archivedAt: vehicle.archivedAt || null,
  archiveReason: vehicle.archiveReason || null,
  lastSeenInFeedAt: vehicle.lastSeenInFeedAt || null,
});

/**
 * Archive scoping for inventory queries.
 * - Default / archived=false  → only active vehicles ({ $ne: true } also
 *   matches legacy documents created before the isArchived field existed).
 * - archived=true             → only Archive/Sold vehicles.
 * - archived=all              → both (admin/reporting use).
 */
const archivedScope = (archived: unknown): Record<string, any> => {
  if (archived === "all") return {};
  if (archived === "true") return { isArchived: true };
  return { isArchived: { $ne: true } };
};

const normalizePublicVehicle = (vehicle: any) => ({
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || "",
  color: vehicle.exteriorColor || "N/A",
  exteriorColor: vehicle.exteriorColor || "N/A",
  interiorColor: vehicle.interiorColor || "N/A",
  stockNumber: vehicle.stockNumber || "N/A",
  price: vehicle.price || 0,
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || "Automatic",
  fuelType: vehicle.fuelType || "Gasoline",
  location: vehicle.dealerCity
    ? `${vehicle.dealerCity}${vehicle.dealerState ? ", " + vehicle.dealerState : ""}${vehicle.dealerZip ? ", " + vehicle.dealerZip : ""}`
    : "Unknown",
  image:
    vehicle.images && vehicle.images.length > 0
      ? vehicle.images[0]
      : "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop",
  images: vehicle.images || [],
  status: vehicle.status,
  daysOnLot: vehicle.daysOnLot || 0,
  comments: vehicle.comments || "",
});

const normalizeCustomerVehicle = (
  vehicle: any,
  member?: { discountPercent: number; tierName: string; tierSlug: string },
) => {
  const price = vehicle.price || 0;
  const discountPercent = member?.discountPercent ?? 0;
  const memberPrice = membershipService.computeMemberPrice(price, vehicle.cost, discountPercent);
  const memberSavings = Math.max(0, price - memberPrice);
  return {
  id: vehicle._id.toString(),
  vin: vehicle.vin,
  year: vehicle.year,
  make: vehicle.make,
  model: vehicle.modelName,
  modelName: vehicle.modelName,
  trim: vehicle.trim || "",
  color: vehicle.exteriorColor || "N/A",
  exteriorColor: vehicle.exteriorColor || "N/A",
  interiorColor: vehicle.interiorColor || "N/A",
  stockNumber: vehicle.stockNumber || "N/A",
  price,
  memberPrice,
  memberSavings,
  memberDiscountPercent: memberSavings > 0 ? discountPercent : 0,
  tierName: memberSavings > 0 ? member?.tierName ?? "" : "",
  marketPrice: vehicle.msrp || 0,
  mileage: vehicle.mileage || 0,
  transmission: vehicle.transmission || "Automatic",
  fuelType: vehicle.fuelType || "Gasoline",
  location: vehicle.dealerCity
    ? `${vehicle.dealerCity}${vehicle.dealerState ? ", " + vehicle.dealerState : ""}${vehicle.dealerZip ? ", " + vehicle.dealerZip : ""}`
    : "Unknown",
  image:
    (Array.isArray(vehicle.images)
      ? vehicle.images.find((img: string) => typeof img === "string" && img.trim().length > 0)
      : null) ||
    "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop",
  images: Array.isArray(vehicle.images)
    ? vehicle.images.filter((img: string) => typeof img === "string" && img.trim().length > 0)
    : [],
  status: vehicle.status,
  daysOnLot: vehicle.daysOnLot || 0,
  engine: vehicle.engine || "",
  driveTrain: vehicle.driveTrain || "",
  comments: vehicle.comments || "",
  options: vehicle.options || "",
  };
};

const createVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;

  const initialPrice =
    req.body?.price !== undefined && req.body?.price !== null
      ? Number(req.body.price)
      : undefined;
  const createdAt = new Date();

  const vehicle = await Vehicle.create({
    ...req.body,
    organizationId: orgId,
    priceUpdatedAt:
      initialPrice !== undefined && Number.isFinite(initialPrice)
        ? createdAt
        : undefined,
    priceHistory:
      initialPrice !== undefined && Number.isFinite(initialPrice)
        ? [
            {
              previousPrice: null,
              newPrice: initialPrice,
              changedAt: createdAt,
              ...(userId ? { changedBy: userId } : {}),
              source: "Suprah AI",
            },
          ]
        : [],
  });

  const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;

  // Notify admins about new vehicle
  if (orgId) {
    const { title, message } = notificationTemplates.vehicle_added({
      vehicleName,
      stockNumber: vehicle.stockNumber,
    });

    await notifyOrgAdmins(
      orgId,
      "vehicle_added",
      title,
      message,
      {
        vehicleId: vehicle._id.toString(),
        vehicleName,
        stockNumber: vehicle.stockNumber,
        vin: vehicle.vin,
      },
      userId, // Exclude the user who created it
    );
  }

  await activityService.createActivity({
    userId: userId || "SYSTEM",
    organizationId: orgId,
    type: "vehicle_added",
    title: "Vehicle Added",
    description: `Added ${vehicleName} to inventory`,
    metadata: {
      vehicleId: vehicle._id.toString(),
      vin: vehicle.vin,
      stockNumber: vehicle.stockNumber,
    },
    ipAddress: req.ip,
  });

  logger.info(
    { vehicleId: vehicle._id, vin: vehicle.vin, orgId },
    "New vehicle added to inventory",
  );

  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        normalizeVehicle(vehicle),
        "Vehicle created successfully",
      ),
    );

  // Invalidate vehicle cache after new vehicle is added
  await cacheService.invalidateByPrefix("veh:");
});

const getVehicles = asyncHandler(async (req: Request, res: Response) => {
  const {
    status,
    search: searchParam,
    q, // Fallback for some frontend search bars
    make,
    model,
    year,
    location,
    minPrice,
    maxPrice,
    minMileage,
    maxMileage,
    highDemand,
    lowPerforming,
    sortBy = "createdAt",
    sortOrder = "desc",
    page = "1",
    limit = "20",
    all,
    includeMetrics,
    metricsOnly,
    archived,
  } = req.query;

  const search = searchParam || q;

  // organizationId is handled in pipeline or match below. The archived scope
  // hides Archive/Sold vehicles from All Inventory by default; the dedicated
  // Archive/Sold view passes archived=true.
  const filter: any = { isDeleted: false, ...archivedScope(archived) };

  if (status && status !== "all") {
    filter.status = status;
  }

  if (make) {
    filter.make = { $regex: make, $options: "i" };
  }

  if (model) {
    filter.modelName = { $regex: model, $options: "i" };
  }

  if (year) {
    filter.year = Number(year);
  }

  if (location) {
    filter.$or = [
      { dealerCity: { $regex: location, $options: "i" } },
      { dealerState: { $regex: location, $options: "i" } },
    ];
  }

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (minMileage || maxMileage) {
    filter.mileage = {};
    if (minMileage) filter.mileage.$gte = Number(minMileage);
    if (maxMileage) filter.mileage.$lte = Number(maxMileage);
  }

  if (req.query.bodyStyle) {
    filter.bodyStyle = { $regex: req.query.bodyStyle, $options: "i" };
  }

  if (req.query.driveTrain) {
    filter.driveTrain = { $regex: req.query.driveTrain, $options: "i" };
  }

  if (req.query.minDaysOnLot || req.query.maxDaysOnLot) {
    filter.daysOnLot = {};
    if (req.query.minDaysOnLot)
      filter.daysOnLot.$gte = Number(req.query.minDaysOnLot);
    if (req.query.maxDaysOnLot)
      filter.daysOnLot.$lte = Number(req.query.maxDaysOnLot);
  }

  if (req.query.minCost || req.query.maxCost) {
    filter.cost = {};
    if (req.query.minCost) filter.cost.$gte = Number(req.query.minCost);
    if (req.query.maxCost) filter.cost.$lte = Number(req.query.maxCost);
  }

  const sortObj: any = {};
  const order = sortOrder === "desc" ? -1 : 1;

  switch (sortBy) {
    case "stockNumber":
      sortObj.stockNumber = order;
      break;
    case "year":
      sortObj.year = order;
      break;
    case "make":
      sortObj.make = order;
      sortObj.modelName = order;
      break;
    case "location":
      sortObj.dealerCity = order;
      sortObj.dealerState = order;
      break;
    case "mileage":
      sortObj.mileage = order;
      break;
    case "cost":
      sortObj.cost = order;
      break;
    case "price":
      sortObj.price = order;
      break;
    case "age":
      sortObj.daysOnLot = order;
      break;
    case "status":
      sortObj.status = order;
      break;
    case "updated":
      sortObj.updatedAt = order;
      break;
    case "priceUpdated":
      sortObj.priceUpdatedAt = order;
      break;
    case "created":
    case "recent":
      sortObj.dateAdded = order;
      break;
    case "demand":
      sortObj.leadCount = order;
      break;
    case "low-performing":
      sortObj.daysOnLot = -1;
      sortObj.leadCount = 1;
      break;
    default:
      sortObj.make = 1;
      sortObj.modelName = 1;
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.max(1, Number(limit) || 20);
  const skip = (pageNum - 1) * limitNum;
  const fetchAll = all === "true";
  const returnMetricsOnly = metricsOnly === "true";

  // Build Aggregation Pipeline
  const pipeline: any[] = [];

  // Stage 1: Search (Must be first)
  if (search) {
    const searchString = search.toString();
    const isNumericSearch = !isNaN(Number(searchString));

    const shouldClauses: any[] = [
      {
        text: {
          query: searchString,
          path: ["make", "modelName", "vin", "stockNumber"],
          fuzzy: { maxEdits: 1 },
        },
      },
    ];

    // If the search is a number (like 2024), add a numeric match for the 'year' field
    if (isNumericSearch) {
      shouldClauses.push({
        equals: {
          value: Number(searchString),
          path: "year",
        },
      });
    }

    pipeline.push({
      $search: {
        index: "Vehicle",
        compound: {
          must: [
            {
              equals: {
                value: req.orgId,
                path: "organizationId",
              },
            },
            {
              compound: {
                should: shouldClauses,
                minimumShouldMatch: 1,
              },
            },
          ],
        },
      },
    });
  } else {
    pipeline.push({ $match: { organizationId: req.orgId, isDeleted: false } });
  }

  // Stage 2: Filter matching
  pipeline.push({ $match: filter });

  // Stage 2.5: Lead-count lookup (only when demand sort or highDemand filter is active)
  const needsDemandMetrics =
    returnMetricsOnly ||
    includeMetrics === "true" ||
    sortBy === "demand" ||
    sortBy === "low-performing" ||
    highDemand === "true" ||
    lowPerforming === "true";
  if (needsDemandMetrics) {
    pipeline.push({
      $lookup: {
        from: "leads",
        let: { vVin: "$vin" },
        pipeline: [
          { $match: { $expr: { $eq: ["$vehicle.vin", "$$vVin"] } } },
          { $count: "total" },
        ],
        as: "_leadData",
      },
    });
    pipeline.push({
      $addFields: {
        leadCount: { $ifNull: [{ $arrayElemAt: ["$_leadData.total", 0] }, 0] },
      },
    });
    if (highDemand === "true") {
      pipeline.push({ $match: { leadCount: { $gte: 1 } } });
    }
    if (lowPerforming === "true") {
      // Low performing: zero inquiries AND sitting on lot for 30+ days
      pipeline.push({ $match: { leadCount: 0, daysOnLot: { $gte: 30 } } });
    }
  }

  // Metrics-only mode is used by the Inventory UI after the page is already
  // interactive. Return only IDs + lead counts and skip the assigned-user
  // lookup, normalization payload, images, notes, and other vehicle fields.
  if (returnMetricsOnly) {
    pipeline.push({
      $project: {
        _id: 1,
        leadCount: { $ifNull: ["$leadCount", 0] },
      },
    });

    const metricRows = await Vehicle.aggregate(pipeline);
    const metrics = metricRows.map((vehicle: any) => ({
      id: vehicle._id.toString(),
      leadCount: vehicle.leadCount || 0,
    }));

    return res.json(
      new ApiResponse(
        200,
        {
          vehicles: metrics,
          total: metrics.length,
          pagination: {
            page: 1,
            limit: metrics.length,
            total: metrics.length,
            totalPages: 1,
          },
        },
        "Vehicle demand metrics fetched successfully",
      ),
    );
  }

  // Stage 3: Sorting
  pipeline.push({ $sort: sortObj });

  // Stage 4: Pagination & Metadata Facets. The All Inventory page can request
  // the complete filtered set once (`all=true`) and perform sorting/pagination
  // locally. That prevents a second server response from replacing the grid
  // every time the user changes the sort option.
  const dataPipeline: any[] = [];

  if (!fetchAll) {
    dataPipeline.push({ $skip: skip }, { $limit: limitNum });
  }

  dataPipeline.push(
    {
      $lookup: {
        from: "users",
        localField: "assignedTo",
        foreignField: "_id",
        as: "assignedTo",
      },
    },
    {
      $unwind: {
        path: "$assignedTo",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        "assignedTo.password": 0,
        "assignedTo.otp": 0,
        "assignedTo.otpExpires": 0,
        _leadData: 0,
        priceHistory: 0,
      },
    },
  );

  pipeline.push({
    $facet: {
      metadata: [{ $count: "total" }],
      data: dataPipeline,
    },
  });

  const [result] = await Vehicle.aggregate(pipeline);

  const total = result.metadata[0]?.total || 0;
  const vehicles = result.data || [];
  const normalized = vehicles.map((v: any) => normalizeVehicle(v));

  const responseData: any = {
    vehicles: normalized,
    total,
  };

  responseData.pagination = {
    page: fetchAll ? 1 : pageNum,
    limit: fetchAll ? total : limitNum,
    total,
    totalPages: fetchAll ? 1 : Math.max(1, Math.ceil(total / limitNum)),
  };

  res.json(new ApiResponse(200, responseData, "Vehicles fetched successfully"));
});

const getVehicleById = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const isStaff =
    user &&
    (user.role === "admin" ||
      user.role === "super_admin" ||
      (user as any).organizationRole === "employee");
  const orgId = req.orgId as string;

  let query: any = { _id: req.params.id, isDeleted: false };

  // If staff, we usually restrict to their organization unless super_admin
  if (isStaff && user.role !== "super_admin") {
    query.organizationId = orgId;
  }

  const vehicle = await Vehicle.findOne(query)
    .select("-priceHistory")
    .populate("assignedTo", "email name");

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  // Role-based normalization
  if (isStaff) {
    res.json(
      new ApiResponse(
        200,
        normalizeVehicle(vehicle),
        "Vehicle fetched successfully",
      ),
    );
  } else {
    // For customers or cross-org checks, return filtered data
    res.json(
      new ApiResponse(
        200,
        normalizeCustomerVehicle(vehicle),
        "Vehicle fetched successfully",
      ),
    );
  }
});

/**
 * Publicly accessible vehicle data (sanitized)
 */
const getPublicVehicleById = asyncHandler(
  async (req: Request, res: Response) => {
    const vehicle = await Vehicle.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).select(
      "-cost -notes -assignedTo -organizationId -dealerEmail -isDeleted -manualStatusLock -priceHistory",
    );

    if (!vehicle) {
      throw new ApiError(404, "Vehicle not found");
    }

    // Double check status - normally we only show 'Ready for Sale' publicly
    // But we allow others if explicitly shared, as long as sensitive data is scrubbed.

    res.json(
      new ApiResponse(
        200,
        normalizePublicVehicle(vehicle),
        "Public vehicle data fetched successfully",
      ),
    );
  },
);

const updateVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const existingVehicle = await Vehicle.findOne({
    _id: req.params.id,
    organizationId: orgId,
  });

  if (!existingVehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  const updateData: Record<string, any> = { ...req.body };
  const oldStatus = existingVehicle.status;

  // Price audit fields are server-managed so clients cannot rewrite history.
  delete updateData.priceHistory;
  delete updateData.priceUpdatedAt;

  const requestedPrice =
    updateData.price !== undefined && updateData.price !== null
      ? Number(updateData.price)
      : undefined;
  const existingPrice =
    existingVehicle.price !== undefined && existingVehicle.price !== null
      ? Number(existingVehicle.price)
      : undefined;
  const priceChanged =
    requestedPrice !== undefined &&
    Number.isFinite(requestedPrice) &&
    requestedPrice !== existingPrice;
  const priceChangedAt = priceChanged ? new Date() : undefined;

  if (priceChanged && priceChangedAt) {
    updateData.priceUpdatedAt = priceChangedAt;
  }

  if (
    updateData.currentStep &&
    updateData.currentStep !== existingVehicle.currentStep
  ) {
    updateData.stepEnteredAt = new Date();
  }

  if (updateData.status && updateData.status !== existingVehicle.status) {
    updateData.manualStatusLock = true;
  }

  const updateOperations: Record<string, any> = {
    $set: updateData,
  };

  if (priceChanged && priceChangedAt && requestedPrice !== undefined) {
    updateOperations.$push = {
      priceHistory: {
        previousPrice: existingPrice ?? null,
        newPrice: requestedPrice,
        changedAt: priceChangedAt,
        ...(userId ? { changedBy: userId } : {}),
        source: "Suprah AI",
      },
    };
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId },
    updateOperations,
    { new: true, runValidators: true },
  ).populate("assignedTo", "email name");

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;

  // Notify on status change (especially if sold)
  if (orgId && updateData.status && updateData.status !== oldStatus) {
    if (updateData.status === "Sold") {
      const { title, message } = notificationTemplates.vehicle_sold({
        vehicleName,
        stockNumber: vehicle.stockNumber,
        price: vehicle.price,
      });

      await notifyOrgAdmins(
        orgId,
        "vehicle_sold",
        title,
        message,
        {
          vehicleId: vehicle._id.toString(),
          vehicleName,
          stockNumber: vehicle.stockNumber,
          price: vehicle.price,
        },
        userId,
      );
    } else {
      const { title, message } = notificationTemplates.vehicle_status_changed({
        vehicleName,
        stockNumber: vehicle.stockNumber,
        status: updateData.status,
      });

      await notifyOrgAdmins(
        orgId,
        "vehicle_status_changed",
        title,
        message,
        {
          vehicleId: vehicle._id.toString(),
          vehicleName,
          oldStatus,
          newStatus: updateData.status,
        },
        userId,
      );
    }
  }

  await activityService.createActivity({
    userId: userId || "SYSTEM",
    organizationId: orgId,
    type: "vehicle_updated",
    title: "Vehicle Updated",
    description: `Updated status of ${vehicleName} to ${updateData.status || vehicle.status}`,
    metadata: {
      vehicleId: vehicle._id.toString(),
      status: updateData.status,
      oldStatus,
    },
  });

  logger.info(
    { vehicleId: vehicle._id, status: vehicle.status, orgId },
    "Vehicle updated",
  );

  // Price drop alert: notify customers who saved this vehicle
  const newPrice = updateData.price != null ? Number(updateData.price) : null;
  const oldPrice = existingVehicle.price != null ? Number(existingVehicle.price) : null;
  if (newPrice !== null && oldPrice !== null && newPrice < oldPrice) {
    try {
      const savers = await SavedVehicle.find({ vehicleId: vehicle._id }).select('userId');
      for (const saver of savers) {
        await safeCreateNotification({
          userId: saver.userId.toString(),
          organizationId: orgId,
          type: 'vehicle_updated',
          title: 'Price Drop Alert',
          message: `${vehicleName} dropped to $${newPrice.toLocaleString()} (was $${oldPrice.toLocaleString()})`,
          metadata: { vehicleId: vehicle._id.toString(), newPrice, oldPrice, route: '/customer/saved' },
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to send price drop alerts');
    }
  }

  res.json(
    new ApiResponse(
      200,
      normalizeVehicle(vehicle),
      "Vehicle updated successfully",
    ),
  );

  // Invalidate vehicle cache on any update
  await cacheService.invalidateByPrefix("veh:");
});

const deleteVehicle = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const vehicle = await Vehicle.findOneAndDelete({
    _id: req.params.id,
    organizationId: orgId,
  });

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  if (orgId) {
    const vehicleName = `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`;
    await notifyOrgAdmins(
      orgId,
      "vehicle_status_changed",
      "Vehicle Deleted",
      `${vehicleName} (Stock #${vehicle.stockNumber || "N/A"}) was removed from inventory`,
      { vehicleId: req.params.id, vehicleName },
      userId,
    );
  }

  await activityService.createActivity({
    userId: userId || "SYSTEM",
    organizationId: orgId,
    type: "vehicle_updated",
    title: "Vehicle Removed",
    description: `Vehicle ${vehicle.year} ${vehicle.make} ${vehicle.modelName} was deleted from inventory`,
    metadata: { vehicleId: req.params.id, vin: vehicle.vin },
  });

  logger.warn(
    { vehicleId: req.params.id, vin: vehicle.vin, orgId },
    "Vehicle deleted from inventory",
  );

  res.json(new ApiResponse(200, null, "Vehicle deleted successfully"));

  // Invalidate vehicle cache on delete
  await cacheService.invalidateByPrefix("veh:");
});

const getVehiclePriceHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const orgId = req.orgId as string;

    const vehicle = await Vehicle.findOne({
      _id: req.params.id,
      organizationId: orgId,
      isDeleted: false,
    })
      .select(
        "year make modelName trim stockNumber price priceUpdatedAt dateAdded isArchived archivedAt dateSold priceHistory",
      )
      .populate("priceHistory.changedBy", "name email")
      .lean();

    if (!vehicle) {
      throw new ApiError(404, "Vehicle not found");
    }

    const rawHistory = Array.isArray((vehicle as any).priceHistory)
      ? (vehicle as any).priceHistory
      : [];

    const history = rawHistory
      .map((entry: any, index: number) => ({
        id: entry._id?.toString?.() || `${vehicle._id.toString()}-${index}`,
        previousPrice:
          entry.previousPrice === null || entry.previousPrice === undefined
            ? null
            : Number(entry.previousPrice),
        newPrice: Number(entry.newPrice || 0),
        changedAt: entry.changedAt,
        source: entry.source || "Suprah AI",
        changedBy: entry.changedBy
          ? {
              id: entry.changedBy._id?.toString?.(),
              name: entry.changedBy.name || "",
              email: entry.changedBy.email || "",
            }
          : null,
      }))
      .sort(
        (a: any, b: any) =>
          new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
      );

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          vehicle: {
            id: vehicle._id.toString(),
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.modelName,
            trim: vehicle.trim || "",
            stockNumber: vehicle.stockNumber || "",
            currentPrice: Number(vehicle.price || 0),
            priceUpdatedAt: getPriceUpdatedAt(vehicle),
          },
          history,
        },
        "Vehicle pricing log fetched successfully",
      ),
    );
  },
);

const addVehicleNote = asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  const userId = (req as any).user?._id;
  const orgId = req.orgId as string;

  if (!text) {
    throw new ApiError(400, "Note text is required");
  }

  if (!userId) {
    throw new ApiError(401, "User not authenticated");
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId },
    {
      $push: {
        notes: {
          text,
          author: userId,
          date: new Date(),
        },
      },
    },
    { new: true },
  )
    .populate("assignedTo", "email name")
    .populate("notes.author", "name email");

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  res.json(
    new ApiResponse(200, normalizeVehicle(vehicle), "Note added successfully"),
  );
});

const FILTER_SCOPE_KEYS = [
  "make",
  "model",
  "status",
  "year",
  "location",
  "bodyStyle",
  "minPrice",
  "maxPrice",
  "minMileage",
  "maxMileage",
] as const;

const hasScopedFilterParams = (query: Request["query"]) =>
  FILTER_SCOPE_KEYS.some((key) => {
    const value = query[key];
    return value !== undefined && value !== "" && value !== "all";
  });

const buildScopedFilterQuery = (
  query: Request["query"],
  baseQuery: Record<string, any>,
) => {
  const scoped: Record<string, any> = { ...baseQuery };

  if (query.make) scoped.make = { $regex: query.make, $options: "i" };
  if (query.model) scoped.modelName = { $regex: query.model, $options: "i" };
  if (query.status && query.status !== "all") scoped.status = query.status;
  if (query.year) scoped.year = Number(query.year);

  if (query.location) {
    scoped.$or = [
      { dealerCity: { $regex: query.location, $options: "i" } },
      { dealerState: { $regex: query.location, $options: "i" } },
    ];
  }

  if (query.bodyStyle) {
    scoped.bodyStyle = { $regex: query.bodyStyle, $options: "i" };
  }

  if (query.minPrice || query.maxPrice) {
    scoped.price = {};
    if (query.minPrice) scoped.price.$gte = Number(query.minPrice);
    if (query.maxPrice) scoped.price.$lte = Number(query.maxPrice);
  }

  if (query.minMileage || query.maxMileage) {
    scoped.mileage = {};
    if (query.minMileage) scoped.mileage.$gte = Number(query.minMileage);
    if (query.maxMileage) scoped.mileage.$lte = Number(query.maxMileage);
  }

  return scoped;
};

const stripQueryField = (query: Record<string, any>, field: string) => {
  const next = { ...query };

  if (field === "location") {
    delete next.$or;
    return next;
  }

  if (field === "model") {
    delete next.modelName;
    return next;
  }

  delete next[field];
  return next;
};

const getFilters = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const hasScopedParams = hasScopedFilterParams(req.query);
  const archiveScope = archivedScope(req.query.archived);
  const cacheKey =
    req.query.archived === "true"
      ? `veh:filters:${orgId}:archived`
      : `veh:filters:${orgId}`;

  if (!hasScopedParams) {
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json(
        new ApiResponse(200, cached, "Filters fetched successfully"),
      );
    }
  }

  const scopedQuery = buildScopedFilterQuery(req.query, {
    organizationId: orgId,
    isDeleted: false,
    ...archiveScope,
  });

  // Make is always unscoped — show all available makes regardless of other filter selections
  const baseQuery = { organizationId: orgId, isDeleted: false, ...archiveScope };

  const [makes, models, statuses, years, locations, bodyStyles, driveTrains] =
    await Promise.all([
      Vehicle.distinct("make", baseQuery),
      Vehicle.distinct("modelName", stripQueryField(scopedQuery, "model")),
      Vehicle.distinct("status", stripQueryField(scopedQuery, "status")),
      Vehicle.distinct("year", stripQueryField(scopedQuery, "year")),
      Vehicle.distinct("dealerCity", stripQueryField(scopedQuery, "location")),
      Vehicle.distinct("bodyStyle", stripQueryField(scopedQuery, "bodyStyle")),
      Vehicle.distinct("driveTrain", scopedQuery),
    ]);

  const data = {
    makes: makes.filter(Boolean).sort(),
    models: models.filter(Boolean).sort(),
    statuses: statuses.filter(Boolean).sort(),
    years: years.filter(Boolean).sort((a, b) => b - a),
    locations: locations.filter(Boolean).sort(),
    bodyStyles: bodyStyles.filter(Boolean).sort(),
    driveTrains: driveTrains.filter(Boolean).sort(),
  };

  if (!hasScopedParams) {
    await cacheService.set(cacheKey, data, VEH_CACHE_TTL);
  }

  res.json(new ApiResponse(200, data, "Filters fetched successfully"));
});

const getStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const cacheKey = `veh:stats:${orgId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.json(
      new ApiResponse(200, cached, "Statistics fetched successfully"),
    );
  }

  const activeMatch = {
    organizationId: orgId,
    isDeleted: false,
    isArchived: { $ne: true },
  };

  const [total, byStatus, vehicles, archivedTotal] = await Promise.all([
    Vehicle.countDocuments(activeMatch),
    Vehicle.aggregate([
      { $match: activeMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Vehicle.find(activeMatch).select("price daysOnLot"),
    Vehicle.countDocuments({
      organizationId: orgId,
      isDeleted: false,
      isArchived: true,
    }),
  ]);

  const statusBreakdown = byStatus.reduce((acc: any, item: any) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  const prices = vehicles.map((v) => v.price || 0).filter((p) => p > 0);
  const averagePrice =
    prices.length > 0
      ? Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length)
      : 0;

  const daysOnLot = vehicles.map((v) => v.daysOnLot || 0);
  const averageDaysOnLot =
    daysOnLot.length > 0
      ? Math.round(daysOnLot.reduce((sum, d) => sum + d, 0) / daysOnLot.length)
      : 0;

  const totalValue = prices.reduce((sum, p) => sum + p, 0);

  const data = {
    total,
    byStatus: statusBreakdown,
    averagePrice,
    averageDaysOnLot,
    totalValue,
    archivedTotal,
  };

  await cacheService.set(cacheKey, data, VEH_CACHE_TTL);

  res.json(new ApiResponse(200, data, "Statistics fetched successfully"));
});

const getDashboardGraphs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const salesTrend = await Vehicle.aggregate([
    {
      $match: {
        organizationId: orgId,
        status: "Sold",
        dateSold: { $gte: sixMonthsAgo },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$dateSold" },
          month: { $month: "$dateSold" },
        },
        sold: { $sum: 1 },
        revenue: { $sum: "$price" },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const formattedSalesTrend = salesTrend.map((item) => ({
    month: monthNames[item._id.month - 1],
    sold: item.sold,
    revenue: item.revenue || 0,
  }));

  const inventoryByMake = await Vehicle.aggregate([
    {
      $match: {
        organizationId: orgId,
        isDeleted: false,
        isArchived: { $ne: true },
        status: { $ne: "Sold" },
      },
    },
    { $group: { _id: "$make", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  const formattedInventoryByMake = inventoryByMake.map((item) => ({
    make: item._id,
    count: item.count,
  }));

  const priceDistribution = await Vehicle.aggregate([
    {
      $match: {
        organizationId: orgId,
        isDeleted: false,
        isArchived: { $ne: true },
        status: { $ne: "Sold" },
        price: { $gt: 0 },
      },
    },
    {
      $bucket: {
        groupBy: "$price",
        boundaries: [0, 20000, 40000, 60000, 80000, 100000, 200000],
        default: "200k+",
        output: { count: { $sum: 1 } },
      },
    },
  ]);

  const priceRangeLabels = [
    "0-20k",
    "20k-40k",
    "40k-60k",
    "60k-80k",
    "80k-100k",
    "100k-200k",
    "200k+",
  ];
  const formattedPriceDistribution = priceDistribution.map((item, index) => ({
    range: priceRangeLabels[index] || "200k+",
    count: item.count,
  }));

  const now = new Date();
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  const [currentVehicles, lastMonthVehicles] = await Promise.all([
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      isArchived: { $ne: true },
      status: { $ne: "Sold" },
      dateAdded: { $gte: lastMonth },
    }).select("daysOnLot"),
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      status: "Sold",
      dateSold: { $gte: lastMonth, $lt: now },
    }).select("daysOnLot"),
  ]);

  const currentAvg =
    currentVehicles.length > 0
      ? Math.round(
          currentVehicles.reduce((sum, v) => sum + (v.daysOnLot || 0), 0) /
            currentVehicles.length,
        )
      : 0;

  const lastMonthAvg =
    lastMonthVehicles.length > 0
      ? Math.round(
          lastMonthVehicles.reduce((sum, v) => sum + (v.daysOnLot || 0), 0) /
            lastMonthVehicles.length,
        )
      : 0;

  const trend =
    currentAvg < lastMonthAvg
      ? "improving"
      : currentAvg > lastMonthAvg
        ? "declining"
        : "stable";

  res.json(
    new ApiResponse(
      200,
      {
        salesTrend: formattedSalesTrend,
        inventoryByMake: formattedInventoryByMake,
        priceDistribution: formattedPriceDistribution,
        daysOnLotAverage: {
          current: currentAvg,
          lastMonth: lastMonthAvg,
          trend,
        },
      },
      "Dashboard graphs data fetched successfully",
    ),
  );
});

const updateVehicleStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, currentStep } = req.body;

    if (!status) {
      throw new ApiError(400, "Status is required");
    }

    const orgId = req.orgId as string;
    const updateData: any = { status };

    if (currentStep) {
      updateData.currentStep = currentStep;
      updateData.stepEnteredAt = new Date();
    }

    updateData.manualStatusLock = true;

    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId },
      updateData,
      { new: true, runValidators: true },
    ).populate("assignedTo", "email name");

    if (!vehicle) {
      throw new ApiError(404, "Vehicle not found");
    }

    res.json(
      new ApiResponse(
        200,
        normalizeVehicle(vehicle),
        "Vehicle status updated successfully",
      ),
    );
  },
);

const exportVehicles = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const {
    status,
    search,
    make,
    model,
    year,
    location,
    minPrice,
    maxPrice,
    minMileage,
    maxMileage,
    archived,
  } = req.query;

  // Used for match stage after search. Archived vehicles are excluded unless
  // explicitly requested (archived=true exports the Archive/Sold view).
  const filter: any = { ...archivedScope(archived) };

  if (status) {
    if (status !== "all") {
      filter.status = status;
    }
  } else {
    filter.status = "Ready for Sale";
  }

  if (make) filter.make = { $regex: make, $options: "i" };
  if (model) filter.modelName = { $regex: model, $options: "i" };
  if (year) filter.year = Number(year);
  if (location) {
    filter.$or = [
      { dealerCity: { $regex: location, $options: "i" } },
      { dealerState: { $regex: location, $options: "i" } },
    ];
  }

  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  if (minMileage || maxMileage) {
    filter.mileage = {};
    if (minMileage) filter.mileage.$gte = Number(minMileage);
    if (maxMileage) filter.mileage.$lte = Number(maxMileage);
  }

  const pipeline: any[] = [];

  if (search) {
    const searchString = search.toString();
    const isNumericSearch = !isNaN(Number(searchString));

    const shouldClauses: any[] = [
      {
        text: {
          query: searchString,
          path: ["make", "modelName", "vin", "stockNumber"],
          fuzzy: { maxEdits: 1 },
        },
      },
    ];

    if (isNumericSearch) {
      shouldClauses.push({
        equals: {
          value: Number(searchString),
          path: "year",
        },
      });
    }

    pipeline.push({
      $search: {
        index: "Vehicle",
        compound: {
          must: [
            {
              equals: {
                value: orgId,
                path: "organizationId",
              },
            },
            {
              compound: {
                should: shouldClauses,
                minimumShouldMatch: 1,
              },
            },
          ],
        },
      },
    });
  } else {
    pipeline.push({ $match: { organizationId: orgId, isDeleted: false } });
  }

  pipeline.push({ $match: filter });
  pipeline.push({ $sort: { createdAt: -1 } });

  const vehicles = await Vehicle.aggregate(pipeline);

  const csvHeader =
    "VIN,Year,Make,Model,Trim,Color,Stock Number,Price,Mileage,Status,Location,Date Added\n";
  const csvRows = vehicles
    .map(
      (v: any) =>
        `"${v.vin}",${v.year},"${v.make}","${v.modelName}","${v.trim || ""}","${v.exteriorColor || ""}","${v.stockNumber || ""}",${v.price || 0},${v.mileage || 0},"${v.status}","${v.dealerCity}, ${v.dealerState}",${v.dateAdded ? new Date(v.dateAdded).toISOString().split("T")[0] : ""}`,
    )
    .join("\n");

  const csv = csvHeader + csvRows;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="vehicles-export-${Date.now()}.csv"`,
  );
  res.send(csv);
});

const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const [recentVehicles, stats, alerts] = await Promise.all([
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      isArchived: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("assignedTo", "email name"),
    Vehicle.aggregate([
      {
        $match: {
          organizationId: orgId,
          isDeleted: false,
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          avgPrice: { $avg: "$price" },
        },
      },
    ]),
    Vehicle.find({
      organizationId: orgId,
      isDeleted: false,
      isArchived: { $ne: true },
      status: "In Recon",
      daysOnLot: { $gt: 30 },
    }).countDocuments(),
  ]);

  const statusBreakdown = stats.reduce((acc: any, item: any) => {
    acc[item._id] = {
      count: item.count,
      avgPrice: Math.round(item.avgPrice || 0),
    };
    return acc;
  }, {});

  res.json(
    new ApiResponse(
      200,
      {
        recentVehicles: recentVehicles.map(normalizeVehicle),
        statusBreakdown,
        alerts: {
          longRecon: alerts,
        },
      },
      "Dashboard data fetched successfully",
    ),
  );
});

const autocomplete = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { q } = req.query;

  if (!q || (q as string).length < 2) {
    return res.json(new ApiResponse(200, [], "Query too short"));
  }

  const regex = { $regex: q, $options: "i" };
  const query = {
    organizationId: orgId,
    isDeleted: false,
    isArchived: { $ne: true },
  };

  const [vins, makes, models, stockNumbers] = await Promise.all([
    Vehicle.distinct("vin", { ...query, vin: regex }),
    Vehicle.distinct("make", { ...query, make: regex }),
    Vehicle.distinct("modelName", { ...query, modelName: regex }),
    Vehicle.distinct("stockNumber", { ...query, stockNumber: regex }),
  ]);

  const suggestions = [
    ...vins.map((v) => ({ type: "vin", value: v })),
    ...makes.map((m) => ({ type: "make", value: m })),
    ...models.map((m) => ({ type: "model", value: m })),
    ...stockNumbers.filter(Boolean).map((s) => ({ type: "stock", value: s })),
  ].slice(0, 10);

  res.json(
    new ApiResponse(200, suggestions, "Autocomplete suggestions fetched"),
  );
});

const checkAvailability = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const vehicle = await Vehicle.findOne({
    _id: req.params.id,
    organizationId: orgId,
  });

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  const available = vehicle.status === "Ready for Sale";

  res.json(
    new ApiResponse(
      200,
      {
        available,
        status: vehicle.status,
        location: vehicle.dealerCity
          ? `${vehicle.dealerCity}, ${vehicle.dealerState}`
          : "Unknown",
        reservedUntil: null,
      },
      "Availability checked",
    ),
  );
});

const reserveVehicle = asyncHandler(async (req: Request, res: Response) => {
  const { customerName, duration = 24 } = req.body;
  const orgId = req.orgId as string;

  if (!customerName) {
    throw new ApiError(400, "Customer name is required");
  }

  const vehicle = await Vehicle.findOne({
    _id: req.params.id,
    organizationId: orgId,
  });

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found");
  }

  if (vehicle.status !== "Ready for Sale") {
    throw new ApiError(400, "Vehicle is not available for reservation");
  }

  const userId = (req as any).user?._id;
  const reservedUntil = new Date();
  reservedUntil.setHours(reservedUntil.getHours() + duration);

  vehicle.notes.push({
    text: `Reserved for ${customerName} until ${reservedUntil.toISOString()}`,
    author: userId,
    date: new Date(),
  } as any);

  await vehicle.save();

  logger.info(
    { vehicleId: vehicle._id, customerName, userId },
    "Vehicle reserved for customer",
  );

  await activityService.createActivity({
    userId: userId || "SYSTEM",
    organizationId: orgId,
    type: "vehicle_updated",
    title: "Vehicle Reserved",
    description: `Reserved ${vehicle.year} ${vehicle.make} ${vehicle.modelName} for ${customerName}`,
    metadata: {
      vehicleId: vehicle._id.toString(),
      customerName,
      reservedUntil,
    },
  });

  res.json(
    new ApiResponse(
      200,
      {
        ...normalizeVehicle(vehicle),
        reservedUntil,
      },
      "Vehicle reserved successfully",
    ),
  );
});

/**
 * SECURE GLOBAL MARKETPLACE: Fetch vehicles across all dealerships
 * Authenticated Customers Only
 */
const getMarketplaceVehicles = asyncHandler(
  async (req: Request, res: Response) => {
    const {
      search: searchParam,
      q,
      make,
      model,
      year,
      location,
      bodyStyle,
      minPrice,
      maxPrice,
      minMileage,
      maxMileage,
      highDemand,
      lowPerforming,
      sortBy = "recent",
      sortOrder = "desc",
      page = "1",
      limit = "20",
    } = req.query;

    const search = searchParam || q;

    // STRICT MARKETPLACE FILTERS
    const filter: any = {
      isDeleted: false,
      isArchived: { $ne: true },
      status: "Ready for Sale", // Customers only see retail-ready inventory
    };

    if (make) filter.make = { $regex: make, $options: "i" };
    if (model) filter.modelName = { $regex: model, $options: "i" };
    if (year) filter.year = Number(year);

    if (location) {
      filter.$or = [
        { dealerCity: { $regex: location, $options: "i" } },
        { dealerState: { $regex: location, $options: "i" } },
      ];
    }

    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (minMileage || maxMileage) {
      filter.mileage = {};
      if (minMileage) filter.mileage.$gte = Number(minMileage);
      if (maxMileage) filter.mileage.$lte = Number(maxMileage);
    }

    if (bodyStyle) {
      filter.bodyStyle = { $regex: bodyStyle, $options: "i" };
    }

    const sortObj: any = {};
    const order = sortOrder === "desc" ? -1 : 1;

    switch (sortBy) {
      case "year":
        sortObj.year = order;
        break;
      case "price":
        sortObj.price = order;
        break;
      case "mileage":
        sortObj.mileage = order;
        break;
      case "make":
        sortObj.make = order;
        sortObj.modelName = order;
        break;
      case "stockNumber":
        sortObj.stockNumber = order;
        break;
      case "location":
        sortObj.dealerCity = order;
        sortObj.dealerState = order;
        break;
      case "demand":
        sortObj.leadCount = order;
        break;
      case "low-performing":
        sortObj.daysOnLot = -1;
        sortObj.leadCount = 1;
        break;
      case "recent":
      default:
        sortObj.dateAdded = order;
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const pipeline: any[] = [];

    // Global Search logic (no orgId constraint)
    if (search) {
      const searchString = search.toString();
      const isNumericSearch = !isNaN(Number(searchString));

      const shouldClauses: any[] = [
        {
          text: {
            query: searchString,
            path: ["make", "modelName", "vin", "stockNumber"],
            fuzzy: { maxEdits: 1 },
          },
        },
      ];

      if (isNumericSearch) {
        shouldClauses.push({
          equals: { value: Number(searchString), path: "year" },
        });
      }

      pipeline.push({
        $search: {
          index: "Vehicle",
          compound: {
            must: [
              {
                compound: {
                  should: shouldClauses,
                  minimumShouldMatch: 1,
                },
              },
            ],
          },
        },
      });

      // After search, we STILL must match the marketplace status
      pipeline.push({
        $match: {
          status: "Ready for Sale",
          isDeleted: false,
          isArchived: { $ne: true },
        },
      });
    } else {
      pipeline.push({
        $match: {
          status: "Ready for Sale",
          isDeleted: false,
          isArchived: { $ne: true },
        },
      });
    }

    pipeline.push({ $match: filter });

    const needsDemandMetrics =
      sortBy === "demand" ||
      sortBy === "low-performing" ||
      highDemand === "true" ||
      lowPerforming === "true";

    if (needsDemandMetrics) {
      pipeline.push({
        $lookup: {
          from: "leads",
          let: { vVin: "$vin" },
          pipeline: [
            { $match: { $expr: { $eq: ["$vehicle.vin", "$$vVin"] } } },
            { $count: "total" },
          ],
          as: "_leadData",
        },
      });
      pipeline.push({
        $addFields: {
          leadCount: {
            $ifNull: [{ $arrayElemAt: ["$_leadData.total", 0] }, 0],
          },
        },
      });

      if (highDemand === "true") {
        pipeline.push({ $match: { leadCount: { $gte: 1 } } });
      }

      if (lowPerforming === "true") {
        pipeline.push({ $match: { leadCount: 0, daysOnLot: { $gte: 30 } } });
      }
    }

    pipeline.push({ $sort: sortObj });

    pipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $skip: skip },
          { $limit: limitNum > 0 ? limitNum : 100 },
          { $project: { priceHistory: 0 } },
        ],
      },
    });

    const [result] = await Vehicle.aggregate(pipeline);

    const total = result.metadata[0]?.total || 0;
    const vehicles = result.data || [];

    const userId = getUserId(req);
    const member = userId
      ? await membershipService.getMemberPricingForUser(userId).catch(() => undefined)
      : undefined;

    // SECURE NORMALIZATION: Scrubs internal data; member price derived server-side
    const normalized = vehicles.map((v: any) => normalizeCustomerVehicle(v, member));

    res.json(
      new ApiResponse(
        200,
        {
          vehicles: normalized,
          total,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: limitNum > 0 ? Math.ceil(total / limitNum) : 1,
          },
        },
        "Marketplace vehicles fetched successfully",
      ),
    );
  },
);

/**
 * GLOBAL MARKETPLACE FILTERS: Get unique makes/models/locations across all dealerships
 */
const getMarketplaceFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const hasScopedParams = hasScopedFilterParams(req.query);
    const cacheKey = `veh:filters:marketplace`;

    if (!hasScopedParams) {
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return res.json(
          new ApiResponse(
            200,
            cached,
            "Marketplace filters fetched successfully",
          ),
        );
      }
    }

    // Customers only see filters for Ready for Sale vehicles
    const scopedQuery = buildScopedFilterQuery(req.query, {
      status: "Ready for Sale",
      isDeleted: false,
      isArchived: { $ne: true },
    });

    // Make is always unscoped — show all available makes regardless of other filter selections
    const baseMarketplaceQuery = {
      status: "Ready for Sale",
      isDeleted: false,
      isArchived: { $ne: true },
    };

    const [makes, models, statuses, years, locations, bodyStyles, driveTrains] =
      await Promise.all([
        Vehicle.distinct("make", baseMarketplaceQuery),
        Vehicle.distinct("modelName", stripQueryField(scopedQuery, "model")),
        Vehicle.distinct("status", stripQueryField(scopedQuery, "status")),
        Vehicle.distinct("year", stripQueryField(scopedQuery, "year")),
        Vehicle.distinct(
          "dealerCity",
          stripQueryField(scopedQuery, "location"),
        ),
        Vehicle.distinct(
          "bodyStyle",
          stripQueryField(scopedQuery, "bodyStyle"),
        ),
        Vehicle.distinct("driveTrain", scopedQuery),
      ]);

    const data = {
      makes: makes.filter(Boolean).sort(),
      models: models.filter(Boolean).sort(),
      statuses: statuses.filter(Boolean).sort(),
      years: years.filter(Boolean).sort((a, b) => b - a),
      locations: locations.filter(Boolean).sort(),
      bodyStyles: bodyStyles.filter(Boolean).sort(),
      driveTrains: driveTrains.filter(Boolean).sort(),
    };

    if (!hasScopedParams) {
      await cacheService.set(cacheKey, data, 3600); // 1 hour cache
    }

    res.json(
      new ApiResponse(200, data, "Marketplace filters fetched successfully"),
    );
  },
);

export default {
  createVehicle,
  getVehicles,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  addVehicleNote,
  getVehiclePriceHistory,
  getFilters,
  getStats,
  getDashboardGraphs,
  updateVehicleStatus,
  exportVehicles,
  getDashboard,
  autocomplete,
  checkAvailability,
  reserveVehicle,
  getPublicVehicleById,
  getMarketplaceVehicles,
  getMarketplaceFilters,
};