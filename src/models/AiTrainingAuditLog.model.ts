import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const TRAINING_AUDIT_ACTIONS = [
  'proposal_submitted',
  'proposal_drafted',
  'draft_saved',
  'review_edited',
  'integrity_repaired',
  'proposal_revised',
  'proposal_withdrawn',
  'proposal_changes_requested',
  'proposal_approved',
  'proposal_rejected',
  'training_enabled',
  'training_disabled',
  'draft_evaluated',
  'legacy_coaching_created',
  'legacy_coaching_updated',
  'legacy_coaching_deleted',
  'import_committed',
  'import_content_purged',
] as const;
export type TrainingAuditAction = (typeof TRAINING_AUDIT_ACTIONS)[number];

export interface IAiTrainingAuditLog extends Document {
  organizationId: string;
  action: TrainingAuditAction;
  policyId?: mongoose.Types.ObjectId;
  version?: number;
  draftId?: mongoose.Types.ObjectId;
  evaluationId?: mongoose.Types.ObjectId;
  legacyCoachingRuleId?: mongoose.Types.ObjectId;
  importBatchId?: mongoose.Types.ObjectId;
  importItemId?: mongoose.Types.ObjectId;
  actor: TrainingActorRef;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  createdAt: Date;
}

const AiTrainingAuditLogSchema: Schema<IAiTrainingAuditLog> = new Schema(
  {
    organizationId: { type: String, required: true },
    action: { type: String, enum: TRAINING_AUDIT_ACTIONS, required: true },
    policyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy' },
    version: { type: Number },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiAgentDraft' },
    evaluationId: { type: Schema.Types.ObjectId, ref: 'AiDraftEvaluation' },
    legacyCoachingRuleId: { type: Schema.Types.ObjectId, ref: 'AiAgentCoachingRule' },
    importBatchId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportBatch' },
    importItemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem' },
    actor: { type: TrainingActorSchema, required: true },
    fromStatus: { type: String, trim: true, maxlength: 40 },
    toStatus: { type: String, trim: true, maxlength: 40 },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingAuditLogSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_training_audit_org_recent' });
AiTrainingAuditLogSchema.index({ organizationId: 1, policyId: 1, createdAt: 1 }, { name: 'ai_training_audit_org_policy' });
AiTrainingAuditLogSchema.index({ organizationId: 1, importBatchId: 1, createdAt: 1 }, { name: 'ai_training_audit_org_import', partialFilterExpression: { importBatchId: { $exists: true } } });
makeAppendOnly(AiTrainingAuditLogSchema, 'AiTrainingAuditLog');

const AiTrainingAuditLog = mongoose.model<IAiTrainingAuditLog>('AiTrainingAuditLog', AiTrainingAuditLogSchema);

export default AiTrainingAuditLog;
