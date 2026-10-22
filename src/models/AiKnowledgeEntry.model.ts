import mongoose, { Document, Schema } from 'mongoose';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const KNOWLEDGE_ENTRY_KINDS = ['faq', 'business_info'] as const;
export type KnowledgeEntryKind = (typeof KNOWLEDGE_ENTRY_KINDS)[number];

export const KNOWLEDGE_BASE_TOPICS = [
  'hours', 'address_directions', 'contact', 'departments', 'test_drives', 'appointments', 'documents_required',
  'trade_in_process', 'financing_process', 'delivery_shipping', 'service', 'warranty', 'general',
] as const;
export type KnowledgeBaseTopic = (typeof KNOWLEDGE_BASE_TOPICS)[number];

export const KNOWLEDGE_ENTRY_STATUSES = ['draft', 'in_review', 'changes_requested', 'approved', 'rejected'] as const;
export type KnowledgeEntryStatus = (typeof KNOWLEDGE_ENTRY_STATUSES)[number];

export const KNOWLEDGE_ENTRY_LIFECYCLES = ['active', 'disabled', 'archived'] as const;
export type KnowledgeEntryLifecycle = (typeof KNOWLEDGE_ENTRY_LIFECYCLES)[number];

export const KNOWLEDGE_CHANNELS = ['sms', 'webchat', 'email'] as const;
export type KnowledgeChannel = (typeof KNOWLEDGE_CHANNELS)[number];

export const KNOWLEDGE_SOURCE_SYSTEMS = ['manual', 'podium_import'] as const;
export type KnowledgeSourceSystem = (typeof KNOWLEDGE_SOURCE_SYSTEMS)[number];

export interface KnowledgeLocationScope {
  scope: 'all' | 'locations';
  locationIds: mongoose.Types.ObjectId[];
}

export interface KnowledgeSource {
  system: KnowledgeSourceSystem;
  importBatchId?: mongoose.Types.ObjectId;
  importBatchNumber?: number;
  importItemId?: mongoose.Types.ObjectId;
  sourceKey?: string;
  keyRevision?: number;
  sourceRef?: string;
  sourceLocationLabel?: string;
  sourceStatus?: 'on' | 'off';
}

export interface KnowledgeDependency {
  detailId: mongoose.Types.ObjectId;
  revision: number;
}

export const KNOWLEDGE_INVALIDATION_REASONS = ['detail_changed', 'detail_revoked', 'detail_archived', 'entry_restored'] as const;
export type KnowledgeInvalidationReason = (typeof KNOWLEDGE_INVALIDATION_REASONS)[number];

export interface KnowledgeApprovalInvalidation {
  reason: KnowledgeInvalidationReason;
  at: Date;
  detailId?: mongoose.Types.ObjectId;
  by?: TrainingActorRef;
}

export interface KnowledgePendingAudit {
  _id: mongoose.Types.ObjectId;
  action: string;
  actor: TrainingActorRef;
  version?: number;
  fromStatus?: string;
  toStatus?: string;
  fromLifecycle?: string;
  toLifecycle?: string;
  detailId?: mongoose.Types.ObjectId;
  locationId?: mongoose.Types.ObjectId;
  note?: string;
  createdAt: Date;
}

