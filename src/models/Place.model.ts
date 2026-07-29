import mongoose, { Document, Schema } from "mongoose";

export interface IPlace extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  coords: {
    lat: number;
    lng: number;
  };
  radiusM: number;
  // Optional wider "warning" ring around the hard radiusM boundary. When set, a person
  // exiting radiusM but still inside warningRadiusM is treated as "still nearby" rather
  // than having left — see resolveCurrentPlace's exit hysteresis in locator.controller.ts.
  // Always > radiusM when present; undefined means "no warning ring, use the normal
  // fixed hysteresis buffer" (the pre-existing behavior).
  warningRadiusM?: number;
  icon?: string;
  color?: string;
  address?: string;
  description?: string;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PlaceSchema = new Schema<IPlace>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    coords: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    radiusM: { type: Number, required: true, min: 10, default: 100 },
    warningRadiusM: { type: Number, min: 20 },
    icon: { type: String },
    color: { type: String },
    address: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 300 },
    isActive: { type: Boolean, default: true },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

PlaceSchema.index({ organizationId: 1, isActive: 1 });

const Place = mongoose.model<IPlace>("Place", PlaceSchema);

export default Place;
