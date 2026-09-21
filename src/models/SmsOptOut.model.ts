import mongoose, { Document, Schema } from 'mongoose';

export interface ISmsOptOut extends Document {
  organizationId: string;
  phone: string;
  optedOut: boolean;
  changedAt: Date;
  keyword?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SmsOptOutSchema: Schema<ISmsOptOut> = new Schema(
  {
    organizationId: { type: String, required: true },
    phone: { type: String, required: true },
    optedOut: { type: Boolean, default: true },
    changedAt: { type: Date, default: Date.now },
    keyword: { type: String },
  },
  { timestamps: true },
);

SmsOptOutSchema.index({ organizationId: 1, phone: 1 }, { unique: true });

const SmsOptOut = mongoose.model<ISmsOptOut>('SmsOptOut', SmsOptOutSchema);

export default SmsOptOut;
