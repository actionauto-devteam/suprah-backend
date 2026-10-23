import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ILeadIntakeLock extends Document {
  organizationId: Types.ObjectId;
  key: string;
  owner: string;
  expiresAt: Date;
  acquiredAt: Date;
}

const LeadIntakeLockSchema = new Schema<ILeadIntakeLock>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  key: { type: String, required: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  acquiredAt: { type: Date, required: true },
});

LeadIntakeLockSchema.index({ organizationId: 1, key: 1 }, { unique: true, name: 'lead_intake_lock_key_unique' });
LeadIntakeLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600, name: 'lead_intake_lock_cleanup' });

const LeadIntakeLock = mongoose.model<ILeadIntakeLock>('LeadIntakeLock', LeadIntakeLockSchema);

export default LeadIntakeLock;
