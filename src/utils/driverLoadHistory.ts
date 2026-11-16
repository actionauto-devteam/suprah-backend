/**
 * A driver's loads, in the views the Driver Portal needs (2026-11-15). The
 * Loads page used to ask for pages while the server sent every load the driver
 * ever had, every 30 seconds; delivered loads are now sent a page at a time.
 */

/** Loads a driver is carrying or about to carry. */
export const DRIVER_CURRENT_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"];

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_PAGE_SIZE = 50;
const SEARCH_MAX_LENGTH = 60;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wholeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, min), max);
};

/** Page, page size and search text for the delivered-loads list, kept within safe bounds. */
export function driverLoadHistoryParams(query: Record<string, unknown>) {
  return {
    page: wholeNumber(query.page, 1, 1, 10_000),
    limit: wholeNumber(query.limit, HISTORY_PAGE_SIZE, 1, HISTORY_MAX_PAGE_SIZE),
    q: typeof query.q === "string" ? query.q.trim().slice(0, SEARCH_MAX_LENGTH) : "",
  };
}

/** This driver's delivered loads, optionally matching a load number, city or vehicle. */
export function driverLoadHistoryFilter(driverId: unknown, q: string) {
  const filter: Record<string, unknown> = { assignedDriverId: driverId, status: "Delivered" };
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { loadNumber: pattern },
      { "pickupLocation.city": pattern },
      { "deliveryLocation.city": pattern },
      { "vehicles.make": pattern },
      { "vehicles.model": pattern },
    ];
  }
  return filter;
}

export function historyPagination(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: page * limit < total,
  };
}
