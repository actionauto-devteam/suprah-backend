import mongoose, { Document, Schema } from 'mongoose';
import { IMPORT_RETENTION_CLASSES, type ImportRetentionClass } from './AiTrainingImportItem.model';

export interface ImportContentFields {
  itemType?: string;
  title?: string;
  location?: string;
  channels?: string[];
  triggerOrQuestion?: string;
  answerOrInstruction?: string;
  handling?: string;
  escalationWhen?: string;
  handoffReason?: string;
  requiredQuestions?: string[];
  mustInclude?: string[];
  mustAvoid?: string[];
  exampleCustomer?: string;
  exampleReply?: string;
  topic?: string;
  sourceRef?: string;
  sourceStatus?: 'on' | 'off';
  notes?: string;
}

export interface IAiTrainingImportContent extends Document {
  organizationId: string;
  batchId: mongoose.Types.ObjectId;
  itemId: mongoose.Types.ObjectId;
  retentionClass: ImportRetentionClass;
  fields: ImportContentFields;
  mappedPayload?: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
}

export class ImportContentImmutableError extends Error {
  constructor() {
    super('Stored import originals cannot be changed. They can only expire or be purged.');
  }
}

const listField = (max: number) => ({ type: [{ type: String, trim: true, maxlength: max }], default: undefined });

const AiTrainingImportContentSchema: Schema<IAiTrainingImportContent> = new Schema(
  {
    organizationId: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportBatch', required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem', required: true },
    retentionClass: { type: String, enum: IMPORT_RETENTION_CLASSES, required: true },
    fields: {
      itemType: { type: String, trim: true, maxlength: 30 },
      title: { type: String, trim: true, maxlength: 120 },
      location: { type: String, trim: true, maxlength: 80 },
      channels: listField(20),
      triggerOrQuestion: { type: String, trim: true, maxlength: 300 },
      answerOrInstruction: { type: String, trim: true, maxlength: 1000 },
      handling: { type: String, trim: true, maxlength: 30 },
      escalationWhen: { type: String, trim: true, maxlength: 300 },
      handoffReason: { type: String, trim: true, maxlength: 200 },
      requiredQuestions: listField(200),
      mustInclude: listField(200),
      mustAvoid: listField(200),
      exampleCustomer: { type: String, trim: true, maxlength: 500 },
      exampleReply: { type: String, trim: true, maxlength: 600 },
      topic: { type: String, trim: true, maxlength: 40 },
      sourceRef: { type: String, trim: true, maxlength: 120 },
      sourceStatus: { type: String, enum: ['on', 'off'] },
      notes: { type: String, trim: true, maxlength: 300 },
    },
    mappedPayload: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: true },
);

AiTrainingImportContentSchema.index({ itemId: 1 }, { unique: true, name: 'ai_import_content_item' });
AiTrainingImportContentSchema.index({ organizationId: 1, batchId: 1 }, { name: 'ai_import_content_org_batch' });
AiTrainingImportContentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ai_import_content_ttl' });

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'] as const) {
  AiTrainingImportContentSchema.pre(hook as any, function blockContentUpdate() {
    throw new ImportContentImmutableError();
  });
}
AiTrainingImportContentSchema.pre('save', function blockContentResave(this: any) {
  if (!this.isNew) throw new ImportContentImmutableError();
});
AiTrainingImportContentSchema.pre('updateOne', { document: true, query: false }, function blockDocumentUpdate() {
  throw new ImportContentImmutableError();
});
AiTrainingImportContentSchema.pre('bulkWrite', function blockBulkUpdate(this: any, next: (err?: Error) => void, operations: any[]) {
  const changes = (operations || []).some((operation) => !operation?.insertOne && !operation?.deleteOne && !operation?.deleteMany);
  if (changes) throw new ImportContentImmutableError();
  next();
});

const AiTrainingImportContent = mongoose.model<IAiTrainingImportContent>('AiTrainingImportContent', AiTrainingImportContentSchema);

export default AiTrainingImportContent;
