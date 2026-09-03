import mongoose, { Document, Schema } from "mongoose";

export interface IDriverRequest extends Document {
  driverUserId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  claimedBy?: mongoose.Types.ObjectId;
  claimedAt?: Date;
  claimExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DriverRequestSchema = new Schema<IDriverRequest>(
  {
    driverUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
    },
    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    claimedAt: {
      type: Date,
    },
    claimExpiresAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

DriverRequestSchema.index({ driverUserId: 1, status: 1 });
DriverRequestSchema.index({ organizationId: 1, status: 1 });

const DriverRequest = mongoose.model<IDriverRequest>(
  "DriverRequest",
  DriverRequestSchema,
);

export default DriverRequest;
