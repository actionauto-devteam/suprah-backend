import mongoose, { Document, Schema } from 'mongoose';

export interface IAiModeChangeLog extends Document {
  organizationId: string;
  channel: 'sms' | 'email' | 'webchat' | 'shadow_drafts';
  fromMode: string;
  toMode: string;
  fromSource: 'configured' | 'legacy' | 'disabled';
  reason?: string;
  changedBy?: mongoose.Types.ObjectId;
  changedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AiModeChangeLogSchema: Schema<IAiModeChangeLog> = new Schema(
  {
    organizationId: { type: String, required: true },
    channel: { type: String, enum: ['sms', 'email', 'webchat', 'shadow_drafts'], required: true },
    fromMode: { type: String, required: true },
    toMode: { type: String, required: true },
    fromSource: { type: String, enum: ['configured', 'legacy', 'disabled'], required: true },
    reason: { type: String, trim: true, maxlength: 500 },
    changedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    changedByName: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true },
);

AiModeChangeLogSchema.index({ organizationId: 1, createdAt: -1 });

const AiModeChangeLog = mongoose.model<IAiModeChangeLog>('AiModeChangeLog', AiModeChangeLogSchema);

export default AiModeChangeLog;
