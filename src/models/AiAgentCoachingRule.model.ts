import mongoose, { Document, Schema } from 'mongoose';

export type AiAgentCoachingStatus = 'active' | 'disabled' | 'deleted';
export type AiAgentCoachingChannel = 'all' | 'sms' | 'webchat';
export type AiAgentCoachingSourceModel = 'CommunicationMessage' | 'WebChatMessage';

export interface IAiAgentCoachingRule extends Document {
  organizationId: string;
  scope: 'organization';
  channel: AiAgentCoachingChannel;
  instruction: string;
  status: AiAgentCoachingStatus;
  sourceLeadId: mongoose.Types.ObjectId;
  sourceMessageId: mongoose.Types.ObjectId;
  sourceMessageModel: AiAgentCoachingSourceModel;
  sourceAiLogId?: mongoose.Types.ObjectId;
  originalAiMessageSnapshot: string;
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  updatedBy?: mongoose.Types.ObjectId;
  disabledBy?: mongoose.Types.ObjectId;
  deletedBy?: mongoose.Types.ObjectId;
  disabledAt?: Date;
  deletedAt?: Date;
  usageCount: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AiAgentCoachingRuleSchema: Schema<IAiAgentCoachingRule> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    scope: { type: String, enum: ['organization'], default: 'organization', required: true },
    channel: { type: String, enum: ['all', 'sms', 'webchat'], default: 'all', index: true },
    instruction: { type: String, required: true, trim: true, maxlength: 800 },
    status: {
      type: String,
      enum: ['active', 'disabled', 'deleted'],
      default: 'active',
      required: true,
      index: true,
    },
    sourceLeadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    sourceMessageId: { type: Schema.Types.ObjectId, required: true, index: true },
    sourceMessageModel: {
      type: String,
      enum: ['CommunicationMessage', 'WebChatMessage'],
      required: true,
    },
    sourceAiLogId: { type: Schema.Types.ObjectId, ref: 'AiAgentLog' },
    originalAiMessageSnapshot: { type: String, required: true, trim: true, maxlength: 1200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    createdByName: { type: String, trim: true, maxlength: 120 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    disabledBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    disabledAt: { type: Date },
    deletedAt: { type: Date },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

AiAgentCoachingRuleSchema.index({ organizationId: 1, status: 1, channel: 1, updatedAt: -1 });
AiAgentCoachingRuleSchema.index({ organizationId: 1, sourceMessageId: 1 });
AiAgentCoachingRuleSchema.index({ sourceLeadId: 1, createdAt: -1 });

const AiAgentCoachingRule = mongoose.model<IAiAgentCoachingRule>(
  'AiAgentCoachingRule',
  AiAgentCoachingRuleSchema,
);

export default AiAgentCoachingRule;
