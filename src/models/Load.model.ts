// Load.model.ts — Central Dispatch-style load (new TMS model, separate from Quote-based Shipment)

import mongoose, { Document, Schema } from "mongoose";

// ─── Location Block ───────────────────────────────────────────────────────────

export interface ILocationBlock {
  locationType?: string;
  companyName?: string;
  contactName?: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  phoneExt?: string;
  notes?: string;
}

const LocationBlockSchema = new Schema<ILocationBlock>(
  {
    locationType: { type: String, trim: true },
    companyName:  { type: String, trim: true },
    contactName:  { type: String, trim: true },
    street:       { type: String, required: true, trim: true },
    city:         { type: String, required: true, trim: true },
    state:        { type: String, required: true, trim: true, uppercase: true },
    zip:          { type: String, required: true, trim: true },
    country:      { type: String, default: "US", trim: true, uppercase: true },
    phone:        { type: String, trim: true },
    phoneExt:     { type: String, trim: true },
    notes:        { type: String, trim: true },
  },
  { _id: false }
);

// ─── Load ─────────────────────────────────────────────────────────────────────

export type LoadStatus = "Draft" | "Posted" | "Assigned" | "In-Transit" | "Delivered" | "Cancelled";
export type LoadPostType = "load-board" | "assign-carrier";

export interface ILoad extends Document {
  organizationId:   string;
  orgId?:           mongoose.Types.ObjectId;
  createdBy:        mongoose.Types.ObjectId;

  postType:         LoadPostType;
  status:           LoadStatus;

  // Day 2 — Locations (required)
  pickupLocation:   ILocationBlock;
  deliveryLocation: ILocationBlock;

  // Day 3 — Vehicles (added later)
  // Day 4 — Dates (added later)
  // Day 5 — Pricing (added later)
  // Day 6 — Additional Info + Contract (added later)

  createdAt: Date;
  updatedAt: Date;
}

const LoadSchema = new Schema<ILoad>(
  {
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
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    postType: {
      type: String,
      enum: ["load-board", "assign-carrier"],
      required: true,
      default: "load-board",
    },
    status: {
      type: String,
      enum: ["Draft", "Posted", "Assigned", "In-Transit", "Delivered", "Cancelled"],
      default: "Draft",
    },

    pickupLocation:   { type: LocationBlockSchema, required: true },
    deliveryLocation: { type: LocationBlockSchema, required: true },
  },
  {
    timestamps: true,
  }
);

LoadSchema.index({ organizationId: 1, createdAt: -1 });
LoadSchema.index({ organizationId: 1, status: 1 });

const Load = mongoose.model<ILoad>("Load", LoadSchema);

export default Load;
