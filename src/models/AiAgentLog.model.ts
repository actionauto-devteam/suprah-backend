import mongoose, { Document, Schema } from 'mongoose';

export type AiAgentLogStatus = 'sent' | 'blocked' | 'failed' | 'skipped' | 'fallback_sent';
export type AiAgentLogChannel = 'webchat' | 'sms';
export type AiAgentLogClassifierVerdict = 'SAFE' | 'UNSAFE' | 'ERROR';

export interface IAiAgentLog extends Document {
  organizationId: string;
  channel: AiAgentLogChannel;
  leadId: mongoose.Types.ObjectId;
  sessionId?: mongoose.Types.ObjectId;
  conversationId?: mongoose.Types.ObjectId;
  messageId?: mongoose.Types.ObjectId;
  generatedMessage?: string;
  finalMessage?: string;
  status: AiAgentLogStatus;
  blockedReason?: string;
  classifierVerdict?: AiAgentLogClassifierVerdict;
  failureReason?: string;
  handoffTriggered?: boolean;
  handoffReason?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AiAgentLogSchema: Schema<IAiAgentLog> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    channel: { type: String, enum: ['webchat', 'sms'], required: true },
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead', index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'WebChatSession' },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    messageId: { type: Schema.Types.ObjectId },
    generatedMessage: { type: String, trim: true },
    finalMessage: { type: String, trim: true },
    status: {
      type: String,
      enum: ['sent', 'blocked', 'failed', 'skipped', 'fallback_sent'],
      required: true,
      index: true,
    },
    blockedReason: { type: String, trim: true, maxlength: 500 },
    classifierVerdict: { type: String, enum: ['SAFE', 'UNSAFE', 'ERROR'] },
    failureReason: { type: String, trim: true, maxlength: 500 },
    handoffTriggered: { type: Boolean, default: false },
    handoffReason: { type: String, trim: true, maxlength: 300 },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

AiAgentLogSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
AiAgentLogSchema.index({ leadId: 1, createdAt: -1 });

const AiAgentLog = mongoose.model<IAiAgentLog>('AiAgentLog', AiAgentLogSchema);

export default AiAgentLog;
