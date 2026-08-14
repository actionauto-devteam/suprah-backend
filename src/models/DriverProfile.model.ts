import mongoose, { Schema, Document, Model } from "mongoose";

// ─── DriverProfile ────────────────────────────────────────────────────────────
// Rebuilt against driverProfile.controller.ts as the source of truth: every
// field this model declares is a field that controller reads or writes
// (equipment, license/insurance, logistics, identity verification, and the
// compliance documents subsystem), plus the fields the driver directory and
// driver tracking controllers consume.

// The compliance meter counts these document types — only the driver's
// license is mandatory to complete an application; everything else in
// DOCUMENT_TYPES is optional.
export const REQUIRED_COMPLIANCE_DOCS: readonly string[] = [
  "drivers_license",
];

export const DOCUMENT_TYPES = [
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
] as const;

export interface IDriverDocument {
  _id?: mongoose.Types.ObjectId;
  type: string;
  label: string;
  fileUrl: string;
  fileKey?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  uploadedAt?: Date;
  expiresAt?: Date;
  verified: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  rejectionReason?: string;
  rejectedAt?: Date;
}

export interface IHomeBase {
  type: "Point";
  coordinates?: number[];
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export const DRIVER_OPERATIONAL_STATUSES = ["active", "on_leave", "maintenance"] as const;
export type DriverOperationalStatus = (typeof DRIVER_OPERATIONAL_STATUSES)[number];

export interface IDriverProfile extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  organizationId: string;

  // ── Equipment ──
  trailerType?: string;
  customTrailerName?: string;
  maxVehicleCapacity: number;
  truckMake?: string;
  truckModel?: string;
  truckYear?: number;
  truckColor?: string;
  vin?: string;
  plateNumber?: string;
  gvwr?: number;
  engineType?: string;
  trailerMake?: string;
  trailerModel?: string;
  trailerYear?: number;
  trailerLength?: number;
  trailerAxles?: number;
  trailerGvwr?: number;
  hitchType?: string;
  specialFeatures: string[];
  dotNumber?: string;
  mcNumber?: string;

  // ── License / insurance ──
  driversLicenseNumber?: string;
  licenseState?: string;
  licenseExpirationDate?: Date;
  medicalCardExpirationDate?: Date;
  insuranceProvider?: string;
  insurancePolicyNumber?: string;
  insuranceExpirationDate?: Date;

  // ── Logistics ──
  operationalStatus: DriverOperationalStatus;
  serviceRadius?: number;
  preferredRoutes: string[];
  availableDays: string[];
  homeBase: IHomeBase;

  // ── Compliance documents ──
  documents: mongoose.Types.DocumentArray<IDriverDocument & mongoose.Types.Subdocument>;

  // ── Identity verification ──
  ssnLast4?: string;
  backgroundCheckConsent: boolean;
  backgroundCheckConsentDate?: Date;
  verificationAgreement: boolean;
  verificationAgreementDate?: Date;
  verificationStatus:
    | "unverified"
    | "pending"
    | "in_progress"
    | "under_review"
    | "verified";

  // ── Scores / flags ──
  profileCompletionScore: number;
  isComplianceExpired: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const driverDocumentSchema = new Schema<IDriverDocument>(
  {
    type: { type: String, enum: DOCUMENT_TYPES as unknown as string[], required: true },
    label: { type: String, required: true, maxlength: 100 },
    fileUrl: { type: String, required: true },
    fileKey: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    mimeType: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    verified: { type: Boolean, default: false },
    reviewStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 500 },
    rejectedAt: { type: Date },
  },
  { _id: true },
);

const homeBaseSchema = new Schema<IHomeBase>(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: undefined },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zip: { type: String, trim: true },
  },
  { _id: false },
);

const driverProfileSchema = new Schema<IDriverProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    organizationId: {
      type: String,
      required: true,
      index: true,
    },

    // ── Equipment ──
    trailerType: { type: String, trim: true },
    customTrailerName: { type: String, trim: true },
    // Platform-wide vehicle ceiling per load is 20 (Create Load hard cap)
    maxVehicleCapacity: { type: Number, min: 1, max: 20, default: 1 },
    truckMake: { type: String, trim: true },
    truckModel: { type: String, trim: true },
    truckYear: { type: Number, min: 1950, max: 2100 },
    truckColor: { type: String, trim: true },
    vin: { type: String, trim: true, uppercase: true, maxlength: 17 },
    plateNumber: { type: String, trim: true },
    gvwr: { type: Number, min: 0 },
    engineType: { type: String, trim: true },
    trailerMake: { type: String, trim: true },
    trailerModel: { type: String, trim: true },
    trailerYear: { type: Number, min: 1950, max: 2100 },
    trailerLength: { type: Number, min: 0 },
    trailerAxles: { type: Number, min: 0 },
    trailerGvwr: { type: Number, min: 0 },
    hitchType: { type: String, trim: true },
    specialFeatures: { type: [String], default: [] },
    dotNumber: { type: String, trim: true },
    mcNumber: { type: String, trim: true },

    // ── License / insurance ──
    driversLicenseNumber: { type: String, trim: true },
    licenseState: { type: String, trim: true },
    licenseExpirationDate: { type: Date },
    medicalCardExpirationDate: { type: Date },
    insuranceProvider: { type: String, trim: true },
    insurancePolicyNumber: { type: String, trim: true },
    insuranceExpirationDate: { type: Date },

    // ── Logistics ──
    operationalStatus: {
      type: String,
      enum: DRIVER_OPERATIONAL_STATUSES,
      trim: true,
      default: "active",
    },
    serviceRadius: { type: Number, min: 0 },
    preferredRoutes: { type: [String], default: [] },
    availableDays: { type: [String], default: [] },
    homeBase: { type: homeBaseSchema, default: () => ({ type: "Point" }) },

    // ── Compliance documents (max 20 enforced in controller) ──
    documents: { type: [driverDocumentSchema], default: [] },

    // ── Identity verification ──
    ssnLast4: { type: String, maxlength: 4 },
    backgroundCheckConsent: { type: Boolean, default: false },
    backgroundCheckConsentDate: { type: Date },
    verificationAgreement: { type: Boolean, default: false },
    verificationAgreementDate: { type: Date },
    verificationStatus: {
      type: String,
      enum: ["unverified", "pending", "in_progress", "under_review", "verified"],
      default: "unverified",
    },

    // ── Scores / flags ──
    profileCompletionScore: { type: Number, min: 0, max: 100, default: 0 },
    isComplianceExpired: { type: Boolean, default: false },
  },
  { timestamps: true },
);

driverProfileSchema.index({ organizationId: 1, operationalStatus: 1 });

// Keep the compliance flag current whenever a profile is saved
driverProfileSchema.pre("save", function (next) {
  const now = Date.now();
  const expired = (d?: Date) => d != null && new Date(d).getTime() < now;
  this.isComplianceExpired =
    expired(this.licenseExpirationDate) ||
    expired(this.medicalCardExpirationDate) ||
    expired(this.insuranceExpirationDate);
  next();
});

const DriverProfile: Model<IDriverProfile> = mongoose.model<IDriverProfile>(
  "DriverProfile",
  driverProfileSchema,
);
export default DriverProfile;