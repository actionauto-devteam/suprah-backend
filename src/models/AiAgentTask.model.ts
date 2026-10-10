import mongoose, { Document, Schema } from 'mongoose';

export type AiAgentTaskStatus = 'pending' | 'resolved' | 'dismissed';
export type AiAgentTaskChannel = 'webchat' | 'sms' | 'email';

export interface IAiAgentTask extends Document {
  organizationId: string;
  leadId: mongoose.Types.ObjectId;
  channel: AiAgentTaskChannel;
  question: string;
  assigneeIds: mongoose.Types.ObjectId[];
  status: AiAgentTaskStatus;
  waitingSince: Date;
  resolvedAt?: Date;
  resolvedBy?: mongoose.Types.ObjectId;
  resolutionNote?: string;
  conversationId?: mongoose.Types.ObjectId;
  sessionId?: mongoose.Types.ObjectId;
  sourceMessageId?: string;
  notificationLease?: string;
  notificationLeaseUntil?: Date;
  notificationsCompletedAt?: Date;
  noteClaimedAt?: Date;
  noteCreatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AiAgentTaskSchema: Schema<IAiAgentTask> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead', index: true },
    channel: { type: String, enum: ['webchat', 'sms', 'email'], required: true },
    question: { type: String, required: true, trim: true, maxlength: 500 },
    assigneeIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    status: {
      type: String,
      enum: ['pending', 'resolved', 'dismissed'],
      default: 'pending',
      index: true,
    },
    waitingSince: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolutionNote: { type: String, trim: true, maxlength: 500 },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    sessionId: { type: Schema.Types.ObjectId, ref: 'WebChatSession' },
    sourceMessageId: { type: String },
    notificationLease: { type: String },
    notificationLeaseUntil: { type: Date },
    notificationsCompletedAt: { type: Date },
    noteClaimedAt: { type: Date },
    noteCreatedAt: { type: Date },
  },
  { timestamps: true },
);

AiAgentTaskSchema.index({ organizationId: 1, status: 1, waitingSince: 1 });
AiAgentTaskSchema.index({ assigneeIds: 1, status: 1 });
AiAgentTaskSchema.index({ leadId: 1, status: 1 });

const AiAgentTask = mongoose.model<IAiAgentTask>('AiAgentTask', AiAgentTaskSchema);

export default AiAgentTask;
