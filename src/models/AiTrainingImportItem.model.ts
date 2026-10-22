import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const IMPORT_ITEM_TYPES = ['rule', 'escalation', 'tone', 'faq', 'business_info', 'template', 'automation', 'example'] as const;
export type ImportItemType = (typeof IMPORT_ITEM_TYPES)[number];

export const IMPORT_ITEM_STATUSES = [
  'ready',
  'ready_with_warnings',
  'changed',
  'unchanged',
  'duplicate_in_file',
  'needs_location',
  'blocked_privacy',
  'blocked_guardrail',
  'blocked_safety_bypass',
  'invalid',
  'parked_knowledge',
  'reference_only',
  'unsupported',
] as const;
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUSES)[number];

export const IMPORT_TARGET_KINDS = ['none', 'proposal_created', 'proposal_version', 'proposal_linked', 'parked_knowledge', 'reference'] as const;
export type ImportTargetKind = (typeof IMPORT_TARGET_KINDS)[number];

export const IMPORT_RETENTION_CLASSES = ['converted', 'parked', 'rejected'] as const;
export type ImportRetentionClass = (typeof IMPORT_RETENTION_CLASSES)[number];

export interface IAiTrainingImportItem extends Document {
  organizationId: string;
  batchId: mongoose.Types.ObjectId;
  batchNumber: number;
  rowNumber: number;
  type: string;
  status: ImportItemStatus;
  issueCodes: string[];
  sourceKey?: string;
  keyRevision?: number;
  fingerprint: string;
  sourceRef?: string;
  sourceLocationLabel?: string;
  sourceStatus?: 'on' | 'off';
  locationScope: { kind: 'all' | 'location' | 'none'; locationId?: mongoose.Types.ObjectId; locationCode?: string };
  title?: string;
  target: {
    kind: ImportTargetKind;
    policyId?: mongoose.Types.ObjectId;
    version?: number;
    previousPolicyId?: mongoose.Types.ObjectId;
    previousItemId?: mongoose.Types.ObjectId;
  };
  contentRetained: boolean;
  retentionClass?: ImportRetentionClass;
  contentExpiresAt?: Date;
  nameReview?: { by: TrainingActorRef; at: Date };
  createdAt: Date;
}

const AiTrainingImportItemSchema: Schema<IAiTrainingImportItem> = new Schema(
  {
    organizationId: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportBatch', required: true },
    batchNumber: { type: Number, required: true, min: 1 },
    rowNumber: { type: Number, required: true, min: 1 },
    type: { type: String, required: true, trim: true, maxlength: 30 },
    status: { type: String, enum: IMPORT_ITEM_STATUSES, required: true },
    issueCodes: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] },
    sourceKey: { type: String, match: /^[a-f0-9]{64}$/ },
    keyRevision: { type: Number, min: 1 },
    fingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    sourceRef: { type: String, trim: true, maxlength: 120 },
    sourceLocationLabel: { type: String, trim: true, maxlength: 80 },
    sourceStatus: { type: String, enum: ['on', 'off'] },
    locationScope: {
      kind: { type: String, enum: ['all', 'location', 'none'], required: true },
      locationId: { type: Schema.Types.ObjectId, ref: 'CrmLocation' },
      locationCode: { type: String, trim: true, maxlength: 40 },
    },
    title: { type: String, trim: true, maxlength: 120 },
    target: {
      kind: { type: String, enum: IMPORT_TARGET_KINDS, required: true },
      policyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy' },
      version: { type: Number, min: 1 },
      previousPolicyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy' },
      previousItemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem' },
    },
    contentRetained: { type: Boolean, required: true },
    retentionClass: { type: String, enum: IMPORT_RETENTION_CLASSES },
    contentExpiresAt: { type: Date },
    nameReview: {
      by: { type: TrainingActorSchema },
      at: { type: Date },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingImportItemSchema.index({ organizationId: 1, batchId: 1, rowNumber: 1 }, { unique: true, name: 'ai_import_item_batch_row' });
AiTrainingImportItemSchema.index({ organizationId: 1, batchId: 1, status: 1, rowNumber: 1 }, { name: 'ai_import_item_batch_status' });
AiTrainingImportItemSchema.index({ organizationId: 1, sourceKey: 1, createdAt: -1 }, { name: 'ai_import_item_org_key' });
AiTrainingImportItemSchema.index(
  { organizationId: 1, sourceKey: 1, keyRevision: 1 },
  { unique: true, name: 'ai_import_item_key_revision', partialFilterExpression: { keyRevision: { $exists: true } } },
);
AiTrainingImportItemSchema.index({ organizationId: 1, fingerprint: 1 }, { name: 'ai_import_item_org_fingerprint' });
AiTrainingImportItemSchema.index({ organizationId: 1, 'target.policyId': 1 }, { name: 'ai_import_item_org_policy' });
makeAppendOnly(AiTrainingImportItemSchema, 'AiTrainingImportItem');

const AiTrainingImportItem = mongoose.model<IAiTrainingImportItem>('AiTrainingImportItem', AiTrainingImportItemSchema);

export default AiTrainingImportItem;
