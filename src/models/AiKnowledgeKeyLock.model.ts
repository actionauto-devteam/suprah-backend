import mongoose, { Document, Schema } from 'mongoose';

export interface IAiKnowledgeKeyLock extends Document {
  organizationId: string;
  keyHash: string;
  seq: number;
}

const AiKnowledgeKeyLockSchema: Schema<IAiKnowledgeKeyLock> = new Schema(
  {
    organizationId: { type: String, required: true },
    keyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

AiKnowledgeKeyLockSchema.index({ organizationId: 1, keyHash: 1 }, { unique: true, name: 'ai_kb_key_lock' });

const AiKnowledgeKeyLock = mongoose.model<IAiKnowledgeKeyLock>('AiKnowledgeKeyLock', AiKnowledgeKeyLockSchema);

export default AiKnowledgeKeyLock;
