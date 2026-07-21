import mongoose, { Document, Schema } from "mongoose";

export type SharingState =
  | "sharing"
  | "paused_break"
  | "paused_manual"
  | "declined_permission"
  | "off_duty";

export interface IEmployeeLocation extends Document {
  userId: mongoose.Types.ObjectId;
  userModel: "User" | "CrmUser";
  organizationId: mongoose.Types.ObjectId;
  userName?: string;
  userAvatar?: string;
  jobTitle?: string;
  department?: string;
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
  deviceType?: "mobile" | "desktop";
  connectionType?: string;
  effectiveType?: string;
  downlinkMbps?: number;
  currentPlaceId?: mongoose.Types.ObjectId;
  drivingSessionId?: mongoose.Types.ObjectId;
  lastSeenAt: Date;
  sharingSince?: Date;
  stationaryAnchor?: { lat: number; lng: number };
  stationarySince?: Date;
  stationaryNotifiedAt?: Date | null;
  connectionLostNotifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const EmployeeLocationSchema = new Schema<IEmployeeLocation>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      refPath: "userModel",
      required: true,
      unique: true,
      index: true,
    },
    userModel: {
      type: String,
      enum: ["User", "CrmUser"],
      default: "User",
      required: true,
    },
    userName: { type: String },
    userAvatar: { type: String },
    jobTitle: { type: String },
    department: { type: String },
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
    deviceType: { type: String, enum: ["mobile", "desktop"] },
    connectionType: {
      type: String,
      enum: ["wifi", "ethernet", "cellular", "bluetooth", "wimax", "none"],
    },
    effectiveType: {
      type: String,
      enum: ["4g", "3g", "2g", "slow-2g"],
    },
    downlinkMbps: { type: Number },
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
    sharingSince: { type: Date },
    stationaryAnchor: {
      lat: { type: Number },
      lng: { type: Number },
    },
    stationarySince: { type: Date },
    stationaryNotifiedAt: { type: Date, default: null },
    connectionLostNotifiedAt: { type: Date, default: null },
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
