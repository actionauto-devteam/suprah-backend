import { Schema, Types } from 'mongoose';

export interface AiHumanAttention {
  reason: 'AI identity concern' | 'Customer requested human' | 'Human-attention check unavailable';
  taskId: Types.ObjectId;
  messageId: string;
  detectedAt: Date;
}

export const aiHumanAttentionFields = {
  aiResponseVersion: { type: Number, default: 0 },
  aiLastDispatchVersion: { type: Number },
  aiAttentionPendingIds: { type: [String], default: [] },
  aiHumanAttention: {
    type: new Schema<AiHumanAttention>({
      reason: { type: String, required: true },
      taskId: { type: Schema.Types.ObjectId, ref: 'AiAgentTask', required: true },
      messageId: { type: String, required: true },
      detectedAt: { type: Date, required: true },
    }, { _id: false }),
  },
};
