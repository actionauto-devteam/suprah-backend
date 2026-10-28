import { Request, Response } from "express";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverProfile, { COMPLIANCE_EXPIRY_FIELDS } from "../models/DriverProfile.model";
import LoadReleaseRequest from "../models/LoadReleaseRequest.model";
import Quote from "../models/Quote.model";
import Vehicle from "../models/Vehicle.model";
import { vehicleStateOf } from "../services/vehicleAvailability";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ACTIVE_LOAD_STATUSES } from "../constants/loadStatus";
import { canViewDriverExactGps } from "../services/driverLocationAccess.service";
import { businessDateParts } from "../utils/businessDate";
import {
  buildLoadAttention,
  type AttentionQuote,
  type AttentionLoad,
  type AttentionLocation,
  type AttentionProfile,
  type AttentionReleaseRequest,
  type AttentionRemovedVehicle,
} from "../services/loadAttention.service";

const ATTENTION_LOAD_FIELDS =
  "_id loadNumber status organizationId assignedDriverId dispatchOwnerId assignedAt dates.pickupDeadline dates.deliveryDeadline proofOfDelivery.submittedAt";

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Waiting quotes and loads not yet picked up whose inventory vehicle was
 * removed (hidden, archived or gone). Sold cars aren't listed: shipping a sold
 * car to its buyer is normal. A customer's waiting request is left out too,
 * since it closes on its own and the customer is told.
 */
async function findRemovedVehicles(organizationId: string): Promise<AttentionRemovedVehicle[]> {
  const [loads, quotes] = await Promise.all([
    Load.find({
      organizationId,
      status: { $in: ["Draft", "Posted", "Assigned", "Accepted"] },
      vehicles: { $elemMatch: { vehicleId: { $type: "objectId" } } },
    })
      .select(`${ATTENTION_LOAD_FIELDS} vehicles.vehicleId vehicles.year vehicles.make vehicles.model`)
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean() as unknown as Promise<AttentionLoad[]>,
    Quote.find({
      organizationId,
      status: { $in: ["pending", "accepted"] },
      vehicleId: { $ne: null },
      $nor: [{ source: "customer_portal", status: "pending" }],
    })
      .select("_id firstName lastName vehicleName vehicleId createdAt")
      .sort({ createdAt: 1 })
      .limit(500)
      .lean() as unknown as Promise<Array<{ _id: unknown; firstName?: string; lastName?: string; vehicleName?: string; vehicleId?: unknown; createdAt?: unknown }>>,
  ]);

  const vehicleIds = [
    ...new Set([
      ...loads.flatMap((load) => (load.vehicles ?? []).map((vehicle) => String(vehicle?.vehicleId ?? ""))),
      ...quotes.map((quote) => String(quote.vehicleId ?? "")),
    ].filter((id) => OBJECT_ID.test(id))),
  ];
  if (vehicleIds.length === 0) return [];
  const vehicles = await Vehicle.find({ _id: { $in: vehicleIds } }).select("status isDeleted isArchived").lean<any[]>();
  const found = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const isRemoved = (id: unknown) => OBJECT_ID.test(String(id ?? "")) && vehicleStateOf(found.get(String(id))) === "removed";

  const removed: AttentionRemovedVehicle[] = [];
  for (const load of loads) {
    const vehicle = (load.vehicles ?? []).find((entry) => isRemoved(entry?.vehicleId));
    if (!vehicle) continue;
    const vehicleName = [vehicle.year, vehicle.make, vehicle.model].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
    removed.push({ load, vehicleName });
  }
  for (const quote of quotes) {
    if (isRemoved(quote.vehicleId)) removed.push({ quote, vehicleName: quote.vehicleName });
  }
  return removed;
}

const driverIdsOf = (loads: AttentionLoad[]) => [
  ...new Set(loads.map((load) => String(load.assignedDriverId ?? "").trim()).filter(Boolean)),
];

/**
 * Who reviews driver requests, the same as in Driver Tracker: organization
 * admins (and platform admins) see them all; a dispatcher sees release
 * requests on the loads they're responsible for, and load requests when they
 * have Dispatcher access for this organization or are dispatching a load now.
 */
function driverRequestAccess(req: Request, user: IUser, organizationId: string, activeLoads: AttentionLoad[]) {
  const userId = String(user._id);
  const effectiveRole = String((req as { orgRole?: string }).orgRole ?? user.role ?? "");
  const isAdmin = user.role === "super_admin" || ["admin", "super_admin"].includes(effectiveRole);
  const dispatcherOrgIds = (user as { dispatcherOrganizationIds?: unknown[] }).dispatcherOrganizationIds;
  const isDesignatedDispatcher =
    Array.isArray(dispatcherOrgIds) && dispatcherOrgIds.some((id) => String(id) === organizationId);
  const dispatchesActiveLoad = activeLoads.some((load) => String(load.dispatchOwnerId ?? "") === userId);
  return {
    canSeeLoadRequests: isAdmin || isDesignatedDispatcher || dispatchesActiveLoad,
    canSeeReleaseRequest: (request: AttentionReleaseRequest, load: AttentionLoad | undefined) =>
      isAdmin || String(request.dispatcherId ?? load?.dispatchOwnerId ?? "") === userId,
  };
}

