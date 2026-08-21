import crypto from "crypto";
import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { IUser } from "../models/User.model";
import User from "../models/User.model";
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from "../models/DriverProfile.model";
import DriverRequest from "../models/DriverRequest.model";
import CustomerInviteToken from "../models/CustomerInviteToken.model";
import storageService from "../services/storage.service";
import activityService from "../services/activity.service";
import emailService from "../services/email.service";
import logger from "../utils/logger";
import config from "../config";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITE_COUNT = 50;
const MAX_BULK_EMAILS = 50;

function generateShortCode(): string {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

async function createDriverInviteToken(createdByUser: string, multiUse: boolean, expiresAt: Date) {
  let shortCode = generateShortCode();
  let attempts = 0;
  while ((await CustomerInviteToken.exists({ shortCode })) && attempts < 5) {
    shortCode = generateShortCode();
    attempts++;
  }

  await CustomerInviteToken.create({
    shortCode,
    createdByUser,
    expiresAt,
    multiUse,
    accountType: "driver",
  });

  return {
    shortCode,
    link: `${config.frontendUrl}/join/${shortCode}`,
    expiresAt,
    multiUse,
    accountType: "driver" as const,
  };
}

// Drivers are a shared platform-wide pool — this whole controller is
// super_admin-only (gated at the route level in admin.routes.ts), so none
// of these queries filter by organizationId.

const getAllDrivers = asyncHandler(async (req: Request, res: Response) => {
  const users = await User.find({ role: "driver" })
    .select("name email personalInfo.phone avatar isActive createdAt")
    .lean();

  if (users.length === 0) {
    return res
      .status(200)
      .json(new ApiResponse(200, { drivers: [], total: 0 }, "Drivers fetched"));
  }

  const ids = users.map((u: any) => u._id);

  const [profiles, requests] = await Promise.all([
    DriverProfile.find({ userId: { $in: ids } })
      .select("userId trailerType maxVehicleCapacity operationalStatus profileCompletionScore isComplianceExpired verificationStatus")
      .lean(),
    DriverRequest.find({ driverUserId: { $in: ids } })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const profileByUser = new Map(profiles.map((p: any) => [String(p.userId), p]));
  const requestByUser = new Map<string, any>();
  for (const request of requests as any[]) {
    const key = String(request.driverUserId);
    if (!requestByUser.has(key)) requestByUser.set(key, request);
  }

  const drivers = users.map((u: any) => {
    const key = String(u._id);
    const profile: any = profileByUser.get(key) ?? null;
    const request: any = requestByUser.get(key) ?? null;
    return {
      id: key,
      name: u.name ?? "",
      email: u.email ?? "",
      phone: u.personalInfo?.phone ?? "",
      avatar: u.avatar ?? null,
      isActive: Boolean(u.isActive),
      memberSince: u.createdAt ?? null,
      applicationStatus: request?.status ?? null,
      appliedAt: request?.createdAt ?? null,
      verificationStatus: profile?.verificationStatus ?? "not_started",
      profileCompletionScore: Number(profile?.profileCompletionScore ?? 0),
      isComplianceExpired: Boolean(profile?.isComplianceExpired),
    };
  });

  drivers.sort((a, b) => {
    const at = a.appliedAt ? new Date(a.appliedAt).getTime() : 0;
    const bt = b.appliedAt ? new Date(b.appliedAt).getTime() : 0;
    return bt - at;
  });

  res.json(new ApiResponse(200, { drivers, total: drivers.length }, "Drivers fetched"));
});

const getDriverById = asyncHandler(async (req: Request, res: Response) => {
  const driverUser = await User.findOne({ _id: req.params.driverId, role: "driver" }).select("_id");
  if (!driverUser) throw new ApiError(404, "Driver not found");

  // A driver may not have created a DriverProfile yet (e.g. mid-application) —
  // vivify one so the admin detail view always has a full profile shape,
  // matching the driver-self getOrCreateProfile behavior.
  let profile = await DriverProfile.findOne({ userId: req.params.driverId });
  if (!profile) {
    profile = await DriverProfile.create({ userId: req.params.driverId });
  }
  await profile.populate("userId", "name email avatar");

  const profileObj = profile.toJSON();
  if (profileObj.documents) {
    for (const doc of profileObj.documents) {
      if (doc.fileUrl && !doc.fileUrl.startsWith("http")) {
        const signed = await storageService.getSignedUrl(doc.fileUrl);
        if (signed) doc.fileUrl = signed;
      }
    }
  }

  const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
  const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
  const complianceSummary = {
    uploadedCount,
    totalRequired: REQUIRED_COMPLIANCE_DOCS.length,
    percentage: Math.round((uploadedCount / REQUIRED_COMPLIANCE_DOCS.length) * 100),
    missingTypes: REQUIRED_COMPLIANCE_DOCS.filter(t => !uploadedTypes.has(t)),
  };

  const driverRequest = await DriverRequest.findOne({ driverUserId: req.params.driverId })
    .sort({ createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, { ...profileObj, complianceSummary, driverRequest }, "Driver profile fetched"));
});

const verifyDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId, documentId } = req.params;
  const { verified } = req.body;

  if (typeof verified !== "boolean") {
    throw new ApiError(400, "verified field must be a boolean");
  }

  const profile = await DriverProfile.findOne({ userId: driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const doc = profile.documents.find(
    (d: any) => d._id?.toString() === documentId,
  );
  if (!doc) throw new ApiError(404, "Document not found");

  doc.verified = verified;
  if (verified) {
    doc.verifiedBy = user._id as any;
    doc.verifiedAt = new Date();
  } else {
    doc.verifiedBy = undefined;
    doc.verifiedAt = undefined;
  }

  await profile.save();

  await activityService.logComplianceActivity(
    driverId,
    "global",
    "doc_verified",
    doc.label,
    verified ? "Verified" : "Unverified",
  );

  res.json(new ApiResponse(200, profile, `Document ${verified ? "verified" : "unverified"}`));

  logger.info({ profileId: profile._id, driverId, documentId, verified }, "Document verification status changed");
});

const rejectDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId, documentId } = req.params;
  const { reason } = req.body;

  if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
    throw new ApiError(400, "A rejection reason is required (min 3 chars)");
  }

  const profile = await DriverProfile.findOne({ userId: driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const doc = profile.documents.find(
    (d: any) => d._id?.toString() === documentId,
  );
  if (!doc) throw new ApiError(404, "Document not found");

  doc.verified = false;
  doc.verifiedBy = undefined;
  doc.verifiedAt = undefined;
  doc.rejectionReason = reason.trim();
  doc.rejectedAt = new Date();
  (doc as any).reviewStatus = "rejected";

  await profile.save();

  await activityService.createActivity({
    userId: driverId,
    organizationId: "global",
    type: "other",
    title: "Document Rejected",
    description: `Document ${doc.label} was rejected: ${reason.trim()}`,
    metadata: { documentId, reason: reason.trim(), adminId: user._id.toString() },
  });

  res.json(new ApiResponse(200, profile, "Document rejected"));

  logger.warn({ profileId: profile._id, driverId, documentId, reason }, "Compliance document rejected");
});

const approveDriverProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId } = req.params;

  const profile = await DriverProfile.findOne({ userId: driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  profile.verificationStatus = "verified";
  await profile.save();

  await activityService.createActivity({
    userId: driverId,
    organizationId: "global",
    type: "other",
    title: "Driver Profile Approved",
    description: `Driver profile was approved by admin ${user.name}`,
    metadata: { profileId: profile._id.toString(), approvedBy: user._id.toString() },
  });

  logger.info({ profileId: profile._id, driverId, approvedBy: user._id }, "Driver profile approved by admin");

  res.json(new ApiResponse(200, profile, "Driver profile approved"));
});

/**
 * POST /api/admin/drivers/invite-link
 * super_admin only — generate driver sign-up invite link(s). Drivers are a
 * shared platform-wide pool, so these tokens carry no organizationId.
 * Body: { count?, multiUse? }
 */
const generateDriverInviteLink = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), MAX_INVITE_COUNT);
  const multiUse = req.body.multiUse === true || req.body.multiUse === "true";

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invites = [];

  for (let i = 0; i < count; i++) {
    invites.push(await createDriverInviteToken(user._id.toString(), multiUse, expiresAt));
  }

  res.json(new ApiResponse(201, { invites }, "Driver invite link(s) generated"));
});

/**
 * POST /api/admin/drivers/invite-link/bulk
 * super_admin only — generate one single-use driver invite link per email
 * and send it directly to that address. Each recipient still completes the
 * normal self-registration + approval flow — this only saves the super_admin
 * from generating and copy-pasting links one at a time.
 * Body: { emails: string[] }
 */
const bulkGenerateDriverInviteLinks = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { emails } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    throw new ApiError(400, "emails must be a non-empty array");
  }
  if (emails.length > MAX_BULK_EMAILS) {
    throw new ApiError(400, `Cannot send more than ${MAX_BULK_EMAILS} invites at once`);
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const results: { email: string; status: "sent" | "already_registered" | "error"; reason?: string }[] = [];

  for (const rawEmail of emails) {
    const email = String(rawEmail ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ email, status: "error", reason: "Invalid email format" });
      continue;
    }

    const existing = await User.findOne({ email });
    if (existing) {
      results.push({ email, status: "already_registered", reason: "An account with this email already exists" });
      continue;
    }

    try {
      const invite = await createDriverInviteToken(user._id.toString(), false, expiresAt);

      await emailService.sendEmail({
        to: email,
        subject: "You're invited to drive with SUPRAH.AI",
        text: `You've been invited to apply as a driver on SUPRAH.AI.\n\nClick the link below to get started:\n${invite.link}\n\nThis link expires in 24 hours and can only be used once.`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#111">You're invited to drive with SUPRAH.AI</h2>
            <p>Click the button below to create your driver account and submit your application.</p>
            <a href="${invite.link}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Apply now</a>
            <p style="color:#888;font-size:12px;margin-top:16px">This link expires in 24 hours and can only be used once.</p>
          </div>
        `,
      });

      results.push({ email, status: "sent" });
    } catch (err: any) {
      results.push({ email, status: "error", reason: err.message || "Unknown error" });
    }
  }

  const sent = results.filter(r => r.status === "sent").length;
  const skipped = results.filter(r => r.status === "already_registered").length;
  const failed = results.filter(r => r.status === "error").length;

  res.json(new ApiResponse(200, { results, sent, skipped, failed },
    `Done: ${sent} sent, ${skipped} skipped (already registered), ${failed} failed`));
});

export default {
  getAllDrivers,
  getDriverById,
  verifyDocument,
  rejectDocument,
  approveDriverProfile,
  generateDriverInviteLink,
  bulkGenerateDriverInviteLinks,
};
