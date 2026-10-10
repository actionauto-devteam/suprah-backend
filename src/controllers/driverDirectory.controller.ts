import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import User from "../models/User.model";
import CrmUser from "../models/CrmUser.model";
import DriverProfile, { isComplianceExpiredAt } from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import Load from "../models/Load.model";
import DriverStatusChangeRequest from "../models/DriverStatusChangeRequest.model";
import LoadReleaseRequest from "../models/LoadReleaseRequest.model";
import { GPS_TRACKING_LOAD_STATUSES, isOrganizationAdminFor } from "../services/driverLocationAccess.service";
import { GPS_LIVE_MS } from "../constants/driverGps";
import { ACTIVE_LOAD_STATUSES as SHARED_ACTIVE_LOAD_STATUSES } from "../constants/loadStatus";
import { getLoadAcceptanceMaterialVersion } from "../services/loadAcceptanceMaterial.service";
import {
  finalizeDriverStatusChangeIfClear,
  isStatusRequestBlockingNewWork,
  OPEN_DRIVER_STATUS_REQUEST_STATES,
} from "../services/driverStatusTransition.service";

const PRESENCE_STALE_MS = GPS_LIVE_MS;
const ACTIVE_LOAD_STATUSES: string[] = [...SHARED_ACTIVE_LOAD_STATUSES];

interface OrgDriver {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  isActive: boolean;
  memberSince: Date | null;
  equipment: {
    trailerType: string | null;
    maxVehicleCapacity: number | null;
    operationalStatus: string | null;
    truckMake: string | null;
    truckModel: string | null;
    isComplianceExpired: boolean;
    profileCompletionScore: number;
  } | null;
  availability: {
    availableDays: string[];
  };
  logistics: {
    serviceRadiusMiles: number | null;
    preferredRoutes: string[];
    homeBase: {
      city: string | null;
      state: string | null;
      zip: string | null;
      coordinates: null;
    };
  };
  presence: {
    canViewExactGps: boolean;
    status: string;
    lastSeenAt: Date | null;
    locationRecordedAt: Date | null;
    accuracy: number | null;
    coords: { lat: number; lng: number } | null;
    isSharing: boolean;
  };
  shipments: Array<{
    id: string;
    trackingNumber: string;
    status: string;
    origin: string;
    destination: string;
    vehicleCount: number;
    trailerType: string | null;
    pickupDate: Date | null;
    pickupLocation: {
      name: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      coordinates: { lat: number; lng: number } | null;
    };
    deliveryLocation: {
      name: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      coordinates: { lat: number; lng: number } | null;
    };
    requiresDispatchReconfirmation: boolean;
    assignmentMaterialVersion: string | null;
    releaseRequest: {
      id: string;
      status: "pending";
      priority: "standard" | "emergency";
      reason: string;
      message?: string | null;
      requestedAt?: Date | null;
      dispatcherId?: string | null;
    } | null;
  }>;
  activeLoadCount: number;
  // Deprecated compatibility field. Vehicle capacity is per load, so there is
  // no meaningful "remaining" value obtained by subtracting active load count.
  remainingCapacity: number | null;
  assignable: boolean;
  messagingAvailable: boolean;
  crmUserId: string | null;
  messagingUnavailableReason: string | null;
  statusRequest: {
    id: string;
    requestedStatus: "on_leave" | "maintenance";
    priority: "standard" | "emergency";
    status: string;
    reason?: string | null;
    message?: string | null;
    submittedAt?: Date | null;
  } | null;
  warnings: string[];
}

