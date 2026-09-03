import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverProfile, {
  REQUIRED_COMPLIANCE_DOCS,
} from "../models/DriverProfile.model";
import { IUser } from "../models/User.model";
import type { ActivityType } from "../models/UserActivity.model";
import storageService, { BucketType } from "../services/storage.service";
import activityService from "../services/activity.service";
import logger from "../utils/logger";
import Load from "../models/Load.model";
import {
  ACTIVE_DRIVER_LOAD_STATUSES,
  applyDriverOperationalStatus,
  finalizeDriverStatusChangeIfClear,
  getOpenDriverStatusRequest,
} from "../services/driverStatusTransition.service";
import { recordDriverReviewEvent } from "../services/driverVerificationReview.service";

const getDriverUser = (req: Request): IUser => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") {
    throw new ApiError(403, "Only drivers can access this");
  }
  return user;
};

// A driver has exactly one profile — not org-owned, since drivers are a
// shared pool across every organization.
const getOrCreateProfile = async (userId: string) => {
  let profile = await DriverProfile.findOne({ userId });
  if (!profile) {
    profile = await DriverProfile.create({ userId });
  }
  return profile;
};

const parseOptionalDate = (
  value: unknown,
  label: string,
): Date | undefined => {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return undefined;
  }

  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError(400, `${label} must be a valid date`);
  }
  return parsed;
};


// Only fields that materially participate in identity/compliance verification
// are part of this snapshot. Ordinary operational Equipment fields (truck
// make/model, trailer type/capacity/features, engine, etc.) are deliberately
// excluded so routine dispatch configuration does not reopen verification.
const verificationCriticalSnapshot = (profile: any) => ({
  firstName: String(profile?.firstName ?? "").trim(),
  lastName: String(profile?.lastName ?? "").trim(),
  driversLicenseNumber: String(profile?.driversLicenseNumber ?? "").trim(),
  licenseState: String(profile?.licenseState ?? "").trim().toUpperCase(),
  licenseExpirationDate: profile?.licenseExpirationDate
    ? new Date(profile.licenseExpirationDate).toISOString()
    : "",
  medicalCardExpirationDate: profile?.medicalCardExpirationDate
    ? new Date(profile.medicalCardExpirationDate).toISOString()
    : "",
  insuranceExpirationDate: profile?.insuranceExpirationDate
    ? new Date(profile.insuranceExpirationDate).toISOString()
    : "",
  insuranceProvider: String(profile?.insuranceProvider ?? "").trim(),
  insurancePolicyNumber: String(profile?.insurancePolicyNumber ?? "").trim(),
  vin: String(profile?.vin ?? "").trim().toUpperCase(),
  plateNumber: String(profile?.plateNumber ?? "").trim().toUpperCase(),
  dotNumber: String(profile?.dotNumber ?? "").trim(),
  mcNumber: String(profile?.mcNumber ?? "").trim(),
  ssnLast4: String(profile?.ssnLast4 ?? "").trim(),
  backgroundCheckConsent: Boolean(profile?.backgroundCheckConsent),
});

const reopenVerifiedProfileWhenCriticalDataChanged = (
  profile: any,
  previousSnapshot: ReturnType<typeof verificationCriticalSnapshot>,
): string[] => {
  if (profile?.verificationStatus !== "verified") return [];

  const nextSnapshot = verificationCriticalSnapshot(profile);
  const changedFields = Object.keys(previousSnapshot).filter(
    (field) =>
      previousSnapshot[field as keyof typeof previousSnapshot] !==
      nextSnapshot[field as keyof typeof nextSnapshot],
  );

  if (changedFields.length > 0) {
    profile.verificationStatus = profile.verificationAgreement
      ? "under_review"
      : "in_progress";
  }

  return changedFields;
};

// Activity records are organization-scoped and ultimately expect a real
// MongoDB ObjectId. DriverProfile itself is intentionally global/shared, so
// the string "global" must never be passed into Activity persistence.
const normalizeActivityOrganizationId = (value: unknown): string | null => {
  const candidate = String(value ?? "").trim();
  return /^[a-fA-F0-9]{24}$/.test(candidate) ? candidate : null;
};

const getActivityOrganizationId = (
  user: IUser,
  profile?: { organizationId?: unknown } | null,
): string | null => {
  return (
    normalizeActivityOrganizationId(user.organizationId) ||
    normalizeActivityOrganizationId(profile?.organizationId)
  );
};

const safeCreateDriverProfileActivity = async ({
  user,
  profile,
  title,
  description,
  metadata,
}: {
  user: IUser;
  profile?: { organizationId?: unknown; _id?: unknown } | null;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}) => {
  const organizationId = getActivityOrganizationId(user, profile);

  if (!organizationId) {
    logger.debug(
      {
        userId: user._id?.toString(),
        profileId: profile?._id?.toString?.(),
        title,
      },
      "Skipping organization-scoped driver activity because no valid organization ObjectId is available",
    );
    return;
  }

  try {
    await activityService.createActivity({
      userId: user._id.toString(),
      organizationId,
      type: "other",
      title,
      description,
      metadata,
    });
  } catch (error) {
    // Profile/equipment/verification mutations are the authoritative action.
    // Activity logging is audit/support metadata and must not convert a
    // successful mutation into a failed API response.
    logger.error(
      {
        error,
        userId: user._id.toString(),
        organizationId,
        title,
      },
      "Non-fatal: failed to create Driver Profile activity",
    );
  }
};

