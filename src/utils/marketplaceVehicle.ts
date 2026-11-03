/**
 * Cars on the marketplace: Ready for Sale and not archived. Customers and
 * signed-out visitors can only open, ask about or apply for these
 * (decided 2026-11-04); staff keep seeing their own cars in every status.
 */
export const MARKETPLACE_VEHICLE_FILTER = {
  status: "Ready for Sale",
  isArchived: { $ne: true },
} as const;

export function isOnMarketplace(
  vehicle: { status?: unknown; isArchived?: unknown; isDeleted?: unknown } | null | undefined,
): boolean {
  return Boolean(vehicle) && vehicle!.status === "Ready for Sale" && vehicle!.isArchived !== true && vehicle!.isDeleted !== true;
}

/** Shown when a customer asks about or applies for a car that's no longer for sale. */
export const VEHICLE_NOT_FOR_SALE =
  "This vehicle isn't listed for sale anymore, so we couldn't send this to the dealership. Browse Shop to see what's available now.";
