import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import User from "../models/User.model";
import CrmUser from "../models/CrmUser.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import Load from "../models/Load.model";
import DriverStatusChangeRequest from "../models/DriverStatusChangeRequest.model";
import {
  finalizeDriverStatusChangeIfClear,
  isStatusRequestBlockingNewWork,
  OPEN_DRIVER_STATUS_REQUEST_STATES,
} from "../services/driverStatusTransition.service";

const PRESENCE_STALE_MS = 5 * 60 * 1000;
const ACTIVE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"];

interface OrgDriver {
  id: string;
  name: string;
  email: string;
  phone: string;
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
  presence: {
    status: string;
    lastSeenAt: Date | null;
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
  }>;
  activeLoadCount: number;
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

/**
 * GET /api/driver-tracking/org-drivers
 *
 * Organization-wide driver directory. Every active driver account is returned,
 * even when the driver has never shared a location or has no DriverProfile yet.
 */
const getOrgDrivers = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const includeInactive = req.query.includeInactive === "true";

  const userFilter: Record<string, unknown> = { organizationId, role: "driver" };
  if (!includeInactive) userFilter.isActive = true;

  const users: any[] = await User.find(userFilter)
    .select("name email personalInfo.phone avatar isActive createdAt")
    .lean();

  if (users.length === 0) {
    return res
      .status(200)
      .json(new ApiResponse(200, { drivers: [], total: 0 }, "Org drivers fetched"));
  }

  const ids = users.map((u: any) => u._id);
  const driverEmails = users
    .map((u: any) => String(u.email ?? "").trim().toLowerCase())
    .filter(Boolean);

  const [profiles, locations, loads, crmUsers, statusRequests] = await Promise.all([
    DriverProfile.find({ userId: { $in: ids } }).lean(),
    DriverLocation.find({ userId: { $in: ids } })
      .select("userId status lastSeenAt coords isSharing")
      .lean(),
    Load.find({
      organizationId,
      assignedDriverId: { $in: ids },
      status: { $in: ACTIVE_LOAD_STATUSES },
    })
      .select(
        "assignedDriverId loadNumber status pickupLocation deliveryLocation vehicles trailerType",
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
    DriverStatusChangeRequest.find({
      organizationId,
      driverId: { $in: ids },
      status: { $in: OPEN_DRIVER_STATUS_REQUEST_STATES },
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const statusRequestByUser = new Map<string, any>();
  for (const request of statusRequests as any[]) {
    const key = String(request.driverId);
    if (!statusRequestByUser.has(key)) statusRequestByUser.set(key, request);
  }
  const locationByUser = new Map(locations.map((l: any) => [String(l.userId), l]));
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
    const isStale =
      !lastSeenAt || now - new Date(lastSeenAt).getTime() > PRESENCE_STALE_MS;
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
          : isSharing
            ? (location?.status ?? "idle")
            : "offline";
    const requestBlocksNewWork = isStatusRequestBlockingNewWork(statusRequest);

    const warnings: string[] = [];
    if (!u.isActive) warnings.push("inactive_account");
    if (!profile) warnings.push("no_driver_profile");
    if (profile?.isComplianceExpired) warnings.push("compliance_expired");
    if (maxCapacity != null && activeLoadCount >= maxCapacity) {
      warnings.push("at_capacity");
    }
    if (operationalStatus === "active" && !isSharing) warnings.push("offline_or_stale_location");
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
      phone: u.personalInfo?.phone ?? "",
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
            isComplianceExpired: Boolean(profile.isComplianceExpired),
            profileCompletionScore: Number(profile.profileCompletionScore ?? 0),
          }
        : null,
      presence: {
        status: liveStatus,
        lastSeenAt,
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
      })),
      activeLoadCount,
      remainingCapacity:
        maxCapacity != null ? Math.max(0, maxCapacity - activeLoadCount) : null,
      assignable:
        Boolean(u.isActive) &&
        operationalStatus === "active" &&
        !requestBlocksNewWork,
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
            reason: statusRequest.reason ?? null,
            message: statusRequest.message ?? null,
            submittedAt: statusRequest.submittedAt ?? statusRequest.createdAt ?? null,
          }
        : null,
      warnings,
    };
  });

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

  return res.status(200).json(
    new ApiResponse(
      200,
      { drivers, total: drivers.length },
      "Org drivers fetched",
    ),
  );
});

export default { getOrgDrivers };