/** A stop's map pin ({ lat, lng }), or null. */
function stopCoordinates(location: any): { lat: number; lng: number } | null {
  const coordinates = location?.coordinates;
  if (!coordinates || typeof coordinates !== "object" || Array.isArray(coordinates)) return null;
  const lat = Number(coordinates.lat);
  const lng = Number(coordinates.lng ?? coordinates.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function getAssignmentReviewState(load: any, validDispatchOwnerIds: Set<string>) {
  if (!load || String(load.status ?? "") !== "Assigned") {
    return {
      requiresDispatchReconfirmation: false,
      assignmentMaterialVersion: null as string | null,
    };
  }

  const currentMaterialVersion = getLoadAcceptanceMaterialVersion(load);
  const storedMaterialVersion = String(load.assignmentMaterialFingerprint ?? "").trim();
  const dispatchOwnerId = String(load.dispatchOwnerId ?? "").trim();
  const invalidDispatchOwner =
    !dispatchOwnerId || !validDispatchOwnerIds.has(dispatchOwnerId);

  if (storedMaterialVersion) {
    return {
      requiresDispatchReconfirmation:
        invalidDispatchOwner || storedMaterialVersion !== currentMaterialVersion,
      assignmentMaterialVersion: currentMaterialVersion,
    };
  }

  const assignedAtMs = load.assignedAt ? new Date(load.assignedAt).getTime() : Number.NaN;
  const updatedAtMs = load.updatedAt ? new Date(load.updatedAt).getTime() : Number.NaN;
  const legacyChangedAfterAssignment =
    Number.isFinite(assignedAtMs) &&
    Number.isFinite(updatedAtMs) &&
    updatedAtMs > assignedAtMs + 2000;

  return {
    requiresDispatchReconfirmation: invalidDispatchOwner || legacyChangedAfterAssignment,
    assignmentMaterialVersion: currentMaterialVersion,
  };
}

const DIRECTORY_PAGE_SIZE = 50;
const DIRECTORY_MAX_PAGE_SIZE = 100;
const DIRECTORY_MAX_IDS = 50;
const DIRECTORY_USER_FIELDS = "name email avatar isActive createdAt";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds directory entries for the given driver accounts. With
 * includeActivity, this organization's active loads, Work Availability
 * requests, release requests and (for the responsible dispatcher) exact GPS
 * are included. Without it, only identity and profile data is returned: the
 * Driver Tracker's working set is the single source of that activity.
 */
async function buildDirectoryEntries(
  req: Request,
  users: any[],
  includeActivity: boolean,
): Promise<OrgDriver[]> {
  const organizationId = req.orgId as string;
  const dispatcherId = String(req.user?._id ?? "");
  const effectiveRole = String((req as any).orgRole ?? req.user?.role ?? "");
  const canAdminReviewReleaseRequests =
    req.user?.role === "super_admin" || ["admin", "super_admin"].includes(effectiveRole);

  if (users.length === 0) return [];

  const ids = users.map((u: any) => u._id);
  const driverEmails = users
    .map((u: any) => String(u.email ?? "").trim().toLowerCase())
    .filter(Boolean);

  const [profiles, loads, crmUsers, statusRequests, releaseRequests] = await Promise.all([
    // Only the fields the directory shows. Profiles also hold uploaded document
    // records and review data, which made this platform-wide list heavy.
    DriverProfile.find({ userId: { $in: ids } })
      .select(
        "userId operationalStatus maxVehicleCapacity trailerType truckMake truckModel isComplianceExpired licenseExpirationDate medicalCardExpirationDate insuranceExpirationDate profileCompletionScore availableDays serviceRadius preferredRoutes homeBase.city homeBase.state homeBase.zip",
      )
      .lean(),
    !includeActivity ? Promise.resolve([] as any[]) : Load.find({
      organizationId,
      assignedDriverId: { $in: ids },
      status: { $in: ACTIVE_LOAD_STATUSES },
    })
      .select(
        "assignedDriverId dispatchOwnerId loadNumber postType status pickupLocation deliveryLocation vehicles trailerType dates pricing additionalInfo assignmentMaterialFingerprint assignedAt updatedAt",
      )
      .sort({ createdAt: -1 })
      .lean(),
    // Fetch matching active CRM identities regardless of organization so we
    // can distinguish a valid same-org account, a legacy account that predates
    // organization linking, and an account that belongs to another org.
    CrmUser.find({
      isActive: true,
      email: { $in: driverEmails },
    })
      .select("_id email organizationId")
      .lean(),
    !includeActivity ? Promise.resolve([] as any[]) : DriverStatusChangeRequest.find({
      organizationId,
      driverId: { $in: ids },
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    })
      .sort({ createdAt: -1 })
      .lean(),
    !includeActivity ? Promise.resolve([] as any[]) : LoadReleaseRequest.find({
      organizationId,
      driverId: { $in: ids },
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  // Whether a driver can take new work uses their open Work Availability
  // requests in every organization: the same rule as the Assign button
  // (getDriverWorkEligibility), so the list never offers a driver it would refuse.
  const globalOpenRequests: any[] = await DriverStatusChangeRequest.find({
    driverId: { $in: ids },
    status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
  })
    .select("driverId priority status transitionGroupId")
    .lean();
  const blockedByAnyRequest = new Set(
    globalOpenRequests
      .filter((request) => isStatusRequestBlockingNewWork(request))
      .map((request) => String(request.driverId)),
  );

  const dispatchOwnerIds = [
    ...new Set(
      (loads as any[])
        .map((load) => String(load.dispatchOwnerId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const dispatchOwners: any[] = dispatchOwnerIds.length
    ? await User.find({
        _id: { $in: dispatchOwnerIds },
        role: { $in: ["employee", "admin", "super_admin"] },
        isActive: true,
      })
        .select("_id role organizationId dispatcherOrganizationIds")
        .lean()
    : [];
  const validDispatchOwnerIds = new Set(
    dispatchOwners
      .filter((owner) => {
        if (owner.role === "super_admin") return true;
        if (String(owner.organizationId ?? "") === organizationId) return true;
        return (
          owner.role === "employee" &&
          Array.isArray(owner.dispatcherOrganizationIds) &&
          owner.dispatcherOrganizationIds.some(
            (id: unknown) => String(id) === organizationId,
          )
        );
      })
      .map((owner) => String(owner._id)),
  );

  // Exact live GPS: the dispatcher responsible for an accepted active load,
  // and this organization's admins (business rule, 2026-09-30). Assigned-only
  // loads never grant location visibility. Live updates use the same rule
  // (driverLocationAccess.service).
  const viewerIsOrgAdmin = isOrganizationAdminFor(req.user as any, organizationId);
  const gpsVisibleDriverIds = [
    ...new Set(
      (loads as any[])
        .filter(
          (load) =>
            GPS_TRACKING_LOAD_STATUSES.includes(load.status as any) &&
            (viewerIsOrgAdmin || (dispatcherId && String(load.dispatchOwnerId ?? "") === dispatcherId)),
        )
        .map((load) => String(load.assignedDriverId ?? ""))
        .filter(Boolean),
    ),
  ];
  const locations = gpsVisibleDriverIds.length
    ? await DriverLocation.find({ userId: { $in: gpsVisibleDriverIds } })
        .select("userId status lastSeenAt locationRecordedAt accuracy coords isSharing")
        .lean()
    : [];

  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const statusRequestByUser = new Map<string, any>();
  for (const request of statusRequests as any[]) {
    const key = String(request.driverId);
    if (!statusRequestByUser.has(key)) statusRequestByUser.set(key, request);
  }
  const locationByUser = new Map(locations.map((l: any) => [String(l.userId), l]));
  const releaseRequestByLoadId = new Map<string, any>();
  for (const request of releaseRequests as any[]) {
    const key = String(request.loadId);
    if (!releaseRequestByLoadId.has(key)) releaseRequestByLoadId.set(key, request);
  }
  const crmUsersByEmail = new Map<string, any[]>();
  for (const crmUser of crmUsers as any[]) {
    const email = String(crmUser.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const current = crmUsersByEmail.get(email) ?? [];
    current.push(crmUser);
    crmUsersByEmail.set(email, current);
  }
  const loadsByUser = new Map<string, any[]>();

  for (const load of loads as any[]) {
    const key = String(load.assignedDriverId);
    const current = loadsByUser.get(key) ?? [];
    current.push(load);
    loadsByUser.set(key, current);
  }

  // Lazy finalization makes the status transition robust even if the final
  // load was delivered through a different controller. Driver Tracker polls
  // this directory, so an approved request becomes effective within the normal
  // tracker refresh cycle once all active loads are gone.
  for (const [driverId, request] of statusRequestByUser.entries()) {
    if (
      request.status === "approved_awaiting_reassignment" &&
      (loadsByUser.get(driverId)?.length ?? 0) === 0
    ) {
      const completed = await finalizeDriverStatusChangeIfClear(
        driverId,
        organizationId,
      );
      if (completed) {
        statusRequestByUser.delete(driverId);
        const profile: any = profileByUser.get(driverId);
        if (profile) profile.operationalStatus = completed.requestedStatus;
      }
    }
  }

  const now = Date.now();

  const drivers: OrgDriver[] = users.map((u: any): OrgDriver => {
    const key = String(u._id);
    const profile: any = profileByUser.get(key) ?? null;
    const location: any = locationByUser.get(key) ?? null;
    const driverLoads = loadsByUser.get(key) ?? [];
    const activeLoadCount = driverLoads.length;
    const canViewStatusRequestNotes = ["admin", "super_admin"].includes(String(req.user?.role ?? "")) ||
      driverLoads.some((load: any) => String(load.dispatchOwnerId ?? "") === dispatcherId);
    const normalizedEmail = String(u.email ?? "").trim().toLowerCase();
    const crmCandidates = crmUsersByEmail.get(normalizedEmail) ?? [];
    const crmUser: any =
      crmCandidates.find(
        (candidate: any) =>
          candidate.organizationId &&
          String(candidate.organizationId) === String(organizationId),
      ) ??
      crmCandidates.find((candidate: any) => !candidate.organizationId) ??
      null;
    const hasCrmAccountInAnotherOrganization =
      !crmUser && crmCandidates.length > 0;
    const usesLegacyCrmOrganizationLink =
      Boolean(crmUser) && !crmUser.organizationId;

    const maxCapacity: number | null =
      typeof profile?.maxVehicleCapacity === "number"
        ? profile.maxVehicleCapacity
        : null;
    const operationalStatus =
      (profile?.operationalStatus ?? "active") as
        | "active"
        | "on_leave"
        | "maintenance";
    const statusRequest: any = statusRequestByUser.get(key) ?? null;

    const lastSeenAt = location?.lastSeenAt ?? null;
    const locationRecordedAt = location?.locationRecordedAt ?? null;
    const freshnessTime = locationRecordedAt ?? lastSeenAt;
    const isStale =
      !freshnessTime || now - new Date(freshnessTime).getTime() > PRESENCE_STALE_MS;
    // GPS sharing is independent from Dispatch Status / Live Status.
    // Legacy rows may not have the new isSharing field yet, so fall back to
    // the previous status-based inference until the driver's next heartbeat.
    const persistedSharing =
      typeof location?.isSharing === "boolean"
        ? location.isSharing
        : location?.status !== "offline";
    const isSharing =
      Boolean(location?.coords) && !isStale && Boolean(persistedSharing);

    // Dispatch Status still owns the driver's Live Status presentation:
    // On Leave -> Offline, In Shop -> Waiting. GPS can be Sharing or
    // Not Sharing independently in either state.
    const liveStatus =
      operationalStatus === "on_leave"
        ? "offline"
        : operationalStatus === "maintenance"
          ? "waiting"
          : (location?.status ?? "offline");
    const requestBlocksNewWork = isStatusRequestBlockingNewWork(statusRequest);

    const warnings: string[] = [];
    if (!u.isActive) warnings.push("inactive_account");
    if (!profile) warnings.push("no_driver_profile");
    if (isComplianceExpiredAt(profile)) warnings.push("compliance_expired");
    const canViewExactGps = gpsVisibleDriverIds.includes(key);
    if (canViewExactGps && operationalStatus === "active" && !isSharing) warnings.push("offline_or_stale_location");
    if (operationalStatus === "on_leave") warnings.push("on_leave");
    if (operationalStatus === "maintenance") warnings.push("in_shop");
    if (requestBlocksNewWork) {
      warnings.push(
        statusRequest?.priority === "emergency"
          ? "emergency_release_active"
          : "status_change_awaiting_reassignment",
      );
    }
    if (usesLegacyCrmOrganizationLink) {
      warnings.push("legacy_supraspace_org_link");
    }
    if (hasCrmAccountInAnotherOrganization) {
      warnings.push("supraspace_account_other_organization");
    }

    return {
      id: key,
      name: u.name ?? "",
      email: u.email ?? "",
      avatar: u.avatar ?? null,
      isActive: Boolean(u.isActive),
      memberSince: u.createdAt ?? null,
      equipment: profile
        ? {
            trailerType: profile.trailerType ?? null,
            maxVehicleCapacity: maxCapacity,
            operationalStatus,
            truckMake: profile.truckMake ?? null,
            truckModel: profile.truckModel ?? null,
            isComplianceExpired: isComplianceExpiredAt(profile),
            profileCompletionScore: Number(profile.profileCompletionScore ?? 0),
          }
        : null,
      availability: {
        availableDays: Array.isArray(profile?.availableDays)
          ? profile.availableDays
          : [],
      },
      logistics: {
        serviceRadiusMiles:
          typeof profile?.serviceRadius === "number" && profile.serviceRadius > 0
            ? profile.serviceRadius
            : null,
        preferredRoutes: Array.isArray(profile?.preferredRoutes)
          ? profile.preferredRoutes
          : [],
        homeBase: {
          city: profile?.homeBase?.city ?? null,
          state: profile?.homeBase?.state ?? null,
          zip: profile?.homeBase?.zip ?? null,
          // Exact home-base coordinates are not needed by the directory UI.
          // Compatibility calculations stay server-side.
          coordinates: null,
        },
      },
      presence: {
        canViewExactGps,
        status: liveStatus,
        lastSeenAt,
        locationRecordedAt,
        accuracy: location?.accuracy ?? null,
        coords: location?.coords ?? null,
        isSharing,
      },
      shipments: driverLoads.map((load: any) => ({
        id: String(load._id),
        trackingNumber: load.loadNumber ?? String(load._id),
        status: load.status ?? "Assigned",
        origin: [load.pickupLocation?.city, load.pickupLocation?.state]
          .filter(Boolean)
          .join(", "),
        destination: [load.deliveryLocation?.city, load.deliveryLocation?.state]
          .filter(Boolean)
          .join(", "),
        vehicleCount: Array.isArray(load.vehicles) ? load.vehicles.length : 0,
        trailerType: load.trailerType ?? null,
        pickupDate:
          load.dates?.firstAvailable ?? load.dates?.pickupDeadline ?? null,
        pickupLocation: {
          // Street and place name place the stop on the Driver Tracker map.
          name: load.pickupLocation?.name || null,
          address: load.pickupLocation?.address || null,
          city: load.pickupLocation?.city ?? null,
          state: load.pickupLocation?.state ?? null,
          zip: load.pickupLocation?.zip ?? null,
          coordinates:
            load.pickupLocation?.coordinates &&
            typeof load.pickupLocation.coordinates === "object" &&
            !Array.isArray(load.pickupLocation.coordinates)
              ? {
                  lat: Number(load.pickupLocation.coordinates.lat),
                  lng: Number(
                    load.pickupLocation.coordinates.lng ??
                      load.pickupLocation.coordinates.lon,
                  ),
                }
              : null,
        },
        deliveryLocation: {
          name: load.deliveryLocation?.name || null,
          address: load.deliveryLocation?.address || null,
          city: load.deliveryLocation?.city ?? null,
          state: load.deliveryLocation?.state ?? null,
          zip: load.deliveryLocation?.zip ?? null,
          coordinates: stopCoordinates(load.deliveryLocation),
        },
        ...getAssignmentReviewState(load, validDispatchOwnerIds),
        releaseRequest: (() => {
          const request: any = releaseRequestByLoadId.get(String(load._id));
          if (!request) return null;
          const requestDispatcherId = String(request.dispatcherId ?? "").trim();
          const canViewRequest =
            canAdminReviewReleaseRequests ||
            Boolean(requestDispatcherId && requestDispatcherId === dispatcherId);
          if (!canViewRequest) return null;
          return {
            id: String(request._id),
            status: "pending" as const,
            priority: request.priority,
            reason: request.reason,
            message: request.message ?? null,
            requestedAt: request.requestedAt ?? request.createdAt ?? null,
            dispatcherId: requestDispatcherId || null,
          };
        })(),
      })),
      activeLoadCount,
      remainingCapacity: null,
      assignable:
        Boolean(u.isActive) &&
        operationalStatus === "active" &&
        !requestBlocksNewWork &&
        !blockedByAnyRequest.has(key),
      messagingAvailable: Boolean(crmUser),
      crmUserId: crmUser ? String(crmUser._id) : null,
      messagingUnavailableReason: crmUser
        ? null
        : hasCrmAccountInAnotherOrganization
          ? "An active Suprah Space account exists for this email, but it belongs to another organization."
          : "No active Suprah Space account is linked to this driver.",
      statusRequest: statusRequest
        ? {
            id: String(statusRequest._id),
            requestedStatus: statusRequest.requestedStatus,
            priority: statusRequest.priority,
            status: statusRequest.status,
            reason: canViewStatusRequestNotes ? statusRequest.reason ?? null : null,
            message: canViewStatusRequestNotes ? statusRequest.message ?? null : null,
            submittedAt: statusRequest.submittedAt ?? statusRequest.createdAt ?? null,
          }
        : null,
      warnings,
    };
  });


  return drivers;
}

function sortDirectoryEntries(drivers: OrgDriver[]) {
  drivers.sort((a, b) => {
    const attentionRank = (driver: OrgDriver) =>
      driver.statusRequest?.priority === "emergency"
        ? 0
        : driver.statusRequest?.status === "approved_awaiting_reassignment"
          ? 1
          : 2;
    const aAttention = attentionRank(a);
    const bAttention = attentionRank(b);
    if (aAttention !== bAttention) return aAttention - bAttention;

    if (a.assignable !== b.assignable) return a.assignable ? -1 : 1;
    const aOnline = a.presence.isSharing ? 0 : 1;
    const bOnline = b.presence.isSharing ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return a.name.localeCompare(b.name);
  });
  return drivers;
}

// The working set is reloaded every 30 seconds and after live events, by
// every open Driver Tracker. The platform-wide totals change rarely, so they
// are reused briefly instead of recounted each time.
const DIRECTORY_SUMMARY_TTL_MS = 15_000;
let directorySummaryCache: { at: number; value: Promise<Awaited<ReturnType<typeof countDirectorySummary>>> } | null = null;

/** Platform-wide driver totals, so paged views still show accurate counts. */
async function getDirectorySummary() {
  const now = Date.now();
  if (!directorySummaryCache || now - directorySummaryCache.at > DIRECTORY_SUMMARY_TTL_MS) {
    const value = countDirectorySummary();
    directorySummaryCache = { at: now, value };
    value.catch(() => {
      if (directorySummaryCache?.value === value) directorySummaryCache = null;
    });
  }
  return directorySummaryCache.value;
}

async function countDirectorySummary() {
  const activeDriverIds = await User.distinct("_id", { role: "driver", isActive: true });
  const [onLeave, inShop] = await Promise.all([
    DriverProfile.countDocuments({ userId: { $in: activeDriverIds }, operationalStatus: "on_leave" }),
    DriverProfile.countDocuments({ userId: { $in: activeDriverIds }, operationalStatus: "maintenance" }),
  ]);
  return {
    totalDrivers: activeDriverIds.length,
    active: Math.max(0, activeDriverIds.length - onLeave - inShop),
    onLeave,
    inShop,
  };
}

/**
 * GET /api/driver-tracking/org-drivers
 *
 * Without ?scope, every active driver on the platform is returned with this
 * organization's activity (unchanged behavior for existing callers). The
 * Driver Tracker uses the lighter scopes:
 *   scope=working    drivers with activity in this organization (active loads,
 *                    Work Availability requests, release requests, pending load
 *                    requests). Always complete. Includes platform totals.
 *   scope=directory  the shared driver pool, paged and searchable by name or
 *                    email (page, limit, search, status=all|active|on_leave|maintenance).
 *                    Identity and profile only.
 *   scope=assignable every driver who can currently take work (for the assign
 *                    and reassign pickers). Identity and profile only.
 *   scope=ids        specific drivers (ids=a,b,...), with activity.
 */
const getOrgDrivers = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  // The shared driver directory is live identity/availability data. Do not
  // reuse a stale browser copy after driver account, organization, or active
  // status changes.
  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0",
  );

  const includeInactive = req.query.includeInactive === "true";
  const scope = String(req.query.scope ?? "").trim();

  // Drivers are a shared platform-wide pool — every org's dispatchers see
  // the same driver directory, not just drivers who signed up under them.
  const userFilter: Record<string, unknown> = { role: "driver" };
  if (!includeInactive) userFilter.isActive = true;

  if (!scope) {
    const users: any[] = await User.find(userFilter).select(DIRECTORY_USER_FIELDS).lean();
    const drivers = sortDirectoryEntries(await buildDirectoryEntries(req, users, true));
    return res.status(200).json(
      new ApiResponse(200, { drivers, total: drivers.length }, "Org drivers fetched"),
    );
  }

  if (scope === "working") {
    const [loadDriverIds, statusRequestDriverIds, releaseDriverIds, loadRequestDriverIds] =
      await Promise.all([
        Load.distinct("assignedDriverId", {
          organizationId,
          assignedDriverId: { $ne: null },
          status: { $in: ACTIVE_LOAD_STATUSES },
        }),
        DriverStatusChangeRequest.distinct("driverId", {
          organizationId,
          status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
        }),
        LoadReleaseRequest.distinct("driverId", { organizationId, status: "pending" }),
        Load.distinct("driverRequests.driverId", {
          organizationId,
          assignedDriverId: null,
          status: "Posted",
        }),
      ]);
    const ids = [
      ...new Set(
        [...loadDriverIds, ...statusRequestDriverIds, ...releaseDriverIds, ...loadRequestDriverIds]
          .map((id: any) => String(id ?? ""))
          .filter(Boolean),
      ),
    ];
    const [users, summary] = await Promise.all([
      ids.length
        ? User.find({ ...userFilter, _id: { $in: ids } }).select(DIRECTORY_USER_FIELDS).lean()
        : Promise.resolve([] as any[]),
      getDirectorySummary(),
    ]);
    const drivers = sortDirectoryEntries(await buildDirectoryEntries(req, users as any[], true));
    return res.status(200).json(
      new ApiResponse(200, { drivers, total: drivers.length, summary }, "Driver Tracker working set fetched"),
    );
  }

  if (scope === "ids") {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .slice(0, DIRECTORY_MAX_IDS);
    const users: any[] = ids.length
      ? await User.find({ ...userFilter, _id: { $in: ids } }).select(DIRECTORY_USER_FIELDS).lean()
      : [];
    const drivers = sortDirectoryEntries(await buildDirectoryEntries(req, users, true));
    return res.status(200).json(
      new ApiResponse(200, { drivers, total: drivers.length }, "Drivers fetched"),
    );
  }

  if (scope === "assignable") {
    const users: any[] = await User.find({ ...userFilter, isActive: true })
      .select(DIRECTORY_USER_FIELDS)
      .sort({ name: 1, _id: 1 })
      .lean();
    const [entries, activeCounts] = await Promise.all([
      buildDirectoryEntries(req, users, false),
      // This organization's active loads per driver: one grouped query instead
      // of the full activity lookup.
      Load.aggregate([
        {
          $match: {
            organizationId,
            assignedDriverId: { $ne: null },
            status: { $in: ACTIVE_LOAD_STATUSES },
          },
        },
        { $group: { _id: "$assignedDriverId", count: { $sum: 1 } } },
      ]),
    ]);
    const activeCountByDriver = new Map(
      (activeCounts as any[]).map((row) => [String(row._id), Number(row.count) || 0]),
    );
    const drivers = entries
      .filter((driver) => driver.assignable)
      .map((driver) => ({ ...driver, activeLoadCount: activeCountByDriver.get(driver.id) ?? 0 }));
    return res.status(200).json(
      new ApiResponse(200, { drivers, total: drivers.length }, "Assignable drivers fetched"),
    );
  }

  if (scope === "directory") {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(
      DIRECTORY_MAX_PAGE_SIZE,
      Math.max(1, Number.parseInt(String(req.query.limit ?? DIRECTORY_PAGE_SIZE), 10) || DIRECTORY_PAGE_SIZE),
    );
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const status = String(req.query.status ?? "all");
    if (!["all", "active", "on_leave", "maintenance"].includes(status)) {
      throw new ApiError(400, "Choose All, Active, On Leave or In Shop to filter drivers.");
    }

    const filter: Record<string, unknown> = { ...userFilter };
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: pattern }, { email: pattern }];
    }
    const skip = (page - 1) * limit;

    let total: number;
    let users: any[];
    if (status === "all") {
      [total, users] = await Promise.all([
        User.countDocuments(filter),
        User.find(filter).select(DIRECTORY_USER_FIELDS).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(),
      ]);
    } else {
      // Work Availability lives on the driver profile; drivers without a
      // profile count as Active.
      const candidates: any[] = await User.find(filter).select("_id").sort({ name: 1, _id: 1 }).lean();
      const offDuty: any[] = await DriverProfile.find({
        userId: { $in: candidates.map((candidate) => candidate._id) },
        operationalStatus: { $in: ["on_leave", "maintenance"] },
      })
        .select("userId operationalStatus")
        .lean();
      const statusByUser = new Map(offDuty.map((profile) => [String(profile.userId), String(profile.operationalStatus)]));
      const matching = candidates.filter(
        (candidate) => (statusByUser.get(String(candidate._id)) ?? "active") === status,
      );
      total = matching.length;
      const pageIds = matching.slice(skip, skip + limit).map((candidate) => String(candidate._id));
      const pageUsers: any[] = pageIds.length
        ? await User.find({ _id: { $in: pageIds } }).select(DIRECTORY_USER_FIELDS).lean()
        : [];
      const byId = new Map(pageUsers.map((user) => [String(user._id), user]));
      users = pageIds.map((id) => byId.get(id)).filter(Boolean);
    }

    const drivers = await buildDirectoryEntries(req, users, false);
    return res.status(200).json(
      new ApiResponse(
        200,
        { drivers, total, page, limit, hasMore: skip + drivers.length < total },
        "Driver directory page fetched",
      ),
    );
  }

  throw new ApiError(400, "That driver list view isn't available. Refresh the page and try again.");
});

export default { getOrgDrivers };
