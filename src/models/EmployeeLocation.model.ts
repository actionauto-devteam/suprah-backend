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
  deviceType?: "mobile" | "desktop";
  connectionType?: string;
  effectiveType?: string;
  downlinkMbps?: number;
  currentPlaceId?: mongoose.Types.ObjectId;
  drivingSessionId?: mongoose.Types.ObjectId;
  lastSeenAt: Date;
  sharingSince?: Date;
  // Anchor point for "has this person basically stayed put" detection — reset whenever a ping
  // lands farther than STATIONARY_RADIUS_M away from it. Lets the UI explain GPS jitter ("still
  // at the same spot, the pin wobble is just noise") instead of it reading as erratic movement.
  stationaryAnchor?: { lat: number; lng: number };
  stationarySince?: Date;
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
    deviceType: { type: String, enum: ["mobile", "desktop"] },
    // Real physical connection type, from the Network Information API's `connection.type` —
    // reliable when a browser exposes it, but many don't (esp. desktop Chrome), hence the
    // separate `effectiveType` fallback below rather than conflating the two.
    connectionType: {
      type: String,
      enum: ["wifi", "ethernet", "cellular", "bluetooth", "wimax", "none"],
    },
    // Speed-quality tier from `connection.effectiveType` (RTT/downlink heuristic) — its labels
    // ("4g" etc.) describe bandwidth class, NOT an actual cellular radio, so this must never be
    // presented as "on 4G" for a device whose connectionType isn't itself cellular.
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
