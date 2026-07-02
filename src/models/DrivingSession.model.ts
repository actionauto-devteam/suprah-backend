import mongoose, { Document, Schema } from "mongoose";

export interface IDrivingSession extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  appointmentId: mongoose.Types.ObjectId;
  vehicleId?: mongoose.Types.ObjectId;
  startedAt: Date;
  endedAt?: Date;
  topSpeedMph: number;
  harshBrakingEvents: number;
  distanceMi: number;
  lastSpeedMph?: number;
  possibleIncident?: {
    detectedAt: Date;
    speedBeforeMph: number;
    confirmed?: boolean;
    respondedAt?: Date;
  };
  status: "active" | "completed" | "aborted";
  createdAt: Date;
  updatedAt: Date;
}

const DrivingSessionSchema = new Schema<IDrivingSession>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userName: { type: String, required: true },
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date },
    topSpeedMph: { type: Number, default: 0 },
    harshBrakingEvents: { type: Number, default: 0 },
    distanceMi: { type: Number, default: 0 },
    lastSpeedMph: { type: Number },
    possibleIncident: {
      detectedAt: { type: Date },
      speedBeforeMph: { type: Number },
      confirmed: { type: Boolean },
      respondedAt: { type: Date },
    },
    status: {
      type: String,
      enum: ["active", "completed", "aborted"],
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

DrivingSessionSchema.index({ organizationId: 1, userId: 1, startedAt: -1 });
DrivingSessionSchema.index({ appointmentId: 1 });

const DrivingSession = mongoose.model<IDrivingSession>("DrivingSession", DrivingSessionSchema);

export default DrivingSession;
