import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import Vehicle from "../models/Vehicle.model";
import { IUser } from "../models/User.model";
import { createLoadSchema, calculateRateSchema } from "../validations/load.validation";
import {
  getCoordinatesFromZip,
  getCoordinatesForPair,
  calculateDistance,
  calculateRate,
  calculateETA,
} from "../utils/calculations";
import { maskLoadForDriver } from "../utils/loadMask";

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
      year:      vehicle.year,
      make:      vehicle.make,
      model:     vehicle.modelName,
      color:     vehicle.exteriorColor || "",
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

  const units       = vehicles.length || 1;
  const hasEnclosed = vehicles.some((v) => v.trailerType === "Enclosed");
  const hasInoperable = vehicles.some((v) => v.condition === "Inoperable");

  const rate = calculateRate(miles, units, hasEnclosed, hasInoperable);
  const eta  = calculateETA(miles);

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
      const units        = vehicles.length || 1;
      const hasEnclosed   = vehicles.some((v) => v.trailerType === "enclosed_2car" || v.trailerType === "enclosed_3car");
      const hasInoperable = vehicles.some((v) => v.condition === "Inoperable");
      estimatedRate = calculateRate(computedMiles, units, hasEnclosed, hasInoperable);
    }
  } catch {
    // Non-fatal — saves without computed pricing if ZIP lookup fails
  }

  const pricing = {
    miles:            computedMiles,
    estimatedRate,
    carrierPayAmount: clientPricing?.carrierPayAmount,
    copCodAmount:     clientPricing?.copCodAmount ?? 0,
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
      { vin:       { $regex: q, $options: "i" } },
      { make:      { $regex: q, $options: "i" } },
      { modelName: { $regex: q, $options: "i" } },
    ];
  }

  const vehicles = await Vehicle.find(filter)
    .select("vin year make modelName exteriorColor status")
    .limit(50)
    .lean();

  const data = vehicles.map((v) => ({
    vin:       v.vin,
    year:      v.year,
    make:      v.make,
    model:     v.modelName,
    color:     v.exteriorColor || "",
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
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip  = (page - 1) * limit;

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
      { loadNumber:                    { $regex: q, $options: "i" } },
      { "pickupLocation.city":         { $regex: q, $options: "i" } },
      { "pickupLocation.state":        { $regex: q, $options: "i" } },
      { "deliveryLocation.city":       { $regex: q, $options: "i" } },
      { "deliveryLocation.state":      { $regex: q, $options: "i" } },
      { "vehicles.make":               { $regex: q, $options: "i" } },
      { "vehicles.model":              { $regex: q, $options: "i" } },
      { "vehicles.vin":                { $regex: q, $options: "i" } },
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

  return res.status(200).json(
    new ApiResponse(200, {
      loads,
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
    all:          0,
    Posted:       0,
    Assigned:     0,
    "In-Transit": 0,
    Delivered:    0,
    Cancelled:    0,
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
  const user           = getUser(req);

  const raw = await Load.findOne({ _id: req.params.id, organizationId }).lean();
  if (!raw) throw new ApiError(404, "Load not found");

  const load = user?.role === "driver"
    ? maskLoadForDriver(raw as unknown as Record<string, unknown>)
    : raw;

  return res.status(200).json(new ApiResponse(200, load, "Load fetched successfully"));
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

  return res.status(200).json(new ApiResponse(200, null, "Load deleted successfully"));
});

export default { lookupVin, getInventoryVehicles, calculateLoadRate, createLoad, getLoads, getLoadStats, getLoadById, deleteLoad };
