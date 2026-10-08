import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Trip history: the positions a driver's phone reported while a load was
 * tracked (Accepted → Delivered). Kept 30 days after each position was
 * measured, then deleted automatically (business rule, 2026-09-30). Only the
 * load's responsible dispatcher and its organization's admins can read it.
 */
export const TRIP_HISTORY_RETENTION_DAYS = 30;

export interface ILoadTripPoint extends Document {
  loadId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  /** WGS84 decimal degrees. */
  lat: number;
  lng: number;
  /** When the phone measured the position. */
  measuredAt: Date;
  /** When Suprah received it. */
  receivedAt: Date;
  /** Metres. */
  accuracy?: number | null;
  /** Metres per second. */
  speed?: number | null;
  /** Degrees clockwise from north. */
  heading?: number | null;
  source: "browser" | "traccar" | "app";
  /** The load's status when the position arrived. */
  loadStatus: string;
  createdAt: Date;
}

const loadTripPointSchema = new Schema<ILoadTripPoint>(
  {
    loadId: { type: Schema.Types.ObjectId, ref: "Load", required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    measuredAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    accuracy: { type: Number, min: 0, default: null },
    speed: { type: Number, min: 0, default: null },
    heading: { type: Number, min: 0, max: 360, default: null },
    source: { type: String, enum: ["browser", "traccar", "app"], required: true },
    loadStatus: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One row per reading and load (a retried or re-uploaded reading is stored
// once), in time order for the history view.
loadTripPointSchema.index({ loadId: 1, measuredAt: 1, source: 1 }, { unique: true });
// Automatic deletion 30 days after the position was measured.
loadTripPointSchema.index(
  { measuredAt: 1 },
  { expireAfterSeconds: TRIP_HISTORY_RETENTION_DAYS * 24 * 60 * 60 },
);

const LoadTripPoint: Model<ILoadTripPoint> =
  (mongoose.models.LoadTripPoint as Model<ILoadTripPoint>) ||
  mongoose.model<ILoadTripPoint>("LoadTripPoint", loadTripPointSchema);

export default LoadTripPoint;
