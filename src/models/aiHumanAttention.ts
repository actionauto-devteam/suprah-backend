import { Schema, Types } from 'mongoose';

export type AttentionKind = 'customer' | 'technical';
export type AttentionCustomerCode = 'human_request' | 'ai_identity_concern';
export type AttentionTechnicalCode =
  | 'local_qa_blocked'
  | 'missing_api_key'
  | 'timeout'
  | 'provider_error'
  | 'unreadable_response'
  | 'uncertain';
export type AttentionCode = AttentionCustomerCode | AttentionTechnicalCode;
export type AttentionClassifierSource = 'gemini' | 'mock' | 'skipped';

export const LEGACY_TECHNICAL_ATTENTION_REASON = 'Human-attention check unavailable';

export const TECHNICAL_ATTENTION_REASONS: Record<AttentionTechnicalCode, string> = {
  local_qa_blocked: 'Safety check blocked in local QA',
  missing_api_key: 'Safety check not configured',
  timeout: 'Safety check timed out',
  provider_error: 'Safety check service error',
  unreadable_response: 'Safety check gave an unreadable result',
  uncertain: 'Safety check was inconclusive',
};

export const TECHNICAL_ATTENTION_CODES = Object.keys(TECHNICAL_ATTENTION_REASONS) as AttentionTechnicalCode[];

export interface AiHumanAttention {
  reason: string;
  kind?: AttentionKind;
  code?: AttentionCode;
  classifierSource?: AttentionClassifierSource;
  pausedBeforeAttention?: { pausedAt?: Date; userId?: string; name?: string; autoPausedUntil?: Date };
  priorPauseChecked?: boolean;
  taskId: Types.ObjectId;
  messageId: string;
  detectedAt: Date;
}

export interface AiTechnicalRecovery {
  taskId: Types.ObjectId;
  recoveredAt: Date;
  recoveredBy: { userId: string; name: string; role: string };
  reason: string;
}

export function attentionKindOf(attention: { kind?: string; reason?: string } | null | undefined): AttentionKind {
  if (attention?.kind === 'technical' || attention?.kind === 'customer') return attention.kind;
  const reason = String(attention?.reason || '');
  return reason === LEGACY_TECHNICAL_ATTENTION_REASON || Object.values(TECHNICAL_ATTENTION_REASONS).includes(reason)
    ? 'technical' : 'customer';
}

export const aiHumanAttentionFields = {
  aiResponseVersion: { type: Number, default: 0 },
  aiLastDispatchVersion: { type: Number },
  aiAttentionPendingIds: { type: [String], default: [] },
  aiHumanAttention: {
    type: new Schema<AiHumanAttention>({
      reason: { type: String, required: true },
      kind: { type: String, enum: ['customer', 'technical'] },
      code: { type: String },
      classifierSource: { type: String, enum: ['gemini', 'mock', 'skipped'] },
      pausedBeforeAttention: {
        type: new Schema({
          pausedAt: { type: Date },
          userId: { type: String },
          name: { type: String },
          autoPausedUntil: { type: Date },
        }, { _id: false }),
      },
      priorPauseChecked: { type: Boolean },
      taskId: { type: Schema.Types.ObjectId, ref: 'AiAgentTask', required: true },
      messageId: { type: String, required: true },
      detectedAt: { type: Date, required: true },
    }, { _id: false }),
  },
  aiLastTechnicalRecovery: {
    type: new Schema<AiTechnicalRecovery>({
      taskId: { type: Schema.Types.ObjectId, ref: 'AiAgentTask', required: true },
      recoveredAt: { type: Date, required: true },
      recoveredBy: {
        type: new Schema({ userId: { type: String }, name: { type: String }, role: { type: String } }, { _id: false }),
        required: true,
      },
      reason: { type: String },
    }, { _id: false }),
  },
};
