import mongoose, { Document, Schema } from 'mongoose';

export const PHONE_NUMBER_KINDS = ['main', 'location', 'department'] as const;
export type PhoneNumberKind = (typeof PHONE_NUMBER_KINDS)[number];

export const TELNYX_CHECK_STATUSES = ['ready', 'needs_setup', 'not_in_account', 'unchecked', 'error'] as const;
export type TelnyxCheckStatus = (typeof TELNYX_CHECK_STATUSES)[number];

export interface TelnyxNumberCheck {
  status: TelnyxCheckStatus;
  readyForCalls: boolean;
  readyForTexts: boolean;
  message: string;
  checkedAt: Date | null;
}

export interface IDealershipPhoneNumber extends Document {
  organizationId: mongoose.Types.ObjectId;
  number: string;
  label: string;
  kind: PhoneNumberKind;
  location: string;
  department: string;
  ringGroupId: mongoose.Types.ObjectId | null;
  telnyx: TelnyxNumberCheck;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TelnyxCheckSchema = new Schema<TelnyxNumberCheck>({
  status: { type: String, enum: TELNYX_CHECK_STATUSES, default: 'unchecked' },
  readyForCalls: { type: Boolean, default: false },
  readyForTexts: { type: Boolean, default: false },
  message: { type: String, default: '' },
  checkedAt: { type: Date, default: null },
}, { _id: false });

const DealershipPhoneNumberSchema = new Schema<IDealershipPhoneNumber>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  number: { type: String, required: true, unique: true },
  label: { type: String, required: true, trim: true, maxlength: 60 },
  kind: { type: String, enum: PHONE_NUMBER_KINDS, required: true },
  location: { type: String, default: '', trim: true, maxlength: 80 },
  department: { type: String, default: '', trim: true, maxlength: 60 },
  ringGroupId: { type: Schema.Types.ObjectId, ref: 'CrmLeadGroup', default: null },
  telnyx: { type: TelnyxCheckSchema, default: () => ({}) },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });

DealershipPhoneNumberSchema.index(
  { organizationId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: 'main' }, name: 'dealership_phone_one_main_per_org' },
);

export default mongoose.model<IDealershipPhoneNumber>('DealershipPhoneNumber', DealershipPhoneNumberSchema);
