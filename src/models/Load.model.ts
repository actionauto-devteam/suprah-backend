import mongoose, { Schema, Document, Model } from "mongoose";

export type LoadStatus =
  | "Draft"
  | "Posted"
  | "Assigned"
  | "Accepted"
  | "Picked Up"
  | "In-Transit"
  | "Delivered"
  | "Cancelled";

export interface ILoad extends Document {
  _id: mongoose.Types.ObjectId;
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  /** Set when the load was converted from a quote — referral.service
   *  resolves referral credit through this link. */
  quoteId?: mongoose.Types.ObjectId;
  loadNumber: string;
  postType: "load-board" | "assign-carrier";
  status: LoadStatus;
  pickupLocation: Record<string, any>;
  deliveryLocation: Record<string, any>;
  vehicles: Array<Record<string, any>>;
  trailerType: string;
  dates?: Record<string, any>;
  pricing: Record<string, any>;
  additionalInfo?: Record<string, any>;
  contract?: Record<string, any>;
  assignedDriverId?: mongoose.Types.ObjectId;
  driverRequests: Array<{
    driverId: mongoose.Types.ObjectId;
    requestedAt: Date;
    note?: string;
  }>;
  notes: Array<{ text: string; author: mongoose.Types.ObjectId; date: Date }>;
  proofOfDelivery?: Record<string, any>;
  assignedAt?: Date;
  acceptedAt?: Date;
  pickedUpAt?: Date;
  inTransitAt?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const locationSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, required: true },
    city: { type: String, trim: true, required: true },
    state: { type: String, trim: true, required: true },
    zip: { type: String, trim: true, required: true },
    // ── NEW: LocationFields additions ──
    // Mirrored in validations/load.validation.ts (zod locationBlockSchema);
    // both layers must know these fields or they're silently dropped.
    country: { type: String, trim: true, uppercase: true, maxlength: 3, default: "" },
    phone: { type: String, trim: true, default: "" },
    phoneExt: { type: String, trim: true, maxlength: 6, default: "" },
    email: { type: String, trim: true, default: "" },
    contactName: { type: String, trim: true, default: "" },
    locationType: {
      type: String,
      enum: ["dealership", "auction", "residence", "business", "port", "other"],
      default: undefined,
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false },
);

const loadVehicleSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", default: undefined },
    vin: { type: String, trim: true, uppercase: true, maxlength: 17 },
    year: { type: Number, min: 1900, max: 2100 },
    make: { type: String, trim: true, default: "" },
    model: { type: String, trim: true, default: "" },
    color: { type: String, trim: true, default: "" },
    condition: {
      type: String,
      enum: ["Operable", "Inoperable"],
      default: "Operable",
    },
  },
  { _id: false },
);

// ── "Make it Available Load" request queue ──
// Drivers request a Posted, unassigned load from their account; the
// dispatcher approves or rejects from the Transportation page.
const driverRequestSchema = new Schema(
  {
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: false },
);

