import mongoose, { Document, Model, Schema } from "mongoose";

export interface IDriverReviewEvent extends Document {
  driverId: mongoose.Types.ObjectId;
  actorId?: mongoose.Types.ObjectId;
  actorName?: string;
  actorRole?: string;
  action: string;
  targetType: "profile" | "document" | "access" | "verification";
  targetId?: string;
  previousStatus?: string;
  newStatus?: string;
  reason?: string;
  organizationId?: string;
  loadId?: mongoose.Types.ObjectId;
  loadNumber?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const driverReviewEventSchema = new Schema<IDriverReviewEvent>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String, trim: true, maxlength: 160 },
    actorRole: { type: String, trim: true, maxlength: 80 },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    targetType: {
      type: String,
      enum: ["profile", "document", "access", "verification"],
      required: true,
    },
    targetId: { type: String, trim: true, maxlength: 160 },
    previousStatus: { type: String, trim: true, maxlength: 120 },
    newStatus: { type: String, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 1000 },
    organizationId: { type: String, trim: true, maxlength: 80 },
    loadId: { type: Schema.Types.ObjectId, ref: "Load" },
    loadNumber: { type: String, trim: true, maxlength: 120 },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

driverReviewEventSchema.index({ driverId: 1, createdAt: -1 });
driverReviewEventSchema.index({ actorId: 1, createdAt: -1 });

const DriverReviewEvent: Model<IDriverReviewEvent> =
  mongoose.models.DriverReviewEvent ||
  mongoose.model<IDriverReviewEvent>("DriverReviewEvent", driverReviewEventSchema);

export default DriverReviewEvent;