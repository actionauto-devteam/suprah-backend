import DriverProfile, {
  REQUIRED_COMPLIANCE_DOCS,
} from "../models/DriverProfile.model";
import DriverRequest from "../models/DriverRequest.model";
import DriverReviewEvent from "../models/DriverReviewEvent.model";
import User from "../models/User.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import notificationService from "./notification.service";

export interface DriverVerificationEligibility {
  eligible: boolean;
  blockers: string[];
  checks: {
    informationComplete: boolean;
    requiredDocumentsApproved: boolean;
    agreementAccepted: boolean;
    credentialsCurrent: boolean;
  };
  requiredDocuments: Array<{
    type: string;
    status: "missing" | "pending" | "approved" | "rejected";
  }>;
}

const isExpired = (value: unknown) => {
  if (!value) return false;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) && time < Date.now();
};

const documentState = (document: any) => {
  if (!document) return "missing" as const;
  if (document.reviewStatus === "rejected") return "rejected" as const;
  if (document.verified || document.reviewStatus === "approved") {
    return "approved" as const;
  }
  return "pending" as const;
};

export function evaluateDriverVerificationEligibility(
  profile: any,
): DriverVerificationEligibility {
  const blockers: string[] = [];

  if (!["under_review", "verified"].includes(String(profile?.verificationStatus || ""))) {
    blockers.push("Driver Verification has not been submitted for admin review");
  }

  const requiredInformation = [
    ["First Name", profile?.firstName?.trim?.()],
    ["Last Name", profile?.lastName?.trim?.()],
    ["CDL Number", profile?.driversLicenseNumber?.trim?.()],
    ["License State", profile?.licenseState?.trim?.()],
    ["CDL Expiration", profile?.licenseExpirationDate],
    ["Insurance Provider", profile?.insuranceProvider?.trim?.()],
    ["Insurance Policy Number", profile?.insurancePolicyNumber?.trim?.()],
    ["VIN", profile?.vin?.trim?.()],
    ["SSN Last 4", String(profile?.ssnLast4 ?? "").length === 4],
    ["Background Check Authorization", profile?.backgroundCheckConsent === true],
  ] as Array<[string, unknown]>;

  for (const [label, value] of requiredInformation) {
    if (!value) blockers.push(`${label} is incomplete`);
  }

  const requiredDocuments = REQUIRED_COMPLIANCE_DOCS.map((type) => {
    const candidates = Array.isArray(profile?.documents)
      ? profile.documents.filter((document: any) => document?.type === type)
      : [];
    const approved = candidates.find(
      (document: any) => document?.verified || document?.reviewStatus === "approved",
    );
    const rejected = candidates.find(
      (document: any) => document?.reviewStatus === "rejected",
    );
    const document = approved || rejected || candidates[0];
    return { type, status: documentState(document) };
  });

  for (const document of requiredDocuments) {
    if (document.status === "missing") {
      blockers.push(`${document.type.replace(/_/g, " ")} is missing`);
    } else if (document.status === "pending") {
      blockers.push(`${document.type.replace(/_/g, " ")} is pending review`);
    } else if (document.status === "rejected") {
      blockers.push(`${document.type.replace(/_/g, " ")} requires correction`);
    }
  }

  if (profile?.verificationAgreement !== true) {
    blockers.push("Verification Agreement has not been accepted");
  }

  const credentialBlockers: string[] = [];
  if (isExpired(profile?.licenseExpirationDate)) {
    credentialBlockers.push("CDL is expired");
  }
  if (isExpired(profile?.medicalCardExpirationDate)) {
    credentialBlockers.push("Medical Card is expired");
  }
  if (isExpired(profile?.insuranceExpirationDate)) {
    credentialBlockers.push("Insurance is expired");
  }
  blockers.push(...credentialBlockers);

  const informationComplete = requiredInformation.every(([, value]) => Boolean(value));
  const requiredDocumentsApproved = requiredDocuments.every(
    (document) => document.status === "approved",
  );
  const agreementAccepted = profile?.verificationAgreement === true;
  const credentialsCurrent = credentialBlockers.length === 0;

  return {
    eligible: blockers.length === 0,
    blockers,
    checks: {
      informationComplete,
      requiredDocumentsApproved,
      agreementAccepted,
      credentialsCurrent,
    },
    requiredDocuments,
  };
}