const safeLogComplianceActivity = async ({
  user,
  profile,
  action,
  documentName,
  status,
}: {
  user: IUser;
  profile?: { organizationId?: unknown; _id?: unknown } | null;
  action: ActivityType;
  documentName: string;
  status: string;
}) => {
  const organizationId = getActivityOrganizationId(user, profile);

  if (!organizationId) {
    logger.debug(
      {
        userId: user._id?.toString(),
        profileId: profile?._id?.toString?.(),
        action,
        documentName,
      },
      "Skipping compliance activity because no valid organization ObjectId is available",
    );
    return;
  }

  try {
    await activityService.logComplianceActivity(
      user._id.toString(),
      organizationId,
      action,
      documentName,
      status,
    );
  } catch (error) {
    logger.error(
      {
        error,
        userId: user._id.toString(),
        organizationId,
        action,
        documentName,
      },
      "Non-fatal: failed to log Driver Profile compliance activity",
    );
  }
};

const getDriverDocumentById = (
  profile: any,
  documentId: string,
) =>
  profile.documents.find(
    (document: any) => document._id?.toString() === documentId,
  );

const getDriverDocumentStorageKey = (document: any): string => {
  const explicitKey = String(document?.fileKey || "").trim();
  if (explicitKey) return explicitKey;

  const rawUrl = String(document?.fileUrl || "").trim();
  if (!rawUrl) return "";

  return storageService.getKeyFromUrl(rawUrl) || rawUrl;
};

const getDocumentFile = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);
  const documentId = String(req.params.documentId || "").trim();

  if (!documentId) {
    throw new ApiError(400, "Document ID is required");
  }

  const profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    throw new ApiError(404, "Driver profile not found");
  }

  const document = getDriverDocumentById(profile, documentId);
  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  const storageKey = getDriverDocumentStorageKey(document);
  if (!storageKey) {
    throw new ApiError(404, "Document file is unavailable");
  }

  // Legacy records can contain a direct external URL without a private key.
  // Keep those readable, while all current private/local uploads are streamed
  // through this authenticated endpoint.
  if (/^https?:\/\//i.test(storageKey)) {
    return res.redirect(storageKey);
  }

  const file = await storageService.streamPrivateFile(storageKey);
  if (!file) {
    throw new ApiError(404, "Document file could not be opened");
  }

  const safeFileName = String(
    document.fileName || document.label || "driver-document",
  ).replace(/[\r\n"]/g, "_");

  // document.mimeType is authoritative here. This also fixes local-development
  // PDFs because storageService's local fallback historically inferred only
  // PNG/JPEG content types.
  res.setHeader(
    "Content-Type",
    document.mimeType || file.contentType || "application/octet-stream",
  );
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${safeFileName}"`,
  );
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  file.stream.on("error", (error) => {
    logger.error(
      {
        error,
        userId: user._id.toString(),
        documentId,
      },
      "Driver document stream failed",
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  file.stream.pipe(res);
});

const replaceDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);
  const documentId = String(req.params.documentId || "").trim();
  const file = req.file;

  if (!documentId) {
    throw new ApiError(400, "Document ID is required");
  }
  if (!file) {
    throw new ApiError(400, "No replacement file provided");
  }

  const profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    throw new ApiError(404, "Driver profile not found");
  }

  const document = getDriverDocumentById(profile, documentId);
  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  const type = String(document.type);
  const label = String(req.body?.label || document.label || "").trim();
  const expiresAt = req.body?.expiresAt;

  if (!label) {
    throw new ApiError(400, "Document label is required");
  }

  const needsExpiry = [
    "drivers_license",
    "medical_card",
    "insurance_certificate",
    "liability_insurance",
    "cargo_insurance",
  ];

  if (needsExpiry.includes(type) && !expiresAt) {
    throw new ApiError(
      400,
      `Expiration date is required for ${type.replace(/_/g, " ")}`,
    );
  }

  const parsedDocumentExpiration = expiresAt
    ? parseOptionalDate(expiresAt, "Document Expiration")
    : undefined;

  // Upload the new object first. Do not remove the currently working document
  // until the replacement metadata is safely committed to MongoDB.
  let newFileUrl: string;
  try {
    newFileUrl = await storageService.upload(
      file,
      "driver-documents",
      BucketType.PRIVATE,
      { allowLocalFallback: false },
    );
  } catch (error) {
    throw new ApiError(
      503,
      "Document storage is not configured. Contact an administrator before uploading driver documents.",
    );
  }
  const newFileKey =
    storageService.getKeyFromUrl(newFileUrl) || newFileUrl;
  const oldStorageKey = getDriverDocumentStorageKey(document);
  const previousReviewStatus = String(document.reviewStatus || "pending");

  document.label = label.substring(0, 100);
  document.fileUrl = newFileUrl;
  document.fileKey = newFileKey;
  document.fileName = file.originalname;
  document.fileSize = file.size;
  document.mimeType = file.mimetype;
  document.uploadedAt = new Date();
  document.expiresAt = parsedDocumentExpiration;
  document.verified = false;
  document.reviewStatus = "pending";
  document.verifiedBy = undefined;
  document.verifiedAt = undefined;
  document.rejectionReason = undefined;
  document.rejectedAt = undefined;

  // Document -> Information sync remains empty-only. A replacement must not
  // silently overwrite a different value already reviewed by the driver.
  if (parsedDocumentExpiration) {
    if (type === "drivers_license" && !profile.licenseExpirationDate) {
      profile.licenseExpirationDate = parsedDocumentExpiration;
    }
    if (type === "medical_card" && !profile.medicalCardExpirationDate) {
      profile.medicalCardExpirationDate = parsedDocumentExpiration;
    }
    if (
      type === "insurance_certificate" &&
      !profile.insuranceExpirationDate
    ) {
      profile.insuranceExpirationDate = parsedDocumentExpiration;
    }
  }

  // Replacing a required credential invalidates the previous document review.
  if (REQUIRED_COMPLIANCE_DOCS.includes(type)) {
    profile.verificationStatus = profile.verificationAgreement
      ? "under_review"
      : "in_progress";
  }

  try {
    await profile.save();
  } catch (error) {
    // MongoDB did not accept the replacement. Remove only the newly uploaded
    // object and leave the old file/metadata intact.
    await storageService
      .delete(newFileKey, BucketType.PRIVATE)
      .catch(() => {});
    throw error;
  }

  // The database now references the replacement, so old-file deletion is
  // best-effort and cannot make the successful replace request fail.
  if (oldStorageKey && oldStorageKey !== newFileKey) {
    await storageService
      .delete(oldStorageKey, BucketType.PRIVATE)
      .catch((error) => {
        logger.warn(
          { error, userId: user._id.toString(), documentId },
          "Non-fatal: previous driver document could not be deleted after replacement",
        );
      });
  }

  await safeLogComplianceActivity({
    user,
    profile,
    action: "compliance_uploaded",
    documentName: label,
    status: "Pending Review",
  });

  await recordDriverReviewEvent({
    driverId: user._id.toString(),
    actor: user,
    action: "document_replaced",
    targetType: "document",
    targetId: documentId,
    previousStatus: previousReviewStatus,
    newStatus: "pending",
    organizationId: user.organizationId?.toString?.(),
    metadata: { documentType: type, documentLabel: label },
  });

  res.json(new ApiResponse(200, profile, "Document replaced"));

  logger.info(
    {
      userId: user._id.toString(),
      profileId: profile._id.toString(),
      documentId,
      type,
    },
    "Driver compliance document replaced",
  );
});

