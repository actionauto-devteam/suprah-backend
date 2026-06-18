import mongoose, { Document, Schema } from 'mongoose';

export interface IDiscountToken extends Document {
  jti: string;
  userId: mongoose.Types.ObjectId;
  tierSlug: string;
  discountPercent: number;
  used: boolean;
  usedAt?: Date;
  expiresAt: Date;
}

const DiscountTokenSchema = new Schema<IDiscountToken>(
  {
    jti:             { type: String, required: true, unique: true },
    userId:          { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tierSlug:        { type: String, required: true },
    discountPercent: { type: Number, required: true },
    used:            { type: Boolean, default: false },
    usedAt:          { type: Date },
    expiresAt:       { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);

export default mongoose.model<IDiscountToken>('DiscountToken', DiscountTokenSchema);
