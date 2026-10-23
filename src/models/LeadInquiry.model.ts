import mongoose, { Document, Schema, Types } from 'mongoose';

export const LEAD_INQUIRY_KINDS = [
  'provider_inquiry',
  'website_inquiry',
  'test_drive',
  'webchat_session',
  'sms',
  'call',
  'email_reply',
  'manual',
] as const;
export type LeadInquiryKind = (typeof LEAD_INQUIRY_KINDS)[number];

export const LEAD_INQUIRY_ASSOCIATION_STATES = ['received', 'associated', 'pending_review', 'resolved'] as const;
export type LeadInquiryAssociationState = (typeof LEAD_INQUIRY_ASSOCIATION_STATES)[number];

export const LEAD_INQUIRY_OUTCOMES = ['created_lead', 'appended', 'manual_create', 'dismissed'] as const;
export type LeadInquiryOutcome = (typeof LEAD_INQUIRY_OUTCOMES)[number];

export const LEAD_INQUIRY_PROCESSING_STATES = ['pending', 'processing', 'completed', 'failed'] as const;
export type LeadInquiryProcessingState = (typeof LEAD_INQUIRY_PROCESSING_STATES)[number];

export const LEAD_INQUIRY_SIDE_EFFECTS = ['conversationRecord', 'notification', 'alexReply'] as const;
export type LeadInquirySideEffect = (typeof LEAD_INQUIRY_SIDE_EFFECTS)[number];

export const LEAD_INQUIRY_SIDE_EFFECT_STATES = ['pending', 'claimed', 'done', 'skipped', 'failed', 'unknown'] as const;
export type LeadInquirySideEffectState = (typeof LEAD_INQUIRY_SIDE_EFFECT_STATES)[number];

export const LEAD_INQUIRY_CONTACT_ASSURANCE = ['carrier_verified', 'self_reported', 'staff_entered'] as const;
export type LeadInquiryContactAssurance = (typeof LEAD_INQUIRY_CONTACT_ASSURANCE)[number];

export interface ILeadInquirySideEffect {
  state: LeadInquirySideEffectState;
  attempts: number;
  claimOwner?: string | null;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  doneAt?: Date | null;
  lastError?: string | null;
  externalRef?: string | null;
}

