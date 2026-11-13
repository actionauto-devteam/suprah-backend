import mongoose from "mongoose";

/**
 * Who someone can find in Dispatch Chat's people search (2026-11-13). Each
 * person finds only the people they work with, never everyone on Suprah AI:
 * - the Suprah AI team (super admins): every active driver and staff member;
 * - dealership staff: drivers (drivers are a shared pool), their own
 *   dealership's staff, and anyone they already share a channel with;
 * - drivers: staff and fellow drivers of the dealerships they've hauled
 *   loads for, and anyone they already share a channel with.
 * Results still show only name, photo, driver/staff and dealership.
 */

export const CHANNEL_STAFF_ROLES = ["employee", "admin", "super_admin"];

export interface PeopleSearchViewer {
  id: string;
  role: string;
  /** The dealership the staff member is signed in to. */
  organizationId?: unknown;
}

export interface PeopleSearchContext {
  /** Dealerships the driver has had loads from. */
  haulOrganizationIds?: unknown[];
  /** Drivers who have had loads from those same dealerships. */
  fellowDriverIds?: unknown[];
  /** Everyone in a channel the viewer is in (the viewer included). */
  channelMateIds?: unknown[];
}

function validIds(values: unknown[] | undefined, except?: string): string[] {
  const ids = (values ?? [])
    .map((value) => String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim())
    .filter((id) => id !== except && mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id));
  return [...new Set(ids)];
}

/**
 * The `$or` branches a people search must match. An empty list means the
 * viewer can't find anyone yet (for example, a new driver with no loads).
 */
export function peopleSearchScope(
  viewer: PeopleSearchViewer,
  context: PeopleSearchContext = {},
): Record<string, unknown>[] {
  if (viewer.role === "super_admin") {
    return [{ role: { $in: [...CHANNEL_STAFF_ROLES, "driver"] } }];
  }

  const branches: Record<string, unknown>[] = [];
  if (viewer.role === "driver") {
    const dealerships = validIds(context.haulOrganizationIds);
    if (dealerships.length) {
      branches.push({ role: { $in: CHANNEL_STAFF_ROLES }, organizationId: { $in: dealerships } });
    }
    const fellowDrivers = validIds(context.fellowDriverIds, viewer.id);
    if (fellowDrivers.length) branches.push({ role: "driver", _id: { $in: fellowDrivers } });
  } else if (CHANNEL_STAFF_ROLES.includes(viewer.role)) {
    branches.push({ role: "driver" });
    const [dealership] = validIds([viewer.organizationId]);
    if (dealership) branches.push({ role: { $in: CHANNEL_STAFF_ROLES }, organizationId: dealership });
  } else {
    return [];
  }

  const mates = validIds(context.channelMateIds, viewer.id);
  if (mates.length) branches.push({ _id: { $in: mates } });
  return branches;
}
