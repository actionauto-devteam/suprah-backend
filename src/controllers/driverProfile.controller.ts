import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverProfile, { REQUIRED_COMPLIANCE_DOCS } from "../models/DriverProfile.model";
import { IUser } from "../models/User.model";
import storageService, { BucketType } from "../services/storage.service";
import activityService from "../services/activity.service";
import logger from "../utils/logger";

const getUserId = (req: Request): string => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  return user._id.toString();
};

const getOrCreateProfile = async (userId: string, organizationId: string) => {
  let profile = await DriverProfile.findOne({ userId });
  if (!profile) {
    profile = await DriverProfile.create({ userId, organizationId });
  }
  return profile;
};

const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

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

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

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
    organizationId: orgId,
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

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

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
    organizationId: orgId,
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

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

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
    orgId,
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
    organizationId: profile.organizationId.toString(),
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

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

  const {
    operationalStatus,
    homeBase,
    serviceRadius,
    preferredRoutes,
    availableDays,
  } = req.body;

  if (operationalStatus !== undefined) profile.operationalStatus = operationalStatus;
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

  res.json(new ApiResponse(200, profile, "Logistics updated"));

  logger.info({ profileId: profile._id, userId: user._id }, 'Logistics information updated');

  await activityService.createActivity({
    userId: user._id.toString(),
    organizationId: orgId,
    type: 'other',
    title: 'Logistics Updated',
    description: `Driver ${user.name} updated service area/routes`,
    metadata: { profileId: profile._id.toString(), serviceRadius }
  });
});

const getOrgDriverProfiles = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const profiles = await DriverProfile.find({ organizationId: orgId })
    .select("userId trailerType maxVehicleCapacity operationalStatus profileCompletionScore isComplianceExpired truckMake truckModel specialFeatures homeBase serviceRadius verificationStatus")
    .populate("userId", "name email avatar")
    .lean();

  const profilesWithSignedDocs = await Promise.all(profiles.map(async (p: any) => {
    if (p.documents) {
      for (const doc of p.documents) {
        if (doc.fileUrl && !doc.fileUrl.startsWith('http')) {
          const signed = await storageService.getSignedUrl(doc.fileUrl);
          if (signed) doc.fileUrl = signed;
        }
      }
    }
    return p;
  }));

  res.json(new ApiResponse(200, profilesWithSignedDocs, "Organization driver profiles fetched"));
});

const getDriverProfileById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const profile = await DriverProfile.findOne({
    userId: req.params.driverId,
    organizationId: orgId,
  }).populate("userId", "name email avatar");

  if (!profile) throw new ApiError(404, "Driver profile not found");

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

const verifyDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (!["admin", "super_admin"].includes(user.role)) {
    throw new ApiError(403, "Only admins can verify documents");
  }

  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const { driverId, documentId } = req.params;
  const { verified } = req.body;

  if (typeof verified !== "boolean") {
    throw new ApiError(400, "verified field must be a boolean");
  }

  const profile = await DriverProfile.findOne({
    userId: driverId,
    organizationId: orgId,
  });
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

  // Log activity (Persona: Admin acting on Driver)
  await activityService.logComplianceActivity(
    driverId,
    orgId,
    'doc_verified',
    doc.label,
    verified ? 'Verified' : 'Unverified'
  );

  res.json(new ApiResponse(200, profile, `Document ${verified ? "verified" : "unverified"}`));

  logger.info({ profileId: profile._id, driverId, documentId, verified }, 'Document verification status changed');
});

const rejectDocument = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (!["admin", "super_admin"].includes(user.role)) {
    throw new ApiError(403, "Only admins can reject documents");
  }

  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const { driverId, documentId } = req.params;
  const { reason } = req.body;

  if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
    throw new ApiError(400, "A rejection reason is required (min 3 chars)");
  }

  const profile = await DriverProfile.findOne({
    userId: driverId,
    organizationId: orgId,
  });
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

  // Log activity (Persona: Admin acting on Driver)
  await activityService.createActivity({
    userId: driverId,
    organizationId: orgId,
    type: 'other',
    title: 'Document Rejected',
    description: `Document ${doc.label} was rejected: ${reason.trim()}`,
    metadata: { documentId, reason: reason.trim(), adminId: user._id.toString() }
  });

  res.json(new ApiResponse(200, profile, "Document rejected"));

  logger.warn({ profileId: profile._id, driverId, documentId, reason }, 'Compliance document rejected');
});

const updateIdentityVerification = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (user.role !== "driver") throw new ApiError(403, "Only drivers can access this");

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

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
    organizationId: orgId,
    type: 'other',
    title: 'Identity Verification Update',
    description: `Driver ${user.name} updated tax/identity info`,
    metadata: { profileId: profile._id.toString(), status: profile.verificationStatus }
  });
});

const approveDriverProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?._id) throw new ApiError(401, "User not authenticated");
  if (!["admin", "super_admin"].includes(user.role)) {
    throw new ApiError(403, "Only admins can approve driver profiles");
  }

  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const { driverId } = req.params;

  const profile = await DriverProfile.findOne({
    userId: driverId,
    organizationId: orgId,
  });
  if (!profile) throw new ApiError(404, "Driver profile not found");

  profile.verificationStatus = "verified";
  await profile.save();

  await activityService.createActivity({
    userId: driverId,
    organizationId: orgId,
    type: 'other',
    title: 'Driver Profile Approved',
    description: `Driver profile was approved by admin ${user.name}`,
    metadata: { profileId: profile._id.toString(), approvedBy: user._id.toString() }
  });

  logger.info({ profileId: profile._id, driverId, approvedBy: user._id }, 'Driver profile approved by admin');

  res.json(new ApiResponse(200, profile, "Driver profile approved"));
});

export default {
  getProfile,
  updateEquipment,
  updateCompliance,
  uploadDocument,
  deleteDocument,
  updateLogistics,
  getOrgDriverProfiles,
  getDriverProfileById,
  verifyDocument,
  rejectDocument,
  updateIdentityVerification,
  approveDriverProfile,
};