export async function recordDriverReviewEvent(args: {
  driverId: string;
  actor?: any;
  action: string;
  targetType: "profile" | "document" | "access" | "verification";
  targetId?: string;
  previousStatus?: string;
  newStatus?: string;
  reason?: string;
  organizationId?: string | null;
  loadId?: string | null;
  loadNumber?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    const actorDispatcherOrganizations = Array.isArray(args.actor?.dispatcherOrganizationIds)
      ? args.actor.dispatcherOrganizationIds
      : [];
    const isScopedDispatcher = Boolean(
      args.organizationId &&
      actorDispatcherOrganizations.some(
        (organizationId: unknown) => String(organizationId) === String(args.organizationId),
      ),
    );

    await DriverReviewEvent.create({
      driverId: args.driverId,
      actorId: args.actor?._id,
      actorName: args.actor?.name || args.actor?.email || undefined,
      actorRole: isScopedDispatcher
        ? "dispatcher"
        : args.actor?.organizationRole || args.actor?.role || undefined,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      previousStatus: args.previousStatus,
      newStatus: args.newStatus,
      reason: args.reason,
      organizationId: args.organizationId || undefined,
      loadId: args.loadId || undefined,
      loadNumber: args.loadNumber || undefined,
      metadata: args.metadata,
    });
  } catch (error) {
    // The review action remains authoritative. Audit persistence is deliberately
    // isolated so a transient logging problem cannot corrupt verification state.
    logger.error(
      { error, driverId: args.driverId, action: args.action },
      "Non-fatal: failed to persist Driver Review event",
    );
  }
}

export async function listDriverReviewEvents(driverId: string, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 250));
  return DriverReviewEvent.find({ driverId })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean();
}

