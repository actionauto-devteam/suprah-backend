import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import Vehicle from "../models/Vehicle.model";
import User, { IUser } from "../models/User.model";
import logger from "../utils/logger";
import { createLoadSchema, calculateRateSchema } from "../validations/load.validation";
import {
  getCoordinatesForPair,
  calculateDistance,
  calculateRate,
  calculateETA,
} from "../utils/calculations";
import { maskLoadForDriver } from "../utils/loadMask";
import { storageService, BucketType } from "../services/storage.service";
import { safeCreateNotification } from "../utils/safeNotification";
import { getSocketIO } from "../utils/socketEmitter";
import activityService from "../services/activity.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getUser = (req: Request) => req.user as IUser;

// ─── VIN Lookup ───────────────────────────────────────────────────────────────
// GET /api/loads/vin/:vin
// Checks org inventory — if found, returns vehicle details for auto-fill

const lookupVin = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const vin = req.params.vin?.toUpperCase().trim();

  if (!vin || vin.length > 17) {
    throw new ApiError(400, "Invalid VIN");
  }

  const vehicle = await Vehicle.findOne({ vin, organizationId, isDeleted: false }).lean();

  if (!vehicle) {
    throw new ApiError(404, "Vehicle not found in inventory");
  }

  return res.status(200).json(
    new ApiResponse(200, {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.modelName,
      color: vehicle.exteriorColor || "",
      condition: vehicle.status === "In Recon" ? "Inoperable" : "Operable",
    }, "Vehicle found in inventory")
  );
});

// ─── Calculate Rate ───────────────────────────────────────────────────────────
// POST /api/loads/calculate-rate
// Accepts pickup/delivery ZIPs + vehicles, returns computed miles + estimated rate

const calculateLoadRate = asyncHandler(async (req: Request, res: Response) => {
  const parsed = calculateRateSchema.safeParse(req.body);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join(", ");
    throw new ApiError(400, messages);
  }

  const { pickupZip, deliveryZip, vehicles } = parsed.data;

  const [pickupCoords, deliveryCoords] = await getCoordinatesForPair(pickupZip, deliveryZip);

  if (!pickupCoords) throw new ApiError(400, `Could not find location for pickup ZIP: ${pickupZip}`);
  if (!deliveryCoords) throw new ApiError(400, `Could not find location for delivery ZIP: ${deliveryZip}`);

  const miles = calculateDistance(
    pickupCoords.lat, pickupCoords.lon,
    deliveryCoords.lat, deliveryCoords.lon
  );

  const units = vehicles.length || 1;
  const hasEnclosed = vehicles.some((v) => v.trailerType === "Enclosed");
  const hasInoperable = vehicles.some((v) => v.condition === "Inoperable");

  const rate = calculateRate(miles, units, hasEnclosed, hasInoperable);
  const eta = calculateETA(miles);

  return res.status(200).json(
    new ApiResponse(200, { miles, estimatedRate: rate, eta }, "Rate calculated")
  );
});

// ─── Create Load ──────────────────────────────────────────────────────────────

const createLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const parsed = createLoadSchema.safeParse(req.body);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join(", ");
    throw new ApiError(400, messages);
  }

  const { postType, pickupLocation, deliveryLocation, vehicles, dates, additionalInfo, contract, pricing: clientPricing } = parsed.data;

  // Compute miles + estimatedRate server-side from ZIPs
  let computedMiles: number | undefined;
  let estimatedRate: number | undefined;
  try {
    const [pc, dc] = await getCoordinatesForPair(pickupLocation.zip, deliveryLocation.zip);
    if (pc && dc) {
      computedMiles = calculateDistance(pc.lat, pc.lon, dc.lat, dc.lon);
      const units = vehicles.length || 1;
      const hasEnclosed = vehicles.some((v) => v.trailerType === "enclosed_2car" || v.trailerType === "enclosed_3car");
      const hasInoperable = vehicles.some((v) => v.condition === "Inoperable");
      estimatedRate = calculateRate(computedMiles, units, hasEnclosed, hasInoperable);
    }
  } catch {
    // Non-fatal — saves without computed pricing if ZIP lookup fails
  }

  const pricing = {
    miles: computedMiles,
    estimatedRate,
    carrierPayAmount: clientPricing?.carrierPayAmount,
    copCodAmount: clientPricing?.copCodAmount ?? 0,
    // balanceAmount computed automatically by pre-save hook in the model
  };

  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  const loadNumber = `LD-${datePart}-${randPart}`;

  const contractWithTimestamp = contract?.agreedToTerms
    ? { ...contract, signedAt: new Date() }
    : contract;

  const load = await Load.create({
    organizationId,
    orgId: (user as any).orgId,
    createdBy: user._id,
    loadNumber,
    postType,
    pickupLocation,
    deliveryLocation,
    vehicles,
    dates,
    pricing,
    additionalInfo,
    contract: contractWithTimestamp,
    status: "Posted",
  });

  const _io = getSocketIO();
  if (_io) _io.to(`org:${organizationId}`).emit("load:change", { action: "created" });

  // Log activity
  await activityService.logLoadActivity(
    user._id.toString(),
    organizationId,
    'load_posted',
    load._id.toString(),
    `Created load ${loadNumber}`
  );

  logger.info({ loadId: load._id, loadNumber, orgId: organizationId }, 'Load created successfully');

  return res.status(201).json(new ApiResponse(201, load, "Load created successfully"));
});

// ─── Get Inventory Vehicles (for VIN picker) ──────────────────────────────────
// GET /api/loads/vehicles?q=search
// Returns org vehicles for VIN combobox — vin, year, make, model, color only

const getInventoryVehicles = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const q = (req.query.q as string | undefined)?.trim().toUpperCase();

  const filter: Record<string, unknown> = { organizationId, isDeleted: false };
  if (q) {
    filter.$or = [
      { vin: { $regex: q, $options: "i" } },
      { make: { $regex: q, $options: "i" } },
      { modelName: { $regex: q, $options: "i" } },
    ];
  }

  const vehicles = await Vehicle.find(filter)
    .select("vin year make modelName exteriorColor status")
    .limit(50)
    .lean();

  const data = vehicles.map((v) => ({
    vin: v.vin,
    year: v.year,
    make: v.make,
    model: v.modelName,
    color: v.exteriorColor || "",
    condition: v.status === "In Recon" ? "Inoperable" : "Operable",
  }));

  return res.status(200).json(new ApiResponse(200, data, "Vehicles fetched"));
});

// ─── Get Loads ────────────────────────────────────────────────────────────────

// ─── Get Loads (with filters, search, pagination) ────────────────────────────
// GET /api/loads?status=Posted&q=LD-2026&postType=load-board&page=1&limit=20

const LOAD_STATUSES = ["Posted", "Assigned", "In-Transit", "Delivered", "Cancelled"] as const;

const getLoads = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  // ── Pagination ──────────────────────────────────────────────────────────────
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  // ── Filters ─────────────────────────────────────────────────────────────────
  const filter: Record<string, unknown> = { organizationId };

  const status = req.query.status as string | undefined;
  if (status && LOAD_STATUSES.includes(status as typeof LOAD_STATUSES[number])) {
    filter.status = status;
  }

  const postType = req.query.postType as string | undefined;
  if (postType === "load-board" || postType === "assign-carrier") {
    filter.postType = postType;
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  const q = (req.query.q as string | undefined)?.trim();
  if (q) {
    filter.$or = [
      { loadNumber: { $regex: q, $options: "i" } },
      { "pickupLocation.city": { $regex: q, $options: "i" } },
      { "pickupLocation.state": { $regex: q, $options: "i" } },
      { "deliveryLocation.city": { $regex: q, $options: "i" } },
      { "deliveryLocation.state": { $regex: q, $options: "i" } },
      { "vehicles.make": { $regex: q, $options: "i" } },
      { "vehicles.model": { $regex: q, $options: "i" } },
      { "vehicles.vin": { $regex: q, $options: "i" } },
    ];
  }

  // ── Query ───────────────────────────────────────────────────────────────────
  const user = getUser(req);
  const isDriver = user?.role === "driver";

  const [rawLoads, total] = await Promise.all([
    Load.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Load.countDocuments(filter),
  ]);

  const loads = isDriver
    ? rawLoads.map((l) => maskLoadForDriver(l as unknown as Record<string, unknown>))
    : rawLoads;

  const loadsWithSignedProofs = await Promise.all(loads.map(async (l: any) => {
    if (l.proofOfDelivery?.imageUrl && !l.proofOfDelivery.imageUrl.startsWith('http')) {
      const signed = await storageService.getSignedUrl(l.proofOfDelivery.imageUrl);
      if (signed) l.proofOfDelivery.imageUrl = signed;
    }
    return l;
  }));

  return res.status(200).json(
    new ApiResponse(200, {
      loads: loadsWithSignedProofs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    }, "Loads fetched successfully")
  );
});