const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);

  let profile = await getOrCreateProfile(user._id.toString());

  // Lazy finalization covers delivery flows that may complete outside the
  // Driver Tracking controller. Once the driver has zero active loads, an
  // approved transition becomes effective automatically.
  await finalizeDriverStatusChangeIfClear(user._id.toString(), "global");
  profile = (await DriverProfile.findOne({ userId: user._id })) || profile;

  const profileObj = profile.toJSON();
  if (profileObj.documents) {
    for (const doc of profileObj.documents) {
      if (doc.fileUrl && !doc.fileUrl.startsWith("http")) {
        const signed = await storageService.getSignedUrl(doc.fileUrl);
        if (signed) doc.fileUrl = signed;
      }
    }
  }

  const uploadedTypes = new Set(
    profile.documents.map((d: any) => d.type),
  );
  const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter((type) =>
    uploadedTypes.has(type),
  ).length;
  const complianceSummary = {
    uploadedCount,
    totalRequired: REQUIRED_COMPLIANCE_DOCS.length,
    percentage: Math.round(
      (uploadedCount / Math.max(REQUIRED_COMPLIANCE_DOCS.length, 1)) * 100,
    ),
    missingTypes: REQUIRED_COMPLIANCE_DOCS.filter(
      (type) => !uploadedTypes.has(type),
    ),
  };

  res.json(
    new ApiResponse(
      200,
      { ...profileObj, complianceSummary },
      "Driver profile fetched",
    ),
  );
});

