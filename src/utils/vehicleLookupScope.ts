import { MARKETPLACE_VEHICLE_FILTER } from "./marketplaceVehicle";

/**
 * Who sees which car when opening one by its id (2026-11-16). Staff are the
 * same accounts inventory's staffOnly rule lets in (super admin, admin,
 * employee, or a dealership admin) and see their own dealership's cars in
 * every status. Everyone else, customers and drivers included, sees only cars
 * on the marketplace, in the customer view.
 */
const INVENTORY_STAFF_ROLES = ["super_admin", "admin", "employee"];

export function isInventoryStaff(role: unknown, orgRole: unknown): boolean {
  return INVENTORY_STAFF_ROLES.includes(String(role ?? "")) || INVENTORY_STAFF_ROLES.includes(String(orgRole ?? ""));
}

export function vehicleLookupScope(
  user: { role?: unknown } | null | undefined,
  orgRole: unknown,
  orgId: unknown,
): { staff: boolean; filter: Record<string, unknown> } {
  const role = String(user?.role ?? "");
  if (role === "super_admin") return { staff: true, filter: {} };
  const dealershipId = typeof orgId === "string" ? orgId.trim() : "";
  if (user && isInventoryStaff(role, orgRole) && dealershipId) {
    return { staff: true, filter: { organizationId: dealershipId } };
  }
  return { staff: false, filter: { ...MARKETPLACE_VEHICLE_FILTER } };
}
