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
import { getSignedProofUrl } from "../utils/signedUrlCache";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";
import { notificationTemplates } from "../utils/notificationTemplates";
import { getSocketIO } from "../utils/socketEmitter";
import activityService from "../services/activity.service";
import emailService from "../services/email.service";
import Quote from "../models/Quote.model";


const getUser = (req: Request) => req.user as IUser;

// ─── Inventory Image Enrichment ───────────────────────────────────────────────
// Load vehicles only persist vin/year/make/model — real photos live on the
// Vehicle (inventory) collection in `images[]`. This helper batch-resolves
// inventory matches (by vehicleId first, then VIN fallback) for a page of
// loads and attaches `imageUrl` to each load vehicle so the frontend can
// render actual vehicle photos instead of a stock placeholder.
// One query per request regardless of page size.

const attachInventoryImages = async (
  loads: Array<Record<string, any>>,
  organizationId: string,
): Promise<void> => {
  const idSet = new Set<string>();
  const vinSet = new Set<string>();

  for (const load of loads) {
    for (const v of load?.vehicles ?? []) {
      if (!v) continue;
      if (v.vehicleId) idSet.add(String(v.vehicleId));
      if (v.vin) vinSet.add(String(v.vin).toUpperCase().trim());
    }
  }

  if (idSet.size === 0 && vinSet.size === 0) return;

  const or: Record<string, unknown>[] = [];
  if (idSet.size) or.push({ _id: { $in: Array.from(idSet) } });
  if (vinSet.size) or.push({ vin: { $in: Array.from(vinSet) } });

  try {
    const inventory = await Vehicle.find({ organizationId, isDeleted: false, $or: or })
      .select("vin images exteriorColor")
      .lean();

    const byId = new Map(inventory.map((v) => [String(v._id), v]));
    const byVin = new Map(
      inventory
        .filter((v) => v.vin)
        .map((v) => [String(v.vin).toUpperCase().trim(), v]),
    );

    for (const load of loads) {
      for (const v of load?.vehicles ?? []) {
        if (!v) continue;
        const match =
          (v.vehicleId && byId.get(String(v.vehicleId))) ||
          (v.vin && byVin.get(String(v.vin).toUpperCase().trim()));
        const image = match?.images?.[0];
        if (image) v.imageUrl = image;
        if (!v.color && match?.exteriorColor) v.color = match.exteriorColor;
      }
    }
  } catch (err) {
    // Non-fatal: loads render without photos rather than failing the request
    logger.error({ err, organizationId }, "Failed to attach inventory images to loads");
  }
};


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


