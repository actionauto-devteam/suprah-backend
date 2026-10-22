import mongoose, { Document, Schema } from 'mongoose';

export const TRAINING_POLICY_CATEGORIES = ['scenario_response', 'behavior', 'escalation', 'tone', 'knowledge'] as const;
export const BEHAVIORAL_TRAINING_CATEGORIES = ['scenario_response', 'behavior', 'escalation', 'tone'] as const;
export type TrainingPolicyCategory = (typeof TRAINING_POLICY_CATEGORIES)[number];

export const TRAINING_POLICY_CHANNELS = ['sms', 'webchat', 'email'] as const;
export type TrainingPolicyChannel = (typeof TRAINING_POLICY_CHANNELS)[number];

export const TRAINING_POLICY_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
  'published_shadow',
  'published_live',
  'retired',
] as const;
export type TrainingPolicyStatus = (typeof TRAINING_POLICY_STATUSES)[number];

export const TRAINING_POLICY_SOURCES = ['coaching_submission', 'manual', 'draft_evaluation', 'train_alex', 'podium_import'] as const;
export type TrainingPolicySource = (typeof TRAINING_POLICY_SOURCES)[number];

export interface TrainingActorRef {
  userId: string;
  name: string;
  role: string;
}

export const TRAINING_RULE_FORMATS = ['instruction', 'structured_v1'] as const;
export type TrainingRuleFormat = (typeof TRAINING_RULE_FORMATS)[number];

export interface TrainingPendingAudit {
  _id: mongoose.Types.ObjectId;
  action: string;
  actor: TrainingActorRef;
  version?: number;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  createdAt: Date;
}

export interface IAiTrainingPolicy extends Document {
  organizationId: string;
  title: string;
  category: TrainingPolicyCategory;
  channels: TrainingPolicyChannel[];
  status: TrainingPolicyStatus;
  source: TrainingPolicySource;
  sourceRef?: {
    leadId?: mongoose.Types.ObjectId;
    messageId?: string;
    messageModel?: 'CommunicationMessage' | 'WebChatMessage';
    channel?: 'sms' | 'webchat';
    aiLogId?: mongoose.Types.ObjectId;
    draftId?: mongoose.Types.ObjectId;
    importBatchId?: mongoose.Types.ObjectId;
    importItemId?: mongoose.Types.ObjectId;
    sourceSystem?: 'podium';
    sourceKey?: string;
    previousPolicyId?: mongoose.Types.ObjectId;
  };
  currentVersion: number;
  ruleFormat?: TrainingRuleFormat;
  submittedVersion?: number;
  adoptedVersions?: number[];
  lastEditedBy?: TrainingActorRef;
  pendingAudit?: TrainingPendingAudit[];
  createdBy: TrainingActorRef;
  submittedAt?: Date;
  lastReview?: { action: string; note?: string; by: TrainingActorRef; at: Date };
  approvedBy?: TrainingActorRef;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const TrainingActorSchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, trim: true, maxlength: 120 },
    role: { type: String, trim: true, maxlength: 30 },
  },
  { _id: false },
);

const AiTrainingPolicySchema: Schema<IAiTrainingPolicy> = new Schema(
  {
    organizationId: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, enum: TRAINING_POLICY_CATEGORIES, default: 'behavior', required: true },
    channels: { type: [{ type: String, enum: TRAINING_POLICY_CHANNELS }], default: ['sms', 'webchat'] },
    status: { type: String, enum: TRAINING_POLICY_STATUSES, default: 'draft', required: true },
    source: { type: String, enum: TRAINING_POLICY_SOURCES, required: true },
    sourceRef: {
      leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
      messageId: { type: String, trim: true, maxlength: 200 },
      messageModel: { type: String, enum: ['CommunicationMessage', 'WebChatMessage'] },
      channel: { type: String, enum: ['sms', 'webchat'] },
      aiLogId: { type: Schema.Types.ObjectId, ref: 'AiAgentLog' },
      draftId: { type: Schema.Types.ObjectId, ref: 'AiAgentDraft' },
      importBatchId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportBatch' },
      importItemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem' },
      sourceSystem: { type: String, enum: ['podium'] },
      sourceKey: { type: String, trim: true, maxlength: 64 },
      previousPolicyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy' },
    },
    currentVersion: { type: Number, default: 1, min: 1 },
    ruleFormat: { type: String, enum: TRAINING_RULE_FORMATS, default: 'instruction' },
    submittedVersion: { type: Number, min: 1 },
    adoptedVersions: { type: [Number], default: undefined },
    lastEditedBy: { type: TrainingActorSchema },
    pendingAudit: {
      type: [new Schema({
        action: { type: String, required: true, trim: true, maxlength: 60 },
        actor: { type: TrainingActorSchema, required: true },
        version: { type: Number },
        fromStatus: { type: String, trim: true, maxlength: 40 },
        toStatus: { type: String, trim: true, maxlength: 40 },
        note: { type: String, trim: true, maxlength: 500 },
        createdAt: { type: Date, required: true },
      })],
      default: undefined,
    },
    createdBy: { type: TrainingActorSchema, required: true },
    submittedAt: { type: Date },
    lastReview: {
      action: { type: String, trim: true, maxlength: 40 },
      note: { type: String, trim: true, maxlength: 500 },
      by: { type: TrainingActorSchema },
      at: { type: Date },
    },
    approvedBy: { type: TrainingActorSchema },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

AiTrainingPolicySchema.index({ organizationId: 1, status: 1, updatedAt: -1 }, { name: 'ai_training_org_status_recent' });
AiTrainingPolicySchema.index({ organizationId: 1, 'createdBy.userId': 1, updatedAt: -1 }, { name: 'ai_training_org_author_recent' });
AiTrainingPolicySchema.index({ organizationId: 1, source: 1, 'sourceRef.messageId': 1 }, { name: 'ai_training_org_source_message' });
AiTrainingPolicySchema.index({ organizationId: 1, 'sourceRef.importItemId': 1 }, { name: 'ai_training_org_import_item' });

const AiTrainingPolicy = mongoose.model<IAiTrainingPolicy>('AiTrainingPolicy', AiTrainingPolicySchema);

export default AiTrainingPolicy;