export interface IAiKnowledgeEntry extends Document {
  organizationId: string;
  kind: KnowledgeEntryKind;
  topic: KnowledgeBaseTopic;
  title: string;
  question?: string;
  questionKey: string;
  channels: KnowledgeChannel[];
  locationScope: KnowledgeLocationScope;
  status: KnowledgeEntryStatus;
  lifecycle: KnowledgeEntryLifecycle;
  currentVersion: number;
  submittedVersion?: number;
  approvedVersion?: number;
  approvedKey?: string;
  approvedLocationScope?: KnowledgeLocationScope;
  approvedDependencies?: KnowledgeDependency[];
  approvalInvalidation?: KnowledgeApprovalInvalidation;
  approvalSuspendedLocationIds?: mongoose.Types.ObjectId[];
  source: KnowledgeSource;
  createdBy: TrainingActorRef;
  lastEditedBy?: TrainingActorRef;
  submittedAt?: Date;
  submittedBy?: TrainingActorRef;
  lastReview?: { action: string; note?: string; by: TrainingActorRef; at: Date };
  approvedBy?: TrainingActorRef;
  approvedAt?: Date;
  disabledAt?: Date;
  disabledBy?: TrainingActorRef;
  archivedAt?: Date;
  archivedBy?: TrainingActorRef;
  restoredAt?: Date;
  restoredBy?: TrainingActorRef;
  pendingAudit?: KnowledgePendingAudit[];
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeLocationScopeSchema = new Schema(
  {
    scope: { type: String, enum: ['all', 'locations'], required: true },
    locationIds: { type: [{ type: Schema.Types.ObjectId, ref: 'CrmLocation' }], default: [] },
  },
  { _id: false },
);

const AiKnowledgeEntrySchema: Schema<IAiKnowledgeEntry> = new Schema(
  {
    organizationId: { type: String, required: true },
    kind: { type: String, enum: KNOWLEDGE_ENTRY_KINDS, required: true, immutable: true },
    topic: { type: String, enum: KNOWLEDGE_BASE_TOPICS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    question: { type: String, trim: true, maxlength: 300 },
    questionKey: { type: String, required: true, maxlength: 400 },
    channels: { type: [{ type: String, enum: KNOWLEDGE_CHANNELS }], default: ['sms', 'webchat', 'email'] },
    locationScope: { type: KnowledgeLocationScopeSchema, required: true },
    status: { type: String, enum: KNOWLEDGE_ENTRY_STATUSES, required: true, default: 'draft' },
    lifecycle: { type: String, enum: KNOWLEDGE_ENTRY_LIFECYCLES, required: true, default: 'active' },
    currentVersion: { type: Number, required: true, min: 1, default: 1 },
    submittedVersion: { type: Number, min: 1 },
    approvedVersion: { type: Number, min: 1 },
    approvedKey: { type: String, maxlength: 400 },
    approvedLocationScope: { type: KnowledgeLocationScopeSchema },
    approvedDependencies: {
      type: [new Schema({
        detailId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeVerifiedDetail', required: true },
        revision: { type: Number, required: true, min: 1 },
      }, { _id: false })],
      default: undefined,
    },
    approvalInvalidation: {
      type: new Schema({
        reason: { type: String, enum: KNOWLEDGE_INVALIDATION_REASONS, required: true },
        at: { type: Date, required: true },
        detailId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeVerifiedDetail' },
        by: { type: TrainingActorSchema },
      }, { _id: false }),
      default: undefined,
    },
    approvalSuspendedLocationIds: { type: [{ type: Schema.Types.ObjectId, ref: 'CrmLocation' }], default: undefined },
    source: {
      system: { type: String, enum: KNOWLEDGE_SOURCE_SYSTEMS, required: true, default: 'manual' },
      importBatchId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportBatch' },
      importBatchNumber: { type: Number, min: 1 },
      importItemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem' },
      sourceKey: { type: String, match: /^[a-f0-9]{64}$/ },
      keyRevision: { type: Number, min: 1 },
      sourceRef: { type: String, trim: true, maxlength: 120 },
      sourceLocationLabel: { type: String, trim: true, maxlength: 80 },
      sourceStatus: { type: String, enum: ['on', 'off'] },
    },
    createdBy: { type: TrainingActorSchema, required: true },
    lastEditedBy: { type: TrainingActorSchema },
    submittedAt: { type: Date },
    submittedBy: { type: TrainingActorSchema },
    lastReview: {
      action: { type: String, trim: true, maxlength: 40 },
      note: { type: String, trim: true, maxlength: 500 },
      by: { type: TrainingActorSchema },
      at: { type: Date },
    },
    approvedBy: { type: TrainingActorSchema },
    approvedAt: { type: Date },
    disabledAt: { type: Date },
    disabledBy: { type: TrainingActorSchema },
    archivedAt: { type: Date },
    archivedBy: { type: TrainingActorSchema },
    restoredAt: { type: Date },
    restoredBy: { type: TrainingActorSchema },
    pendingAudit: {
      type: [new Schema({
        action: { type: String, required: true, trim: true, maxlength: 60 },
        actor: { type: TrainingActorSchema, required: true },
        version: { type: Number },
        fromStatus: { type: String, trim: true, maxlength: 40 },
        toStatus: { type: String, trim: true, maxlength: 40 },
        fromLifecycle: { type: String, trim: true, maxlength: 40 },
        toLifecycle: { type: String, trim: true, maxlength: 40 },
        detailId: { type: Schema.Types.ObjectId },
        locationId: { type: Schema.Types.ObjectId },
        note: { type: String, trim: true, maxlength: 500 },
        createdAt: { type: Date, required: true },
      })],
      default: undefined,
    },
  },
  { timestamps: true },
);

AiKnowledgeEntrySchema.index({ organizationId: 1, lifecycle: 1, status: 1, updatedAt: -1 }, { name: 'ai_kb_org_state' });
AiKnowledgeEntrySchema.index({ organizationId: 1, kind: 1, questionKey: 1 }, { name: 'ai_kb_org_key' });
AiKnowledgeEntrySchema.index({ organizationId: 1, kind: 1, approvedKey: 1, lifecycle: 1 }, { name: 'ai_kb_org_approved_key' });
AiKnowledgeEntrySchema.index({ organizationId: 1, 'locationScope.locationIds': 1 }, { name: 'ai_kb_org_location' });
AiKnowledgeEntrySchema.index({ organizationId: 1, 'approvedLocationScope.locationIds': 1 }, { name: 'ai_kb_org_approved_location' });
AiKnowledgeEntrySchema.index({ organizationId: 1, 'approvedDependencies.detailId': 1 }, { name: 'ai_kb_org_dependency' });
AiKnowledgeEntrySchema.index(
  { organizationId: 1, 'source.sourceKey': 1 },
  { unique: true, name: 'ai_kb_org_source_key', partialFilterExpression: { 'source.sourceKey': { $type: 'string' } } },
);
AiKnowledgeEntrySchema.index(
  { organizationId: 1, 'source.importItemId': 1 },
  { unique: true, name: 'ai_kb_org_import_item', partialFilterExpression: { 'source.importItemId': { $type: 'objectId' } } },
);

const AiKnowledgeEntry = mongoose.model<IAiKnowledgeEntry>('AiKnowledgeEntry', AiKnowledgeEntrySchema);

export default AiKnowledgeEntry;
