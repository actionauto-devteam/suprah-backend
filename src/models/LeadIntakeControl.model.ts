import mongoose, { Document, Schema, Types } from 'mongoose';

export const LEAD_INTAKE_MODES = ['off', 'active', 'paused'] as const;
export type LeadIntakeMode = (typeof LEAD_INTAKE_MODES)[number];

export interface ILeadIntakeControl extends Document {
  organizationId: Types.ObjectId;
  mode: LeadIntakeMode;
  reason?: string | null;
  updatedBy?: { userId?: string | null; name?: string | null } | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const LeadIntakeControlSchema = new Schema<ILeadIntakeControl>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    mode: { type: String, enum: LEAD_INTAKE_MODES, default: 'off' },
    reason: { type: String, default: null, maxlength: 1000 },
    updatedBy: {
      type: new Schema({ userId: { type: String, default: null }, name: { type: String, default: null } }, { _id: false }),
      default: null,
    },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

LeadIntakeControlSchema.index({ organizationId: 1 }, { unique: true, name: 'lead_intake_control_org_unique' });

const LeadIntakeControl = mongoose.model<ILeadIntakeControl>('LeadIntakeControl', LeadIntakeControlSchema);

export default LeadIntakeControl;
