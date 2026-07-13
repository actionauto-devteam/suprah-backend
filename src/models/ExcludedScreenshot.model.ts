import mongoose, { Document, Schema } from "mongoose";

export interface IExcludedScreenshot extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  key: string;
  reason: string;
  excludedBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ExcludedScreenshotSchema = new Schema<IExcludedScreenshot>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true, unique: true },
    reason: { type: String, required: true },
    excludedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ExcludedScreenshotSchema.index({ organizationId: 1, userId: 1 });

const ExcludedScreenshot = mongoose.model<IExcludedScreenshot>("ExcludedScreenshot", ExcludedScreenshotSchema);

export default ExcludedScreenshot;
