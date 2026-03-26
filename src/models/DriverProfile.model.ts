import mongoose, { Document, Schema } from "mongoose";

export type TrailerType =
  | "open_3car_wedge"
  | "open_2car"
  | "enclosed_2car"
  | "enclosed_3car"
  | "flatbed"
  | "hotshot"
  | "dually_flatbed"
  | "gooseneck"
  | "lowboy"
  | "step_deck"
  | "9car_stinger"
  | "7car_stinger"
  | "5car_open"
  | "rgn"
  | "double_drop"
  | "power_only"
  | "other";

export type OperationalStatus =
  | "active"
  | "on_leave"
  | "maintenance"
  | "terminated";

export type ComplianceDocumentType =
  | "drivers_license"
  | "medical_card"
  | "insurance_certificate"
  | "vehicle_registration"
  | "dot_inspection"
  | "w9_form"
  | "operating_authority"
  | "cargo_insurance"
  | "liability_insurance"
  | "other";

export interface IComplianceDocument {
  _id?: mongoose.Types.ObjectId;
  type: ComplianceDocumentType;
  label: string;
  fileUrl: string;
  fileKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: Date;
  expiresAt?: Date;
  verified: boolean;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
}

export interface IDriverProfile extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: string;

  trailerType: TrailerType;
  maxVehicleCapacity: number;
  truckMake: string;
  truckModel: string;
  truckYear: number;
  trailerLength: number;
  dotNumber: string;
  mcNumber: string;
  specialFeatures: string[];

  driversLicenseNumber: string;
  licenseState: string;
  licenseExpirationDate: Date;
  medicalCardExpirationDate: Date;
  insuranceExpirationDate: Date;
  insuranceProvider: string;
  insurancePolicyNumber: string;
  documents: IComplianceDocument[];

  operationalStatus: OperationalStatus;
  homeBase: {
    type: string;
    coordinates: number[];
    address: string;
    city: string;
    state: string;
    zip: string;
  };
  serviceRadius: number;
  preferredRoutes: string[];
  availableDays: string[];

  profileCompletionScore: number;
  isComplianceExpired: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const ComplianceDocumentSchema = new Schema<IComplianceDocument>(
  {
    type: {
      type: String,
      enum: [
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
      ],
      required: true,
    },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    fileUrl: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileName: { type: String, required: true, trim: true },
    fileSize: { type: Number, required: true },
    mimeType: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    verified: { type: Boolean, default: false },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
  },
  { _id: true },
);

const DriverProfileSchema = new Schema<IDriverProfile>(
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

    trailerType: {
      type: String,
      enum: [
        "open_3car_wedge",
        "open_2car",
        "enclosed_2car",
        "enclosed_3car",
        "flatbed",
        "hotshot",
        "dually_flatbed",
        "gooseneck",
        "lowboy",
        "step_deck",
        "9car_stinger",
        "7car_stinger",
        "5car_open",
        "rgn",
        "double_drop",
        "power_only",
        "other",
      ],
      default: "open_3car_wedge",
    },
    maxVehicleCapacity: { type: Number, default: 1, min: 1, max: 12 },
    truckMake: { type: String, trim: true, default: "" },
    truckModel: { type: String, trim: true, default: "" },
    truckYear: { type: Number, min: 1990, max: 2030 },
    trailerLength: { type: Number, min: 0, max: 80 },
    dotNumber: { type: String, trim: true, default: "" },
    mcNumber: { type: String, trim: true, default: "" },
    specialFeatures: {
      type: [String],
      default: [],
      enum: [
        "lift_gate",
        "winch",
        "enclosed",
        "air_ride",
        "gps_tracking",
        "eld_equipped",
        "hazmat_certified",
        "oversized_capable",
        "inoperable_vehicle_capable",
      ],
    },

    driversLicenseNumber: { type: String, trim: true, default: "" },
    licenseState: { type: String, trim: true, default: "" },
    licenseExpirationDate: { type: Date },
    medicalCardExpirationDate: { type: Date },
    insuranceExpirationDate: { type: Date },
    insuranceProvider: { type: String, trim: true, default: "" },
    insurancePolicyNumber: { type: String, trim: true, default: "" },
    documents: { type: [ComplianceDocumentSchema], default: [] },

    operationalStatus: {
      type: String,
      enum: ["active", "on_leave", "maintenance", "terminated"],
      default: "active",
    },
    homeBase: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] },
      address: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      state: { type: String, trim: true, default: "" },
      zip: { type: String, trim: true, default: "" },
    },
    serviceRadius: { type: Number, default: 500, min: 0, max: 3000 },
    preferredRoutes: { type: [String], default: [] },
    availableDays: {
      type: [String],
      default: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      enum: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
    },

    profileCompletionScore: { type: Number, default: 0, min: 0, max: 100 },
    isComplianceExpired: { type: Boolean, default: false },
  },
  { timestamps: true },
);

DriverProfileSchema.index({ "homeBase.coordinates": "2dsphere" });
DriverProfileSchema.index({ organizationId: 1, operationalStatus: 1 });
DriverProfileSchema.index({ organizationId: 1, trailerType: 1 });

DriverProfileSchema.pre("save", function (next) {
  let score = 0;
  const total = 10;

  if (this.trailerType) score++;
  if (this.maxVehicleCapacity > 0) score++;
  if (this.truckMake) score++;
  if (this.driversLicenseNumber) score++;
  if (this.licenseExpirationDate) score++;
  if (this.medicalCardExpirationDate) score++;
  if (this.insuranceExpirationDate) score++;
  if (this.homeBase?.address) score++;
  if (this.documents?.length > 0) score++;
  if (this.dotNumber || this.mcNumber) score++;

  this.profileCompletionScore = Math.round((score / total) * 100);

  const now = new Date();
  this.isComplianceExpired =
    (!!this.licenseExpirationDate && this.licenseExpirationDate < now) ||
    (!!this.medicalCardExpirationDate && this.medicalCardExpirationDate < now) ||
    (!!this.insuranceExpirationDate && this.insuranceExpirationDate < now);

  next();
});

const DriverProfile = mongoose.model<IDriverProfile>(
  "DriverProfile",
  DriverProfileSchema,
);

export default DriverProfile;