const updateEquipment = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);
  const profile = await getOrCreateProfile(user._id.toString());
  const previousCriticalSnapshot = verificationCriticalSnapshot(profile);

  const {
    trailerType,
    maxVehicleCapacity,
    customTrailerName,
    truckMake,
    truckModel,
    truckYear,
    trailerLength,
    dotNumber,
    mcNumber,
    vin,
    plateNumber,
    truckColor,
    gvwr,
    trailerAxles,
    trailerGvwr,
    engineType,
    trailerMake,
    trailerModel,
    trailerYear,
    hitchType,
    specialFeatures,
  } = req.body;

  if (trailerType !== undefined) profile.trailerType = trailerType;
  if (maxVehicleCapacity !== undefined) {
    profile.maxVehicleCapacity = maxVehicleCapacity;
  }
  if (customTrailerName !== undefined) {
    profile.customTrailerName = customTrailerName;
  }
  if (truckMake !== undefined) profile.truckMake = truckMake;
  if (truckModel !== undefined) profile.truckModel = truckModel;
  if (truckYear !== undefined) profile.truckYear = truckYear;
  if (trailerLength !== undefined) profile.trailerLength = trailerLength;
  if (dotNumber !== undefined) profile.dotNumber = dotNumber;
  if (mcNumber !== undefined) profile.mcNumber = mcNumber;
  if (vin !== undefined) profile.vin = vin;
  if (plateNumber !== undefined) profile.plateNumber = plateNumber;
  if (truckColor !== undefined) profile.truckColor = truckColor;
  if (gvwr !== undefined) profile.gvwr = gvwr;
  if (trailerAxles !== undefined) profile.trailerAxles = trailerAxles;
  if (trailerGvwr !== undefined) profile.trailerGvwr = trailerGvwr;
  if (engineType !== undefined) profile.engineType = engineType;
  if (trailerMake !== undefined) profile.trailerMake = trailerMake;
  if (trailerModel !== undefined) profile.trailerModel = trailerModel;
  if (trailerYear !== undefined) profile.trailerYear = trailerYear;
  if (hitchType !== undefined) profile.hitchType = hitchType;
  if (specialFeatures !== undefined) profile.specialFeatures = specialFeatures;

  const changedVerificationFields = reopenVerifiedProfileWhenCriticalDataChanged(
    profile,
    previousCriticalSnapshot,
  );

  await profile.save();

  if (changedVerificationFields.length > 0) {
    await recordDriverReviewEvent({
      driverId: user._id.toString(),
      actor: user,
      action: "verification_reopened",
      targetType: "verification",
      targetId: profile._id.toString(),
      previousStatus: "verified",
      newStatus: String(profile.verificationStatus),
      organizationId: user.organizationId?.toString?.(),
      metadata: {
        source: "equipment",
        changedFields: changedVerificationFields,
      },
    });
  }

  res.json(new ApiResponse(200, profile, "Equipment updated"));

  logger.info(
    { profileId: profile._id, userId: user._id },
    "Equipment information updated",
  );

  await safeCreateDriverProfileActivity({
    user,
    profile,
    title: "Equipment Updated",
    description: `Driver ${user.name} updated equipment details`,
    metadata: { profileId: profile._id.toString(), trailerType },
  });
});

