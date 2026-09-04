import crypto from "crypto";
import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import User, { IUser } from "../models/User.model";
import Organization from "../models/Organization.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverRequest from "../models/DriverRequest.model";
import Invitation from "../models/Invitation.model";
import Vehicle from "../models/Vehicle.model";
import UserActivity from "../models/UserActivity.model";
import Lead from "../models/lead.model";
import logger from "../utils/logger";

const dayKey = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

const buildSeries = (docs: Array<{ createdAt?: Date }>, days: number) => {
  const buckets = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    buckets.set(dayKey(new Date(Date.now() - offset * 86400000)), 0);
  }
  for (const doc of docs) {
    if (!doc.createdAt) continue;
    const key = dayKey(doc.createdAt);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return Array.from(buckets, ([date, count]) => ({ date, count }));
};

const pctChange = (current: number, previous: number) => {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 100);
};

const getPlatformAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
  const since = new Date(Date.now() - days * 86400000);
  const priorSince = new Date(Date.now() - days * 2 * 86400000);

  const [
    usersInWindow,
    usersPriorWindow,
    orgsInWindow,
    orgsPriorWindow,
    driverRequestsInWindow,
    tierRows,
    driverProfiles,
    totalDrivers,
    activeDrivers,
    topOrgs,
  ] = await Promise.all([
    User.find({ createdAt: { $gte: since } }).select("createdAt role").lean(),
    User.countDocuments({ createdAt: { $gte: priorSince, $lt: since } }),
    Organization.find({ createdAt: { $gte: since } }).select("createdAt").lean(),
    Organization.countDocuments({ createdAt: { $gte: priorSince, $lt: since } }),
    DriverRequest.find({ createdAt: { $gte: since } }).select("createdAt status").lean(),
    Organization.aggregate([
      { $group: { _id: "$subscription.tier", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    DriverProfile.find({}).select("verificationStatus documents operationalStatus").lean(),
    User.countDocuments({ role: "driver" }),
    User.countDocuments({ role: "driver", isActive: true }),
    Organization.aggregate([
      { $lookup: { from: "users", localField: "_id", foreignField: "organizationId", as: "members" } },
      { $project: { name: 1, memberCount: { $size: "$members" }, tier: "$subscription.tier" } },
      { $sort: { memberCount: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const applied = driverRequestsInWindow.length;
  const uploadedDocs = driverProfiles.filter((p: any) => (p.documents || []).length > 0).length;
  const underReview = driverProfiles.filter((p: any) =>
    ["pending", "in_progress", "under_review"].includes(String(p.verificationStatus)),
  ).length;
  const verified = driverProfiles.filter((p: any) => p.verificationStatus === "verified").length;

  res.json(
    new ApiResponse(
      200,
      {
        windowDays: days,
        signups: buildSeries(usersInWindow as any, days),
        driverApplications: buildSeries(driverRequestsInWindow as any, days),
        totals: {
          users: usersInWindow.length,
          organizations: orgsInWindow.length,
          driverApplications: applied,
        },
        deltas: {
          users: pctChange(usersInWindow.length, usersPriorWindow),
          organizations: pctChange(orgsInWindow.length, orgsPriorWindow),
        },
        driverFunnel: [
          { stage: "Applied", count: applied },
          { stage: "Documents uploaded", count: uploadedDocs },
          { stage: "Under review", count: underReview },
          { stage: "Verified", count: verified },
          { stage: "Active", count: activeDrivers },
        ],
        drivers: { total: totalDrivers, active: activeDrivers, verified },
        tiers: tierRows.map((row: any) => ({
          tier: row._id || "unassigned",
          count: row.count,
        })),
        topDealerships: topOrgs.map((org: any) => ({
          id: String(org._id),
          name: org.name,
          memberCount: org.memberCount,
          tier: org.tier || "unassigned",
        })),
      },
      "Platform analytics fetched",
    ),
  );
});

const inviteUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.user as IUser;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = String(req.body?.role || "member");
  const organizationId = String(req.body?.organizationId || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "A valid email address is required");
  }
  if (!["admin", "member", "customer"].includes(role)) {
    throw new ApiError(400, "Role must be admin, member or customer");
  }
  if (!organizationId) {
    throw new ApiError(400, "Select the dealership this user is joining");
  }

  const organization = await Organization.findById(organizationId).select("name");
  if (!organization) throw new ApiError(404, "Dealership not found");

  const existing = await User.findOne({ email, organizationId });
  if (existing) throw new ApiError(409, "That user already belongs to this dealership");

  const pending = await Invitation.findOne({ email, organizationId, status: "pending" });
  const expiresAt = new Date(Date.now() + 7 * 86400000);

  let token: string;
  if (pending) {
    token = pending.token;
    pending.expiresAt = expiresAt;
    pending.role = role as "admin" | "member" | "customer";
    await pending.save();
  } else {
    token = crypto.randomBytes(32).toString("hex");
    await Invitation.create({
      email,
      organizationId,
      inviterId: actor._id,
      role,
      token,
      expiresAt,
      status: "pending",
    });
  }

  logger.info({ actorId: actor._id, email, organizationId }, "Super admin sent a user invitation");

  res.status(201).json(
    new ApiResponse(
      201,
      {
        email,
        role,
        organization: organization.name,
        expiresAt,
        reused: Boolean(pending),
      },
      pending ? "Existing invitation refreshed" : "Invitation created",
    ),
  );
});

const getOrganizationDetail = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = String(req.params.id || "").trim();

  const organization: any = await Organization.findById(organizationId).lean();
  if (!organization) throw new ApiError(404, "Dealership not found");

  const [members, roleRows, vehicleCount, leadCount, pendingInvites] = await Promise.all([
    User.find({ organizationId })
      .select("name email role organizationRole isActive avatar createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    User.aggregate([
      { $match: { organizationId: organization._id } },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]),
    Vehicle.countDocuments({ organizationId }).catch(() => 0),
    Lead.countDocuments({ organizationId }).catch(() => 0),
    Invitation.countDocuments({ organizationId, status: "pending" }).catch(() => 0),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        organization: {
          id: String(organization._id),
          name: organization.name,
          slug: organization.slug,
          status: organization.status || "active",
          createdAt: organization.createdAt,
          subscription: organization.subscription || null,
          contactEmail: organization.contactEmail || organization.email || null,
          phone: organization.phone || null,
        },
        members: members.map((member: any) => ({
          id: String(member._id),
          name: member.name,
          email: member.email,
          role: member.role,
          organizationRole: member.organizationRole || null,
          isActive: Boolean(member.isActive),
          avatar: member.avatar || null,
          joinedAt: member.createdAt,
        })),
        counts: {
          members: members.length,
          vehicles: vehicleCount,
          leads: leadCount,
          pendingInvites,
          byRole: roleRows.map((row: any) => ({ role: row._id || "unknown", count: row.count })),
        },
      },
      "Dealership detail fetched",
    ),
  );
});

const getUserDetail = asyncHandler(async (req: Request, res: Response) => {
  const userId = String(req.params.id || "").trim();

  const user: any = await User.findById(userId)
    .select("name email role organizationRole isActive avatar createdAt lastLogin personalInfo onboardingCompleted")
    .populate("organizationId", "name slug status")
    .lean();
  if (!user) throw new ApiError(404, "User not found");

  const [recentActivity, driverProfile] = await Promise.all([
    UserActivity.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("type title description createdAt")
      .lean()
      .catch(() => []),
    user.role === "driver"
      ? DriverProfile.findOne({ userId })
          .select("verificationStatus operationalStatus profileCompletionScore isComplianceExpired documents")
          .lean()
      : Promise.resolve(null),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          organizationRole: user.organizationRole || null,
          isActive: Boolean(user.isActive),
          avatar: user.avatar || null,
          phone: user.personalInfo?.phone || null,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin || null,
          onboardingCompleted: Boolean(user.onboardingCompleted),
          organization: user.organizationId
            ? {
                id: String(user.organizationId._id),
                name: user.organizationId.name,
                slug: user.organizationId.slug,
                status: user.organizationId.status || "active",
              }
            : null,
        },
        driverProfile: driverProfile
          ? {
              verificationStatus: (driverProfile as any).verificationStatus,
              operationalStatus: (driverProfile as any).operationalStatus,
              profileCompletionScore: (driverProfile as any).profileCompletionScore ?? 0,
              isComplianceExpired: Boolean((driverProfile as any).isComplianceExpired),
              documentCount: ((driverProfile as any).documents || []).length,
            }
          : null,
        recentActivity: (recentActivity as any[]).map((entry) => ({
          id: String(entry._id),
          type: entry.type,
          title: entry.title,
          description: entry.description,
          createdAt: entry.createdAt,
        })),
      },
      "User detail fetched",
    ),
  );
});

export default { getPlatformAnalytics, inviteUser, getOrganizationDetail, getUserDetail };
