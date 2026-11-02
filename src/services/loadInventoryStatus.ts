import mongoose from "mongoose";

/**
 * The Inventory cars whose status follows a load: "In Transit" at pickup and
 * "Ready for Sale" at delivery, which fits a car coming to the dealership.
 * A load made from a quote ships a car out to a customer (decided
 * 2026-11-02): it still goes "In Transit" at pickup, so the marketplace stops
 * offering it, but delivery never puts it back on sale. The dealer, the feed
 * or "Add to customer's garage" decides when it's Sold.
 */
export function inventoryVehicleIdsFollowingLoad(
  load: {
    quoteId?: unknown;
    vehicles?: Array<{ vehicleId?: unknown } | null | undefined> | null;
  } | null | undefined,
  toStatus: "In Transit" | "Ready for Sale",
): string[] {
  if (!load) return [];
  if (toStatus === "Ready for Sale" && String(load.quoteId ?? "").trim()) return [];
  return [
    ...new Set(
      (Array.isArray(load.vehicles) ? load.vehicles : [])
        .map((vehicle) => String(vehicle?.vehicleId ?? "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
}