// ─── Get Load Stats (counts per status) ──────────────────────────────────────
// GET /api/loads/stats
// Returns { all, Posted, Assigned, In-Transit, Delivered, Cancelled }

const getLoadStats = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  // organizationId is stored as String on the Load model — do NOT cast to ObjectId
  const agg = await Load.aggregate([
    { $match: { organizationId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const stats: Record<string, number> = {
    all: 0,
    Posted: 0,
    Assigned: 0,
    "In-Transit": 0,
    Delivered: 0,
    Cancelled: 0,
  };

  for (const { _id, count } of agg) {
    if (_id && _id in stats) stats[_id] = count;
    stats.all += count;
  }

  return res.status(200).json(new ApiResponse(200, stats, "Load stats fetched"));
});

// ─── Get Load by ID ───────────────────────────────────────────────────────────

const getLoadById = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const user = getUser(req);

  const raw = await Load.findOne({ _id: req.params.id, organizationId }).lean();
  if (!raw) throw new ApiError(404, "Load not found");

  const load = user?.role === "driver"
    ? maskLoadForDriver(raw as unknown as Record<string, unknown>)
    : raw;

  // Sign proof of delivery URL if exists
  const loadObj = load as any;
  if (loadObj.proofOfDelivery?.imageUrl && !loadObj.proofOfDelivery.imageUrl.startsWith('http')) {
    const signed = await storageService.getSignedUrl(loadObj.proofOfDelivery.imageUrl);
    if (signed) loadObj.proofOfDelivery.imageUrl = signed;
  }

  return res.status(200).json(new ApiResponse(200, loadObj, "Load fetched successfully"));
});

const deleteLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");

  if (load.status === "In-Transit") {
    throw new ApiError(400, "Cannot delete a load that is currently In-Transit");
  }

  await Load.deleteOne({ _id: load._id });

  const _io = getSocketIO();
  if (_io) _io.to(`org:${organizationId}`).emit("load:change", { action: "deleted" });

  // Log activity
  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId,
    type: 'shipment_deleted', // Assuming similar mapping or add quote_deleted/load_deleted
    title: 'Load Deleted',
    description: `Deleted load ${load.loadNumber}`,
    metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber }
  });

  logger.warn({ loadId: load._id, loadNumber: load.loadNumber, orgId: organizationId }, 'Load deleted');

  return res.status(200).json(new ApiResponse(200, null, "Load deleted successfully"));
});

// ─── Submit Proof of Delivery ─────────────────────────────────────────────────
// POST /api/loads/:id/submit-proof
// Driver submits a proof-of-delivery image for a Load-type assignment.