// Driver Verification information endpoint.
// This is the endpoint the frontend already expects at:
// PATCH /api/driver-profile/personal-info
const updatePersonalInfo = asyncHandler(
  async (req: Request, res: Response) => {
    const user = getDriverUser(req);
    const profile = await getOrCreateProfile(user._id.toString());
    const previousCriticalSnapshot = verificationCriticalSnapshot(profile);

    const {
      firstName,
      lastName,
      phone,
      address,
      city,
      state,
      zipCode,
      vehicleMake,
      vehicleModel,
      vehicleYear,
      vehicleVin,
      vehicleLicensePlate,
      driversLicenseNumber,
      licenseState,
      licenseExpirationDate,
      medicalCardExpirationDate,
      insuranceExpirationDate,
      insuranceProvider,
      insurancePolicyNumber,
      ssnLast4,
      backgroundCheckConsent,
    } = req.body ?? {};

    const normalized = {
      firstName: String(firstName ?? "").trim(),
      lastName: String(lastName ?? "").trim(),
      driversLicenseNumber: String(driversLicenseNumber ?? "").trim(),
      licenseState: String(licenseState ?? "").trim().toUpperCase(),
      licenseExpirationDate: String(licenseExpirationDate ?? "").trim(),
      insuranceProvider: String(insuranceProvider ?? "").trim(),
      insurancePolicyNumber: String(insurancePolicyNumber ?? "").trim(),
      vehicleVin: String(vehicleVin ?? "").trim().toUpperCase(),
      ssnLast4: String(ssnLast4 ?? "").replace(/\D/g, ""),
    };

    const missing: string[] = [];
    if (!normalized.firstName) missing.push("First Name");
    if (!normalized.lastName) missing.push("Last Name");
    if (!normalized.driversLicenseNumber) missing.push("CDL Number");
    if (!normalized.licenseState) missing.push("License State");
    if (!normalized.licenseExpirationDate) missing.push("CDL Expiration");
    if (!normalized.insuranceProvider) missing.push("Insurance Provider");
    if (!normalized.insurancePolicyNumber) missing.push("Policy Number");
    if (!normalized.vehicleVin) missing.push("VIN");
    if (normalized.ssnLast4.length !== 4) missing.push("SSN Last 4");
    if (backgroundCheckConsent !== true) {
      missing.push("Background Check Authorization");
    }

    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Complete the required Driver Verification information: ${missing.join(
          ", ",
        )}`,
      );
    }

    const parsedLicenseExpiration = new Date(
      normalized.licenseExpirationDate,
    );
    if (!Number.isFinite(parsedLicenseExpiration.getTime())) {
      throw new ApiError(400, "CDL Expiration must be a valid date");
    }

    const parsedVehicleYear =
      vehicleYear === undefined ||
      vehicleYear === null ||
      String(vehicleYear).trim() === ""
        ? undefined
        : Number(vehicleYear);

    if (
      parsedVehicleYear !== undefined &&
      (!Number.isInteger(parsedVehicleYear) ||
        parsedVehicleYear < 1950 ||
        parsedVehicleYear > 2100)
    ) {
      throw new ApiError(400, "Vehicle year must be between 1950 and 2100");
    }

    profile.firstName = normalized.firstName;
    profile.lastName = normalized.lastName;
    profile.phone = String(phone ?? "").trim() || undefined;
    profile.address = String(address ?? "").trim() || undefined;
    profile.city = String(city ?? "").trim() || undefined;
    profile.state = String(state ?? "").trim().toUpperCase() || undefined;
    profile.zipCode = String(zipCode ?? "").trim() || undefined;

    // Map the verification page's vehicle fields to the existing canonical
    // equipment fields. This avoids duplicate sources of truth.
    if (vehicleMake !== undefined) {
      profile.truckMake = String(vehicleMake ?? "").trim() || undefined;
    }
    if (vehicleModel !== undefined) {
      profile.truckModel = String(vehicleModel ?? "").trim() || undefined;
    }
    if (parsedVehicleYear !== undefined) {
      profile.truckYear = parsedVehicleYear;
    }
    profile.vin = normalized.vehicleVin;
    if (vehicleLicensePlate !== undefined) {
      profile.plateNumber =
        String(vehicleLicensePlate ?? "").trim().toUpperCase() || undefined;
    }

    profile.driversLicenseNumber = normalized.driversLicenseNumber;
    profile.licenseState = normalized.licenseState;
    profile.licenseExpirationDate = parsedLicenseExpiration;

    const parsedMedicalExpiration = parseOptionalDate(
      medicalCardExpirationDate,
      "Medical Card Expiration",
    );
    if (parsedMedicalExpiration !== undefined) {
      profile.medicalCardExpirationDate = parsedMedicalExpiration;
    }

    const parsedInsuranceExpiration = parseOptionalDate(
      insuranceExpirationDate,
      "Insurance Expiration",
    );
    if (parsedInsuranceExpiration !== undefined) {
      profile.insuranceExpirationDate = parsedInsuranceExpiration;
    }

    profile.insuranceProvider = normalized.insuranceProvider;
    profile.insurancePolicyNumber = normalized.insurancePolicyNumber;
    profile.ssnLast4 = normalized.ssnLast4;

    if (!profile.backgroundCheckConsent) {
      profile.backgroundCheckConsent = true;
      profile.backgroundCheckConsentDate = new Date();
    }

    // Saving Information starts the workflow. A verified profile is reopened
    // only below when verification-critical values actually changed.
    if (
      profile.verificationStatus === "unverified" ||
      profile.verificationStatus === "pending"
    ) {
      profile.verificationStatus = "in_progress";
    }

    const changedVerificationFields = reopenVerifiedProfileWhenCriticalDataChanged(
      profile,
      previousCriticalSnapshot,
    );

    await profile.save();

    if (changedVerificationFields.length > 0) {
      await recordDriverReviewEvent({
        driverId: user._id.toString(),
        actor: user,
        action: "verification_reopened",
        targetType: "verification",
        targetId: profile._id.toString(),
        previousStatus: "verified",
        newStatus: String(profile.verificationStatus),
        organizationId: user.organizationId?.toString?.(),
        metadata: {
          source: "information",
          changedFields: changedVerificationFields,
        },
      });
    }

    res.json(
      new ApiResponse(
        200,
        profile,
        "Driver verification information saved",
      ),
    );

    logger.info(
      { profileId: profile._id, userId: user._id },
      "Driver verification information updated",
    );

    await safeCreateDriverProfileActivity({
      user,
      profile,
      title: "Driver Verification Information Updated",
      description: `Driver ${user.name} updated verification information`,
      metadata: { profileId: profile._id.toString() },
    });
  },
);

const updateCompliance = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);
  const profile = await getOrCreateProfile(user._id.toString());
  const previousCriticalSnapshot = verificationCriticalSnapshot(profile);

  const {
    driversLicenseNumber,
    licenseState,
    licenseExpirationDate,
    medicalCardExpirationDate,
    insuranceExpirationDate,
    insuranceProvider,
    insurancePolicyNumber,
  } = req.body;

  if (driversLicenseNumber !== undefined) {
    profile.driversLicenseNumber = String(driversLicenseNumber).trim();
  }
  if (licenseState !== undefined) {
    profile.licenseState = String(licenseState).trim().toUpperCase();
  }

  const parsedLicenseExpiration = parseOptionalDate(
    licenseExpirationDate,
    "CDL Expiration",
  );
  if (parsedLicenseExpiration !== undefined) {
    profile.licenseExpirationDate = parsedLicenseExpiration;
  }

  const parsedMedicalExpiration = parseOptionalDate(
    medicalCardExpirationDate,
    "Medical Card Expiration",
  );
  if (parsedMedicalExpiration !== undefined) {
    profile.medicalCardExpirationDate = parsedMedicalExpiration;
  }

  const parsedInsuranceExpiration = parseOptionalDate(
    insuranceExpirationDate,
    "Insurance Expiration",
  );
  if (parsedInsuranceExpiration !== undefined) {
    profile.insuranceExpirationDate = parsedInsuranceExpiration;
  }

  if (insuranceProvider !== undefined) {
    profile.insuranceProvider = String(insuranceProvider).trim();
  }
  if (insurancePolicyNumber !== undefined) {
    profile.insurancePolicyNumber = String(insurancePolicyNumber).trim();
  }

  const changedVerificationFields = reopenVerifiedProfileWhenCriticalDataChanged(
    profile,
    previousCriticalSnapshot,
  );

  await profile.save();

  if (changedVerificationFields.length > 0) {
    await recordDriverReviewEvent({
      driverId: user._id.toString(),
      actor: user,
      action: "verification_reopened",
      targetType: "verification",
      targetId: profile._id.toString(),
      previousStatus: "verified",
      newStatus: String(profile.verificationStatus),
      organizationId: user.organizationId?.toString?.(),
      metadata: {
        source: "compliance",
        changedFields: changedVerificationFields,
      },
    });
  }

  res.json(new ApiResponse(200, profile, "Compliance updated"));

  logger.info(
    { profileId: profile._id, userId: user._id },
    "Compliance information updated",
  );

  await safeCreateDriverProfileActivity({
    user,
    profile,
    title: "Compliance Updated",
    description: `Driver ${user.name} updated license/insurance details`,
    metadata: { profileId: profile._id.toString(), licenseState },
  });
});

const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);

  const file = req.file;
  if (!file) throw new ApiError(400, "No file provided");

  const { type, label, expiresAt } = req.body;
  if (!type || !label) {
    throw new ApiError(400, "Document type and label are required");
  }

  const allowedTypes = [
    "drivers_license",
    "medical_card",
    "insurance_certificate",
    "vehicle_registration",
    "dot_inspection",
    "w9_form",
    "operating_authority",
    "cargo_insurance",
    "liability_insurance",
    "other",
  ];
  if (!allowedTypes.includes(type)) {
    throw new ApiError(400, "Invalid document type");
  }

  // Expiration is collected once at document upload for credentials that map
  // directly to Driver Verification Information. This removes duplicate data
  // entry later in the wizard.
  const needsExpiry = [
    "drivers_license",
    "medical_card",
    "insurance_certificate",
    "liability_insurance",
    "cargo_insurance",
  ];
  if (needsExpiry.includes(type) && !expiresAt) {
    throw new ApiError(
      400,
      `Expiration date is required for ${type.replace(/_/g, " ")}`,
    );
  }

  const profile = await getOrCreateProfile(user._id.toString());

  if (profile.documents.length >= 20) {
    throw new ApiError(400, "Maximum of 20 documents allowed");
  }

  let fileUrl: string;
  try {
    fileUrl = await storageService.upload(
      file,
      "driver-documents",
      BucketType.PRIVATE,
      { allowLocalFallback: false },
    );
  } catch (error) {
    throw new ApiError(
      503,
      "Document storage is not configured. Contact an administrator before uploading driver documents.",
    );
  }
  const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
  const parsedDocumentExpiration = expiresAt
    ? parseOptionalDate(expiresAt, "Document Expiration")
    : undefined;

  profile.documents.push({
    type,
    label: String(label).substring(0, 100),
    fileUrl,
    fileKey,
    fileName: file.originalname,
    fileSize: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date(),
    expiresAt: parsedDocumentExpiration,
    verified: false,
    reviewStatus: "pending",
  });

  // Documents -> Information synchronization.
  //
  // Only populate an EMPTY canonical field. If Information already contains a
  // different value, preserve it so the frontend can warn the driver instead
  // of silently changing previously entered/submitted data.
  if (parsedDocumentExpiration) {
    if (type === "drivers_license" && !profile.licenseExpirationDate) {
      profile.licenseExpirationDate = parsedDocumentExpiration;
    }

    if (type === "medical_card" && !profile.medicalCardExpirationDate) {
      profile.medicalCardExpirationDate = parsedDocumentExpiration;
    }

    if (
      type === "insurance_certificate" &&
      !profile.insuranceExpirationDate
    ) {
      profile.insuranceExpirationDate = parsedDocumentExpiration;
    }
  }

  if (
    profile.verificationStatus === "unverified" ||
    profile.verificationStatus === "pending"
  ) {
    profile.verificationStatus = "in_progress";
  }

  await profile.save();

  const uploadedDocument: any = profile.documents[profile.documents.length - 1];

  // The document is already uploaded and the DriverProfile is already saved at
  // this point. Activity logging must therefore be best-effort/non-fatal.
  await safeLogComplianceActivity({
    user,
    profile,
    action: "compliance_uploaded",
    documentName: String(label),
    status: "Pending Review",
  });

  await recordDriverReviewEvent({
    driverId: user._id.toString(),
    actor: user,
    action: "document_uploaded",
    targetType: "document",
    targetId: uploadedDocument?._id?.toString?.(),
    newStatus: "pending",
    organizationId: user.organizationId?.toString?.(),
    metadata: { documentType: type, documentLabel: String(label) },
  });

  res.json(new ApiResponse(200, profile, "Document uploaded"));

  logger.info(
    { profileId: profile._id, type, label },
    "Compliance document uploaded",
  );
});

const deleteDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);
  const { documentId } = req.params;

  if (!documentId) throw new ApiError(400, "Document ID is required");

  const profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const doc = getDriverDocumentById(profile, documentId);
  if (!doc) throw new ApiError(404, "Document not found");

  const documentStorageKey = getDriverDocumentStorageKey(doc);
  const deletedType = String(doc.type);
  const deletedLabel = String(doc.label || doc.fileName || deletedType);
  const deletedReviewStatus = String(doc.reviewStatus || "pending");

  // Commit metadata removal first. If MongoDB fails, the existing file remains
  // available instead of leaving a broken document record.
  profile.documents = profile.documents.filter(
    (item: any) => item._id?.toString() !== documentId,
  ) as any;

  const uploadedTypes = new Set(
    profile.documents.map((item: any) => item.type),
  );
  const hasAllRequired = REQUIRED_COMPLIANCE_DOCS.every((type) =>
    uploadedTypes.has(type),
  );

  // A verified driver cannot remain verified after removing a required
  // compliance credential.
  if (!hasAllRequired || REQUIRED_COMPLIANCE_DOCS.includes(deletedType)) {
    profile.verificationStatus = "in_progress";
  }

  await profile.save();

  if (documentStorageKey) {
    await storageService
      .delete(documentStorageKey, BucketType.PRIVATE)
      .catch((error) => {
        logger.warn(
          { error, userId: user._id.toString(), documentId },
          "Non-fatal: deleted driver document object could not be removed from storage",
        );
      });
  }

  res.json(new ApiResponse(200, profile, "Document deleted"));

  logger.warn(
    { profileId: profile._id, documentId },
    "Compliance document deleted",
  );

  await safeCreateDriverProfileActivity({
    user,
    profile,
    title: "Document Deleted",
    description: `Driver ${user.name} removed a compliance document`,
    metadata: { profileId: profile._id.toString(), documentId },
  });

  await recordDriverReviewEvent({
    driverId: user._id.toString(),
    actor: user,
    action: "document_deleted",
    targetType: "document",
    targetId: documentId,
    previousStatus: deletedReviewStatus,
    newStatus: "deleted",
    organizationId: user.organizationId?.toString?.(),
    metadata: { documentType: deletedType, documentLabel: deletedLabel },
  });
});

const updateLogistics = asyncHandler(async (req: Request, res: Response) => {
  const user = getDriverUser(req);

  let profile = await getOrCreateProfile(user._id.toString());
  await finalizeDriverStatusChangeIfClear(user._id.toString(), "global");
  profile = (await DriverProfile.findOne({ userId: user._id })) || profile;

  const {
    operationalStatus,
    homeBase,
    serviceRadius,
    preferredRoutes,
    availableDays,
  } = req.body;

  if (operationalStatus !== undefined) {
    const allowed = ["active", "on_leave", "maintenance"];
    if (!allowed.includes(String(operationalStatus))) {
      throw new ApiError(400, "Invalid Dispatch Status");
    }
  }

  if (serviceRadius !== undefined) profile.serviceRadius = serviceRadius;
  if (preferredRoutes !== undefined) profile.preferredRoutes = preferredRoutes;
  if (availableDays !== undefined) profile.availableDays = availableDays;
  if (homeBase !== undefined) {
    if (homeBase.address !== undefined) profile.homeBase.address = homeBase.address;
    if (homeBase.city !== undefined) profile.homeBase.city = homeBase.city;
    if (homeBase.state !== undefined) profile.homeBase.state = homeBase.state;
    if (homeBase.zip !== undefined) profile.homeBase.zip = homeBase.zip;
    if (homeBase.coordinates !== undefined) {
      profile.homeBase.coordinates = homeBase.coordinates;
      profile.homeBase.type = "Point";
    }
  }

  await profile.save();

  if (operationalStatus !== undefined) {
    const nextStatus = String(operationalStatus) as
      | "active"
      | "on_leave"
      | "maintenance";

    if (nextStatus !== profile.operationalStatus) {
      if (
        profile.operationalStatus === "active" &&
        nextStatus !== "active"
      ) {
        const openRequest = await getOpenDriverStatusRequest(
          user._id.toString(),
          "global",
        );
        if (openRequest) {
          throw new ApiError(
            409,
            "You already have an active Dispatch Status request. Wait for Dispatch or update that request instead of changing status directly.",
          );
        }

        const activeLoadCount = await Load.countDocuments({
          assignedDriverId: user._id,
          status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
        });

        if (activeLoadCount > 0) {
          throw new ApiError(
            409,
            `You currently have ${activeLoadCount} active load${
              activeLoadCount === 1 ? "" : "s"
            }. Submit a Dispatch Status request so Dispatch can review and reassign the affected loads.`,
          );
        }
      }

      profile = await applyDriverOperationalStatus({
        driverId: user._id.toString(),
        organizationId: "global",
        status: nextStatus,
      });
    }
  }

  res.json(new ApiResponse(200, profile, "Logistics updated"));

  logger.info(
    { profileId: profile._id, userId: user._id },
    "Logistics information updated",
  );

  await safeCreateDriverProfileActivity({
    user,
    profile,
    title: "Logistics Updated",
    description: `Driver ${user.name} updated service area/routes or Dispatch Status`,
    metadata: {
      profileId: profile._id.toString(),
      serviceRadius,
      operationalStatus: profile.operationalStatus,
    },
  });
});

const updateIdentityVerification = asyncHandler(
  async (req: Request, res: Response) => {
    const user = getDriverUser(req);
    const profile = await getOrCreateProfile(user._id.toString());
    const previousVerificationStatus = String(profile.verificationStatus || "unverified");

    const { ssnLast4, backgroundCheckConsent, verificationAgreement } =
      req.body ?? {};

    if (ssnLast4 !== undefined) {
      const cleaned = String(ssnLast4).replace(/\D/g, "");
      if (cleaned.length !== 4) {
        throw new ApiError(400, "SSN must be exactly 4 digits");
      }
      profile.ssnLast4 = cleaned;
    }

    if (
      backgroundCheckConsent === true &&
      !profile.backgroundCheckConsent
    ) {
      profile.backgroundCheckConsent = true;
      profile.backgroundCheckConsentDate = new Date();
    }

    const uploadedTypes = new Set(
      profile.documents.map((d: any) => d.type),
    );
    const allUploaded = REQUIRED_COMPLIANCE_DOCS.every((type) =>
      uploadedTypes.has(type),
    );
    // The Agreement action is the actual submission transition. Revalidate
    // all prerequisites on the server so the frontend cannot bypass them.
    if (verificationAgreement === true) {
      const missing: string[] = [];
      if (!profile.firstName?.trim()) missing.push("First Name");
      if (!profile.lastName?.trim()) missing.push("Last Name");
      if (!profile.driversLicenseNumber?.trim()) missing.push("CDL Number");
      if (!profile.licenseState?.trim()) missing.push("License State");
      if (!profile.licenseExpirationDate) missing.push("CDL Expiration");
      if (!profile.insuranceProvider?.trim()) {
        missing.push("Insurance Provider");
      }
      if (!profile.insurancePolicyNumber?.trim()) {
        missing.push("Policy Number");
      }
      if (!profile.vin?.trim()) missing.push("VIN");
      if (!profile.ssnLast4 || profile.ssnLast4.length !== 4) {
        missing.push("SSN Last 4");
      }
      if (!profile.backgroundCheckConsent) {
        missing.push("Background Check Authorization");
      }
      if (!allUploaded) missing.push("Required Documents");

      if (missing.length > 0) {
        throw new ApiError(
          400,
          `Driver Verification cannot be submitted yet. Complete: ${missing.join(
            ", ",
          )}`,
        );
      }

      if (!profile.verificationAgreement) {
        profile.verificationAgreement = true;
        profile.verificationAgreementDate = new Date();
      }
    }

    const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter((type) =>
      uploadedTypes.has(type),
    ).length;
    const complianceScore = Math.round(
      (uploadedCount / Math.max(REQUIRED_COMPLIANCE_DOCS.length, 1)) * 100,
    );

    if (
      profile.verificationAgreement &&
      allUploaded &&
      profile.ssnLast4 &&
      profile.backgroundCheckConsent
    ) {
      // Submission never self-verifies. Individual document review and final
      // approval are separate administrator actions enforced by the backend.
      profile.verificationStatus = "under_review";
    } else if (uploadedCount > 0 || profile.ssnLast4 || profile.firstName) {
      profile.verificationStatus = "in_progress";
    } else {
      profile.verificationStatus = "unverified";
    }

    profile.profileCompletionScore = complianceScore;

    await profile.save();

    res.json(
      new ApiResponse(
        200,
        profile,
        profile.verificationStatus === "under_review"
          ? "Driver verification submitted for admin review"
          : "Identity verification updated",
      ),
    );

    logger.info(
      { profileId: profile._id, userId: user._id },
      "Identity verification updated",
    );

    await safeCreateDriverProfileActivity({
      user,
      profile,
      title: "Identity Verification Update",
      description: `Driver ${user.name} updated identity verification`,
      metadata: {
        profileId: profile._id.toString(),
        status: profile.verificationStatus,
      },
    });

    if (
      verificationAgreement === true &&
      profile.verificationStatus === "under_review" &&
      previousVerificationStatus !== "under_review"
    ) {
      await recordDriverReviewEvent({
        driverId: user._id.toString(),
        actor: user,
        action: "verification_submitted",
        targetType: "verification",
        targetId: profile._id.toString(),
        previousStatus: previousVerificationStatus,
        newStatus: "under_review",
        organizationId: user.organizationId?.toString?.(),
      });
    }
  },
);

export default {
  getProfile,
  updateEquipment,
  updatePersonalInfo,
  updateCompliance,
  uploadDocument,
  getDocumentFile,
  replaceDocument,
  deleteDocument,
  updateLogistics,
  updateIdentityVerification,
};