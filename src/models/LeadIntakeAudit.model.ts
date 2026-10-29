import mongoose, { Document, Schema, Types } from 'mongoose';

export const LEAD_INTAKE_AUDIT_EVENTS = [
  'intake_mode_changed',
  'review_resolved',
  'inquiry_moved_to_review',
  'review_reopened',
  'lead_linked',
  'duplicates_combined',
  'duplicates_uncombined',
] as const;
export type LeadIntakeAuditEvent = (typeof LEAD_INTAKE_AUDIT_EVENTS)[number];

export interface ILeadIntakeAudit extends Document {
  organizationId: Types.ObjectId;
  event: LeadIntakeAuditEvent;
  actor: { kind: 'staff' | 'system'; userId?: string | null; name?: string | null };
  fromMode?: string | null;
  toMode?: string | null;
  inquiryId?: Types.ObjectId | null;
  leadId?: Types.ObjectId | null;
  resolution?: string | null;
  reason?: string | null;
  createdAt: Date;
}

const LeadIntakeAuditSchema = new Schema<ILeadIntakeAudit>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    event: { type: String, enum: LEAD_INTAKE_AUDIT_EVENTS, required: true },
    actor: {
      type: new Schema(
        {
          kind: { type: String, enum: ['staff', 'system'], required: true },
          userId: { type: String, default: null },
          name: { type: String, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    fromMode: { type: String, default: null },
    toMode: { type: String, default: null },
    inquiryId: { type: Schema.Types.ObjectId, ref: 'LeadInquiry', default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    resolution: { type: String, default: null, maxlength: 60 },
    reason: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

LeadIntakeAuditSchema.index({ organizationId: 1, event: 1, createdAt: -1 });
LeadIntakeAuditSchema.index({ organizationId: 1, inquiryId: 1, createdAt: -1 });

const refuseChange = function (next: (err?: Error) => void) {
  next(new Error('Lead intake audit records cannot be changed or deleted'));
};
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  LeadIntakeAuditSchema.pre(operation as any, refuseChange as any);
}

const LeadIntakeAudit = mongoose.model<ILeadIntakeAudit>('LeadIntakeAudit', LeadIntakeAuditSchema);

export default LeadIntakeAudit;
