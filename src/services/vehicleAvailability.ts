/**
 * Whether the inventory vehicle on a quote or load is still there. Pure, so
 * the rule is testable without a database.
 *
 * - "removed": hidden or archived in inventory, or no longer in it at all.
 * - "sold": marked Sold. Normal for many shipments (the buyer's car), so it's
 *   shown to staff as information, never acted on, except for a customer's
 *   waiting request for a car on the marketplace.
 * - "available": anything else, including In Recon and In Transit.
 */
export type VehicleState = "available" | "sold" | "removed";

export interface VehicleAvailabilityFields {
  status?: string | null;
  isDeleted?: boolean | null;
  isArchived?: boolean | null;
}

export function vehicleStateOf(vehicle: VehicleAvailabilityFields | null | undefined): VehicleState {
  if (!vehicle || vehicle.isDeleted === true || vehicle.isArchived === true) return "removed";
  if (String(vehicle.status ?? "") === "Sold") return "sold";
  return "available";
}
