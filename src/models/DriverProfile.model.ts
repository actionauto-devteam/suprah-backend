import mongoose, { Schema, Document, Model } from "mongoose";
import { businessDateParts } from "../utils/businessDate";
import { MAX_TRAILER_VEHICLES, RIG_HEIGHT_INCHES, RIG_LENGTH_FEET } from "../validations/load.validation";

// The compliance meter currently requires only the driver's license.
// Keep this synchronized with REQUIRED_DOCUMENTS on the frontend.
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

export const DRIVER_OPERATIONAL_STATUSES = [
  "active",
  "on_leave",
  "maintenance",
] as const;
export type DriverOperationalStatus =
  (typeof DRIVER_OPERATIONAL_STATUSES)[number];

export interface IDriverProfile extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  // Historical only — drivers are a shared pool, not org-owned.
  organizationId?: string;

  // ── Driver Verification identity/contact snapshot ──
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;

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
  /** Overall rig height (truck and trailer, loaded), in inches. Used for truck routes. */
  rigHeightInches?: number;
  /** Overall rig length (front bumper to the end of the trailer), in feet. Used for truck routes. */
  rigLengthFeet?: number;
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
  commitmentLock?: {
    token: string;
    acquiredAt: Date;
    lockedUntil: Date;
  };
  serviceRadius?: number;
  preferredRoutes: string[];
  availableDays: string[];
  homeBase: IHomeBase;

  // ── Compliance documents ──
  documents: mongoose.Types.DocumentArray<
    IDriverDocument & mongoose.Types.Subdocument
  >;

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
  /** Expiry reminders already sent ("CDL:2026-11-12:14"), so each goes out once. */
  complianceRemindersSent?: string[];

  // ── Review claim/ownership (superadmin review queue) ──
  claimedBy?: mongoose.Types.ObjectId;
  claimedAt?: Date;
  claimExpiresAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const driverDocumentSchema = new Schema<IDriverDocument>(
  {
    type: {
      type: String,
      enum: DOCUMENT_TYPES as unknown as string[],
      required: true,
    },
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
      required: false,
      index: true,
    },

    // ── Driver Verification identity/contact snapshot ──
    firstName: { type: String, trim: true, maxlength: 120 },
    lastName: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 40 },
    address: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 120 },
    state: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 2,
    },
    zipCode: { type: String, trim: true, maxlength: 12 },

    // ── Equipment ──
    trailerType: { type: String, trim: true },
    customTrailerName: { type: String, trim: true },
    maxVehicleCapacity: { type: Number, min: 1, max: MAX_TRAILER_VEHICLES, default: 1 },
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
    rigHeightInches: { type: Number, min: RIG_HEIGHT_INCHES.min, max: RIG_HEIGHT_INCHES.max },
    rigLengthFeet: { type: Number, min: RIG_LENGTH_FEET.min, max: RIG_LENGTH_FEET.max },
    hitchType: { type: String, trim: true },
    specialFeatures: { type: [String], default: [] },
    dotNumber: { type: String, trim: true },
    mcNumber: { type: String, trim: true },

    // ── License / insurance ──
    driversLicenseNumber: { type: String, trim: true },
    licenseState: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 2,
    },
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
    commitmentLock: {
      token: { type: String, trim: true },
      acquiredAt: { type: Date },
      lockedUntil: { type: Date },
    },
    serviceRadius: { type: Number, min: 0 },
    preferredRoutes: { type: [String], default: [] },
    availableDays: { type: [String], default: [] },
    homeBase: {
      type: homeBaseSchema,
      default: () => ({ type: "Point" }),
    },

    documents: { type: [driverDocumentSchema], default: [] },

    // ── Identity verification ──
    ssnLast4: {
      type: String,
      maxlength: 4,
      validate: {
        validator: (value?: string) =>
          value === undefined || /^\d{4}$/.test(value),
        message: "SSN Last 4 must contain exactly four digits",
      },
    },
    backgroundCheckConsent: { type: Boolean, default: false },
    backgroundCheckConsentDate: { type: Date },
    verificationAgreement: { type: Boolean, default: false },
    verificationAgreementDate: { type: Date },
    verificationStatus: {
      type: String,
      enum: [
        "unverified",
        "pending",
        "in_progress",
        "under_review",
        "verified",
      ],
      default: "unverified",
    },

    profileCompletionScore: { type: Number, min: 0, max: 100, default: 0 },
    isComplianceExpired: { type: Boolean, default: false },
    // Internal bookkeeping for the expiry reminder scheduler; never sent to clients.
    complianceRemindersSent: { type: [String], default: undefined, select: false },

    claimedBy: { type: Schema.Types.ObjectId, ref: "User" },
    claimedAt: { type: Date },
    claimExpiresAt: { type: Date },
  },
  { timestamps: true },
);

driverProfileSchema.index({ organizationId: 1, operationalStatus: 1 });

