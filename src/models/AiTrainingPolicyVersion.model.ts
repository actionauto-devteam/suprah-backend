import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const TRAINING_RULE_HANDLING = ['ai_handles', 'ask_clarifying', 'escalate'] as const;
export type TrainingRuleHandling = (typeof TRAINING_RULE_HANDLING)[number];

export interface TrainingPolicySpec {
  format?: 'instruction' | 'structured_v1';
  title?: string;
  category?: string;
  channels?: string[];
  intent?: string;
  triggers?: string[];
  handling?: TrainingRuleHandling;
  instruction: string;
  guidance?: string;
  triggerDescription?: string;
  requiredQuestions?: string[];
  mustInclude?: string[];
  mustAvoid?: string[];
  escalation?: { when?: string; handoffReason?: string };
  examples?: Array<{ customerMessage: string; idealReply: string }>;
}

export interface IAiTrainingPolicyVersion extends Document {
  organizationId: string;
  policyId: mongoose.Types.ObjectId;
  version: number;
  spec: TrainingPolicySpec;
  originalAiMessageSnapshot?: string;
  changeNote?: string;
  createdBy: TrainingActorRef;
  createdAt: Date;
}

const AiTrainingPolicyVersionSchema: Schema<IAiTrainingPolicyVersion> = new Schema(
  {
    organizationId: { type: String, required: true },
    policyId: { type: Schema.Types.ObjectId, ref: 'AiTrainingPolicy', required: true },
    version: { type: Number, required: true, min: 1 },
    spec: {
      format: { type: String, enum: ['instruction', 'structured_v1'] },
      title: { type: String, trim: true, maxlength: 120 },
      category: { type: String, trim: true, maxlength: 40 },
      channels: { type: [{ type: String, enum: ['sms', 'webchat', 'email'] }], default: undefined },
      intent: { type: String, trim: true, maxlength: 120 },
      triggers: { type: [{ type: String, trim: true, maxlength: 120 }], default: undefined },
      handling: { type: String, enum: TRAINING_RULE_HANDLING },
      instruction: { type: String, required: true, trim: true, maxlength: 800 },
      guidance: { type: String, trim: true, maxlength: 600 },
      triggerDescription: { type: String, trim: true, maxlength: 300 },
      requiredQuestions: { type: [{ type: String, trim: true, maxlength: 200 }], default: undefined },
      mustInclude: { type: [{ type: String, trim: true, maxlength: 200 }], default: undefined },
      mustAvoid: { type: [{ type: String, trim: true, maxlength: 200 }], default: undefined },
      escalation: {
        when: { type: String, trim: true, maxlength: 300 },
        handoffReason: { type: String, trim: true, maxlength: 200 },
      },
      examples: {
        type: [{
          _id: false,
          customerMessage: { type: String, required: true, trim: true, maxlength: 500 },
          idealReply: { type: String, required: true, trim: true, maxlength: 600 },
        }],
        default: undefined,
      },
    },
    originalAiMessageSnapshot: { type: String, trim: true, maxlength: 1200 },
    changeNote: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingPolicyVersionSchema.index({ policyId: 1, version: 1 }, { unique: true, name: 'ai_training_version_unique' });
AiTrainingPolicyVersionSchema.index({ organizationId: 1, policyId: 1, version: -1 }, { name: 'ai_training_version_org_policy' });
makeAppendOnly(AiTrainingPolicyVersionSchema, 'AiTrainingPolicyVersion');

const AiTrainingPolicyVersion = mongoose.model<IAiTrainingPolicyVersion>('AiTrainingPolicyVersion', AiTrainingPolicyVersionSchema);

export default AiTrainingPolicyVersion;