export async function reviewDriverDocument(args: {
  driverId: string;
  documentId: string;
  reviewer: any;
  organizationId?: string | null;
  decision: "approved" | "rejected" | "pending";
  reason?: string;
  expectedUploadedAt?: string | Date | null;
}) {
  const profile = await DriverProfile.findOne({ userId: args.driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const document: any = profile.documents.find(
    (item: any) => item._id?.toString() === args.documentId,
  );
  if (!document) throw new ApiError(404, "Document not found");

  if (args.decision !== "pending" && document.uploadedAt && !args.expectedUploadedAt) {
    throw new ApiError(
      409,
      "The document review snapshot is missing. Refresh the Driver Review Center before taking action.",
    );
  }

  if (args.expectedUploadedAt) {
    const expectedTime = new Date(args.expectedUploadedAt).getTime();
    const currentTime = document.uploadedAt
      ? new Date(document.uploadedAt).getTime()
      : Number.NaN;
    if (
      !Number.isFinite(expectedTime) ||
      !Number.isFinite(currentTime) ||
      expectedTime !== currentTime
    ) {
      throw new ApiError(
        409,
        "This document was replaced or changed while it was being reviewed. Refresh the Driver Review Center before taking action.",
      );
    }
  }

  const previousStatus = String(document.reviewStatus || "pending");
  const now = new Date();

  if (args.decision === "approved") {
    document.verified = true;
    document.reviewStatus = "approved";
    document.verifiedBy = args.reviewer._id as any;
    document.verifiedAt = now;
    document.rejectionReason = undefined;
    document.rejectedAt = undefined;
  } else if (args.decision === "rejected") {
    const reason = String(args.reason || "").trim();
    if (reason.length < 3) {
      throw new ApiError(400, "A rejection reason is required (min 3 chars)");
    }
    document.verified = false;
    document.reviewStatus = "rejected";
    document.verifiedBy = undefined;
    document.verifiedAt = undefined;
    document.rejectionReason = reason;
    document.rejectedAt = now;
  } else {
    document.verified = false;
    document.reviewStatus = "pending";
    document.verifiedBy = undefined;
    document.verifiedAt = undefined;
    document.rejectionReason = undefined;
    document.rejectedAt = undefined;
  }

  if (
    REQUIRED_COMPLIANCE_DOCS.includes(String(document.type)) &&
    profile.verificationStatus === "verified" &&
    args.decision !== "approved"
  ) {
    profile.verificationStatus = profile.verificationAgreement
      ? "under_review"
      : "in_progress";
  }

  await profile.save();

  await recordDriverReviewEvent({
    driverId: args.driverId,
    actor: args.reviewer,
    action:
      args.decision === "approved"
        ? "document_approved"
        : args.decision === "rejected"
          ? "document_rejected"
          : "document_review_reset",
    targetType: "document",
    targetId: args.documentId,
    previousStatus,
    newStatus: args.decision,
    reason: args.decision === "rejected" ? String(args.reason || "").trim() : undefined,
    organizationId: args.organizationId,
    metadata: {
      documentType: document.type,
      documentLabel: document.label,
    },
  });

  if (args.decision !== "pending") {
    try {
      await notificationService.createNotification({
        userId: args.driverId,
        organizationId: args.organizationId || "global",
        type:
          args.decision === "approved"
            ? "driver_document_verified"
            : "driver_document_rejected",
        title:
          args.decision === "approved" ? "Document Verified" : "Document Rejected",
        message:
          args.decision === "approved"
            ? `Your ${document.label} has been verified.`
            : `Your ${document.label} was rejected: ${args.reason}`,
        metadata: {
          documentId: args.documentId,
          documentType: document.type,
        },
      });
    } catch (error) {
      logger.error(
        { error, driverId: args.driverId, documentId: args.documentId },
        "Non-fatal: failed to send document review notification",
      );
    }
  }

  return profile;
}

export async function approveDriverVerification(args: {
  driverId: string;
  reviewer: any;
  organizationId?: string | null;
  expectedUpdatedAt?: string | Date | null;
}) {
  const profile: any = await DriverProfile.findOne({ userId: args.driverId });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const eligibility = evaluateDriverVerificationEligibility(profile);
  if (!eligibility.eligible) {
    const detail = eligibility.blockers.slice(0, 6).join("; ");
    throw new ApiError(
      409,
      `Final approval unavailable. ${eligibility.blockers.length} item${eligibility.blockers.length === 1 ? "" : "s"} require attention: ${detail}`,
    );
  }

  if (args.expectedUpdatedAt) {
    const expectedTime = new Date(args.expectedUpdatedAt).getTime();
    const currentTime = profile.updatedAt
      ? new Date(profile.updatedAt).getTime()
      : Number.NaN;
    if (
      !Number.isFinite(expectedTime) ||
      !Number.isFinite(currentTime) ||
      expectedTime !== currentTime
    ) {
      throw new ApiError(
        409,
        "Driver Verification changed while it was being reviewed. Refresh the Review Center before final approval.",
      );
    }
  }

  const previousStatus = String(profile.verificationStatus || "unverified");

  const driverUser: any = await User.findById(args.driverId);
  if (!driverUser) throw new ApiError(404, "Driver user not found");

  let driverRequest: any = await DriverRequest.findOne({
    driverUserId: args.driverId,
  }).sort({ createdAt: -1 });

  if (driverRequest?.status === "rejected") {
    throw new ApiError(
      409,
      "Final approval unavailable because the latest Driver Account application is rejected. A new pending application is required before verification can be approved.",
    );
  }

  // Protect final approval from a stale reviewer screen. Any concurrent profile
  // change updates updatedAt and forces the reviewer to refresh before approving.
  const approvedProfile: any = await DriverProfile.findOneAndUpdate(
    { _id: profile._id, updatedAt: profile.updatedAt },
    { $set: { verificationStatus: "verified" } },
    { new: true, runValidators: true },
  );

  if (!approvedProfile) {
    throw new ApiError(
      409,
      "Driver Verification changed while it was being reviewed. Refresh the Review Center and try again.",
    );
  }

  const previousUserState = {
    role: driverUser.role,
    isApproved: driverUser.isApproved,
    onboardingCompleted: driverUser.onboardingCompleted,
  };
  let userApprovalSaved = false;

  try {
    driverUser.role = "driver";
    driverUser.isApproved = true;
    driverUser.onboardingCompleted = true;
    await driverUser.save();
    userApprovalSaved = true;

    if (driverRequest?.status === "pending") {
      driverRequest.status = "approved";
      driverRequest.reviewedBy = args.reviewer._id as any;
      driverRequest.reviewedAt = new Date();
      await driverRequest.save();
    } else if (!driverRequest) {
      // Driver invite-link registration can legitimately reach verification
      // without a pre-existing DriverRequest. The driver dashboard still uses
      // DriverRequest as its account gate, so create the synchronized approved
      // record here rather than leaving a verified user stuck on /driver/pending.
      driverRequest = await DriverRequest.create({
        driverUserId: args.driverId,
        status: "approved",
        reviewedBy: args.reviewer._id as any,
        reviewedAt: new Date(),
      });
    }
  } catch (error) {
    // This deployment cannot assume Mongo transactions are available. Use a
    // narrow compensating rollback so a secondary account/request write does
    // not leave DriverProfile verified by itself.
    await DriverProfile.updateOne(
      { _id: approvedProfile._id, verificationStatus: "verified" },
      { $set: { verificationStatus: previousStatus } },
    ).catch(() => {});

    if (userApprovalSaved) {
      await User.findByIdAndUpdate(args.driverId, {
        $set: previousUserState,
      }).catch(() => {});
    }

    throw error;
  }

  await recordDriverReviewEvent({
    driverId: args.driverId,
    actor: args.reviewer,
    action: "final_verification_approved",
    targetType: "verification",
    targetId: String(approvedProfile._id),
    previousStatus,
    newStatus: "verified",
    organizationId: args.organizationId,
    metadata: {
      driverRequestId: driverRequest?._id?.toString?.(),
    },
  });

  try {
    await notificationService.createNotification({
      userId: args.driverId,
      organizationId: args.organizationId || "global",
      type: "driver_profile_approved",
      title: "Driver Profile Approved",
      message: "Your driver verification has been fully approved.",
      metadata: {
        driverProfileId: String(approvedProfile._id),
      },
    });
  } catch (error) {
    logger.error(
      { error, driverId: args.driverId },
      "Non-fatal: failed to send driver profile approval notification",
    );
  }

  return {
    profile: approvedProfile,
    request: driverRequest,
    eligibility,
  };
}