// Load.model.ts — Central Dispatch-style TMS load

import mongoose, { Document, Schema } from "mongoose";

// ─── Location Block ───────────────────────────────────────────────────────────

export interface ILocationBlock {
  locationType?: string;
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  cellPhone?: string;
  phoneExt?: string;
  street?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  buyerReferenceNumber?: string;
  isTwicRequired?: boolean;
  notes?: string;
}

const LocationBlockSchema = new Schema<ILocationBlock>(
  {
    locationType: { type: String, trim: true },
    companyName: { type: String, trim: true },
    contactName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    cellPhone: { type: String, trim: true },
    phoneExt: { type: String, trim: true },
    street: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true, uppercase: true },
    zip: { type: String, required: true, trim: true },
    country: { type: String, default: "US", trim: true, uppercase: true },
    buyerReferenceNumber: { type: String, trim: true, maxlength: 50 },
    isTwicRequired: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

// ─── Load Vehicle ─────────────────────────────────────────────────────────────

export interface ILoadVehicle {
  vehicleId?: mongoose.Types.ObjectId;
  hasVin?: boolean;
  vin?: string;
  vehicleType?: string;
  year?: number;
  make?: string;
  model?: string;
  color?: string;
  condition: "Operable" | "Inoperable";
  oversized?: boolean;
  lotNumber?: string;
  licensePlate?: string;
  licenseState?: string;
  carrierNotes?: string;
}

const LoadVehicleSchema = new Schema<ILoadVehicle>(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle" },
    hasVin: { type: Boolean, default: false },
    vin: { type: String, trim: true, uppercase: true, maxlength: 17 },
    vehicleType: { type: String, trim: true },
    year: { type: Number },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    color: { type: String, trim: true },
    condition: {
      type: String,
      enum: ["Operable", "Inoperable"],
      default: "Operable",
    },
    oversized: { type: Boolean, default: false },
    lotNumber: { type: String, trim: true },
    licensePlate: { type: String, trim: true, uppercase: true },
    licenseState: { type: String, trim: true, uppercase: true },
    carrierNotes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

// ─── Load Dates ───────────────────────────────────────────────────────────────

export interface ILoadDates {
  firstAvailable?: Date;
  expirationDate?: Date;
  pickupDeadline?: Date;
  deliveryDeadline?: Date;
  notes?: string;
}

const LoadDatesSchema = new Schema<ILoadDates>(
  {
    firstAvailable: { type: Date },
    expirationDate: { type: Date },
    pickupDeadline: { type: Date },
    deliveryDeadline: { type: Date },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

// ─── Load Pricing ─────────────────────────────────────────────────────────────
// miles + estimatedRate are server-computed.
// carrierPayAmount is entered by dispatcher; copCodAmount is optional cash collected by driver.
// balanceAmount = carrierPayAmount - copCodAmount (computed on save).

export interface ILoadPricing {
  miles?: number;
  estimatedRate?: number;
  carrierPayAmount?: number;
  copCodAmount?: number;
  balanceAmount?: number;
}

const LoadPricingSchema = new Schema<ILoadPricing>(
  {
    miles: { type: Number },
    estimatedRate: { type: Number },
    carrierPayAmount: { type: Number },
    copCodAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number },
  },
  { _id: false },
);

// ─── Additional Info ──────────────────────────────────────────────────────────

export interface ILoadAdditionalInfo {
  notes?: string;
  instructions?: string;
  visibility: "public" | "private";
  internalLoadId?: string;
  preDispatchNotes?: string;
  specialInstructions?: string;
  loadSpecificTerms?: string;
}

const LoadAdditionalInfoSchema = new Schema<ILoadAdditionalInfo>(
  {
    notes: { type: String, trim: true, maxlength: 4000 },
    instructions: { type: String, trim: true, maxlength: 4000 },
    visibility: {
      type: String,
      enum: ["public", "private"],
      default: "public",
    },
    internalLoadId: { type: String, trim: true, maxlength: 50 },
    preDispatchNotes: { type: String, trim: true, maxlength: 4000 },
    specialInstructions: { type: String, trim: true, maxlength: 4000 },
    loadSpecificTerms: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

// ─── Contract ─────────────────────────────────────────────────────────────────

export interface ILoadContract {
  agreedToTerms: boolean;
  signatureName?: string;
  signedAt?: Date;
}

const LoadContractSchema = new Schema<ILoadContract>(
  {
    agreedToTerms: { type: Boolean, required: true, default: false },
    signatureName: { type: String, trim: true, maxlength: 200 },
    signedAt: { type: Date },
  },
  { _id: false },
);

// ─── Load ─────────────────────────────────────────────────────────────────────

export type LoadStatus =
  | "Draft"
  | "Posted"
  | "Assigned"
  | "Accepted"
  | "Picked Up"
  | "In-Transit"
  | "Delivered"
  | "Cancelled";
export type LoadPostType = "load-board" | "assign-carrier";

export interface ILoad extends Document {
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;

  // Optional link to the Quote this load was created from
  quoteId?: mongoose.Types.ObjectId;
  // True for records migrated from the legacy Shipment collection
  migratedFromShipment?: boolean;

  loadNumber: string;
  postType: LoadPostType;
  status: LoadStatus;
  trailerType: string;

  pickupLocation: ILocationBlock;
  deliveryLocation: ILocationBlock;

  vehicles: ILoadVehicle[];
  dates?: ILoadDates;
  pricing?: ILoadPricing;
  additionalInfo?: ILoadAdditionalInfo;
  contract?: ILoadContract;

  assignedDriverId?: mongoose.Types.ObjectId;
  assignedAt?: Date;
  driverAcceptedAt?: Date;
  acceptedAt?: Date;
  pickedUpAt?: Date;
  inTransitAt?: Date;
  deliveredAt?: Date;
  droppedAt?: Date;

  proofOfDelivery?: {
    imageUrl: string;
    submittedAt: Date;
    note?: string;
    submittedTo?: mongoose.Types.ObjectId;
    confirmedAt?: Date;
    confirmedBy?: mongoose.Types.ObjectId;
  };

  pendingDriverRequests?: Array<{
    driverId: mongoose.Types.ObjectId;
    driverName: string;
    requestedAt: Date;
    status: "pending" | "approved" | "rejected";
    reviewedAt?: Date;
    reviewedBy?: mongoose.Types.ObjectId;
    rejectionReason?: string;
  }>;

  notes?: Array<{
    text: string;
    author: mongoose.Types.ObjectId;
    date: Date;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const LoadSchema = new Schema<ILoad>(
  {
    organizationId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization" },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    loadNumber: { type: String, unique: true, sparse: true },

    postType: {
      type: String,
      enum: ["load-board", "assign-carrier"],
      required: true,
      default: "load-board",
    },
    status: {
      type: String,
      enum: ["Draft", "Posted", "Assigned", "Accepted", "Picked Up", "In-Transit", "Delivered", "Cancelled"],
      default: "Draft",
    },
    trailerType: { type: String, required: true, trim: true },

    pickupLocation: { type: LocationBlockSchema, required: true },
    deliveryLocation: { type: LocationBlockSchema, required: true },

    vehicles: { type: [LoadVehicleSchema], default: [] },
    dates: { type: LoadDatesSchema },
    pricing: { type: LoadPricingSchema },
    additionalInfo: { type: LoadAdditionalInfoSchema },
    contract: { type: LoadContractSchema },

    quoteId: { type: Schema.Types.ObjectId, ref: "Quote" },
    migratedFromShipment: { type: Boolean, default: false },

    assignedDriverId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    assignedAt: { type: Date },
    driverAcceptedAt: { type: Date },
    acceptedAt: { type: Date },
    pickedUpAt: { type: Date },
    inTransitAt: { type: Date },
    deliveredAt: { type: Date },
    droppedAt: { type: Date },

    proofOfDelivery: {
      imageUrl: { type: String, trim: true },
      submittedAt: { type: Date },
      note: { type: String, trim: true },
      submittedTo: { type: Schema.Types.ObjectId, ref: "User" },
      confirmedAt: { type: Date },
      confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },

    pendingDriverRequests: [
      {
        driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        driverName: { type: String, required: true },
        requestedAt: { type: Date, default: Date.now },
        status: {
          type: String,
          enum: ["pending", "approved", "rejected"],
          default: "pending",
        },
        reviewedAt: { type: Date },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        rejectionReason: { type: String, trim: true },
      },
    ],

    notes: [
      {
        text: { type: String, required: true, trim: true, maxlength: 4000 },
        author: { type: Schema.Types.ObjectId, ref: "User", required: true },
        date: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

// ─── Load Number Counter ──────────────────────────────────────────────────────
// Atomic counter keyed by YYYYMMDD — same pattern as InvoiceCounter in Payment.model.ts

const LoadCounterSchema = new Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { collection: "loadcounters" },
);
const LoadCounter =
  mongoose.models.LoadCounter ||
  mongoose.model("LoadCounter", LoadCounterSchema);

// Auto-generate loadNumber and compute balanceAmount before save
LoadSchema.pre("save", async function (next) {
  // 1. Generate sequential loadNumber if not already set
  if (!this.loadNumber) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const counter = await LoadCounter.findOneAndUpdate(
      { _id: datePart },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    this.loadNumber = `LD-${datePart}-${String(counter.seq).padStart(4, "0")}`;
  }

  // 2. Compute balanceAmount from pricing
  if (this.pricing) {
    const pay = this.pricing.carrierPayAmount ?? 0;
    const cod = this.pricing.copCodAmount ?? 0;
    this.pricing.balanceAmount = pay - cod;
  }

  next();
});

LoadSchema.index({ organizationId: 1, createdAt: -1 });
LoadSchema.index({ organizationId: 1, status: 1 });
LoadSchema.index({ organizationId: 1, "additionalInfo.visibility": 1 });
LoadSchema.index({
  "pendingDriverRequests.driverId": 1,
  "pendingDriverRequests.status": 1,
});
LoadSchema.index({
  loadNumber: "text",
  "pickupLocation.city": "text",
  "pickupLocation.state": "text",
  "deliveryLocation.city": "text",
  "deliveryLocation.state": "text",
  "vehicles.make": "text",
  "vehicles.model": "text",
  "vehicles.vin": "text",
});

const Load = mongoose.model<ILoad>("Load", LoadSchema);

export default Load;
