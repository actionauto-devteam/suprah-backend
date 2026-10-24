import mongoose, { Document, Schema, Types } from 'mongoose';

export const COMPOSER_SEND_CHANNELS = ['sms', 'email'] as const;
export type ComposerSendChannel = (typeof COMPOSER_SEND_CHANNELS)[number];

export const COMPOSER_SEND_STATES = ['sending', 'sent', 'failed', 'uncertain'] as const;
export type ComposerSendState = (typeof COMPOSER_SEND_STATES)[number];

export interface IComposerSendClaim extends Document {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  channel: ComposerSendChannel;
  clientRequestId: string;
  requestHash: string;
  userId?: string | null;
  state: ComposerSendState;
  attempts: number;
  leaseExpiresAt?: Date | null;
  result?: Record<string, unknown> | null;
  lastError?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ComposerSendClaimSchema = new Schema<IComposerSendClaim>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    channel: { type: String, enum: COMPOSER_SEND_CHANNELS, required: true },
    clientRequestId: { type: String, required: true, trim: true, maxlength: 80 },
    requestHash: { type: String, required: true },
    userId: { type: String, default: null },
    state: { type: String, enum: COMPOSER_SEND_STATES, required: true, default: 'sending' },
    attempts: { type: Number, default: 1, min: 0 },
    leaseExpiresAt: { type: Date, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

ComposerSendClaimSchema.index(
  { organizationId: 1, channel: 1, clientRequestId: 1 },
  { unique: true, name: 'composer_send_claim_request_unique' },
);
ComposerSendClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'composer_send_claim_cleanup' });

const ComposerSendClaim = mongoose.model<IComposerSendClaim>('ComposerSendClaim', ComposerSendClaimSchema);

export default ComposerSendClaim;
