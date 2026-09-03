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
import activityService from "../services/activity.service";
import emailService from "../services/email.service";
import logger from "../utils/logger";
import config from "../config";
import {
  approveDriverVerification,
  evaluateDriverVerificationEligibility,
  listDriverReviewEvents,
  reviewDriverDocument,
} from "../services/driverVerificationReview.service";

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

const CREDENTIAL_FIELDS: Array<{ field: string; label: string }> = [
  { field: "licenseExpirationDate", label: "CDL" },
  { field: "medicalCardExpirationDate", label: "Medical Card" },
  { field: "insuranceExpirationDate", label: "Insurance" },
];

const getExpiringCompliance = asyncHandler(async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const horizon = new Date(Date.now() + days * 86400000);

  const profiles: any[] = await DriverProfile.find({
    $or: [
      ...CREDENTIAL_FIELDS.map(({ field }) => ({ [field]: { $ne: null, $lte: horizon } })),
      { "documents.expiresAt": { $ne: null, $lte: horizon } },
    ],
  })
    .populate("userId", "name email avatar")
    .select("userId documents licenseExpirationDate medicalCardExpirationDate insuranceExpirationDate")
    .lean();

  const now = Date.now();
  const items = profiles.flatMap((profile) => {
    const driverId = profile.userId?._id ? String(profile.userId._id) : String(profile.userId);
    const driverName = profile.userId?.name ?? "Unknown driver";

    const fromCredentials = CREDENTIAL_FIELDS.flatMap(({ field, label }) => {
      const value = profile[field];
      if (!value || new Date(value) > horizon) return [];
      return [{ kind: label, expiresAt: value }];
    });

    const fromDocuments = (Array.isArray(profile.documents) ? profile.documents : [])
      .filter((doc: any) => doc?.expiresAt && new Date(doc.expiresAt) <= horizon)
      .map((doc: any) => ({ kind: doc.label || doc.type, expiresAt: doc.expiresAt }));

    return [...fromCredentials, ...fromDocuments].map((entry) => {
      const daysRemaining = Math.ceil((new Date(entry.expiresAt).getTime() - now) / 86400000);
      return {
        driverId,
        driverName,
        kind: entry.kind,
        expiresAt: entry.expiresAt,
        daysRemaining,
        expired: daysRemaining < 0,
      };
    });
  });

  items.sort((a, b) => a.daysRemaining - b.daysRemaining);

  res.json(
    new ApiResponse(
      200,
      {
        items,
        total: items.length,
        expired: items.filter((item) => item.expired).length,
        windowDays: days,
      },
      "Expiring compliance fetched",
    ),
  );
});

const getDriverById = asyncHandler(async (req: Request, res: Response) => {
  const driverId = String(req.params.driverId || "").trim();
  const driverUser = await User.findOne({ _id: driverId, role: "driver" }).select("_id");
  if (!driverUser) throw new ApiError(404, "Driver not found");

  // A driver may not have created a DriverProfile yet (e.g. mid-application) —
  // vivify one so the existing Super Admin detail page preserves its current
  // full-profile shape. Private document bytes are no longer signed into this
  // JSON response; they are opened through an authenticated Review endpoint.
  let profile: any = await DriverProfile.findOne({ userId: driverId });
  if (!profile) {
    profile = await DriverProfile.create({ userId: driverId });
  }
  await profile.populate("userId", "name email avatar");

  const profileObj: any = profile.toJSON();
  profileObj.documents = (Array.isArray(profileObj.documents) ? profileObj.documents : []).map(
    (doc: any) => {
      const { fileUrl: _fileUrl, fileKey: _fileKey, ...safeDocument } = doc;
      const documentId = doc?._id ? String(doc._id) : "";
      return {
        ...safeDocument,
        fileAvailable: Boolean(doc?.fileKey || doc?.fileUrl),
        fileEndpoint: documentId
          ? `/api/driver-tracking/drivers/${encodeURIComponent(driverId)}/documents/${encodeURIComponent(documentId)}/file`
          : undefined,
      };
    },
  );

  const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
  const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
  const complianceSummary = {
    uploadedCount,
    totalRequired: REQUIRED_COMPLIANCE_DOCS.length,
    percentage: Math.round((uploadedCount / Math.max(REQUIRED_COMPLIANCE_DOCS.length, 1)) * 100),
    missingTypes: REQUIRED_COMPLIANCE_DOCS.filter(t => !uploadedTypes.has(t)),
  };

  const [driverRequest, reviewHistory] = await Promise.all([
    DriverRequest.findOne({ driverUserId: driverId }).sort({ createdAt: -1 }).lean(),
    listDriverReviewEvents(driverId),
  ]);
  const eligibility = evaluateDriverVerificationEligibility(profile);

  res.json(
    new ApiResponse(
      200,
      { ...profileObj, complianceSummary, driverRequest, eligibility, reviewHistory },
      "Driver profile fetched",
    ),
  );
});

const verifyDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId, documentId } = req.params;
  const { verified } = req.body;

  if (typeof verified !== "boolean") {
    throw new ApiError(400, "verified field must be a boolean");
  }

  const profile: any = await reviewDriverDocument({
    driverId,
    documentId,
    reviewer: user,
    organizationId: "global",
    decision: verified ? "approved" : "pending",
    expectedUploadedAt: req.body?.expectedUploadedAt,
  });
  const doc: any = profile.documents.find(
    (d: any) => d._id?.toString() === documentId,
  );

  try {
    await activityService.logComplianceActivity(
      driverId,
      undefined,
      "doc_verified",
      doc?.label || "Driver document",
      verified ? "Verified" : "Unverified",
    );
  } catch (error) {
    logger.error(
      { error, driverId, documentId },
      "Non-fatal: failed to write legacy document verification activity",
    );
  }

  res.json(new ApiResponse(200, profile, `Document ${verified ? "verified" : "unverified"}`));
  logger.info({ profileId: profile._id, driverId, documentId, verified }, "Document verification status changed");
});

const rejectDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId, documentId } = req.params;
  const reason = String(req.body?.reason || "").trim();

  if (reason.length < 3) {
    throw new ApiError(400, "A rejection reason is required (min 3 chars)");
  }

  const profile: any = await reviewDriverDocument({
    driverId,
    documentId,
    reviewer: user,
    organizationId: "global",
    decision: "rejected",
    reason,
    expectedUploadedAt: req.body?.expectedUploadedAt,
  });
  const doc: any = profile.documents.find(
    (d: any) => d._id?.toString() === documentId,
  );

  try {
    await activityService.createActivity({
      userId: driverId,
      organizationId: undefined,
      type: "other",
      title: "Document Rejected",
      description: `Document ${doc?.label || "Driver document"} was rejected: ${reason}`,
      metadata: { documentId, reason, adminId: user._id.toString() },
    });
  } catch (error) {
    logger.error(
      { error, driverId, documentId },
      "Non-fatal: failed to write legacy document rejection activity",
    );
  }

  res.json(new ApiResponse(200, profile, "Document rejected"));
  logger.warn({ profileId: profile._id, driverId, documentId, reason }, "Compliance document rejected");
});

const approveDriverProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { driverId } = req.params;

  const result = await approveDriverVerification({
    driverId,
    reviewer: user,
    organizationId: "global",
    expectedUpdatedAt: req.body?.expectedUpdatedAt,
  });

  try {
    await activityService.createActivity({
      userId: driverId,
      organizationId: undefined,
      type: "other",
      title: "Driver Profile Approved",
      description: `Driver profile was approved by admin ${user.name}`,
      metadata: { profileId: result.profile._id.toString(), approvedBy: user._id.toString() },
    });
  } catch (error) {
    logger.error(
      { error, driverId },
      "Non-fatal: failed to write legacy Driver Profile approval activity",
    );
  }

  logger.info({ profileId: result.profile._id, driverId, approvedBy: user._id }, "Driver profile approved by admin");
  res.json(new ApiResponse(200, result.profile, "Driver profile approved"));
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
  getExpiringCompliance,
  getDriverById,
  verifyDocument,
  rejectDocument,
  approveDriverProfile,
  generateDriverInviteLink,
  bulkGenerateDriverInviteLinks,
};