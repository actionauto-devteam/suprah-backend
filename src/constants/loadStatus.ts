import type { LoadStatus } from "../models/Load.model";

/**
 * Load statuses and the lifecycle rules between them, in one place. The
 * frontend mirrors these lists in src/lib/load-status.ts.
 */

/** Every load status, in lifecycle order. */
export const LOAD_STATUSES = [
  "Draft",
  "Posted",
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
  "Delivered",
  "Cancelled",
] as const satisfies readonly LoadStatus[];

/** A driver has the load: assigned and not yet delivered. */
export const ACTIVE_LOAD_STATUSES = [
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const satisfies readonly LoadStatus[];

/** The driver accepted the load, so GPS tracking applies. */
export const GPS_TRACKING_LOAD_STATUSES = [
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const satisfies readonly LoadStatus[];

/** The vehicles are on the trailer. */
export const VEHICLES_ON_BOARD_STATUSES = [
  "Picked Up",
  "In-Transit",
] as const satisfies readonly LoadStatus[];

/**
 * Which status changes the lifecycle allows (from → to):
 * - Posted → Assigned: a dispatcher assigns the load or approves a request.
 * - any active status → Assigned: reassigned to another driver.
 * - Assigned / Accepted → Posted: returned to Available Loads (not after pickup).
 * - Assigned → Accepted → Picked Up → In-Transit → Delivered: the driver's steps.
 */
export const LOAD_STATUS_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Draft: ["Posted", "Cancelled"],
  Posted: ["Assigned", "Draft", "Cancelled"],
  Assigned: ["Accepted", "Assigned", "Posted", "Cancelled"],
  Accepted: ["Picked Up", "Assigned", "Posted", "Cancelled"],
  "Picked Up": ["In-Transit", "Assigned"],
  "In-Transit": ["Delivered", "Assigned"],
  Delivered: [],
  Cancelled: [],
};

export function isAllowedLoadTransition(from: string, to: string): boolean {
  const allowed = LOAD_STATUS_TRANSITIONS[from as LoadStatus];
  return Array.isArray(allowed) && allowed.includes(to as LoadStatus);
}