const submitProofOfDelivery = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const userId = user._id.toString();
  const { note } = req.body;
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file) throw new ApiError(400, "Proof image is required");

  const load = await Load.findById(req.params.id);
  if (!load) throw new ApiError(404, "Load not found");

  if (!load.assignedDriverId || load.assignedDriverId.toString() !== userId) {
    throw new ApiError(403, "Only the assigned driver can submit proof of delivery");
  }

  // Replace old image if one exists (R2 stores raw keys, not http URLs)
  if (load.proofOfDelivery?.imageUrl) {
    try { await storageService.delete(load.proofOfDelivery.imageUrl, BucketType.PRIVATE); } catch { /* non-fatal */ }
  }

  // Upload to PRIVATE bucket for security
  const imageUrl = await storageService.upload(file, "proof-of-delivery", BucketType.PRIVATE);

  // Auto-route proof to whoever created/posted the load
  const submittedTo = load.createdBy ? load.createdBy.toString() : undefined;

  (load as any).proofOfDelivery = {
    imageUrl,
    submittedAt: new Date(),
    note: note || undefined,
    submittedTo: submittedTo || undefined,
  };

  await load.save();

  // Log activity
  await activityService.logLoadActivity(
    userId,
    load.organizationId?.toString(),
    'load_delivered',
    load._id.toString(),
    `Submitted proof of delivery for load ${load.loadNumber}`
  );

  const orgId = load.organizationId?.toString();
  if (orgId) {
    // Notify the admin who created/posted the load; fallback to all admins
    const notifyIds: string[] = submittedTo
      ? [submittedTo]
      : (await User.find({ organizationId: orgId, role: { $in: ["admin", "super_admin", "employee"] } }).select("_id")).map((a: any) => a._id.toString());

    for (const adminId of notifyIds) {
      await safeCreateNotification({
        userId: adminId, organizationId: orgId,
        type: "proof_submitted", title: "Proof of Delivery Submitted",
        message: `Driver submitted proof of delivery for load ${load.loadNumber || req.params.id}`,
        metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber, imageUrl },
      });
    }
  }

  logger.info({ loadId: load._id, userId }, 'Proof of delivery submitted for load');

  return res.status(200).json(new ApiResponse(200, { imageUrl }, "Proof of delivery submitted"));
});

// ─── Proof Image Proxy ────────────────────────────────────────────────────────
// GET /api/loads/:id/proof-image
// Streams the private proof image to authenticated admin/dealer clients.

const streamProofImage = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId }).lean();
  if (!load) throw new ApiError(404, "Load not found");

  const key = (load as any).proofOfDelivery?.imageUrl;
  if (!key) throw new ApiError(404, "No proof image submitted");

  const result = await storageService.streamPrivateFile(key);
  if (!result) throw new ApiError(404, "Proof image not found in storage");

  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  result.stream.pipe(res);
});

// ─── Confirm Delivery ─────────────────────────────────────────────────────────
// POST /api/loads/:id/confirm-delivery
// Admin/dealer confirms the driver's submitted proof, marking the load as Delivered.

const confirmDelivery = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) throw new ApiError(404, "Load not found");

  if (!load.proofOfDelivery?.imageUrl) {
    throw new ApiError(400, "No proof of delivery has been submitted yet");
  }

  const updated = await Load.findOneAndUpdate(
    { _id: req.params.id, organizationId },
    {
      status: "Delivered",
      "proofOfDelivery.confirmedAt": new Date(),
      "proofOfDelivery.confirmedBy": user._id,
    },
    { new: true }
  );

  if (load.assignedDriverId) {
    await safeCreateNotification({
      userId: load.assignedDriverId.toString(),
      organizationId,
      type: "delivery_confirmed",
      title: "Delivery Confirmed",
      message: `Your delivery for load ${load.loadNumber} has been confirmed`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber },
    });
  }

  await activityService.logLoadActivity(
    user._id.toString(),
    organizationId,
    "load_delivered",
    load._id.toString(),
    `Admin confirmed proof of delivery for load ${load.loadNumber}`
  );

  logger.info({ loadId: load._id, userId: user._id }, "Delivery confirmed by admin for load");

  return res.status(200).json(new ApiResponse(200, updated, "Delivery confirmed successfully"));
});

export default { lookupVin, getInventoryVehicles, calculateLoadRate, createLoad, getLoads, getLoadStats, getLoadById, deleteLoad, submitProofOfDelivery, streamProofImage, confirmDelivery };
