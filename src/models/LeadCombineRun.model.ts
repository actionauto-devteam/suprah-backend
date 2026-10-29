import mongoose, { Document, Schema, Types } from 'mongoose';

export const LEAD_COMBINE_RUN_STATES = ['running', 'done', 'failed'] as const;
export type LeadCombineRunState = (typeof LEAD_COMBINE_RUN_STATES)[number];

export interface ILeadCombineRun extends Document {
  organizationId: Types.ObjectId;
  state: LeadCombineRunState;
  owner?: string | null;
  leaseUntil?: Date | null;
  attempts: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  customers: number;
  leadsCombined: number;
  skippedGroups: number;
  failedGroups: number;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const LeadCombineRunSchema = new Schema<ILeadCombineRun>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    state: { type: String, enum: LEAD_COMBINE_RUN_STATES, required: true },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    customers: { type: Number, default: 0 },
    leadsCombined: { type: Number, default: 0 },
    skippedGroups: { type: Number, default: 0 },
    failedGroups: { type: Number, default: 0 },
    error: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true },
);

LeadCombineRunSchema.index({ organizationId: 1 }, { unique: true, name: 'lead_combine_run_org_unique' });

const LeadCombineRun = mongoose.model<ILeadCombineRun>('LeadCombineRun', LeadCombineRunSchema);

export default LeadCombineRun;
