import mongoose, { Document, Schema } from 'mongoose';

export type EmailCampaignRecipientStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface IEmailCampaignRecipient extends Document {
  campaignId: mongoose.Types.ObjectId;
  organizationId: string;
  leadId?: mongoose.Types.ObjectId;
  marketingContactId?: mongoose.Types.ObjectId;
  email: string;
  phone?: string;
  customerName: string;
  status: EmailCampaignRecipientStatus;
  failureReason?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailCampaignRecipientSchema: Schema<IEmailCampaignRecipient> = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true, ref: 'EmailCampaign', index: true },
    organizationId: { type: String, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    marketingContactId: { type: Schema.Types.ObjectId, ref: 'MarketingContact' },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },
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

EmailCampaignRecipientSchema.pre('validate', function (next) {
  const hasLead = !!this.leadId;
  const hasMarketingContact = !!this.marketingContactId;
  if (hasLead === hasMarketingContact) {
    next(new Error('Exactly one of leadId or marketingContactId must be set'));
    return;
  }
  next();
});

EmailCampaignRecipientSchema.index({ campaignId: 1, status: 1 });

const EmailCampaignRecipient = mongoose.model<IEmailCampaignRecipient>(
  'EmailCampaignRecipient',
  EmailCampaignRecipientSchema,
);

export default EmailCampaignRecipient;