const calculateLoadRate = asyncHandler(async (req: Request, res: Response) => {
  const parsed = calculateRateSchema.safeParse(req.body);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join(", ");
    throw new ApiError(400, messages);
  }

  const { pickupZip, deliveryZip, vehicles, trailerType } = parsed.data;

  const [pickupCoords, deliveryCoords] = await getCoordinatesForPair(pickupZip, deliveryZip);

  if (!pickupCoords) throw new ApiError(400, `Could not find location for pickup ZIP: ${pickupZip}`);
  if (!deliveryCoords) throw new ApiError(400, `Could not find location for delivery ZIP: ${deliveryZip}`);

  const miles = calculateDistance(
    pickupCoords.lat, pickupCoords.lon,
    deliveryCoords.lat, deliveryCoords.lon
  );

  const units = vehicles.length || 1;
  const hasEnclosed = trailerType.toLowerCase().includes("enclosed");
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

  const { postType, pickupLocation, deliveryLocation, vehicles, trailerType, dates, additionalInfo, contract, pricing: clientPricing } = parsed.data;

  // Compute miles + estimatedRate server-side from ZIPs
  let computedMiles: number | undefined;
  let estimatedRate: number | undefined;
  let pricingWarning: string | undefined;
  try {
    const [pc, dc] = await getCoordinatesForPair(pickupLocation.zip, deliveryLocation.zip);
    if (pc && dc) {
      computedMiles = calculateDistance(pc.lat, pc.lon, dc.lat, dc.lon);
      const units = vehicles.length || 1;
      const hasEnclosed = trailerType.toLowerCase().includes("enclosed");
      const hasInoperable = vehicles.some((v) => v.condition === "Inoperable");
      estimatedRate = calculateRate(computedMiles, units, hasEnclosed, hasInoperable);
    } else {
      pricingWarning = "Could not compute miles and rate from ZIP codes. Set carrier pay manually.";
    }
  } catch {
    pricingWarning = "Could not compute miles and rate from ZIP codes. Set carrier pay manually.";
  }

  const pricing = {
    miles: computedMiles,
    estimatedRate,
    carrierPayAmount: clientPricing?.carrierPayAmount,
    copCodAmount: clientPricing?.copCodAmount ?? 0,
    // balanceAmount computed automatically by pre-save hook in the model
  };

  const contractWithTimestamp = contract?.agreedToTerms
    ? { ...contract, signedAt: new Date() }
    : contract;

  // Validation 1: Check for duplicate VINs
  const vins = vehicles?.map((v: any) => v.vin).filter(Boolean) || [];
  if (new Set(vins).size !== vins.length) {
    return res.status(400).json({
      success: false,
      error: 'Duplicate VINs not allowed',
      code: 'DUPLICATE_VIN',
      field: 'vehicles',
    });
  }

  // Validation 2: Check trailer capacity
  const TRAILER_CAPACITY: Record<string, number> = {
    open_3car_wedge: 3,
    open_2car: 2,
    enclosed_2car: 2,
    enclosed_3car: 3,
    flatbed: 2,
    hotshot: 1,
    dually_flatbed: 1,
    gooseneck: 2,
    lowboy: 1,
    step_deck: 2,
    '9car_stinger': 9,
    '7car_stinger': 7,
    '5car_open': 5,
    rgn: 2,
    double_drop: 2,
    power_only: 0,
    other: 1,
  };

  const maxVehicles = TRAILER_CAPACITY[trailerType] ?? 1;
  const vehicleCount = vehicles?.length || 0;

  if (vehicleCount > maxVehicles) {
    return res.status(400).json({
      success: false,
      error: `Max ${maxVehicles} vehicles allowed for ${trailerType}`,
      code: 'CAPACITY_EXCEEDED',
      field: 'vehicles',
    });
  }

  // Validation 3: Check for past dates
  if (dates?.firstAvailable) {
    const selectedDate = new Date(dates.firstAvailable);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (selectedDate < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot select a date in the past',
        code: 'INVALID_DATE',
        field: 'dates.firstAvailable',
      });
    }
  }

  // Link load vehicles to inventory by VIN so photos resolve on every fetch.
  // Non-fatal: an unmatched VIN just means no photo enrichment for that unit.
  const vehiclesWithLinks = [...(vehicles ?? [])] as Array<Record<string, any>>;
  if (vins.length) {
    try {
      const inventoryMatches = await Vehicle.find({
        organizationId,
        isDeleted: false,
        vin: { $in: vins.map((v: string) => v.toUpperCase().trim()) },
      })
        .select("vin")
        .lean();
      const vinToId = new Map(
        inventoryMatches.map((v) => [String(v.vin).toUpperCase().trim(), v._id]),
      );
      for (const v of vehiclesWithLinks) {
        if (v.vin && !v.vehicleId) {
          const match = vinToId.get(String(v.vin).toUpperCase().trim());
          if (match) v.vehicleId = match;
        }
      }
    } catch (err) {
      logger.error({ err, orgId: organizationId }, "Non-fatal: failed to link load vehicles to inventory");
    }
  }

  const load = await Load.create({
    organizationId,
    orgId: (user as any).orgId,
    createdBy: user._id,
    postType,
    pickupLocation,
    deliveryLocation,
    vehicles: vehiclesWithLinks,
    trailerType,
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
    `Created load ${load.loadNumber}`
  );

  {
    const { title, message } = notificationTemplates.shipment_created({
      trackingNumber: load.loadNumber,
      customerName: `${load.pickupLocation.city || ''} → ${load.deliveryLocation.city || ''}`.trim(),
    });
    notifyOrgAdmins(organizationId, 'shipment_created', title, message, {
      loadId: load._id.toString(),
      loadNumber: load.loadNumber,
      route: '/transportation?tab=shipments',
    }, user._id.toString()).catch((err) => logger.error(err, 'Failed to notify admins of new load'));
  }

  logger.info({ loadId: load._id, loadNumber: load.loadNumber, orgId: organizationId }, 'Load created successfully');

  return res.status(201).json(new ApiResponse(201, { load, ...(pricingWarning ? { warning: pricingWarning } : {}) }, "Load created successfully"));
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
    .select("vin year make modelName exteriorColor status images")
    .limit(50)
    .lean();

  const data = vehicles.map((v) => ({
    vin: v.vin,
    year: v.year,
    make: v.make,
    model: v.modelName,
    color: v.exteriorColor || "",
    condition: v.status === "In Recon" ? "Inoperable" : "Operable",
    imageUrl: v.images?.[0] || undefined,
  }));

  return res.status(200).json(new ApiResponse(200, data, "Vehicles fetched"));
});

