/**
 * A staff quote can only be linked to a car in the staff member's own
 * dealership (2026-11-14). Before, any car ID was looked up, so another
 * dealership's price, VIN, stock number, status and days on lot could be
 * copied into a quote.
 */

export const QUOTE_VEHICLE_NOT_IN_INVENTORY =
  "That vehicle isn't in your dealership's inventory. Pick it from your Inventory, or enter the vehicle details yourself.";

/** The lookup for the car a staff quote is made for: that car, in this dealership only. */
export function ownDealershipVehicleFilter(vehicleId: string, organizationId: string) {
  return { _id: vehicleId, organizationId };
}