/**
 * GET /api/loads/attention
 * This organization's work that needs Dispatch now: delivery proofs waiting
 * for confirmation, missed pickup/delivery days, loads with no driver on their
 * pickup day, assignments not accepted after 2 hours, drivers waiting for an
 * answer (release and load requests, only for those who review them), customer
 * shipping requests waiting, quotes and loads before pickup whose vehicle was
 * removed from inventory, drivers whose GPS has gone quiet (only for the
 * dispatcher in charge and org admins, like the alert), and drivers whose CDL,
 * medical card or insurance has expired or expires soon.
 */
const getLoadAttention = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const user = req.user as IUser;
  const { year, month, day } = businessDateParts();
  const todayKey = `${year}-${month}-${day}`;

  const [activeLoads, proofLoads, unassignedLoads, pendingReleases, customerRequests] = (await Promise.all([
    Load.find({
      organizationId,
      status: { $in: ACTIVE_LOAD_STATUSES },
      assignedDriverId: { $ne: null },
    })
      .select(ATTENTION_LOAD_FIELDS)
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean(),
    // The same rule as the payouts page's pending proofs.
    Load.find({
      organizationId,
      "proofOfDelivery.imageUrl": { $exists: true, $ne: "" },
      "proofOfDelivery.confirmedAt": { $exists: false },
    })
      .select(ATTENTION_LOAD_FIELDS)
      .sort({ "proofOfDelivery.submittedAt": 1 })
      .limit(200)
      .lean(),
    // Schedule days are stored at UTC midnight, so this is "today or earlier".
    Load.find({
      organizationId,
      status: { $in: ["Draft", "Posted"] },
      assignedDriverId: null,
      "dates.pickupDeadline": { $lte: new Date(`${todayKey}T23:59:59.999Z`) },
    })
      .select(ATTENTION_LOAD_FIELDS)
      .sort({ "dates.pickupDeadline": 1 })
      .limit(500)
      .lean(),
    LoadReleaseRequest.find({ organizationId, status: "pending" })
      .select("loadId driverId dispatcherId priority requestedAt")
      .sort({ requestedAt: 1 })
      .limit(200)
      .lean(),
    Quote.find({ organizationId, source: "customer_portal", status: "pending" })
      .select("_id firstName lastName vehicleName createdAt")
      .sort({ createdAt: 1 })
      .limit(500)
      .lean(),
  ])) as unknown as [
    AttentionLoad[],
    AttentionLoad[],
    AttentionLoad[],
    AttentionReleaseRequest[],
    AttentionQuote[],
  ];

  const access = driverRequestAccess(req, user, organizationId, activeLoads);
  const activeById = new Map(activeLoads.map((load) => [String(load._id), load]));
  const releaseRequests = pendingReleases.filter((request) =>
    access.canSeeReleaseRequest(request, activeById.get(String(request.loadId))),
  );
  const requestedLoads = access.canSeeLoadRequests
    ? ((await Load.find({ organizationId, status: "Posted", "driverRequests.0": { $exists: true } })
        .select(`${ATTENTION_LOAD_FIELDS} driverRequests.driverId driverRequests.requestedAt`)
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean()) as unknown as AttentionLoad[])
    : [];

  const removedVehicles = await findRemovedVehicles(organizationId);

  const driverIds = [
    ...new Set([
      ...driverIdsOf([...activeLoads, ...proofLoads]),
      ...releaseRequests.map((request) => String(request.driverId ?? "").trim()).filter(Boolean),
    ]),
  ];
  const activeDriverIds = driverIdsOf(activeLoads);

  const [drivers, locations, profiles] = await Promise.all([
    driverIds.length ? User.find({ _id: { $in: driverIds } }).select("name").lean() : Promise.resolve([]),
    activeDriverIds.length
      ? DriverLocation.find({ userId: { $in: activeDriverIds } })
          .select("userId status offlineAlertSentAt lastSeenAt locationRecordedAt")
          .lean()
      : Promise.resolve([]),
    activeDriverIds.length
      ? DriverProfile.find({ userId: { $in: activeDriverIds } })
          .select([
            "userId",
            ...COMPLIANCE_EXPIRY_FIELDS,
            "documents.type",
            "documents.label",
            "documents.expiresAt",
            "documents.reviewStatus",
          ])
          .lean()
      : Promise.resolve([]),
  ]);

  const data = buildLoadAttention({
    activeLoads,
    proofLoads,
    unassignedLoads,
    requestedLoads,
    releaseRequests,
    customerRequests,
    removedVehicles,
    locations: locations as unknown as AttentionLocation[],
    profiles: profiles as unknown as AttentionProfile[],
    driverNames: new Map(
      (drivers as Array<{ _id: unknown; name?: string }>).map((driver) => [String(driver._id), driver.name || "Driver"]),
    ),
    canSeeGps: (load) => canViewDriverExactGps(user, [load as Parameters<typeof canViewDriverExactGps>[1][number]]),
    todayKey,
  });

  return res.status(200).json(new ApiResponse(200, data, "Loads needing attention fetched"));
});

export default { getLoadAttention };
