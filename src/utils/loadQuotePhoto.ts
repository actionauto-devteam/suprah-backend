/**
 * Loads made from a quote show the quote's own photo when the car isn't in the
 * dealership's inventory, e.g. a customer's own car (2026-11-13). Before,
 * load photos came only from inventory, so these loads showed "No photo on
 * file" although the quote had one.
 */

type LoadLike = Record<string, any>;

export interface QuotePhoto {
  vehicleImage?: string | null;
  vin?: string | null;
  vehicleId?: unknown;
}

const idOf = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in (value as Record<string, unknown>)) {
    return String((value as { _id: unknown })._id ?? "");
  }
  return value == null ? "" : String(value);
};

const sameVin = (a: unknown, b: unknown) =>
  Boolean(a && b && String(a).toUpperCase().trim() === String(b).toUpperCase().trim());

/** The quotes whose photo could fill a load vehicle that still has none. */
export function quoteIdsNeedingPhotos(loads: LoadLike[]): string[] {
  const ids = new Set<string>();
  for (const load of loads) {
    const quoteId = idOf(load?.quoteId);
    if (!quoteId) continue;
    if ((load.vehicles ?? []).some((vehicle: LoadLike | null) => vehicle && !vehicle.imageUrl)) ids.add(quoteId);
  }
  return [...ids];
}

/**
 * Gives the quote's photo to the load vehicle that is the quote's car: same VIN
 * or inventory car, or the only vehicle on the load. Inventory photos already
 * attached are kept.
 */
export function applyQuotePhotos(loads: LoadLike[], quotesById: Map<string, QuotePhoto>): void {
  for (const load of loads) {
    const quote = quotesById.get(idOf(load?.quoteId));
    const photo = typeof quote?.vehicleImage === "string" ? quote.vehicleImage.trim() : "";
    if (!quote || !photo) continue;
    const vehicles = (load.vehicles ?? []).filter(Boolean) as LoadLike[];
    for (const vehicle of vehicles) {
      if (vehicle.imageUrl) continue;
      const isQuoteCar =
        vehicles.length === 1 ||
        sameVin(vehicle.vin, quote.vin) ||
        Boolean(quote.vehicleId && vehicle.vehicleId && idOf(vehicle.vehicleId) === idOf(quote.vehicleId));
      if (isQuoteCar) vehicle.imageUrl = photo;
    }
  }
}
