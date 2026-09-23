import mongoose, { Document, Schema } from 'mongoose';

export type SmsCampaignRecipientStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ISmsCampaignRecipient extends Document {
  campaignId: mongoose.Types.ObjectId;
  organizationId: string;
  leadId: mongoose.Types.ObjectId;
  phone: string;
  customerName: string;
  status: SmsCampaignRecipientStatus;
  failureReason?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SmsCampaignRecipientSchema: Schema<ISmsCampaignRecipient> = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true, ref: 'SmsCampaign', index: true },
    organizationId: { type: String, required: true },
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead' },
    phone: { type: String, required: true },
    customerName: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },
    failureReason: { type: String, trim: true, maxlength: 500 },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

SmsCampaignRecipientSchema.index({ campaignId: 1, status: 1 });

const SmsCampaignRecipient = mongoose.model<ISmsCampaignRecipient>(
  'SmsCampaignRecipient',
  SmsCampaignRecipientSchema,
);

export default SmsCampaignRecipient;
