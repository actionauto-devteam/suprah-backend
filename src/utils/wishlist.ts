import { isOnMarketplace } from "./marketplaceVehicle";

/** One Wishlist row as the customer sees it. */
export type WishlistEntry = Record<string, unknown> & { id: string; available: boolean };

type StoredVehicle = {
  _id: { toString(): string };
  status?: unknown;
  isArchived?: unknown;
  isDeleted?: unknown;
  year?: unknown;
  make?: unknown;
  modelName?: unknown;
  trim?: unknown;
  images?: unknown;
};

/**
 * The customer's Wishlist in the order the cars were saved (2026-11-09).
 * A car still for sale comes in the same format as Shop (member price, never
 * the dealer's cost or how many leads it has) with available: true. A car
 * that's been sold, archived or removed comes with just enough to recognise
 * and remove it, and available: false, instead of failing when it's opened.
 * A saved car whose record no longer exists is left out.
 */
export function wishlistEntries<V extends StoredVehicle>(
  savedVehicleIds: string[],
  vehicles: V[],
  toCustomerVehicle: (vehicle: V) => Record<string, unknown>,
): WishlistEntry[] {
  const byId = new Map(vehicles.map((vehicle) => [vehicle._id.toString(), vehicle]));
  const entries: WishlistEntry[] = [];
  for (const id of savedVehicleIds) {
    const vehicle = byId.get(id);
    if (!vehicle) continue;
    entries.push(
      isOnMarketplace(vehicle)
        ? { ...toCustomerVehicle(vehicle), id, available: true }
        : unavailableEntry(id, vehicle),
    );
  }
  return entries;
}

function unavailableEntry(id: string, vehicle: StoredVehicle): WishlistEntry {
  const images = Array.isArray(vehicle.images)
    ? vehicle.images.filter((image): image is string => typeof image === "string" && image.trim().length > 0)
    : [];
  return {
    id,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.modelName,
    modelName: vehicle.modelName,
    trim: vehicle.trim || "",
    image: images[0] || "",
    images: images.slice(0, 1),
    available: false,
  };
}
