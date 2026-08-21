import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from "../models/DriverProfile.model";
import { IUser } from "../models/User.model";
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

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  return user._id.toString();
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

const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  let profile = await getOrCreateProfile(user._id.toString());

  // Lazy finalization covers delivery flows that may complete outside the
  // Driver Tracking controller. Once the driver has zero active loads, an
  // approved transition becomes effective automatically.
  await finalizeDriverStatusChangeIfClear(user._id.toString(), "global");
  profile = (await DriverProfile.findOne({ userId: user._id })) || profile;

  const profileObj = profile.toJSON();
  if (profileObj.documents) {
    for (const doc of profileObj.documents) {
      if (doc.fileUrl && !doc.fileUrl.startsWith('http')) {
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
    missingTypes: REQUIRED_COMPLIANCE_DOCS.filter(t => !uploadedTypes.has(t))
  };

  res.json(new ApiResponse(200, { ...profileObj, complianceSummary }, "Driver profile fetched"));
});

const updateEquipment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const profile = await getOrCreateProfile(user._id.toString());

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
  if (maxVehicleCapacity !== undefined) profile.maxVehicleCapacity = maxVehicleCapacity;
  if (customTrailerName !== undefined) profile.customTrailerName = customTrailerName;
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

  await profile.save();

  res.json(new ApiResponse(200, profile, "Equipment updated"));

  logger.info({ profileId: profile._id, userId: user._id }, 'Equipment information updated');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: 'global',
    type: 'other',
    title: 'Equipment Updated',
    description: `Driver ${user.name} updated equipment details`,
    metadata: { profileId: profile._id.toString(), trailerType }
  });
});

const updateCompliance = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const profile = await getOrCreateProfile(user._id.toString());

  const {
    driversLicenseNumber,
    licenseState,
    licenseExpirationDate,
    medicalCardExpirationDate,
    insuranceExpirationDate,
    insuranceProvider,
    insurancePolicyNumber,
  } = req.body;

  if (driversLicenseNumber !== undefined) profile.driversLicenseNumber = driversLicenseNumber;
  if (licenseState !== undefined) profile.licenseState = licenseState;
  if (licenseExpirationDate !== undefined) profile.licenseExpirationDate = new Date(licenseExpirationDate);
  if (medicalCardExpirationDate !== undefined) profile.medicalCardExpirationDate = new Date(medicalCardExpirationDate);
  if (insuranceExpirationDate !== undefined) profile.insuranceExpirationDate = new Date(insuranceExpirationDate);
  if (insuranceProvider !== undefined) profile.insuranceProvider = insuranceProvider;
  if (insurancePolicyNumber !== undefined) profile.insurancePolicyNumber = insurancePolicyNumber;

  await profile.save();

  res.json(new ApiResponse(200, profile, "Compliance updated"));

  logger.info({ profileId: profile._id, userId: user._id }, 'Compliance information updated');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: 'global',
    type: 'other',
    title: 'Compliance Updated',
    description: `Driver ${user.name} updated license/insurance details`,
    metadata: { profileId: profile._id.toString(), licenseState }
  });
});

const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const file = req.file;
  if (!file) throw new ApiError(400, "No file provided");

  const { type, label, expiresAt } = req.body;
  if (!type || !label) throw new ApiError(400, "Document type and label are required");

  const allowedTypes = [
    "drivers_license", "medical_card", "insurance_certificate",
    "vehicle_registration", "dot_inspection", "w9_form",
    "operating_authority", "cargo_insurance", "liability_insurance", "other",
  ];
  if (!allowedTypes.includes(type)) throw new ApiError(400, "Invalid document type");

  // Enforce expiration dates for high-risk documents
  const needsExpiry = ["drivers_license_front", "drivers_license_back", "medical_card", "insurance_certificate", "liability_insurance", "cargo_insurance"];
  if (needsExpiry.includes(type) && !expiresAt) {
    throw new ApiError(400, `Expiration date is required for ${type.replace(/_/g, " ")}`);
  }

  const profile = await getOrCreateProfile(user._id.toString());

  if (profile.documents.length >= 20) {
    throw new ApiError(400, "Maximum of 20 documents allowed");
  }

  // Upload to PRIVATE bucket for security
  const fileUrl = await storageService.upload(file, "driver-documents", BucketType.PRIVATE);
  const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;

  profile.documents.push({
    type,
    label: label.substring(0, 100),
    fileUrl,
    fileKey,
    fileName: file.originalname,
    fileSize: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date(),
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    verified: false,
    reviewStatus: "pending",
  });

  await profile.save();

  // Log activity
  await activityService.logComplianceActivity(
    user._id.toString(),
    'global',
    'compliance_uploaded',
    label,
    'Pending Review'
  );

  res.json(new ApiResponse(200, profile, "Document uploaded"));

  logger.info({ profileId: profile._id, type, label }, 'Compliance document uploaded');
});

const deleteDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const { documentId } = req.params;
  if (!documentId) throw new ApiError(400, "Document ID is required");

  const profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  const doc = profile.documents.find(
    (d: any) => d._id?.toString() === documentId,
  );
  if (!doc) throw new ApiError(404, "Document not found");

  if (doc.fileKey) {
    await storageService.delete(doc.fileKey).catch(() => { });
  }

  profile.documents = profile.documents.filter(
    (d: any) => d._id?.toString() !== documentId,
  ) as any;

  await profile.save();

  res.json(new ApiResponse(200, profile, "Document deleted"));

  logger.warn({ profileId: profile._id, documentId }, 'Compliance document deleted');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: profile.organizationId?.toString() || 'global',
    type: 'other',
    title: 'Document Deleted',
    description: `Driver ${user.name} removed a compliance document`,
    metadata: { profileId: profile._id.toString(), documentId }
  });
});

const updateLogistics = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

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
      // Active -> unavailable cannot bypass the petition flow while loads are
      // still assigned. Returning to Active remains direct for now.
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

        // Shared-pool driver: count active loads across every org, not just one.
        const activeLoadCount = await Load.countDocuments({
          assignedDriverId: user._id,
          status: { $in: ACTIVE_DRIVER_LOAD_STATUSES },
        });

        if (activeLoadCount > 0) {
          throw new ApiError(
            409,
            `You currently have ${activeLoadCount} active load${activeLoadCount === 1 ? "" : "s"}. Submit a Dispatch Status request so Dispatch can review and reassign the affected loads.`,
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

  logger.info({ profileId: profile._id, userId: user._id }, 'Logistics information updated');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: 'global',
    type: 'other',
    title: 'Logistics Updated',
    description: `Driver ${user.name} updated service area/routes or Dispatch Status`,
    metadata: { profileId: profile._id.toString(), serviceRadius, operationalStatus: profile.operationalStatus }
  });
});

const updateIdentityVerification = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const profile = await getOrCreateProfile(user._id.toString());

  const { ssnLast4, backgroundCheckConsent, verificationAgreement } = req.body;

  if (ssnLast4 !== undefined) {
    const cleaned = ssnLast4.replace(/\D/g, "");
    if (cleaned.length !== 4) throw new ApiError(400, "SSN must be exactly 4 digits");
    profile.ssnLast4 = cleaned;
  }

  if (backgroundCheckConsent === true && !profile.backgroundCheckConsent) {
    profile.backgroundCheckConsent = true;
    profile.backgroundCheckConsentDate = new Date();
  }

  if (verificationAgreement === true && !profile.verificationAgreement) {
    profile.verificationAgreement = true;
    profile.verificationAgreementDate = new Date();
  }

  const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
  const allUploaded = REQUIRED_COMPLIANCE_DOCS.every(t => uploadedTypes.has(t));

  const allVerified = REQUIRED_COMPLIANCE_DOCS.every(t =>
    profile.documents.some((d: any) => d.type === t && d.verified)
  );

  // Progress score calculation for 0/7 (or 0/6 in UI)
  const uploadedCount = REQUIRED_COMPLIANCE_DOCS.filter(t => uploadedTypes.has(t)).length;
  const complianceScore = Math.round((uploadedCount / REQUIRED_COMPLIANCE_DOCS.length) * 100);

  if (allVerified && profile.ssnLast4 && profile.backgroundCheckConsent && profile.verificationAgreement) {
    profile.verificationStatus = "verified";
  } else if (allUploaded && profile.ssnLast4 && profile.backgroundCheckConsent && profile.verificationAgreement) {
    profile.verificationStatus = "under_review";
  } else if (uploadedCount > 0 || profile.ssnLast4) {
    profile.verificationStatus = "in_progress";
  }

  profile.profileCompletionScore = complianceScore; // Reuse this field for doc progress if preferred or keep separate


  await profile.save();

  res.json(new ApiResponse(200, profile, "Identity verification updated"));

  logger.info({ profileId: profile._id, userId: user._id }, 'Identity verification updated');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: 'global',
    type: 'other',
    title: 'Identity Verification Update',
    description: `Driver ${user.name} updated tax/identity info`,
    metadata: { profileId: profile._id.toString(), status: profile.verificationStatus }
  });
});

export default {
  getProfile,
  updateEquipment,
  updateCompliance,
  uploadDocument,
  deleteDocument,
  updateLogistics,
  updateIdentityVerification,
};