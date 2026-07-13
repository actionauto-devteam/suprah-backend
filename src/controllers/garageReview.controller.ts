import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { emitToOrg } from '../utils/socketEmitter';
import Vehicle from '../models/Vehicle.model';
import { OwnedVehicle } from '../models/OwnedVehicle.model';
import GarageTransfer from '../models/GarageTransfer.model';
import Deal, { DealStage } from '../models/Deal.model';
import User from '../models/User.model';
import Organization from '../models/Organization.model';


const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanImages = (images: unknown): string[] =>
  Array.isArray(images)
    ? images.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    : [];

const vehicleLabel = (v: { year?: unknown; make?: string; modelName?: string }) =>
  `${v.year ?? ''} ${v.make ?? ''} ${v.modelName ?? ''}`.replace(/\s+/g, ' ').trim();

const slimVehicle = (v: any) => ({
  id: v._id.toString(),
  vin: v.vin,
  year: v.year,
  make: v.make,
  model: v.modelName,
  trim: v.trim || '',
  color: v.exteriorColor || '',
  stockNumber: v.stockNumber || '',
  mileage: v.mileage || 0,
  price: v.price || 0,
  status: v.status,
  image: cleanImages(v.images)[0] || null,
  images: cleanImages(v.images),
});

const slimCustomer = (u: any) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  role: u.role,
  avatar: u.avatarUrl || u.avatar || null,
  organizationId: u.organizationId ? u.organizationId.toString() : null,
});

// ─── Inventory picker ─────────────────────────────────────────────────────────
// Returns this org's inventory vehicles for the Finance team to choose from.
// Defaults to retail-relevant statuses; falls back to a free-text $or search.
const getInventory = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const filter: Record<string, unknown> = { organizationId: orgId, isDeleted: { $ne: true } };

  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    const or: Record<string, unknown>[] = [
      { vin: rx }, { make: rx }, { modelName: rx }, { stockNumber: rx },
    ];
    if (!Number.isNaN(Number(search))) or.push({ year: Number(search) });
    filter.$or = or;
  }

  const vehicles = await Vehicle.find(filter)
    .select('vin year make modelName trim exteriorColor stockNumber mileage price status images')
    .sort({ status: 1, dateAdded: -1 })
    .limit(30);

  res.json(new ApiResponse(200, vehicles.map(slimVehicle), 'Inventory fetched'));
});

// ─── Customer picker ───────────────────────────────────────────────────────────
// Searches this org's customers by name/email. Also surfaces users with no org
// (legacy / not-yet-assigned customers) so the buyer can always be found —
// mirrors the single-dealership fallback philosophy used elsewhere.
const getCustomers = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  const scope = { $or: [{ organizationId: orgId }, { organizationId: null }] };
  const notSuperAdmin = { role: { $ne: 'super_admin' } };

  const filter: Record<string, unknown> = search
    ? {
        $and: [
          scope,
          notSuperAdmin,
          { $or: [
            { name: { $regex: escapeRegex(search), $options: 'i' } },
            { email: { $regex: escapeRegex(search), $options: 'i' } },
          ] },
        ],
      }
    : { $and: [scope, notSuperAdmin] };

  const users = await User.find(filter)
    .select('name email role avatar avatarUrl organizationId')
    .sort({ createdAt: -1 })
    .limit(20);

  res.json(new ApiResponse(200, users.map(slimCustomer), 'Customers fetched'));
});

// ─── Optional deal context ──────────────────────────────────────────────────────
// Deals near closing, so a transfer can be associated with the deal it closes.
const getTransferableDeals = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const stages: DealStage[] = ['negotiation', 'closed_won'];
  const deals = await Deal.find({ organizationId: orgId, stage: { $in: stages } })
    .select('title company contactName value currency stage tags')
    .sort({ updatedAt: -1 })
    .limit(25)
    .lean();

  res.json(new ApiResponse(200, deals, 'Deals fetched'));
});

// ─── Transfer history ────────────────────────────────────────────────────────────
const getTransfers = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const transfers = await GarageTransfer.find({ organizationId: orgId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.json(new ApiResponse(200, transfers, 'Transfers fetched'));
});

