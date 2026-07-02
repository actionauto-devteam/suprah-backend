import mongoose, { Document, Schema } from "mongoose";

export interface ISosAlert extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  coords: {
    lat: number;
    lng: number;
  };
  status: "active" | "resolved" | "false_alarm";
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SosAlertSchema = new Schema<ISosAlert>(
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
    coords: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    status: {
      type: String,
      enum: ["active", "resolved", "false_alarm"],
      default: "active",
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, trim: true },
  },
  {
    timestamps: true,
  },
);

SosAlertSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const SosAlert = mongoose.model<ISosAlert>("SosAlert", SosAlertSchema);

export default SosAlert;
