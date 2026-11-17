import mongoose, { Document, Schema } from 'mongoose';

export const LEAD_HANDLING_ACTIONS = ['took_over', 'resumed', 'email_sent'] as const;
export type LeadHandlingAction = (typeof LEAD_HANDLING_ACTIONS)[number];

export const LEAD_HANDLING_CHANNELS = ['sms', 'webchat', 'email'] as const;
export type LeadHandlingChannel = (typeof LEAD_HANDLING_CHANNELS)[number];

export interface ILeadHandlingEvent extends Document {
  organizationId: string;
  leadId: mongoose.Types.ObjectId;
  action: LeadHandlingAction;
  channel: LeadHandlingChannel;
  actor: { userId: string; name?: string };
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LeadHandlingEventSchema = new Schema<ILeadHandlingEvent>(
  {
    organizationId: { type: String, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    action: { type: String, enum: LEAD_HANDLING_ACTIONS, required: true },
    channel: { type: String, enum: LEAD_HANDLING_CHANNELS, required: true },
    actor: {
      userId: { type: String, required: true },
      name: { type: String, trim: true, maxlength: 120 },
    },
    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

LeadHandlingEventSchema.index({ organizationId: 1, leadId: 1, at: -1 });
LeadHandlingEventSchema.index({ organizationId: 1, 'actor.userId': 1 });

const LeadHandlingEvent = mongoose.model<ILeadHandlingEvent>('LeadHandlingEvent', LeadHandlingEventSchema);

export default LeadHandlingEvent;
