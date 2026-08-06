import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import User from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import Load from "../models/Load.model";

// ─── Centralized Driver Directory ─────────────────────────────────────────────
// GET /api/driver-tracking/org-drivers
//
// THE single source of truth for "who are the drivers in this organization".
// Consumed by: Create Load's Assign Driver picker, Driver Tracker, the
// Transportation page, and any assign/reassign modal. It merges three
// collections into one unified profile per driver:
//
//   User           → identity (name, email, phone, avatar, active flag)
//   DriverProfile  → equipment, capacity, compliance (Driver's Account data)
//   DriverLocation → live presence (status, last seen, coordinates)
//
// BUSINESS RULE: every driver in the org appears in this list unless they are
// deactivated (User.isActive === false). Nothing else hides a driver.
// Compliance problems, missing profiles, being at capacity, or being offline
// are returned as ADVISORY warnings so the UI can inform the dispatcher —
// the dispatcher decides, the system doesn't silently filter.
//
// Pass ?includeInactive=true to also list deactivated drivers (flagged).

const PRESENCE_STALE_MS = 5 * 60 * 1000; // matches Driver Tracker's staleness window

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
  } | null;
  presence: {
    status: string;
    lastSeenAt: Date | null;
    coords: unknown;
  };
  activeLoadCount: number;
  remainingCapacity: number | null;
  assignable: boolean;
  warnings: string[];
}

const getOrgDrivers = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const includeInactive = req.query.includeInactive === "true";

  const userFilter: Record<string, unknown> = { organizationId, role: "driver" };
  if (!includeInactive) userFilter.isActive = true;

  const users: any[] = await User.find(userFilter)
    .select("name email phone avatar isActive createdAt")
    .lean();

  if (users.length === 0) {
    return res
      .status(200)
      .json(new ApiResponse(200, { drivers: [], total: 0 }, "Org drivers fetched"));
  }

  const ids = users.map((u: any) => u._id);

  const [profiles, locations, loadAgg] = await Promise.all([
    DriverProfile.find({ userId: { $in: ids } }).lean(),
    DriverLocation.find({ userId: { $in: ids } })
      .select("userId status lastSeenAt coords")
      .lean(),
    Load.aggregate([
      {
        $match: {
          organizationId,
          assignedDriverId: { $in: ids },
          status: { $nin: ["Delivered", "Cancelled"] },
        },
      },
      { $group: { _id: "$assignedDriverId", count: { $sum: 1 } } },
    ]),
  ]);

  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const locationByUser = new Map(locations.map((l: any) => [String(l.userId), l]));
  const activeLoadsByUser = new Map(
    loadAgg.map((row: any) => [String(row._id), row.count as number]),
  );

  const now = Date.now();

  const drivers: OrgDriver[] = users.map((u: any): OrgDriver => {
    const key = String(u._id);
    const profile: any = profileByUser.get(key) ?? null;
    const location: any = locationByUser.get(key) ?? null;
    const activeLoadCount = Number(activeLoadsByUser.get(key) ?? 0);

    const maxCapacity: number | null =
      typeof profile?.maxVehicleCapacity === "number"
        ? profile.maxVehicleCapacity
        : null;

    const lastSeenAt = location?.lastSeenAt ?? null;
    const isStale =
      !lastSeenAt || now - new Date(lastSeenAt).getTime() > PRESENCE_STALE_MS;

    // Advisory warnings — informative, never exclusionary
    const warnings: string[] = [];
    if (!u.isActive) warnings.push("inactive_account");
    if (!profile) warnings.push("no_driver_profile");
    if (profile?.isComplianceExpired) warnings.push("compliance_expired");
    if (maxCapacity != null && activeLoadCount >= maxCapacity)
      warnings.push("at_capacity");
    if (isStale) warnings.push("offline_or_stale_location");

    return {
      id: key,
      // Identity — always from the User record (Driver's Account is the
      // source of truth; edits there propagate everywhere automatically)
      name: u.name ?? "",
      email: u.email ?? "",
      phone: u.phone ?? "",
      avatar: u.avatar ?? null,
      isActive: Boolean(u.isActive),
      memberSince: u.createdAt ?? null,
      // Equipment — from the driver's own profile, null if not set up yet
      equipment: profile
        ? {
            trailerType: profile.trailerType ?? null,
            maxVehicleCapacity: maxCapacity,
            operationalStatus: profile.operationalStatus ?? null,
            truckMake: profile.truckMake ?? null,
            truckModel: profile.truckModel ?? null,
            isComplianceExpired: Boolean(profile.isComplianceExpired),
          }
        : null,
      // Live presence — from the tracker, offline default when never seen
      presence: {
        status: !location || isStale ? "offline" : (location.status ?? "idle"),
        lastSeenAt,
        coords: location?.coords ?? null,
      },
      // Workload
      activeLoadCount,
      remainingCapacity:
        maxCapacity != null ? Math.max(0, maxCapacity - activeLoadCount) : null,
      // The only hard eligibility gate is account status; everything else
      // is the dispatcher's call, surfaced through warnings.
      assignable: Boolean(u.isActive),
      warnings,
    };
  });

  // Stable, useful default order: assignable first, then online before
  // offline, then by name — the UI can re-sort freely.
  drivers.sort((a: OrgDriver, b: OrgDriver) => {
    if (a.assignable !== b.assignable) return a.assignable ? -1 : 1;
    const aOnline = a.presence.status !== "offline" ? 0 : 1;
    const bOnline = b.presence.status !== "offline" ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return a.name.localeCompare(b.name);
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { drivers, total: drivers.length },
        "Org drivers fetched",
      ),
    );
});

export default { getOrgDrivers };