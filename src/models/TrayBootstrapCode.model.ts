import mongoose, { Document, Schema } from 'mongoose';

export interface ITrayBootstrapCode extends Document {
  codeHash: string;
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
}

const TrayBootstrapCodeSchema = new Schema<ITrayBootstrapCode>(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, autoIndex: false, autoCreate: false },
);

export default mongoose.models.TrayBootstrapCode
  || mongoose.model<ITrayBootstrapCode>('TrayBootstrapCode', TrayBootstrapCodeSchema);
