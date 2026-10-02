import Load from "../models/Load.model";
import User from "../models/User.model";
import { emitToUser } from "../utils/socketEmitter";
import { GPS_TRACKING_LOAD_STATUSES } from "../constants/loadStatus";

// Shared lifecycle list (constants/loadStatus.ts), re-exported for existing imports.
export { GPS_TRACKING_LOAD_STATUSES };

const DISPATCH_ROLES = ["employee", "admin", "super_admin"];
const ORG_ADMIN_ROLES = ["admin", "super_admin"];

/**
 * An active admin of this organization, by role or organization role. The
 * same rule as the location monitor's admin fallback.
 */
export function isOrganizationAdminFor(
  user: { isActive?: boolean; role?: unknown; organizationRole?: unknown; organizationId?: unknown } | null | undefined,
  organizationId: unknown,
): boolean {
  if (!user || user.isActive === false) return false;
  const orgId = String(organizationId ?? "").trim();
  if (!orgId || String(user.organizationId ?? "") !== orgId) return false;
  return ORG_ADMIN_ROLES.includes(String(user.role ?? "")) || ORG_ADMIN_ROLES.includes(String(user.organizationRole ?? ""));
}

export interface DriverGpsTrackingLoad {
  _id: any;
  organizationId: string;
  assignedDriverId: any;
  dispatchOwnerId?: any;
  loadNumber?: string;
  status?: string;
  assignedAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export async function getDriverGpsTrackingLoads(
  driverId: string,
  organizationId?: string | null,
): Promise<DriverGpsTrackingLoad[]> {
  const filter: Record<string, any> = {
    assignedDriverId: driverId,
    status: { $in: GPS_TRACKING_LOAD_STATUSES },
  };
  if (organizationId) filter.organizationId = organizationId;

  return Load.find(filter)
    .select(
      "_id organizationId assignedDriverId dispatchOwnerId loadNumber status assignedAt acceptedAt createdAt updatedAt",
    )
    .lean() as unknown as Promise<DriverGpsTrackingLoad[]>;
}

/**
 * Whether this user may see the exact GPS of the driver on these tracking
 * loads: the responsible dispatcher of one of them, or an admin of one of
 * their organizations. The same rule as the directory and live updates.
 */
export function canViewDriverExactGps(
  user: { _id?: unknown; isActive?: boolean; role?: unknown; organizationRole?: unknown; organizationId?: unknown } | null | undefined,
  loads: DriverGpsTrackingLoad[],
): boolean {
  const userId = String(user?._id ?? "").trim();
  if (!userId || user?.isActive === false) return false;
  return loads.some(
    (load) =>
      GPS_TRACKING_LOAD_STATUSES.includes(load.status as any) &&
      (String(load.dispatchOwnerId ?? "") === userId || isOrganizationAdminFor(user, load.organizationId)),
  );
}

export async function getDispatcherGpsVisibleDriverIds(
  dispatcherId: string,
  organizationId: string,
): Promise<string[]> {
  const ids = await Load.distinct("assignedDriverId", {
    organizationId,
    dispatchOwnerId: dispatcherId,
    assignedDriverId: { $ne: null },
    status: { $in: GPS_TRACKING_LOAD_STATUSES },
  });
  return ids.map((id: any) => String(id)).filter(Boolean);
}

async function getLocationViewerIds(loads: DriverGpsTrackingLoad[]) {
  const ownerIds = [
    ...new Set(
      loads
        .map((load) => String(load.dispatchOwnerId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const organizationIds = [
    ...new Set(
      loads
        .map((load) => String(load.organizationId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (!ownerIds.length && !organizationIds.length) return [] as string[];

  const candidates: any[] = await User.find({
    isActive: true,
    $or: [
      ...(ownerIds.length ? [{ _id: { $in: ownerIds }, role: { $in: DISPATCH_ROLES } }] : []),
      ...(organizationIds.length
        ? [{
            organizationId: { $in: organizationIds },
            $or: [{ role: { $in: ORG_ADMIN_ROLES } }, { organizationRole: { $in: ORG_ADMIN_ROLES } }],
          }]
        : []),
    ],
  })
    .select("_id role organizationRole organizationId isActive")
    .lean();

  const byId = new Map(candidates.map((user: any) => [String(user._id), user]));
  const recipients = new Set<string>();

  for (const load of loads) {
    // The dispatcher responsible for this load.
    const dispatcherId = String(load.dispatchOwnerId ?? "").trim();
    const dispatcher: any = dispatcherId ? byId.get(dispatcherId) : null;
    if (
      dispatcher &&
      DISPATCH_ROLES.includes(String(dispatcher.role)) &&
      (dispatcher.role === "super_admin" ||
        String(dispatcher.organizationId ?? "") === String(load.organizationId ?? ""))
    ) {
      recipients.add(dispatcherId);
    }
    // The load organization's admins (business rule, 2026-09-30).
    for (const candidate of candidates) {
      if (isOrganizationAdminFor(candidate, load.organizationId)) recipients.add(String(candidate._id));
    }
  }

  return [...recipients];
}

/**
 * Exact live GPS must never be sent to an organization room. Recipients are
 * derived from Accepted/Picked Up/In-Transit loads: the dispatcher responsible
 * for each load and that load organization's admins.
 */
export async function emitDriverLocationToResponsibleDispatchers(
  driverId: string,
  payload: Record<string, unknown>,
  // A caller that already read this driver's tracking loads in the same request
  // (the GPS heartbeat) passes them in, instead of reading them a second time.
  trackingLoads?: DriverGpsTrackingLoad[],
): Promise<string[]> {
  const loads = trackingLoads ?? (await getDriverGpsTrackingLoads(driverId));
  const dispatcherIds = await getLocationViewerIds(loads);

  for (const dispatcherId of dispatcherIds) {
    emitToUser(dispatcherId, "driver:location", {
      driverId,
      ...payload,
    });
  }

  return dispatcherIds;
}