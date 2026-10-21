import mongoose, { Document, Schema } from 'mongoose';

export const AI_DRAFT_CHANNELS = ['sms', 'email', 'webchat'] as const;
export type AiDraftChannel = (typeof AI_DRAFT_CHANNELS)[number];

export const AI_DRAFT_STATUSES = [
  'claimed',
  'generating',
  'ready',
  'blocked_safety',
  'needs_human',
  'skipped_cap',
  'skipped_attention',
  'skipped_technical',
  'failed',
] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

export const AI_DRAFT_TERMINAL_STATUSES: AiDraftStatus[] = ['ready', 'blocked_safety', 'needs_human', 'skipped_cap', 'skipped_attention', 'skipped_technical', 'failed'];

export const AI_DRAFT_SOURCE_MODELS = ['CommunicationMessage', 'WebChatMessage', 'Lead'] as const;
export type AiDraftSourceModel = (typeof AI_DRAFT_SOURCE_MODELS)[number];

export const AI_DRAFT_RETENTION_DAYS = 90;

export interface IAiAgentDraft extends Document {
  organizationId: string;
  channel: AiDraftChannel;
  sourceMessageId: string;
  sourceMessageModel: AiDraftSourceModel;
  leadId?: mongoose.Types.ObjectId;
  conversationId?: mongoose.Types.ObjectId;
  sessionId?: mongoose.Types.ObjectId;
  inquiryReceivedAt?: Date;
  status: AiDraftStatus;
  statusReason?: string;
  modeAtClaim?: string;
  leaseId?: string;
  leaseExpiresAt?: Date;
  attemptCount: number;
  usageDay?: string;
  draftText?: string;
  kind?: 'reply' | 'vehicle_clarification';
  handoffReason?: string;
  deterministicOk?: boolean;
  deterministicReasons?: string[];
  classifierVerdict?: 'SAFE' | 'UNSAFE' | 'ERROR';
  vehicleResolution?: string;
  coachingRuleIds?: string[];
  coachingVerdict?: 'compliant' | 'violates' | 'not_applicable' | 'error' | 'not_checked';
  wouldHaveBeenCapped?: boolean;
  aiModel?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  aiCallCount?: number;
  failureReason?: string;
  generationStartedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AiAgentDraftSchema: Schema<IAiAgentDraft> = new Schema(
  {
    organizationId: { type: String, required: true },
    channel: { type: String, enum: AI_DRAFT_CHANNELS, required: true },
    sourceMessageId: { type: String, required: true, trim: true, maxlength: 200 },
    sourceMessageModel: { type: String, enum: AI_DRAFT_SOURCE_MODELS, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    conversationId: { type: Schema.Types.ObjectId },
    sessionId: { type: Schema.Types.ObjectId },
    inquiryReceivedAt: { type: Date },
    status: { type: String, enum: AI_DRAFT_STATUSES, default: 'claimed', required: true },
    statusReason: { type: String, trim: true, maxlength: 500 },
    modeAtClaim: { type: String, trim: true, maxlength: 20 },
    leaseId: { type: String },
    leaseExpiresAt: { type: Date },
    attemptCount: { type: Number, default: 0 },
    usageDay: { type: String },
    draftText: { type: String, maxlength: 4000 },
    kind: { type: String, enum: ['reply', 'vehicle_clarification'] },
    handoffReason: { type: String, trim: true, maxlength: 500 },
    deterministicOk: { type: Boolean },
    deterministicReasons: { type: [String], default: undefined },
    classifierVerdict: { type: String, enum: ['SAFE', 'UNSAFE', 'ERROR'] },
    vehicleResolution: { type: String, trim: true, maxlength: 40 },
    coachingRuleIds: { type: [String], default: undefined },
    coachingVerdict: { type: String, enum: ['compliant', 'violates', 'not_applicable', 'error', 'not_checked'] },
    wouldHaveBeenCapped: { type: Boolean },
    aiModel: { type: String, trim: true, maxlength: 120 },
    latencyMs: { type: Number },
    promptTokens: { type: Number },
    completionTokens: { type: Number },
    totalTokens: { type: Number },
    aiCallCount: { type: Number },
    failureReason: { type: String, trim: true, maxlength: 500 },
    generationStartedAt: { type: Date },
    completedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

AiAgentDraftSchema.index({ organizationId: 1, channel: 1, sourceMessageId: 1 }, { unique: true, name: 'ai_draft_source_unique' });
AiAgentDraftSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_draft_org_recent' });
AiAgentDraftSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 }, { name: 'ai_draft_org_lead_recent' });
AiAgentDraftSchema.index({ organizationId: 1, status: 1, leaseExpiresAt: 1 }, { name: 'ai_draft_org_lease' });
AiAgentDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ai_draft_retention_ttl' });

const AiAgentDraft = mongoose.model<IAiAgentDraft>('AiAgentDraft', AiAgentDraftSchema);

export default AiAgentDraft;
