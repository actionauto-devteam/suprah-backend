import mongoose, { Document, Schema } from 'mongoose';

export interface ITimeLog extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'time-in' | 'time-out' | 'break-in' | 'break-out';
  timestamp: Date;
  note?: string;
  ipAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TimeLogSchema = new Schema<ITimeLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['time-in', 'time-out', 'break-in', 'break-out'],
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
    },
    ipAddress: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
TimeLogSchema.index({ userId: 1, timestamp: -1 });
TimeLogSchema.index({ userId: 1, type: 1, timestamp: -1 });

const TimeLog = mongoose.model<ITimeLog>('TimeLog', TimeLogSchema);

export default TimeLog;