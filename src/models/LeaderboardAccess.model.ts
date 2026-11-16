import mongoose, { Document, Schema } from 'mongoose';

export interface ILeaderboardAccess extends Document {
  organizationId: string;
  principalId: string;
  principalKind: 'crm' | 'main';
  allowed: boolean;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const LeaderboardAccessSchema = new Schema<ILeaderboardAccess>(
  {
    organizationId: { type: String, required: true },
    principalId: { type: String, required: true },
    principalKind: { type: String, enum: ['crm', 'main'], required: true },
    allowed: { type: Boolean, default: false },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
);

LeaderboardAccessSchema.index({ organizationId: 1, principalId: 1, principalKind: 1 }, { unique: true });

const LeaderboardAccess = mongoose.model<ILeaderboardAccess>('LeaderboardAccess', LeaderboardAccessSchema);

export default LeaderboardAccess;