/** The credential dates that decide whether a driver's compliance has expired. */
export const COMPLIANCE_EXPIRY_FIELDS = [
  "licenseExpirationDate",
  "medicalCardExpirationDate",
  "insuranceExpirationDate",
] as const;

type ComplianceDates = Partial<Record<(typeof COMPLIANCE_EXPIRY_FIELDS)[number], unknown>>;

/** How each credential is named in messages to drivers and Dispatch. */
const COMPLIANCE_EXPIRY_LABELS: Record<(typeof COMPLIANCE_EXPIRY_FIELDS)[number], string> = {
  licenseExpirationDate: "CDL",
  medicalCardExpirationDate: "medical card",
  insuranceExpirationDate: "insurance",
};

const DAY_MS = 86_400_000;
const dayNumber = (dateKey: string) => Date.parse(`${dateKey}T00:00:00Z`) / DAY_MS;

/** Today's day number on the Mountain Time (America/Denver) calendar. */
function mountainToday(nowMs: number): number {
  const { year, month, day } = businessDateParts(new Date(nowMs));
  return dayNumber(`${year}-${month}-${day}`);
}

/**
 * Whole days from today (Mountain Time calendar) to a stored expiration day:
 * 0 on the day itself, negative once it's past. Expiration dates are calendar
 * days, stored as midnight UTC of that day.
 */
export function mountainDaysUntil(value: unknown, nowMs = Date.now()): number | null {
  if (value === null || value === undefined || value === "") return null;
  const time = new Date(value as string | Date).getTime();
  if (!Number.isFinite(time)) return null;
  return dayNumber(new Date(time).toISOString().slice(0, 10)) - mountainToday(nowMs);
}

/**
 * Stored expiration dates before this instant have expired: the start of
 * tomorrow on the Mountain Time calendar, as stored. A credential counts as
 * expired from its expiration day on, so database queries agree with
 * complianceExpiryItems.
 */
export function complianceExpiryCutoff(nowMs = Date.now()): Date {
  return new Date((mountainToday(nowMs) + 1) * DAY_MS);
}

export type ComplianceExpiryItem = {
  label: string;
  /** The expiration day, YYYY-MM-DD. */
  date: string;
  expired: boolean;
  /** Whole days until it expires on the Mountain Time calendar (0 or less once the day has come). */
  daysLeft: number;
};

/** Each credential that has an expiration date, with whether it has expired as of `nowMs`. */
export function complianceExpiryItems(
  profile: ComplianceDates | null | undefined,
  nowMs = Date.now(),
): ComplianceExpiryItem[] {
  if (!profile) return [];
  return COMPLIANCE_EXPIRY_FIELDS.flatMap((field) => {
    const value = profile[field];
    if (value === null || value === undefined || value === "") return [];
    const time = new Date(value as string | Date).getTime();
    if (!Number.isFinite(time)) return [];
    // Counted on the Mountain Time calendar: expired from its expiration day on.
    const daysLeft = mountainDaysUntil(time, nowMs) as number;
    return [
      {
        label: COMPLIANCE_EXPIRY_LABELS[field],
        date: new Date(time).toISOString().slice(0, 10),
        expired: daysLeft <= 0,
        daysLeft,
      },
    ];
  });
}

/**
 * Whether the CDL, medical card or insurance has expired as of `nowMs`. The
 * stored `isComplianceExpired` flag can lag behind (it's set on save and by the
 * hourly compliance sweep), so screens that must be exact use this.
 */
export function isComplianceExpiredAt(profile: ComplianceDates | null | undefined, nowMs = Date.now()): boolean {
  return complianceExpiryItems(profile, nowMs).some((item) => item.expired);
}