const loadSchema = new Schema<ILoad>(
  {
    organizationId: { type: String, required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    quoteId: { type: Schema.Types.ObjectId, ref: "Quote", index: true, sparse: true },
    loadNumber: { type: String, unique: true, index: true },
    postType: {
      type: String,
      enum: ["load-board", "assign-carrier"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "Draft",
        "Posted",
        "Assigned",
        "Accepted",
        "Picked Up",
        "In-Transit",
        "Delivered",
        "Cancelled",
      ],
      default: "Posted",
      index: true,
    },
    pickupLocation: { type: locationSchema, required: true },
    deliveryLocation: { type: locationSchema, required: true },
    // Platform limit of 20 is enforced in validation + controller; the
    // schema-level ceiling is a final backstop.
    vehicles: {
      type: [loadVehicleSchema],
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 1 && v.length <= 20,
        message: "A load must include between 1 and 20 vehicles",
      },
    },
    trailerType: { type: String, required: true },
    dates: {
      firstAvailable: { type: Date },
      pickupDeadline: { type: Date },
      deliveryDeadline: { type: Date },
      notes: { type: String, trim: true, maxlength: 1000, default: "" },
    },
    pricing: {
      miles: { type: Number, min: 0 },
      estimatedRate: { type: Number, min: 0 },
      // ── NEW: dispatcher's $/mi rate from Create Load ──
      // Optional; absent on loads created before this field existed and on
      // loads where carrier pay was typed directly without a rate estimate.
      pricePerMile: { type: Number, min: 0 },
      carrierPayAmount: { type: Number, min: 0 },
      copCodAmount: { type: Number, min: 0, default: 0 },
      balanceAmount: { type: Number },
    },
    additionalInfo: {
      visibility: { type: String, enum: ["public", "private"], default: "public" },
      notes: { type: String, trim: true, maxlength: 4000, default: "" },
      instructions: { type: String, trim: true, maxlength: 4000, default: "" },
      referenceNumber: { type: String, trim: true, maxlength: 120, default: "" },
    },
    contract: {
      agreedToTerms: { type: Boolean, default: false },
      signedAt: { type: Date },
      // ── SignaturePad e-signature ──
      signatureDataUrl: { type: String, maxlength: 200_000, default: null },
      signerName: { type: String, trim: true, maxlength: 160, default: "" },
    },
    assignedDriverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    driverRequests: { type: [driverRequestSchema], default: [] },
    notes: [
      {
        text: { type: String, trim: true, maxlength: 4000 },
        author: { type: Schema.Types.ObjectId, ref: "User" },
        date: { type: Date, default: Date.now },
      },
    ],
    proofOfDelivery: {
      imageUrl: { type: String },
      submittedAt: { type: Date },
      note: { type: String, trim: true, maxlength: 2000 },
      submittedTo: { type: Schema.Types.ObjectId, ref: "User" },
      confirmedAt: { type: Date },
      confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    // ── Lifecycle timestamps written by driver-tracking transitions ──
    assignedAt: { type: Date },
    acceptedAt: { type: Date },
    pickedUpAt: { type: Date },
    inTransitAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

// ── Indexes ──
loadSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
loadSchema.index({ organizationId: 1, assignedDriverId: 1, status: 1 });
loadSchema.index({
  loadNumber: "text",
  "pickupLocation.city": "text",
  "deliveryLocation.city": "text",
  "vehicles.vin": "text",
  "vehicles.make": "text",
  "vehicles.model": "text",
});

// ── Daily load-number counter: LD-YYYYMMDD-### per org per day ──
const loadCounterSchema = new Schema(
  { _id: String, seq: { type: Number, default: 0 } },
  { versionKey: false },
);
const LoadCounter =
  (mongoose.models.LoadCounter as Model<any>) ||
  mongoose.model("LoadCounter", loadCounterSchema);

loadSchema.pre("validate", async function (this: ILoad, next: (err?: Error) => void) {
  try {
    if (this.isNew && !this.loadNumber) {
      const now = new Date();
      const yyyymmdd = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("");
      const counter = await LoadCounter.findOneAndUpdate(
        { _id: `load-${this.organizationId}-${yyyymmdd}` },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      );
      this.loadNumber = `LD-${yyyymmdd}-${String(counter.seq).padStart(3, "0")}`;
    }
    next();
  } catch (err) {
    next(err as Error);
  }
});

// ── Balance auto-computation ──
// NOTE: pre("save") does NOT run on findOneAndUpdate — controllers that
// update pricing via $set (see updateLoad) recompute balanceAmount
// explicitly. This hook covers document-style saves.
loadSchema.pre("save", function (this: ILoad, next: (err?: Error) => void) {
  const p: any = this.pricing ?? {};
  if (typeof p.carrierPayAmount === "number") {
    p.balanceAmount = p.carrierPayAmount - (p.copCodAmount ?? 0);
    this.pricing = p;
  }
  next();
});

const Load: Model<ILoad> = mongoose.model<ILoad>("Load", loadSchema);
export default Load;