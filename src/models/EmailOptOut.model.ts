import mongoose, { Document, Schema } from 'mongoose';

export interface IEmailOptOut extends Document {
  organizationId: string;
  email: string;
  optedOut: boolean;
  changedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailOptOutSchema: Schema<IEmailOptOut> = new Schema(
  {
    organizationId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    optedOut: { type: Boolean, default: true },
    changedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

EmailOptOutSchema.index({ organizationId: 1, email: 1 }, { unique: true });

const EmailOptOut = mongoose.model<IEmailOptOut>('EmailOptOut', EmailOptOutSchema);

export default EmailOptOut;
