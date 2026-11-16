/**
 * Inventory's "Change status" when several people work at once (2026-11-16):
 * a change made from an older view of the car is refused instead of quietly
 * replacing someone else's, and a car on a load that's on its way keeps the
 * status delivery will give it (the screen already hid the choice).
 */
export const ON_THE_WAY_LOAD_STATUSES = ["Picked Up", "In-Transit"];

export const VEHICLE_STATUS_CHANGED_TYPE = "vehicle_status_changed";

/** The message when the car's status changed since the person looked at it, or null. */
export function statusChangedMeanwhile(current: unknown, expected: unknown): string | null {
  if (typeof expected !== "string" || !expected.trim()) return null;
  const now = String(current ?? "").trim();
  if (now === expected.trim()) return null;
  return now
    ? `Someone else changed this car to ${now} while you were choosing. Check its status now, then try again if it still needs a change.`
    : "Someone else changed this car's status while you were choosing. Check its status now, then try again if it still needs a change.";
}

/** The load carrying the car right now, if one is on its way. */
export function loadOnTheWay(loads: Array<{ loadNumber?: unknown; status?: unknown }>): { loadNumber: string } | null {
  const load = loads.find((item) => ON_THE_WAY_LOAD_STATUSES.includes(String(item?.status ?? "")));
  return load ? { loadNumber: String(load.loadNumber ?? "").trim() } : null;
}

export function carOnTheWayMessage(loadNumber: string): string {
  return `This car is on ${loadNumber ? `load ${loadNumber}` : "a load"}, which is on its way. Its status changes by itself at delivery, so it can't be changed until then.`;
}
