import mongoose, { Document, Schema } from 'mongoose';

/**
 * Audit trail for CrmUser.hourlyRate — payroll-sensitive, so every change
 * (not just the current value) needs to be traceable back to which admin
 * made it and when, in case a wrong rate is ever disputed after the fact.
 */
export interface IHourlyRateChangeLog extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  previousRate: number | null;
  newRate: number;
  changedByAdminId: mongoose.Types.ObjectId;
  changedByAdminName: string;
  createdAt: Date;
}

const HourlyRateChangeLogSchema = new Schema<IHourlyRateChangeLog>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    previousRate: { type: Number, default: null },
    newRate: { type: Number, required: true },
    changedByAdminId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    changedByAdminName: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

HourlyRateChangeLogSchema.index({ userId: 1, createdAt: -1 });

export const HourlyRateChangeLog: mongoose.Model<IHourlyRateChangeLog> =
  mongoose.models.HourlyRateChangeLog ||
  mongoose.model<IHourlyRateChangeLog>('HourlyRateChangeLog', HourlyRateChangeLogSchema);
