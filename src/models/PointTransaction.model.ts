import mongoose, { Document, Schema } from 'mongoose';

export type PointSourceType =
  | 'aftermarket_order'
  | 'service_appointment'
  | 'test_drive'
  | 'referral_conversion'
  | 'profile_completion'
  | 'account_anniversary'
  | 'admin_adjustment';

export interface IPointTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: string;
  delta: number;
  balanceAfter: number;
  sourceType: PointSourceType;
  sourceId: string;
  description: string;
  adminId?: mongoose.Types.ObjectId;
  metadata?: Record<string, unknown>;
}

const PointTransactionSchema = new Schema<IPointTransaction>(
  {
    userId:         { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    delta:          { type: Number, required: true },
    balanceAfter:   { type: Number, required: true, default: 0 },
    sourceType: {
      type: String,
      required: true,
      enum: ['aftermarket_order','service_appointment','test_drive','referral_conversion','profile_completion','account_anniversary','admin_adjustment'],
    },
    sourceId:    { type: String, required: true },
    description: { type: String, required: true },
    adminId:     { type: Schema.Types.ObjectId, ref: 'User' },
    metadata:    { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

PointTransactionSchema.index({ userId: 1, sourceType: 1, sourceId: 1 }, { unique: true });
PointTransactionSchema.index({ userId: 1, createdAt: -1 });
PointTransactionSchema.index({ organizationId: 1, createdAt: -1 });

export default mongoose.model<IPointTransaction>('PointTransaction', PointTransactionSchema);