/** "CDL (Oct 1, 2026), medical card (Sep 28, 2026)" for messages. Dates are calendar days, shown as stored. */
export function describeComplianceItems(items: ComplianceExpiryItem[]): string {
  return items
    .map((item) => {
      const day = new Date(`${item.date}T00:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      return `${item.label} (${day})`;
    })
    .join(", ");
}

/** The stored credential date each credential document type renews. */
const CREDENTIAL_EXPIRY_FIELD_BY_DOCUMENT_TYPE = new Map<string, (typeof COMPLIANCE_EXPIRY_FIELDS)[number]>([
  ["drivers_license", "licenseExpirationDate"],
  ["medical_card", "medicalCardExpirationDate"],
  ["insurance_certificate", "insuranceExpirationDate"],
]);

/** Document types whose approval can renew a stored credential date. */
export const CREDENTIAL_DOCUMENT_TYPES = [...CREDENTIAL_EXPIRY_FIELD_BY_DOCUMENT_TYPE.keys()];

/** How each dated document type is named in messages to drivers and Dispatch. */
const DOCUMENT_EXPIRY_LABELS: Record<string, string> = {
  drivers_license: "CDL",
  medical_card: "medical card",
  insurance_certificate: "insurance",
  vehicle_registration: "vehicle registration",
  dot_inspection: "DOT inspection",
  w9_form: "W-9 form",
  operating_authority: "operating authority",
  cargo_insurance: "cargo insurance",
  liability_insurance: "liability insurance",
};

type ExpiringSoonDocument = Partial<Pick<IDriverDocument, "type" | "label" | "expiresAt" | "reviewStatus">>;

/**
 * The credentials and documents that expire within `withinDays` but haven't
 * expired yet, as the driver sees them on the Documents page: for each type,
 * the latest expiration among its documents that weren't rejected (so an
 * uploaded renewal replaces the old one), or, for the CDL, medical card and
 * insurance when no such document has a date, the date on the profile.
 * Days are counted on the Mountain Time (America/Denver) calendar; a document
 * counts as expired on its expiration date, the same as everywhere else.
 */
export function expiringSoonItems(
  profile: (ComplianceDates & { documents?: readonly unknown[] | null }) | null | undefined,
  withinDays = 30,
  nowMs = Date.now(),
): ComplianceExpiryItem[] {
  if (!profile) return [];
  const latestByType = new Map<string, { label: string; time: number }>();
  for (const document of (profile.documents ?? []) as ExpiringSoonDocument[]) {
    if (!document?.expiresAt || document.reviewStatus === "rejected") continue;
    const time = new Date(document.expiresAt).getTime();
    if (!Number.isFinite(time)) continue;
    const type = String(document.type ?? "");
    const known = DOCUMENT_EXPIRY_LABELS[type];
    const label = known ?? (String(document.label ?? "").trim() || "document");
    // "Other" documents are told apart by their own name.
    const key = known ? type : `other:${label.toLowerCase()}`;
    const current = latestByType.get(key);
    if (!current || time > current.time) latestByType.set(key, { label, time });
  }
  for (const [type, field] of CREDENTIAL_EXPIRY_FIELD_BY_DOCUMENT_TYPE) {
    if (latestByType.has(type)) continue;
    const value = profile[field];
    if (value === null || value === undefined || value === "") continue;
    const time = new Date(value as string | Date).getTime();
    if (Number.isFinite(time)) latestByType.set(type, { label: COMPLIANCE_EXPIRY_LABELS[field], time });
  }

  return [...latestByType.values()]
    .flatMap(({ label, time }) => {
      const date = new Date(time).toISOString().slice(0, 10);
      const daysLeft = mountainDaysUntil(time, nowMs) as number;
      return daysLeft >= 1 && daysLeft <= withinDays ? [{ label, date, expired: false, daysLeft }] : [];
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

type CredentialDocument = Pick<IDriverDocument, "type" | "expiresAt" | "reviewStatus">;

/**
 * The credential dates that approved documents renew. Replacing a document
 * never overwrites the stored date on its own (the driver may have typed a
 * different one), but once a reviewer approves a renewed CDL, medical card or
 * insurance document, its expiration is the one Dispatch should see. For each
 * credential this returns the latest approved document expiration when it's
 * later than the stored date (or there is none); a date never moves backwards.
 */
export function approvedCredentialExpiryUpdates(
  profile: ComplianceDates & { documents?: CredentialDocument[] | null },
): Partial<Record<(typeof COMPLIANCE_EXPIRY_FIELDS)[number], Date>> {
  const updates: Partial<Record<(typeof COMPLIANCE_EXPIRY_FIELDS)[number], Date>> = {};
  for (const document of profile.documents ?? []) {
    const field = CREDENTIAL_EXPIRY_FIELD_BY_DOCUMENT_TYPE.get(String(document.type));
    if (!field || document.reviewStatus !== "approved" || !document.expiresAt) continue;
    const documentTime = new Date(document.expiresAt).getTime();
    if (!Number.isFinite(documentTime)) continue;
    const current = updates[field] ?? profile[field];
    const currentTime =
      current === null || current === undefined || current === ""
        ? Number.NaN
        : new Date(current as string | Date).getTime();
    if (!Number.isFinite(currentTime) || documentTime > currentTime) {
      updates[field] = new Date(documentTime);
    }
  }
  return updates;
}

// A profile saved before the 10-vehicle trailer limit is brought down to it on
// its next save, so that driver can still save everything else.
driverProfileSchema.pre("validate", function (next) {
  if (typeof this.maxVehicleCapacity === "number" && this.maxVehicleCapacity > MAX_TRAILER_VEHICLES) {
    this.maxVehicleCapacity = MAX_TRAILER_VEHICLES;
  }
  next();
});

// Keep the compliance flag current whenever a profile is saved.
driverProfileSchema.pre("save", function (next) {
  this.isComplianceExpired = isComplianceExpiredAt(this);
  next();
});

const DriverProfile: Model<IDriverProfile> = mongoose.model<IDriverProfile>(
  "DriverProfile",
  driverProfileSchema,
);

export default DriverProfile;