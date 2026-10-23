import mongoose, { Document, Schema } from 'mongoose';

export const CONTACT_RESTRICTION_AUDIT_EVENTS = [
  'dnc_applied',
  'dnc_removed',
  'dnc_contact_changed',
  'webchat_exception_reply',
  'outbound_blocked',
] as const;
export type ContactRestrictionAuditEvent = (typeof CONTACT_RESTRICTION_AUDIT_EVENTS)[number];

export type ContactRestrictionAuditActorKind = 'staff' | 'ai' | 'system';

export interface IContactRestrictionAuditActor {
  kind: ContactRestrictionAuditActorKind;
  userId?: string | null;
  name?: string | null;
}

export interface IContactRestrictionAudit extends Document {
  organizationId: mongoose.Types.ObjectId;
  leadId?: mongoose.Types.ObjectId | null;
  event: ContactRestrictionAuditEvent;
  actor: IContactRestrictionAuditActor;
  channel?: 'sms' | 'email' | 'webchat' | null;
  purpose?: string | null;
  outcome?: 'restricted' | 'unavailable' | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  previousContact?: { phone?: string | null; email?: string | null } | null;
  newContact?: { phone?: string | null; email?: string | null } | null;
  restrictingLeadIds?: mongoose.Types.ObjectId[];
  sessionId?: mongoose.Types.ObjectId | null;
  messageId?: mongoose.Types.ObjectId | null;
  respondingToMessageId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const ContactSnapshotSchema = new Schema(
  { phone: { type: String, default: null }, email: { type: String, default: null } },
  { _id: false },
);

const ContactRestrictionAuditSchema = new Schema<IContactRestrictionAudit>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    event: { type: String, enum: CONTACT_RESTRICTION_AUDIT_EVENTS, required: true },
    actor: {
      type: new Schema(
        {
          kind: { type: String, enum: ['staff', 'ai', 'system'], required: true },
          userId: { type: String, default: null },
          name: { type: String, trim: true, maxlength: 160, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    channel: { type: String, enum: ['sms', 'email', 'webchat', null], default: null },
    purpose: { type: String, trim: true, maxlength: 80, default: null },
    outcome: { type: String, enum: ['restricted', 'unavailable', null], default: null },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    reason: { type: String, trim: true, maxlength: 1000, default: null },
    previousContact: { type: ContactSnapshotSchema, default: null },
    newContact: { type: ContactSnapshotSchema, default: null },
    restrictingLeadIds: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
    sessionId: { type: Schema.Types.ObjectId, ref: 'WebChatSession', default: null },
    messageId: { type: Schema.Types.ObjectId, default: null },
    respondingToMessageId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ContactRestrictionAuditSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });
ContactRestrictionAuditSchema.index({ organizationId: 1, event: 1, createdAt: -1 });

const IMMUTABLE_OPERATIONS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const;
for (const operation of IMMUTABLE_OPERATIONS) {
  ContactRestrictionAuditSchema.pre(operation as any, function rejectChange(next: (err?: Error) => void) {
    next(new Error('Contact restriction audit records cannot be changed or deleted'));
  });
}

const ContactRestrictionAudit = mongoose.model<IContactRestrictionAudit>('ContactRestrictionAudit', ContactRestrictionAuditSchema);

export default ContactRestrictionAudit;
