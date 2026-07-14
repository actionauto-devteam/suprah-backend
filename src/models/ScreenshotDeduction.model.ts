import mongoose, { Document, Schema } from "mongoose";

/**
 * Aggregate seconds-to-deduct per user per day, accumulated when a user
 * deletes one of their own screenshots. Intentionally minimal — no reason,
 * no "excluded by", no per-screenshot record. This is not an audit log.
 */
export interface IScreenshotDeduction extends Document {
  userId: mongoose.Types.ObjectId;
  date: string; // company-local "YYYY-MM-DD"
  deductedSeconds: number;
}

const ScreenshotDeductionSchema = new Schema<IScreenshotDeduction>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    deductedSeconds: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

ScreenshotDeductionSchema.index({ userId: 1, date: 1 }, { unique: true });

const ScreenshotDeduction = mongoose.model<IScreenshotDeduction>("ScreenshotDeduction", ScreenshotDeductionSchema);

export default ScreenshotDeduction;
