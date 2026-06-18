import mongoose, { Document, Schema } from 'mongoose';

export interface IMembershipPoints extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: string;
  lifetimePoints: number;
  currentPoints: number;
  currentTierSlug: string;
  currentTierRank: number;
  profileCompletionRewarded: boolean;
  anniversaryLastRewardedYear: number;
}

const MembershipPointsSchema = new Schema<IMembershipPoints>(
  {
    userId:          { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    organizationId:  { type: String, required: true, index: true },
    lifetimePoints:  { type: Number, default: 0 },
    currentPoints:   { type: Number, default: 0 },
    currentTierSlug: { type: String, default: 'bronze' },
    currentTierRank: { type: Number, default: 1, index: true },
    profileCompletionRewarded:  { type: Boolean, default: false },
    anniversaryLastRewardedYear: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default mongoose.model<IMembershipPoints>('MembershipPoints', MembershipPointsSchema);
