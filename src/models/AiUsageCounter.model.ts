import mongoose, { Document, Schema } from 'mongoose';

export type AiUsageKind = 'attention_screen';

export interface IAiUsageCounter extends Document {
  organizationId: string;
  day: string;
  kind: AiUsageKind;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const AiUsageCounterSchema: Schema<IAiUsageCounter> = new Schema(
  {
    organizationId: { type: String, required: true },
    day: { type: String, required: true },
    kind: { type: String, enum: ['attention_screen'], required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

AiUsageCounterSchema.index({ organizationId: 1, day: 1, kind: 1 }, { unique: true });

const AiUsageCounter = mongoose.model<IAiUsageCounter>('AiUsageCounter', AiUsageCounterSchema);

export default AiUsageCounter;
