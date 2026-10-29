import mongoose, { Document, Schema } from 'mongoose';

export interface IStaffCallPhone extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: string;
  phone: string;
  enabled: boolean;
  verifiedAt: Date | null;
  verifyCallControlId: string | null;
  verifyRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const StaffCallPhoneSchema = new Schema<IStaffCallPhone>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  userId: { type: String, required: true },
  phone: { type: String, required: true },
  enabled: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  verifyCallControlId: { type: String, default: null },
  verifyRequestedAt: { type: Date, default: null },
}, { timestamps: true });

StaffCallPhoneSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
StaffCallPhoneSchema.index({ organizationId: 1, enabled: 1 });

export default mongoose.model<IStaffCallPhone>('StaffCallPhone', StaffCallPhoneSchema);
