import mongoose, { Document, Schema } from 'mongoose';

export interface IScreenshot extends Document {
  userId: mongoose.Types.ObjectId;
  r2Key: string;          // private R2 object key (e.g. screenshots/userId/2025-05-15/1234567890.jpg)
  shiftDate: string;      // YYYY-MM-DD (UTC) — which work day this screenshot belongs to
  capturedAt: Date;
  idleDetected: boolean;  // true if mouse/keyboard was idle when screenshot was taken
  createdAt: Date;
  updatedAt: Date;
}

const ScreenshotSchema = new Schema<IScreenshot>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    r2Key: {
      type: String,
      required: true,
    },
    shiftDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    capturedAt: {
      type: Date,
      required: true,
    },
    idleDetected: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

ScreenshotSchema.index({ userId: 1, shiftDate: 1, capturedAt: -1 });

const Screenshot = mongoose.model<IScreenshot>('Screenshot', ScreenshotSchema);

export default Screenshot;
