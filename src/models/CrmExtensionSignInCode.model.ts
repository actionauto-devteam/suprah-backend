import mongoose, { Document, Schema } from 'mongoose';

export interface ICrmExtensionSignInCode extends Document {
  codeHash: string;
  challenge: string;
  crmUserId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const CrmExtensionSignInCodeSchema = new Schema<ICrmExtensionSignInCode>({
  codeHash: { type: String, required: true, unique: true },
  challenge: { type: String, required: true },
  crmUserId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

CrmExtensionSignInCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<ICrmExtensionSignInCode>('CrmExtensionSignInCode', CrmExtensionSignInCodeSchema);
