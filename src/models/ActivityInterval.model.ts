import mongoose, { Document, Schema } from 'mongoose';

export interface IActivityInterval extends Document {
  userId: mongoose.Types.ObjectId;
  shiftDate: string;
  startAt: Date;
  endAt: Date;
  durationSeconds: number;
}

const ActivityIntervalSchema = new Schema<IActivityInterval>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    shiftDate: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    durationSeconds: { type: Number, required: true },
  },
  { timestamps: true }
);

ActivityIntervalSchema.index({ userId: 1, shiftDate: 1 });

export default mongoose.model<IActivityInterval>('ActivityInterval', ActivityIntervalSchema);
