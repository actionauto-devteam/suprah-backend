import mongoose, { Document, Schema } from 'mongoose';

export interface IScreenshot extends Document {
  userId: mongoose.Types.ObjectId;
  r2Key: string;
  shiftDate: string;
  capturedAt: Date;
  idleDetected: boolean;
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
