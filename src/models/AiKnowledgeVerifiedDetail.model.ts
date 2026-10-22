import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';
import { KnowledgeLocationScopeSchema, type KnowledgeLocationScope } from './AiKnowledgeEntry.model';

export const VERIFIED_DETAIL_KINDS = ['phone', 'email', 'website', 'program'] as const;
export type VerifiedDetailKind = (typeof VERIFIED_DETAIL_KINDS)[number];

export const VERIFIED_DETAIL_STATUSES = ['pending', 'approved', 'revoked', 'archived'] as const;
export type VerifiedDetailStatus = (typeof VERIFIED_DETAIL_STATUSES)[number];

export const VERIFIED_PROGRAM_TYPES = ['military', 'first_responder', 'educator', 'healthcare', 'college_graduate', 'loyalty', 'other'] as const;
export type VerifiedProgramType = (typeof VERIFIED_PROGRAM_TYPES)[number];

export interface VerifiedDetailContent {
  kind: VerifiedDetailKind;
  value: string;
  normalizedValue: string;
  label?: string;
  programType?: VerifiedProgramType;
  locationScope: KnowledgeLocationScope;
}

export interface IAiKnowledgeVerifiedDetail extends Document, VerifiedDetailContent {
  organizationId: string;
  status: VerifiedDetailStatus;
  revision: number;
  proposedBy: TrainingActorRef;
  approvedBy?: TrainingActorRef;
  approvedAt?: Date;
  revokedBy?: TrainingActorRef;
  revokedAt?: Date;
  archivedBy?: TrainingActorRef;
  archivedAt?: Date;
  suspendedLocationIds?: mongoose.Types.ObjectId[];
  reapprovedBy?: TrainingActorRef;
  reapprovedAt?: Date;
  lockSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

const contentFields = () => ({
  kind: { type: String, enum: VERIFIED_DETAIL_KINDS, required: true },
  value: { type: String, required: true, trim: true, maxlength: 200 },
  normalizedValue: { type: String, required: true, trim: true, maxlength: 200 },
  label: { type: String, trim: true, maxlength: 80 },
  programType: { type: String, enum: VERIFIED_PROGRAM_TYPES },
  locationScope: { type: KnowledgeLocationScopeSchema, required: true },
});

const AiKnowledgeVerifiedDetailSchema: Schema<IAiKnowledgeVerifiedDetail> = new Schema(
  {
    organizationId: { type: String, required: true },
    ...contentFields(),
    kind: { type: String, enum: VERIFIED_DETAIL_KINDS, required: true, immutable: true },
    status: { type: String, enum: VERIFIED_DETAIL_STATUSES, required: true, default: 'pending' },
    revision: { type: Number, required: true, min: 1, default: 1 },
    proposedBy: { type: TrainingActorSchema, required: true },
    approvedBy: { type: TrainingActorSchema },
    approvedAt: { type: Date },
    revokedBy: { type: TrainingActorSchema },
    revokedAt: { type: Date },
    archivedBy: { type: TrainingActorSchema },
    archivedAt: { type: Date },
    suspendedLocationIds: { type: [{ type: Schema.Types.ObjectId, ref: 'CrmLocation' }], default: undefined },
    reapprovedBy: { type: TrainingActorSchema },
    reapprovedAt: { type: Date },
    lockSeq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

AiKnowledgeVerifiedDetailSchema.index({ organizationId: 1, kind: 1, normalizedValue: 1, status: 1 }, { name: 'ai_kb_detail_org_value' });
AiKnowledgeVerifiedDetailSchema.index({ organizationId: 1, status: 1, kind: 1, updatedAt: -1 }, { name: 'ai_kb_detail_org_status' });
AiKnowledgeVerifiedDetailSchema.index({ organizationId: 1, 'locationScope.locationIds': 1 }, { name: 'ai_kb_detail_org_location' });

export const AiKnowledgeVerifiedDetail = mongoose.model<IAiKnowledgeVerifiedDetail>('AiKnowledgeVerifiedDetail', AiKnowledgeVerifiedDetailSchema);

export interface IAiKnowledgeVerifiedDetailRevision extends Document, VerifiedDetailContent {
  organizationId: string;
  detailId: mongoose.Types.ObjectId;
  revision: number;
  createdBy: TrainingActorRef;
  createdAt: Date;
}

const AiKnowledgeVerifiedDetailRevisionSchema: Schema<IAiKnowledgeVerifiedDetailRevision> = new Schema(
  {
    organizationId: { type: String, required: true },
    detailId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeVerifiedDetail', required: true },
    revision: { type: Number, required: true, min: 1 },
    ...contentFields(),
    createdBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiKnowledgeVerifiedDetailRevisionSchema.index({ detailId: 1, revision: 1 }, { unique: true, name: 'ai_kb_detail_revision' });
AiKnowledgeVerifiedDetailRevisionSchema.index({ organizationId: 1, detailId: 1, revision: -1 }, { name: 'ai_kb_detail_revision_org' });
makeAppendOnly(AiKnowledgeVerifiedDetailRevisionSchema, 'AiKnowledgeVerifiedDetailRevision');

export const AiKnowledgeVerifiedDetailRevision = mongoose.model<IAiKnowledgeVerifiedDetailRevision>(
  'AiKnowledgeVerifiedDetailRevision',
  AiKnowledgeVerifiedDetailRevisionSchema,
);

export default AiKnowledgeVerifiedDetail;
