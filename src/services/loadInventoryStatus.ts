import mongoose from "mongoose";

/** The Inventory statuses a load moves its cars to. */
export type LoadInventoryStatus = "In Transit" | "Ready for Sale" | "Sold";

/**
 * What the cars on a load become at delivery. A car coming to the dealership
 * goes back to "Ready for Sale". A load made from a quote takes the car to its
 * buyer, so at delivery it becomes "Sold" (decided 2026-11-02): it never goes
 * back on sale, other customers' waiting requests for it close, and the feed
 * can still update it later like any sold car.
 */
export function inventoryStatusAtDelivery(load: { quoteId?: unknown } | null | undefined): "Ready for Sale" | "Sold" {
  return String(load?.quoteId ?? "").trim() ? "Sold" : "Ready for Sale";
}

/**
 * The Inventory cars whose status follows a load. Every load puts its cars
 * "In Transit" at pickup, so the marketplace stops offering them; at delivery
 * only the status that fits the load applies (see inventoryStatusAtDelivery).
 */
export function inventoryVehicleIdsFollowingLoad(
  load: {
    quoteId?: unknown;
    vehicles?: Array<{ vehicleId?: unknown } | null | undefined> | null;
  } | null | undefined,
  toStatus: LoadInventoryStatus,
): string[] {
  if (!load) return [];
  if (toStatus !== "In Transit" && toStatus !== inventoryStatusAtDelivery(load)) return [];
  return [
    ...new Set(
      (Array.isArray(load.vehicles) ? load.vehicles : [])
        .map((vehicle) => String(vehicle?.vehicleId ?? "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
}