// ─── Get Loads (with filters, search, pagination) ────────────────────────────
// GET /api/loads?status=Posted&q=LD-2026&postType=load-board&page=1&limit=20

const LOAD_STATUSES = ["Posted", "Assigned", "Accepted", "Picked Up", "In-Transit", "Delivered", "Cancelled"] as const;

const getLoads = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const isReportRequest = req.query.report === "true";
  const requestedLimit = parseInt(req.query.limit as string) || (isReportRequest ? 5000 : 20);
  const maxLimit = isReportRequest ? 5000 : 50;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(maxLimit, Math.max(1, requestedLimit));
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { organizationId };

  const status = req.query.status as string | undefined;
  if (status && LOAD_STATUSES.includes(status as typeof LOAD_STATUSES[number])) {
    filter.status = status;
  }

  const postType = req.query.postType as string | undefined;
  if (postType === "load-board" || postType === "assign-carrier") {
    filter.postType = postType;
  }

  const q = (req.query.q as string | undefined)?.trim();
  if (q) (filter as any).$text = { $search: q };

  // Report period support. Accepts either month/year or date=YYYY-MM.
  const dateParam = (req.query.date as string | undefined)?.trim();
  const dateMatch = dateParam?.match(/^(\d{4})-(\d{2})$/);
  const year = Number(req.query.year ?? dateMatch?.[1]);
  const month = Number(req.query.month ?? dateMatch?.[2]);

  if (Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1));
    filter.createdAt = { $gte: startDate, $lt: endDate };
  }

  const user = getUser(req);
  const isDriver = user?.role === "driver";

  const [rawLoads, total, summaryRows] = await Promise.all([
    Load.find(filter)
      .populate("assignedDriverId", "name email phone avatar")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Load.countDocuments(filter),
    Load.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalLoads: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] } },
          totalRevenue: { $sum: { $ifNull: ["$pricing.estimatedRate", 0] } },
          totalCarrierPay: { $sum: { $ifNull: ["$pricing.carrierPayAmount", 0] } },
          totalMiles: { $sum: { $ifNull: ["$pricing.miles", 0] } },
        },
      },
    ]),
  ]);

  const loads = isDriver
    ? rawLoads.map((load) => maskLoadForDriver(load as unknown as Record<string, unknown>))
    : rawLoads;

  // Attach real inventory photos (runs AFTER masking so imageUrl survives)
  await attachInventoryImages(loads as Array<Record<string, any>>, organizationId);

  const loadsWithSignedProofs = await Promise.all(
    loads.map(async (load: any) => {
      if (load.proofOfDelivery?.imageUrl) {
        const signed = await getSignedProofUrl(load.proofOfDelivery.imageUrl);
        if (signed) load.proofOfDelivery.imageUrl = signed;
      }
      return load;
    }),
  );

  const aggregate = summaryRows[0] ?? {};
  const totalRevenue = aggregate.totalRevenue ?? 0;
  const totalCarrierPay = aggregate.totalCarrierPay ?? 0;
  const summary = {
    totalLoads: aggregate.totalLoads ?? 0,
    delivered: aggregate.delivered ?? 0,
    cancelled: aggregate.cancelled ?? 0,
    totalRevenue,
    totalCarrierPay,
    grossProfit: totalRevenue - totalCarrierPay,
    totalMiles: aggregate.totalMiles ?? 0,
  };

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        loads: loadsWithSignedProofs,
        summary,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page * limit < total,
        },
      },
      "Loads fetched successfully",
    ),
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

  // BUG FIX: "Accepted" and "Picked Up" were previously missing from this
  // object, so the `_id in stats` guard silently discarded their counts —
  // loads in those statuses inflated `all` but had no row and no filter in
  // the sidebar.
  const stats: Record<string, number> = {
    all: 0,
    Posted: 0,
    Assigned: 0,
    Accepted: 0,
    "Picked Up": 0,
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

  const raw = await Load.findOne({ _id: req.params.id, organizationId })
    .populate("assignedDriverId", "name email phone avatar")
    .lean();
  if (!raw) throw new ApiError(404, "Load not found");

  const load = user?.role === "driver"
    ? maskLoadForDriver(raw as unknown as Record<string, unknown>)
    : raw;

  // Attach real inventory photos (single-item batch)
  await attachInventoryImages([load as Record<string, any>], organizationId);

  // Sign proof of delivery URL if exists
  const loadObj = load as any;
  if (loadObj.proofOfDelivery?.imageUrl) {
    const signed = await getSignedProofUrl(loadObj.proofOfDelivery.imageUrl);
    if (signed) loadObj.proofOfDelivery.imageUrl = signed;
  }

  return res.status(200).json(new ApiResponse(200, loadObj, "Load fetched successfully"));
});

