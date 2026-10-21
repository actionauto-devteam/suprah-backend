import { Schema } from 'mongoose';

const BLOCKED_QUERY_HOOKS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;

export class AppendOnlyViolationError extends Error {
  constructor(modelName: string) {
    super(`${modelName} records are append-only and cannot be changed or removed`);
  }
}

export function makeAppendOnly(schema: Schema, modelName: string): void {
  for (const hook of BLOCKED_QUERY_HOOKS) {
    schema.pre(hook as any, function blockQuery() {
      throw new AppendOnlyViolationError(modelName);
    });
  }
  schema.pre('save', function blockResave(this: any) {
    if (!this.isNew) throw new AppendOnlyViolationError(modelName);
  });
  schema.pre('deleteOne', { document: true, query: false }, function blockDocumentDelete() {
    throw new AppendOnlyViolationError(modelName);
  });
  schema.pre('updateOne', { document: true, query: false }, function blockDocumentUpdate() {
    throw new AppendOnlyViolationError(modelName);
  });
  schema.pre('bulkWrite', function blockBulkWrite(this: any, next: (err?: Error) => void, operations: any[]) {
    const changes = (operations || []).some((operation) => !operation?.insertOne);
    if (changes) throw new AppendOnlyViolationError(modelName);
    next();
  });
}
