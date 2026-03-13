// Shipment.model.ts

import mongoose, { Document, Schema } from "mongoose";

export interface IShipment extends Document {
  quoteId: mongoose.Types.ObjectId;
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;

  // Status
  status:
  | "Available for Pickup"
  | "Cancelled"
  | "Delivered"
  | "Dispatched"
  | "In-Route";

  // Route Information
  origin: string;
  destination: string;

  // Dates
  requestedPickupDate: Date;
  scheduledPickup?: Date;
  pickedUp?: Date;
  scheduledDelivery?: Date;
  delivered?: Date;

  // Tracking
  trackingNumber?: string;
  carrierInfo?: {
    name: string;
    contact: string;
  };

  // Preserved Quote Data (stored when quote is deleted)
  preservedQuoteData?: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    vehicleId?: mongoose.Types.ObjectId;
    vehicleName?: string;
    vehicleImage?: string;
    vin?: string;
    stockNumber?: string;
    fromZip: string;
    toZip: string;
    fromAddress: string;
    toAddress: string;
    miles: number;
    rate: number;
    eta: {
      min: number;
      max: number;
    };
    enclosedTrailer: boolean;
    vehicleInoperable: boolean;
    units: number;
  };

  // Notes
  notes?: Array<{
    text: string;
    author: mongoose.Types.ObjectId;
    date: Date;
  }>;

  // Creator tracking
  createdBy?: mongoose.Types.ObjectId;

  // Driver assignment
  assignedDriverId?: mongoose.Types.ObjectId;
  assignedAt?: Date;
  driverAcceptedAt?: Date;

  // Proof of Delivery
  proofOfDelivery?: {
    imageUrl: string;
    submittedAt: Date;
    note?: string;
    confirmedAt?: Date;
    confirmedBy?: mongoose.Types.ObjectId;
  };

  createdAt: Date;
  updatedAt: Date;
}

const ShipmentSchema: Schema<IShipment> = new Schema(
  {
    quoteId: {
      type: Schema.Types.ObjectId,
      ref: "Quote",
      required: true,
    },

    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },

    status: {
      type: String,
      enum: [
        "Available for Pickup",
        "Cancelled",
        "Delivered",
        "Dispatched",
        "In-Route",
      ],
      default: "Available for Pickup",
    },

    origin: { type: String, required: true, trim: true },
    destination: { type: String, required: true, trim: true },

    requestedPickupDate: { type: Date, required: true, default: Date.now },
    scheduledPickup: { type: Date },
    pickedUp: { type: Date },
    scheduledDelivery: { type: Date },
    delivered: { type: Date },

    trackingNumber: { type: String, trim: true },
    carrierInfo: {
      name: { type: String, trim: true },
      contact: { type: String, trim: true },
    },

    // Preserved quote data for when quotes are deleted
    preservedQuoteData: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle" },
      vehicleName: { type: String, trim: true },
      vehicleImage: { type: String, trim: true },
      vin: { type: String, trim: true },
      stockNumber: { type: String, trim: true },
      fromZip: { type: String, trim: true },
      toZip: { type: String, trim: true },
      fromAddress: { type: String, trim: true },
      toAddress: { type: String, trim: true },
      miles: { type: Number },
      rate: { type: Number },
      eta: {
        min: { type: Number },
        max: { type: Number },
      },
      enclosedTrailer: { type: Boolean },
      vehicleInoperable: { type: Boolean },
      units: { type: Number },
    },

    notes: [
      {
        text: { type: String, required: true },
        author: { type: Schema.Types.ObjectId, ref: "User" },
        date: { type: Date, default: Date.now },
      },
    ],



    assignedDriverId: { type: Schema.Types.ObjectId, ref: "User" },
    assignedAt: { type: Date },
    driverAcceptedAt: { type: Date },

    proofOfDelivery: {
      imageUrl: { type: String, trim: true },
      submittedAt: { type: Date },
      note: { type: String, trim: true },
      confirmedAt: { type: Date },
      confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
ShipmentSchema.index({ createdBy: 1, createdAt: -1 });
ShipmentSchema.index({ organizationId: 1, createdAt: -1 });

// Virtual to get quote data from either the quote reference or preserved data
ShipmentSchema.virtual("quoteData").get(function (this: IShipment) {
  if (this.populated("quoteId")) {
    return this.quoteId;
  }
  return this.preservedQuoteData;
});

// Ensure virtuals are included in JSON responses
ShipmentSchema.set("toJSON", { virtuals: true });
ShipmentSchema.set("toObject", { virtuals: true });

const Shipment = mongoose.model<IShipment>("Shipment", ShipmentSchema);

export default Shipment;
