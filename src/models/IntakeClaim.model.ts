import mongoose, { Document, Schema } from 'mongoose';

export type IntakeClaimKind = 'webchat_session' | 'test_drive_booking' | 'vehicle_inquiry';

export interface IIntakeClaim extends Document {
  organizationId: mongoose.Types.ObjectId | string;
  kind: IntakeClaimKind;
  claimKey: string;
  leadId?: mongoose.Types.ObjectId | null;
  appointmentId?: mongoose.Types.ObjectId | null;
  expiresAt: Date;
  createdAt: Date;
}

const IntakeClaimSchema: Schema<IIntakeClaim> = new Schema(
  {
    organizationId: { type: Schema.Types.Mixed, required: true },
    kind: { type: String, enum: ['webchat_session', 'test_drive_booking', 'vehicle_inquiry'], required: true },
    claimKey: { type: String, required: true, trim: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

IntakeClaimSchema.index(
  { organizationId: 1, kind: 1, claimKey: 1 },
  { unique: true, name: 'intake_claim_org_kind_key_unique' },
);

const IntakeClaim = mongoose.model<IIntakeClaim>('IntakeClaim', IntakeClaimSchema);

export default IntakeClaim;
