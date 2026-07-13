import mongoose, { Document, Schema } from "mongoose";

export interface ILocationHistory extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  coords: {
    lat: number;
    lng: number;
  };
  speedMph?: number;
  drivingSessionId?: mongoose.Types.ObjectId;
  recordedAt: Date;
}

const LocationHistorySchema = new Schema<ILocationHistory>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: "Organization",
    required: true,
  },
  coords: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  speedMph: { type: Number },
  drivingSessionId: {
    type: Schema.Types.ObjectId,
    ref: "DrivingSession",
  },
  recordedAt: { type: Date, required: true, default: Date.now },
});

LocationHistorySchema.index({ organizationId: 1, userId: 1, recordedAt: -1 });
LocationHistorySchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

const LocationHistory = mongoose.model<ILocationHistory>("LocationHistory", LocationHistorySchema);

export default LocationHistory;
