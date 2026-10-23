import mongoose, { Document, Schema } from 'mongoose';

export interface IContactRestrictionIdentifier extends Document {
  organizationId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  kind: 'phone' | 'email';
  value: string;
  active: boolean;
  createdBy?: string | null;
  releasedAt?: Date | null;
  releasedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ContactRestrictionIdentifierSchema = new Schema<IContactRestrictionIdentifier>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    kind: { type: String, enum: ['phone', 'email'], required: true },
    value: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: String, default: null },
  },
  { timestamps: true },
);

ContactRestrictionIdentifierSchema.index(
  { organizationId: 1, kind: 1, value: 1 },
  { partialFilterExpression: { active: true }, name: 'contact_restriction_identifier_active' },
);
ContactRestrictionIdentifierSchema.index({ organizationId: 1, leadId: 1 });

const ContactRestrictionIdentifier = mongoose.model<IContactRestrictionIdentifier>(
  'ContactRestrictionIdentifier',
  ContactRestrictionIdentifierSchema,
);

export default ContactRestrictionIdentifier;
