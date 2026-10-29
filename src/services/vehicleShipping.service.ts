import mongoose from "mongoose";
import Load from "../models/Load.model";
import Quote from "../models/Quote.model";

/*
 * Which cars a dealership is already shipping (decided 2026-10-29), so staff
 * don't put the same car on two loads: a load that isn't delivered or
 * cancelled, or a shipping quote still waiting (pending or accepted).
 * Inventory tags its cars with it, Create Load warns before saving, and
 * Convert to Load warns after. It never blocks anything.
 */

export const FINISHED_LOAD_STATUSES = ["Delivered", "Cancelled"];
export const WAITING_QUOTE_STATUSES = ["pending", "accepted"];
/** The most cars one lookup checks (an Inventory page shows up to 48). */
export const VEHICLE_SHIPPING_LOOKUP_MAX = 100;

export interface VehicleShippingLoad {
  _id: string;
  loadNumber: string;
  status: string;
  vehicleIds: string[];
  vins: string[];
}

export interface VehicleShippingQuote {
  _id: string;
  status: string;
  vehicleId?: string;
  vin?: string;
}

const listOf = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.filter((item): item is string => typeof item === "string");
};

/** A VIN as loads store it: letters and digits only, uppercase, at most 17. */
export const cleanVin = (value: unknown): string =>
  typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17) : "";

/** The cars to look up: valid ids and VINs only, no repeats, capped. */
export function cleanVehicleShippingQuery(input: { vehicleIds?: unknown; vins?: unknown }) {
  const vehicleIds = [...new Set(listOf(input.vehicleIds).map((id) => id.trim()))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .slice(0, VEHICLE_SHIPPING_LOOKUP_MAX);
  const vins = [...new Set(listOf(input.vins).map(cleanVin))].filter(Boolean).slice(0, VEHICLE_SHIPPING_LOOKUP_MAX);
  return { vehicleIds, vins };
}

/**
 * The dealership's live loads (and, when asked, waiting quotes) for these
 * cars, matched by inventory id or VIN. `excludeLoadId` leaves out the load
 * being edited or just created.
 */
export async function findVehicleShipping(
  organizationId: string,
  cars: { vehicleIds?: unknown; vins?: unknown },
  options: { excludeLoadId?: unknown; includeQuotes?: boolean } = {},
): Promise<{ loads: VehicleShippingLoad[]; quotes: VehicleShippingQuote[] }> {
  const { vehicleIds, vins } = cleanVehicleShippingQuery(cars);
  if (!organizationId || (vehicleIds.length === 0 && vins.length === 0)) return { loads: [], quotes: [] };

  const objectIds = vehicleIds.map((id) => new mongoose.Types.ObjectId(id));
  const excludeLoadId = String(options.excludeLoadId ?? "");

  const loadMatch: Record<string, unknown>[] = [];
  if (objectIds.length) loadMatch.push({ "vehicles.vehicleId": { $in: objectIds } });
  if (vins.length) loadMatch.push({ "vehicles.vin": { $in: vins } });

  const quoteMatch: Record<string, unknown>[] = [];
  if (objectIds.length) quoteMatch.push({ vehicleId: { $in: objectIds } });
  if (vins.length) quoteMatch.push({ vin: { $in: vins } });

  const [loads, quotes] = await Promise.all([
    Load.find({
      organizationId,
      status: { $nin: FINISHED_LOAD_STATUSES },
      $or: loadMatch,
      ...(mongoose.Types.ObjectId.isValid(excludeLoadId) ? { _id: { $ne: excludeLoadId } } : {}),
    })
      .select("loadNumber status vehicles.vehicleId vehicles.vin createdAt")
      .sort({ createdAt: -1 })
      .limit(VEHICLE_SHIPPING_LOOKUP_MAX * 2)
      .lean<any[]>(),
    options.includeQuotes
      ? Quote.find({ organizationId, status: { $in: WAITING_QUOTE_STATUSES }, $or: quoteMatch })
          .select("status vehicleId vin createdAt")
          .sort({ createdAt: -1 })
          .limit(VEHICLE_SHIPPING_LOOKUP_MAX * 2)
          .lean<any[]>()
      : Promise.resolve([] as any[]),
  ]);

  return {
    loads: loads.map((load) => {
      const vehicles = Array.isArray(load.vehicles) ? load.vehicles : [];
      return {
        _id: String(load._id),
        loadNumber: String(load.loadNumber ?? ""),
        status: String(load.status ?? ""),
        vehicleIds: vehicles.map((vehicle: any) => String(vehicle?.vehicleId ?? "")).filter(Boolean),
        vins: vehicles.map((vehicle: any) => cleanVin(vehicle?.vin)).filter(Boolean),
      };
    }),
    quotes: quotes.map((quote) => ({
      _id: String(quote._id),
      status: String(quote.status ?? ""),
      ...(quote.vehicleId ? { vehicleId: String(quote.vehicleId) } : {}),
      ...(cleanVin(quote.vin) ? { vin: cleanVin(quote.vin) } : {}),
    })),
  };
}
