import mongoose, { Document, Schema } from "mongoose";

export type DriverStatus = "on-route" | "idle" | "offline";

export interface IDriverLocation extends Document {
  organizationId: string;
  userId: mongoose.Types.ObjectId;
  status: DriverStatus;
  coords: {
    lat: number;
    lng: number;
  };
  shipmentIds: mongoose.Types.ObjectId[];
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DriverLocationSchema = new Schema<IDriverLocation>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["on-route", "idle", "offline"],
      default: "idle",
    },
    coords: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    shipmentIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Shipment",
      },
    ],
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

DriverLocationSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

const DriverLocation = mongoose.model<IDriverLocation>(
  "DriverLocation",
  DriverLocationSchema,
);

export default DriverLocation;
