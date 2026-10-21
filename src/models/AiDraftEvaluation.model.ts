import mongoose, { Document, Schema } from 'mongoose';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const DRAFT_EVALUATION_RATINGS = ['good', 'needs_edit', 'wrong', 'unsafe'] as const;
export type DraftEvaluationRating = (typeof DRAFT_EVALUATION_RATINGS)[number];

export const DRAFT_EVALUATION_TAGS = [
  'wrong_facts',
  'missed_question',
  'should_escalate',
  'tone',
  'too_long',
  'unsafe_claim',
  'other',
] as const;
export type DraftEvaluationTag = (typeof DRAFT_EVALUATION_TAGS)[number];

export const DRAFT_EVALUATION_RETENTION_DAYS = 365;

export interface IAiDraftEvaluation extends Document {
  organizationId: string;
  draftId: mongoose.Types.ObjectId;
  rating: DraftEvaluationRating;
  correctedReply?: string;
  reasonTags: DraftEvaluationTag[];
  note?: string;
  evaluator: TrainingActorRef;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AiDraftEvaluationSchema: Schema<IAiDraftEvaluation> = new Schema(
  {
    organizationId: { type: String, required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiAgentDraft', required: true },
    rating: { type: String, enum: DRAFT_EVALUATION_RATINGS, required: true },
    correctedReply: { type: String, trim: true, maxlength: 1000 },
    reasonTags: { type: [{ type: String, enum: DRAFT_EVALUATION_TAGS }], default: [] },
    note: { type: String, trim: true, maxlength: 500 },
    evaluator: { type: TrainingActorSchema, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

AiDraftEvaluationSchema.index({ organizationId: 1, draftId: 1, 'evaluator.userId': 1 }, { unique: true, name: 'ai_draft_eval_unique' });
AiDraftEvaluationSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_draft_eval_org_recent' });
AiDraftEvaluationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ai_draft_eval_retention_ttl' });

const AiDraftEvaluation = mongoose.model<IAiDraftEvaluation>('AiDraftEvaluation', AiDraftEvaluationSchema);

export default AiDraftEvaluation;
