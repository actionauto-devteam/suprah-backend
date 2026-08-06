import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import User from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import Load from "../models/Load.model";

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

  const [profiles, locations, loads] = await Promise.all([
    DriverProfile.find({ userId: { $in: ids } }).lean(),
    DriverLocation.find({ userId: { $in: ids } })
      .select("userId status lastSeenAt coords")
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
  ]);

  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const locationByUser = new Map(locations.map((l: any) => [String(l.userId), l]));
  const loadsByUser = new Map<string, any[]>();

  for (const load of loads as any[]) {
    const key = String(load.assignedDriverId);
    const current = loadsByUser.get(key) ?? [];
    current.push(load);
    loadsByUser.set(key, current);
  }

  const now = Date.now();

  const drivers: OrgDriver[] = users.map((u: any): OrgDriver => {
    const key = String(u._id);
    const profile: any = profileByUser.get(key) ?? null;
    const location: any = locationByUser.get(key) ?? null;
    const driverLoads = loadsByUser.get(key) ?? [];
    const activeLoadCount = driverLoads.length;

    const maxCapacity: number | null =
      typeof profile?.maxVehicleCapacity === "number"
        ? profile.maxVehicleCapacity
        : null;

    const lastSeenAt = location?.lastSeenAt ?? null;
    const isStale =
      !lastSeenAt || now - new Date(lastSeenAt).getTime() > PRESENCE_STALE_MS;
    const isSharing = Boolean(location?.coords) && !isStale && location?.status !== "offline";

    const warnings: string[] = [];
    if (!u.isActive) warnings.push("inactive_account");
    if (!profile) warnings.push("no_driver_profile");
    if (profile?.isComplianceExpired) warnings.push("compliance_expired");
    if (maxCapacity != null && activeLoadCount >= maxCapacity) {
      warnings.push("at_capacity");
    }
    if (!isSharing) warnings.push("offline_or_stale_location");

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
            operationalStatus: profile.operationalStatus ?? null,
            truckMake: profile.truckMake ?? null,
            truckModel: profile.truckModel ?? null,
            isComplianceExpired: Boolean(profile.isComplianceExpired),
            profileCompletionScore: Number(profile.profileCompletionScore ?? 0),
          }
        : null,
      presence: {
        status: !isSharing ? "offline" : (location.status ?? "idle"),
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
      assignable: Boolean(u.isActive),
      warnings,
    };
  });

  drivers.sort((a, b) => {
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
