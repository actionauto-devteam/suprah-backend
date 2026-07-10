import mongoose, { Document, Schema } from "mongoose";

// Marks a screenshot (identified by its R2 storage key) as excluded from a
// user's proof-of-work record — e.g. captured after an admin-corrected
// clock-out time. The underlying R2 object is never deleted, only hidden from
// getScreenshots(), so there is always a paper trail of what was excluded and why.
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
