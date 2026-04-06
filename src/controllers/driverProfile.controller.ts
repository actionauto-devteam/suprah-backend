import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import DriverProfile from "../models/DriverProfile.model";
import { IUser } from "../models/User.model";
import storageService from "../services/storage.service";
import AuditLog from "../models/AuditLog.model";

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

  res.json(new ApiResponse(200, profile, "Driver profile fetched"));
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

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Equipment information updated",
    performedBy: user._id,
    changes: req.body,
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

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Compliance information updated",
    performedBy: user._id,
    changes: {
      licenseState,
      licenseExpirationDate,
      medicalCardExpirationDate,
      insuranceExpirationDate,
      insuranceProvider,
    },
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

  const orgId = user.organizationId?.toString() || "";
  const profile = await getOrCreateProfile(user._id.toString(), orgId);

  if (profile.documents.length >= 20) {
    throw new ApiError(400, "Maximum of 20 documents allowed");
  }

  const fileUrl = await storageService.upload(file, "driver-documents");
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

  res.json(new ApiResponse(200, profile, "Document uploaded"));

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Compliance document uploaded",
    performedBy: user._id,
    changes: { documentType: type, fileName: file.originalname },
  });
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

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Compliance document deleted",
    performedBy: user._id,
    changes: { deletedDocumentId: documentId },
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

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Logistics information updated",
    performedBy: user._id,
    changes: req.body,
  });
});

const getOrgDriverProfiles = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const profiles = await DriverProfile.find({ organizationId: orgId })
    .select("userId trailerType maxVehicleCapacity operationalStatus profileCompletionScore isComplianceExpired truckMake truckModel specialFeatures homeBase serviceRadius verificationStatus")
    .populate("userId", "name email avatar")
    .lean();

  res.json(new ApiResponse(200, profiles, "Organization driver profiles fetched"));
});

const getDriverProfileById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(403, "Organization context required");

  const profile = await DriverProfile.findOne({
    userId: req.params.driverId,
    organizationId: orgId,
  }).populate("userId", "name email avatar");

  if (!profile) throw new ApiError(404, "Driver profile not found");
  res.json(new ApiResponse(200, profile, "Driver profile fetched"));
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

  res.json(new ApiResponse(200, profile, `Document ${verified ? "verified" : "unverified"}`));

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: `Document ${verified ? "verified" : "verification revoked"}`,
    performedBy: user._id,
    changes: { documentId, verified },
  });
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

  res.json(new ApiResponse(200, profile, "Document rejected"));

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Compliance document rejected",
    performedBy: user._id,
    changes: { documentId, rejectionReason: reason.trim() },
  });
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

  const requiredDocs = [
    "drivers_license", "medical_card", "insurance_certificate",
    "vehicle_registration", "operating_authority", "w9_form",
  ];
  const uploadedTypes = new Set(profile.documents.map((d: any) => d.type));
  const allUploaded = requiredDocs.every(t => uploadedTypes.has(t));
  const allVerified = requiredDocs.every(t =>
    profile.documents.some((d: any) => d.type === t && d.verified)
  );

  if (allVerified && profile.ssnLast4 && profile.backgroundCheckConsent && profile.verificationAgreement) {
    profile.verificationStatus = "verified";
  } else if (allUploaded && profile.ssnLast4 && profile.backgroundCheckConsent && profile.verificationAgreement) {
    profile.verificationStatus = "under_review";
  } else if (profile.documents.length > 0 || profile.ssnLast4) {
    profile.verificationStatus = "in_progress";
  }

  await profile.save();

  res.json(new ApiResponse(200, profile, "Identity verification updated"));

  await AuditLog.create({
    entityType: "DriverProfile",
    entityId: profile._id,
    action: "UPDATE",
    reason: "Identity verification information updated",
    performedBy: user._id,
    changes: { ssnLast4: ssnLast4 ? "****" : undefined, backgroundCheckConsent, verificationAgreement },
  });
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
};