/**
 * Update Load
 * PUT /api/loads/:id
 * Allows dispatchers to edit load details (pickup, delivery, pricing, vehicles, etc.)
 */
const updateLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;
  
  const loadId = req.params.id;

  const load = await Load.findOne({ _id: loadId, organizationId });
  if (!load) throw new ApiError(404, "Load not found");

  // Prevent editing if load is Delivered or Cancelled
  if (["Delivered", "Cancelled"].includes(load.status)) {
    throw new ApiError(400, `Cannot edit a load in ${load.status} status`);
  }

  const {
    postType,
    pickupLocation,
    deliveryLocation,
    vehicles,
    trailerType,
    dates,
    pricing,
    additionalInfo,
    status
  } = req.body;

  const updateData: any = {};

  if (postType !== undefined) updateData.postType = postType;
  if (pickupLocation !== undefined) updateData.pickupLocation = pickupLocation;
  if (deliveryLocation !== undefined) updateData.deliveryLocation = deliveryLocation;
  if (vehicles !== undefined) updateData.vehicles = vehicles;
  if (trailerType !== undefined) updateData.trailerType = trailerType;
  if (dates !== undefined) updateData.dates = dates;
  if (additionalInfo !== undefined) updateData.additionalInfo = additionalInfo;
  if (pricing !== undefined) {
    // If pricing is provided, we merge it with existing pricing to preserve computed fields
    updateData.pricing = { ...load.pricing, ...pricing };
  }

  if (status !== undefined) {
    if (!LOAD_STATUSES.includes(status)) {
      throw new ApiError(400, "Invalid status");
    }
    updateData.status = status;
  }

  // If pickup or delivery locations changed, recalculate miles/rate if not manually overridden
  if (pickupLocation?.zip || deliveryLocation?.zip) {
    try {
      const finalPickupZip = pickupLocation?.zip || load.pickupLocation.zip;
      const finalDeliveryZip = deliveryLocation?.zip || load.deliveryLocation.zip;
      const [pc, dc] = await getCoordinatesForPair(finalPickupZip, finalDeliveryZip);
      
      if (pc && dc) {
        const miles = calculateDistance(pc.lat, pc.lon, dc.lat, dc.lon);
        const units = (vehicles || load.vehicles).length || 1;
        const currentTrailerType = trailerType || load.trailerType;
        const hasEnclosed = currentTrailerType.toLowerCase().includes("enclosed");
        const hasInoperable = (vehicles || load.vehicles).some((v: any) => v.condition === "Inoperable");
        const estimatedRate = calculateRate(miles, units, hasEnclosed, hasInoperable);

        if (!updateData.pricing) updateData.pricing = { ...load.pricing };
        updateData.pricing.miles = miles;
        updateData.pricing.estimatedRate = estimatedRate;
      }
    } catch (err) {
      logger.error({ err, loadId }, "Error recalculating pricing on update");
    }
  }

  // BUG FIX: the model's pre("save") hook computes balanceAmount, but
  // Mongoose pre-save hooks do NOT run on findOneAndUpdate — the old comment
  // claimed otherwise, leaving balanceAmount stale after carrier pay edits.
  // Recompute it explicitly whenever pricing is part of this update.
  if (updateData.pricing) {
    const pay = updateData.pricing.carrierPayAmount ?? 0;
    const cod = updateData.pricing.copCodAmount ?? 0;
    updateData.pricing.balanceAmount = pay - cod;
  }

  const updatedLoad = await Load.findOneAndUpdate(
    { _id: loadId, organizationId },
    { $set: updateData },
    { new: true, runValidators: true }
  );

  const _io = getSocketIO();
  if (_io) _io.to(`org:${organizationId}`).emit("load:change", { action: "updated", loadId });

  await activityService.logLoadActivity(
    user._id.toString(),
    organizationId,
    'load_updated',
    loadId,
    `Updated load ${load.loadNumber}`
  );

  return res.json(new ApiResponse(200, updatedLoad, "Load updated successfully"));
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
  if (_io) _io.to(`org:${organizationId}`).emit("load:change", { action: "deleted", loadId: load._id.toString() });

  // Log activity — NON-FATAL. The load is already deleted at this point;
  // a logging failure must not turn a successful delete into a 500 response
  // (root-cause fix: the client was reporting "delete not working" while the
  // document was in fact removed).
  try {
    await activityService.createActivity({
      userId: user._id.toString(),
      organizationId,
      type: 'load_deleted',
      title: 'Load Deleted',
      description: `Deleted load ${load.loadNumber}`,
      metadata: { loadId: load._id.toString(), loadNumber: load.loadNumber }
    });
  } catch (err) {
    logger.error({ err, loadId: load._id }, 'Non-fatal: failed to log load deletion activity');
  }

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

  // Broadcast to Org Admins
  const orgId = load.organizationId?.toString();
  const { title, message } = notificationTemplates.proof_of_delivery({
    driverName: user.name || "A driver",
    trackingNumber: load.loadNumber || req.params.id,
  });

  if (orgId) {
    await notifyOrgAdmins(
      orgId,
      "proof_of_delivery",
      title,
      message,
      {
        loadId: load._id.toString(),
        loadNumber: load.loadNumber,
        imageUrl,
        driverName: user.name,
      }
    );
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
      deliveredAt: new Date(),
      "proofOfDelivery.confirmedAt": new Date(),
      "proofOfDelivery.confirmedBy": user._id,
    },
    { new: true }
  );

  if (load.assignedDriverId) {
    await safeCreateNotification({
      userId: load.assignedDriverId.toString(),
      organizationId,
      type: "load_delivered", // Using load terminology
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

/**
 * Add internal note to load
 */
const addNote = asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  const user = getUser(req);
  const organizationId = req.orgId as string;

  if (!text) throw new ApiError(400, "Note text is required");

  const load = await Load.findOneAndUpdate(
    { _id: req.params.id, organizationId },
    {
      $push: {
        notes: {
          text,
          author: user._id,
          date: new Date(),
        },
      },
    },
    { new: true }
  ).populate("notes.author", "name email avatar");

  if (!load) throw new ApiError(404, "Load not found");

  res.json(new ApiResponse(200, load, "Note added successfully"));
});

/**
 * Send load details via email
 */
const sendDetailsEmail = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const { id } = req.params;
  const { recipientEmail } = req.body as { recipientEmail?: string };

  const email = (recipientEmail || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "A valid recipient email is required");
  }

  const load = await Load.findOne({ _id: id, organizationId }).populate("createdBy", "name email");
  if (!load) throw new ApiError(404, "Load not found");

  const pickup = load.pickupLocation;
  const delivery = load.deliveryLocation;
  const vehicles = load.vehicles.map(v => `${v.year} ${v.make} ${v.model} (${v.condition})`).join(", ");

  const text = [
    "Load Details",
    "",
    `Load Number: ${load.loadNumber}`,
    `Status: ${load.status}`,
    `Vehicles: ${vehicles}`,
    `Origin: ${pickup.city}, ${pickup.state} ${pickup.zip}`,
    `Destination: ${delivery.city}, ${delivery.state} ${delivery.zip}`,
    `Pickup: ${load.dates?.firstAvailable ? new Date(load.dates.firstAvailable).toLocaleDateString() : 'N/A'}`,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
      <h2 style="margin-bottom: 12px;">Load Details</h2>
      <p><strong>Load Number:</strong> ${load.loadNumber}</p>
      <p><strong>Status:</strong> ${load.status}</p>
      <p><strong>Vehicles:</strong> ${vehicles}</p>
      <p><strong>Origin:</strong> ${pickup.city}, ${pickup.state} ${pickup.zip}</p>
      <p><strong>Destination:</strong> ${delivery.city}, ${delivery.state} ${delivery.zip}</p>
      <p><strong>Pickup:</strong> ${load.dates?.firstAvailable ? new Date(load.dates.firstAvailable).toLocaleDateString() : 'N/A'}</p>
    </div>
  `;

  await emailService.sendEmail({
    to: email,
    subject: `Load Update: ${load.loadNumber}`,
    text,
    html,
    organizationId,
  });

  res.json(new ApiResponse(200, { sentTo: email }, "Load details email sent successfully"));
});

export default { lookupVin, getInventoryVehicles, calculateLoadRate, createLoad, getLoads, getLoadStats, getLoadById, updateLoad, deleteLoad, submitProofOfDelivery, streamProofImage, confirmDelivery, addNote, sendDetailsEmail };