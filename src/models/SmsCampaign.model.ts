import mongoose, { Document, Schema } from 'mongoose';

export type SmsCampaignStatus = 'queued' | 'sending' | 'completed' | 'cancelled' | 'failed';

export interface ISmsCampaign extends Document {
  organizationId: string;
  name: string;
  message: string;
  audienceStatuses: string[];
  status: SmsCampaignStatus;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SmsCampaignSchema: Schema<ISmsCampaign> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    audienceStatuses: [{ type: String }],
    status: {
      type: String,
      enum: ['queued', 'sending', 'completed', 'cancelled', 'failed'],
      default: 'queued',
      index: true,
    },
    totalRecipients: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdByName: { type: String, trim: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

SmsCampaignSchema.index({ organizationId: 1, createdAt: -1 });

const SmsCampaign = mongoose.model<ISmsCampaign>('SmsCampaign', SmsCampaignSchema);

export default SmsCampaign;
