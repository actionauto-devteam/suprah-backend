import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';
import {
  KNOWLEDGE_BASE_TOPICS,
  KNOWLEDGE_CHANNELS,
  KNOWLEDGE_ENTRY_KINDS,
  KnowledgeLocationScopeSchema,
  type KnowledgeBaseTopic,
  type KnowledgeChannel,
  type KnowledgeEntryKind,
  type KnowledgeLocationScope,
} from './AiKnowledgeEntry.model';

export interface KnowledgeEntryContent {
  kind: KnowledgeEntryKind;
  topic: KnowledgeBaseTopic;
  title: string;
  question?: string;
  answer: string;
  channels: KnowledgeChannel[];
  locationScope: KnowledgeLocationScope;
}

export interface IAiKnowledgeEntryVersion extends Document {
  organizationId: string;
  entryId: mongoose.Types.ObjectId;
  version: number;
  content: KnowledgeEntryContent;
  changeNote?: string;
  createdBy: TrainingActorRef;
  createdAt: Date;
}

const AiKnowledgeEntryVersionSchema: Schema<IAiKnowledgeEntryVersion> = new Schema(
  {
    organizationId: { type: String, required: true },
    entryId: { type: Schema.Types.ObjectId, ref: 'AiKnowledgeEntry', required: true },
    version: { type: Number, required: true, min: 1 },
    content: {
      kind: { type: String, enum: KNOWLEDGE_ENTRY_KINDS, required: true },
      topic: { type: String, enum: KNOWLEDGE_BASE_TOPICS, required: true },
      title: { type: String, required: true, trim: true, maxlength: 120 },
      question: { type: String, trim: true, maxlength: 300 },
      answer: { type: String, required: true, trim: true, maxlength: 1000 },
      channels: { type: [{ type: String, enum: KNOWLEDGE_CHANNELS }], required: true },
      locationScope: { type: KnowledgeLocationScopeSchema, required: true },
    },
    changeNote: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiKnowledgeEntryVersionSchema.index({ entryId: 1, version: 1 }, { unique: true, name: 'ai_kb_version_entry_version' });
AiKnowledgeEntryVersionSchema.index({ organizationId: 1, entryId: 1, version: -1 }, { name: 'ai_kb_version_org_entry' });
makeAppendOnly(AiKnowledgeEntryVersionSchema, 'AiKnowledgeEntryVersion');

const AiKnowledgeEntryVersion = mongoose.model<IAiKnowledgeEntryVersion>('AiKnowledgeEntryVersion', AiKnowledgeEntryVersionSchema);

export default AiKnowledgeEntryVersion;
