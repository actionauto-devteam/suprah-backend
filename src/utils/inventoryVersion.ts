/**
 * A short "has anything changed?" stamp for a dealership's inventory
 * (2026-11-16). The Inventory page checks it before its quiet refresh and
 * downloads the whole inventory again only when it differs: a car added,
 * removed or changed (count and newest change), or a new hour, so ages and
 * anything saved without a change time still refresh at least hourly.
 */
export function inventoryVersion(count: number, latestChange: Date | null | undefined, now: Date = new Date()): string {
  const latest = latestChange instanceof Date && Number.isFinite(latestChange.getTime()) ? latestChange.getTime() : 0;
  return `${Math.max(0, Math.floor(Number(count) || 0))}:${latest}:${now.toISOString().slice(0, 13)}`;
}

/** The newest change time among these cars. */
export function newestChange(vehicles: Array<{ updatedAt?: unknown }>): Date | null {
  let newest = 0;
  for (const vehicle of vehicles) {
    const time = vehicle?.updatedAt ? new Date(vehicle.updatedAt as string | Date).getTime() : NaN;
    if (Number.isFinite(time) && time > newest) newest = time;
  }
  return newest ? new Date(newest) : null;
}
