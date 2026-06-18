import mongoose, { Document, Schema } from 'mongoose';

export interface IMembershipTier extends Document {
  name: string;
  slug: string;
  rank: number;
  minPoints: number;
  discountPercent: number;
  benefits: string[];
  colorTheme: {
    primary: string;
    secondary: string;
    gradient: string[];
  };
  isActive: boolean;
}

const MembershipTierSchema = new Schema<IMembershipTier>(
  {
    name:            { type: String, required: true },
    slug:            { type: String, required: true, unique: true, lowercase: true },
    rank:            { type: Number, required: true, unique: true },
    minPoints:       { type: Number, required: true, default: 0 },
    discountPercent: { type: Number, required: true, default: 0 },
    benefits:        [{ type: String }],
    colorTheme: {
      primary:   { type: String, required: true },
      secondary: { type: String, required: true },
      gradient:  [{ type: String }],
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

MembershipTierSchema.index({ minPoints: 1 });

export default mongoose.model<IMembershipTier>('MembershipTier', MembershipTierSchema);
