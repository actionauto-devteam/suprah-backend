import mongoose, { Document, Schema } from 'mongoose';

export type EmailCampaignStatus = 'queued' | 'sending' | 'completed' | 'cancelled' | 'failed';

export interface IEmailCampaign extends Document {
  organizationId: string;
  name: string;
  subject: string;
  greetingText: string;
  bodyText: string;
  bannerImageUrl?: string;
  signOffText?: string;
  audienceStatuses: string[];
  status: EmailCampaignStatus;
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

const EmailCampaignSchema: Schema<IEmailCampaign> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    greetingText: { type: String, required: true, trim: true, maxlength: 500 },
    bodyText: { type: String, required: true, trim: true, maxlength: 5000 },
    bannerImageUrl: { type: String, trim: true },
    signOffText: { type: String, trim: true, maxlength: 300 },
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

EmailCampaignSchema.index({ organizationId: 1, createdAt: -1 });

const EmailCampaign = mongoose.model<IEmailCampaign>('EmailCampaign', EmailCampaignSchema);

export default EmailCampaign;