export interface ILeadInquiry extends Document {
  organizationId: Types.ObjectId;
  kind: LeadInquiryKind;
  channel?: string;
  source?: string;
  sourceProvider?: string;
  receivedAt: Date;
  contact: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    normalizedPhone?: string | null;
    normalizedEmail?: string | null;
    emailExcluded?: boolean;
    assurance?: LeadInquiryContactAssurance;
  };
  vehicle?: {
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    vin?: string;
    stock?: string;
  };
  subject?: string;
  comments?: string;
  sourceIds: {
    gmailMessageId?: string;
    gmailThreadId?: string;
    providerInquiryKey?: string;
    smsProviderMessageId?: string;
    callControlId?: string;
    webchatSessionId?: Types.ObjectId;
    appointmentId?: Types.ObjectId;
    communicationMessageId?: Types.ObjectId;
  };
  fingerprint?: string;
  contentKey?: string;
  association: {
    state: LeadInquiryAssociationState;
    leadId?: Types.ObjectId | null;
    outcome?: LeadInquiryOutcome | null;
    reason?: string | null;
    candidateLeadIds: Types.ObjectId[];
    contextLeadId?: Types.ObjectId | null;
    duplicateOf?: Types.ObjectId | null;
    decidedAt?: Date | null;
    resolvedBy?: { userId?: string; name?: string } | null;
    resolvedAt?: Date | null;
  };
  processing: {
    state: LeadInquiryProcessingState;
    attempts: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    lastAttemptAt?: Date | null;
    nextAttemptAt?: Date | null;
    lastError?: string | null;
  };
  sideEffects: Record<LeadInquirySideEffect, ILeadInquirySideEffect>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const SideEffectSchema = new Schema<ILeadInquirySideEffect>(
  {
    state: { type: String, enum: LEAD_INQUIRY_SIDE_EFFECT_STATES, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    claimOwner: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    claimExpiresAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    externalRef: { type: String, default: null, maxlength: 200 },
  },
  { _id: false },
);

const LeadInquirySchema = new Schema<ILeadInquiry>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    kind: { type: String, enum: LEAD_INQUIRY_KINDS, required: true },
    channel: { type: String, trim: true },
    source: { type: String, trim: true },
    sourceProvider: { type: String, trim: true },
    receivedAt: { type: Date, required: true },
    contact: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
      normalizedPhone: { type: String, default: null },
      normalizedEmail: { type: String, default: null },
      emailExcluded: { type: Boolean, default: false },
      assurance: { type: String, enum: LEAD_INQUIRY_CONTACT_ASSURANCE, default: 'self_reported' },
    },
    vehicle: {
      year: { type: String, trim: true },
      make: { type: String, trim: true },
      model: { type: String, trim: true },
      trim: { type: String, trim: true },
      vin: { type: String, trim: true },
      stock: { type: String, trim: true },
    },
    subject: { type: String, trim: true, maxlength: 500 },
    comments: { type: String, maxlength: 10000 },
    sourceIds: {
      gmailMessageId: { type: String, trim: true },
      gmailThreadId: { type: String, trim: true },
      providerInquiryKey: { type: String, trim: true },
      smsProviderMessageId: { type: String, trim: true },
      callControlId: { type: String, trim: true },
      webchatSessionId: { type: Schema.Types.ObjectId, ref: 'WebChatSession' },
      appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
      communicationMessageId: { type: Schema.Types.ObjectId, ref: 'CommunicationMessage' },
    },
    fingerprint: { type: String, trim: true },
    contentKey: { type: String, trim: true },
    association: {
      state: { type: String, enum: LEAD_INQUIRY_ASSOCIATION_STATES, default: 'received' },
      leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
      outcome: { type: String, enum: [...LEAD_INQUIRY_OUTCOMES, null], default: null },
      reason: { type: String, default: null, maxlength: 200 },
      candidateLeadIds: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
      contextLeadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
      duplicateOf: { type: Schema.Types.ObjectId, ref: 'LeadInquiry', default: null },
      decidedAt: { type: Date, default: null },
      resolvedBy: {
        type: new Schema({ userId: String, name: String }, { _id: false }),
        default: null,
      },
      resolvedAt: { type: Date, default: null },
    },
    processing: {
      state: { type: String, enum: LEAD_INQUIRY_PROCESSING_STATES, default: 'pending' },
      attempts: { type: Number, default: 0, min: 0 },
      leaseOwner: { type: String, default: null },
      leaseExpiresAt: { type: Date, default: null },
      lastAttemptAt: { type: Date, default: null },
      nextAttemptAt: { type: Date, default: null },
      lastError: { type: String, default: null, maxlength: 500 },
    },
    sideEffects: {
      conversationRecord: { type: SideEffectSchema, default: () => ({}) },
      notification: { type: SideEffectSchema, default: () => ({}) },
      alexReply: { type: SideEffectSchema, default: () => ({}) },
    },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const uniqueOptionalKey = (field: string, type: 'string' | 'objectId', name: string) => {
  LeadInquirySchema.index(
    { organizationId: 1, [field]: 1 },
    { unique: true, partialFilterExpression: { [field]: { $type: type } }, name },
  );
};

uniqueOptionalKey('sourceIds.gmailMessageId', 'string', 'lead_inquiry_org_gmail_message_unique');
uniqueOptionalKey('sourceIds.providerInquiryKey', 'string', 'lead_inquiry_org_provider_inquiry_unique');
uniqueOptionalKey('sourceIds.smsProviderMessageId', 'string', 'lead_inquiry_org_sms_message_unique');
uniqueOptionalKey('sourceIds.callControlId', 'string', 'lead_inquiry_org_call_control_unique');
uniqueOptionalKey('sourceIds.webchatSessionId', 'objectId', 'lead_inquiry_org_webchat_session_unique');
uniqueOptionalKey('fingerprint', 'string', 'lead_inquiry_org_fingerprint_unique');

LeadInquirySchema.index(
  { organizationId: 1, contentKey: 1, createdAt: -1 },
  { partialFilterExpression: { contentKey: { $type: 'string' } }, name: 'lead_inquiry_org_content_recent' },
);
LeadInquirySchema.index({ organizationId: 1, 'association.state': 1, createdAt: -1 }, { name: 'lead_inquiry_org_association_state' });
LeadInquirySchema.index({ organizationId: 1, 'association.leadId': 1, receivedAt: -1 }, { name: 'lead_inquiry_org_lead_received' });
LeadInquirySchema.index({ 'processing.state': 1, 'processing.nextAttemptAt': 1 }, { name: 'lead_inquiry_processing_queue' });

const LeadInquiry = mongoose.model<ILeadInquiry>('LeadInquiry', LeadInquirySchema);

export default LeadInquiry;
