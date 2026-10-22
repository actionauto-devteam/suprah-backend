import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const KNOWLEDGE_AUDIT_ACTIONS = [
  'entry_created',
  'version_saved',
  'entry_submitted',
  'changes_requested',
  'entry_approved',
  'entry_rejected',
  'entry_disabled',
  'entry_enabled',
  'entry_archived',
  'entry_restored',
  'approval_invalidated',
  'location_suspended',
  'knowledge_base_enabled',
  'knowledge_base_disabled',
  'detail_proposed',
  'detail_updated',
  'detail_approved',
  'detail_revoked',
  'detail_archived',
  'detail_reapproved',
  'detail_location_suspended',
] as const;
export type KnowledgeAuditAction = (typeof KNOWLEDGE_AUDIT_ACTIONS)[number];

export interface IAiKnowledgeAuditLog extends Document {
  organizationId: string;
  entryId?: mongoose.Types.ObjectId;
  detailId?: mongoose.Types.ObjectId;
  locationId?: mongoose.Types.ObjectId;
  action: KnowledgeAuditAction;
  version?: number;
  fromStatus?: string;
  toStatus?: string;
  fromLifecycle?: string;
  toLifecycle?: string;
  note?: string;
  actor: TrainingActorRef;
  createdAt: Date;
}

const AiKnowledgeAuditLogSchema: Schema<IAiKnowledgeAuditLog> = new Schema(
  {
    organizationId: { type: String, required: true },
    entryId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeEntry' },
    detailId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeVerifiedDetail' },
    locationId: { type: Schema.Types.ObjectId, ref: 'CrmLocation' },
    action: { type: String, enum: KNOWLEDGE_AUDIT_ACTIONS, required: true },
    version: { type: Number, min: 1 },
    fromStatus: { type: String, trim: true, maxlength: 40 },
    toStatus: { type: String, trim: true, maxlength: 40 },
    fromLifecycle: { type: String, trim: true, maxlength: 40 },
    toLifecycle: { type: String, trim: true, maxlength: 40 },
    note: { type: String, trim: true, maxlength: 500 },
    actor: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiKnowledgeAuditLogSchema.index({ organizationId: 1, entryId: 1, createdAt: -1 }, { name: 'ai_kb_audit_entry' });
AiKnowledgeAuditLogSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_kb_audit_org_recent' });
AiKnowledgeAuditLogSchema.index({ organizationId: 1, detailId: 1, createdAt: -1 }, { name: 'ai_kb_audit_detail' });
makeAppendOnly(AiKnowledgeAuditLogSchema, 'AiKnowledgeAuditLog');

const AiKnowledgeAuditLog = mongoose.model<IAiKnowledgeAuditLog>('AiKnowledgeAuditLog', AiKnowledgeAuditLogSchema);

export default AiKnowledgeAuditLog;
