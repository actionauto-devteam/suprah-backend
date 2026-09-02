import Load from "../models/Load.model";
import User from "../models/User.model";
import { emitToUser } from "../utils/socketEmitter";

export const GPS_TRACKING_LOAD_STATUSES = [
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const;

const DISPATCH_ROLES = ["employee", "admin", "super_admin"];

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

async function getValidDispatcherRecipients(loads: DriverGpsTrackingLoad[]) {
  const candidateIds = [
    ...new Set(
      loads
        .map((load) => String(load.dispatchOwnerId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (!candidateIds.length) return [] as string[];

  const dispatchers: any[] = await User.find({
    _id: { $in: candidateIds },
    role: { $in: DISPATCH_ROLES },
    isActive: true,
  })
    .select("_id role organizationId")
    .lean();

  const byId = new Map(dispatchers.map((user: any) => [String(user._id), user]));
  const recipients = new Set<string>();

  for (const load of loads) {
    const dispatcherId = String(load.dispatchOwnerId ?? "").trim();
    if (!dispatcherId) continue;
    const dispatcher: any = byId.get(dispatcherId);
    if (!dispatcher) continue;

    const isValidForLoad =
      dispatcher.role === "super_admin" ||
      String(dispatcher.organizationId ?? "") === String(load.organizationId ?? "");
    if (isValidForLoad) recipients.add(dispatcherId);
  }

  return [...recipients];
}

/**
 * Exact live GPS must never be sent to an organization room. Recipients are
 * derived from Accepted/Picked Up/In-Transit loads owned by the dispatcher who
 * is responsible for that assignment.
 */
export async function emitDriverLocationToResponsibleDispatchers(
  driverId: string,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const loads = await getDriverGpsTrackingLoads(driverId);
  const dispatcherIds = await getValidDispatcherRecipients(loads);

  for (const dispatcherId of dispatcherIds) {
    emitToUser(dispatcherId, "driver:location", {
      driverId,
      ...payload,
    });
  }

  return dispatcherIds;
}