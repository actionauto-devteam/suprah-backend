import mongoose from "mongoose";

/**
 * The Inventory cars whose status follows a load: "In Transit" at pickup and
 * "Ready for Sale" at delivery, which fits a car coming to the dealership.
 * A load made from a quote ships a car out to a customer, so it never changes
 * the car's status (decided 2026-10-30): the dealer, the feed or "Add to
 * customer's garage" decides when it's Sold.
 */
export function inventoryVehicleIdsFollowingLoad(load: {
  quoteId?: unknown;
  vehicles?: Array<{ vehicleId?: unknown } | null | undefined> | null;
} | null | undefined): string[] {
  if (!load || String(load.quoteId ?? "").trim()) return [];
  return [
    ...new Set(
      (Array.isArray(load.vehicles) ? load.vehicles : [])
        .map((vehicle) => String(vehicle?.vehicleId ?? "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
}