// ─── The action: transfer an inventory vehicle into a customer's My Garage ────────
const transferVehicle = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'CRM authentication required.');

  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const {
    vehicleId,
    customerId,
    dealId,
    mileageOverride,
    purchaseDate,
    markVehicleSold = true,
  } = req.body as {
    vehicleId?: string;
    customerId?: string;
    dealId?: string;
    mileageOverride?: number | string;
    purchaseDate?: string;
    markVehicleSold?: boolean;
  };

  if (!vehicleId || !customerId) {
    throw new ApiError(400, 'vehicleId and customerId are required');
  }

  // 1. Inventory vehicle — must belong to this org
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    organizationId: orgId,
    isDeleted: { $ne: true },
  });
  if (!vehicle) throw new ApiError(404, 'Vehicle not found in your inventory');

  // 2. Customer — must belong to this org (or be unassigned/legacy)
  const customer = await User.findById(customerId).select('name email organizationId');
  if (!customer) throw new ApiError(404, 'Customer not found');
  const custOrg = (customer as any).organizationId?.toString();
  if (custOrg && custOrg !== orgId.toString()) {
    throw new ApiError(403, 'This customer belongs to another dealership');
  }

  // 3. Resolve mileage
  const mileage =
    mileageOverride !== undefined && mileageOverride !== ''
      ? Number(mileageOverride)
      : Number((vehicle as any).mileage || 0);
  if (Number.isNaN(mileage) || mileage < 0) {
    throw new ApiError(400, 'Invalid mileage value');
  }

  // 4. Dealership name (best-effort, for the customer-facing badge)
  let dealershipName: string | undefined;
  try {
    const org = await Organization.findById(orgId).select('name');
    dealershipName = (org as any)?.name || undefined;
  } catch {
    dealershipName = undefined;
  }

  // 5. Provision the OwnedVehicle — idempotent on { userId, vin }
  let owned = await OwnedVehicle.findOne({ userId: customer._id, vin: vehicle.vin });
  const alreadyExisted = !!owned;

  if (owned) {
    // Re-activate / refresh an existing garage entry rather than duplicating
    owned.status = 'ACTIVE';
    owned.currentMileage = Math.max(owned.currentMileage || 0, mileage);
    owned.source = 'DEALERSHIP_TRANSFER';
    if (dealershipName) owned.dealershipName = dealershipName;
    owned.transferredAt = new Date();
    if ((!owned.images || owned.images.length === 0) && cleanImages((vehicle as any).images).length) {
      owned.images = cleanImages((vehicle as any).images);
    }
    await owned.save();
  } else {
    owned = await OwnedVehicle.create({
      userId: customer._id,
      vin: vehicle.vin,
      make: vehicle.make,
      model: (vehicle as any).modelName,
      year: String(vehicle.year),
      trim: (vehicle as any).trim || undefined,
      color: (vehicle as any).exteriorColor || undefined,
      currentMileage: mileage,
      images: cleanImages((vehicle as any).images),
      status: 'ACTIVE',
      purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
      source: 'DEALERSHIP_TRANSFER',
      dealershipName,
      transferredAt: new Date(),
    });
  }

  // 6. Mark the inventory vehicle Sold (dealership-side effect of the sale)
  let vehicleMarkedSold = false;
  if (markVehicleSold && vehicle.status !== 'Sold') {
    vehicle.status = 'Sold';
    (vehicle as any).dateSold = new Date();
    (vehicle as any).manualStatusLock = true;
    await vehicle.save();
    vehicleMarkedSold = true;
  }

  // 7. Optionally associate + advance the deal this closes
  let linkedDealId: typeof Deal.prototype._id | null = null;
  if (dealId) {
    const deal = await Deal.findOne({ _id: dealId, organizationId: orgId });
    if (deal) {
      if (deal.stage !== 'closed_won') deal.stage = 'closed_won';
      if (!deal.tags.includes('garage-transferred')) deal.tags.push('garage-transferred');
      await deal.save();
      linkedDealId = deal._id;
    }
  }

  // 8. Audit record
  const record = await GarageTransfer.create({
    organizationId: orgId,
    vehicleId: vehicle._id,
    ownedVehicleId: owned._id,
    customerId: customer._id,
    dealId: linkedDealId,
    vin: vehicle.vin,
    vehicleLabel: vehicleLabel(vehicle as any),
    customerName: (customer as any).name,
    customerEmail: (customer as any).email,
    mileageAtTransfer: mileage,
    vehicleMarkedSold,
    performedBy: actor._id,
    performedByName: actor.fullName,
    status: alreadyExisted ? 'already_in_garage' : 'transferred',
  });

  // 9. Notify the org in real time (dashboards / inventory views can react)
  emitToOrg(orgId.toString(), 'garage:vehicle_transferred', {
    transferId: record._id,
    vehicleId: vehicle._id,
    customerId: customer._id,
    vin: vehicle.vin,
    status: record.status,
  });

  res.status(201).json(
    new ApiResponse(
      201,
      { transfer: record, ownedVehicle: owned },
      alreadyExisted
        ? 'Vehicle was already in this customer’s garage — record refreshed.'
        : 'Vehicle transferred to the customer’s My Garage successfully.'
    )
  );
});

export default {
  getInventory,
  getCustomers,
  getTransferableDeals,
  getTransfers,
  transferVehicle,
};