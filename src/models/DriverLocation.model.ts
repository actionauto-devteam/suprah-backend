import mongoose, { Document, Schema } from "mongoose";

export type DriverStatus = "on-route" | "idle" | "on-break" | "waiting" | "offline";

export interface IDriverLocation extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
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
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["on-route", "idle", "on-break", "waiting", "offline"],
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

const DriverLocation = mongoose.model<IDriverLocation>(
  "DriverLocation",
  DriverLocationSchema,
);

export default DriverLocation;
