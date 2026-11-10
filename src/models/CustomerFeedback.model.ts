import mongoose, { Document, Schema } from 'mongoose';

export const FEEDBACK_CHANNELS = ['sms', 'email'] as const;
export const FEEDBACK_SOURCES = ['automation', 'appointment'] as const;

export interface ICustomerFeedback extends Document {
  organizationId: string;
  customerId: mongoose.Types.ObjectId | null;
  leadId: mongoose.Types.ObjectId | null;
  appointmentId: mongoose.Types.ObjectId | null;
  automationRunId: string | null;
  channel: (typeof FEEDBACK_CHANNELS)[number];
  source: (typeof FEEDBACK_SOURCES)[number];
  contact: { name: string; phone: string; email: string };
  reviewLink: string | null;
  tokenHash: string;
  status: 'requested' | 'answered';
  rating: number | null;
  comment: string;
  answeredAt: Date | null;
  lowRatingTaskAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerFeedbackSchema = new Schema<ICustomerFeedback>(
  {
    organizationId: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    automationRunId: { type: String, default: null },
    channel: { type: String, enum: FEEDBACK_CHANNELS, required: true },
    source: { type: String, enum: FEEDBACK_SOURCES, required: true },
    contact: {
      name: { type: String, default: '', maxlength: 160 },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
    },
    reviewLink: { type: String, default: null },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['requested', 'answered'], default: 'requested' },
    rating: { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, default: '', maxlength: 2000 },
    answeredAt: { type: Date, default: null },
    lowRatingTaskAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

CustomerFeedbackSchema.index({ tokenHash: 1 }, { unique: true, name: 'customer_feedback_token' });
CustomerFeedbackSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
CustomerFeedbackSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });

const CustomerFeedback = mongoose.model<ICustomerFeedback>('CustomerFeedback', CustomerFeedbackSchema);

export default CustomerFeedback;
