import mongoose, { Document, Schema } from "mongoose";

export type SharingState =
  | "sharing"
  | "paused_break"
  | "paused_manual"
  | "declined_permission"
  | "off_duty";

export interface IEmployeeLocation extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  coords: {
    lat: number;
    lng: number;
  };
  heading?: number;
  speedMph?: number;
  accuracyM?: number;
  sharingState: SharingState;
  batteryLevel?: number;
  isCharging?: boolean;
  connectivity: "online" | "offline";
  currentPlaceId?: mongoose.Types.ObjectId;
  drivingSessionId?: mongoose.Types.ObjectId;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmployeeLocationSchema = new Schema<IEmployeeLocation>(
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
    coords: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    heading: { type: Number },
    speedMph: { type: Number },
    accuracyM: { type: Number },
    sharingState: {
      type: String,
      enum: ["sharing", "paused_break", "paused_manual", "declined_permission", "off_duty"],
      default: "off_duty",
    },
    batteryLevel: { type: Number },
    isCharging: { type: Boolean },
    connectivity: {
      type: String,
      enum: ["online", "offline"],
      default: "online",
    },
    currentPlaceId: {
      type: Schema.Types.ObjectId,
      ref: "Place",
    },
    drivingSessionId: {
      type: Schema.Types.ObjectId,
      ref: "DrivingSession",
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

const EmployeeLocation = mongoose.model<IEmployeeLocation>(
  "EmployeeLocation",
  EmployeeLocationSchema,
);

export default EmployeeLocation;
