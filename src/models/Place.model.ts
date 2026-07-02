import mongoose, { Document, Schema } from "mongoose";

export interface IPlace extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  coords: {
    lat: number;
    lng: number;
  };
  radiusM: number;
  icon?: string;
  color?: string;
  address?: string;
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
    icon: { type: String },
    color: { type: String },
    address: { type: String, trim: true },
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
