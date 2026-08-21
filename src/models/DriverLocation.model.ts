import mongoose, { Document, Schema } from "mongoose";

export type DriverStatus = "on-route" | "idle" | "on-break" | "waiting" | "offline";

export interface IDriverLocation extends Document {
  userId: mongoose.Types.ObjectId;
  /** Historical only — drivers are a shared pool, not org-owned. Never filtered on. */
  organizationId?: mongoose.Types.ObjectId;
  status: DriverStatus;
  coords: {
    lat: number;
    lng: number;
  };
  shipmentIds: mongoose.Types.ObjectId[];
  lastSeenAt: Date;
  /** Independent GPS-sharing flag. A driver may share GPS while On Leave/In Shop even though live status stays Offline/Waiting. */
  isSharing: boolean;
  /** Set when a "went offline" alert has already fired for the current silence gap; cleared on the next location ping. */
  offlineAlertSentAt?: Date | null;
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
      required: false,
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
    isSharing: {
      type: Boolean,
      default: false,
    },
    offlineAlertSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

DriverLocationSchema.index({ organizationId: 1, status: 1, lastSeenAt: -1 });

const DriverLocation = mongoose.model<IDriverLocation>(
  "DriverLocation",
  DriverLocationSchema,
);

export default DriverLocation;