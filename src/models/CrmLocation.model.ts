import mongoose, { Document, Schema } from 'mongoose';

export const CRM_LOCATION_STATUSES = ['active', 'archived'] as const;
export type CrmLocationStatus = (typeof CRM_LOCATION_STATUSES)[number];

export const CRM_LOCATION_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface CrmLocationActorRef {
  userId: string;
  name: string;
  role: string;
}

export interface ICrmLocation extends Document {
  organizationId: string;
  code: string;
  name: string;
  aliases: string[];
  aliasKeys: string[];
  status: CrmLocationStatus;
  archivedAt?: Date | null;
  revision: number;
  createdBy: CrmLocationActorRef;
  updatedBy: CrmLocationActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export const CrmLocationActorSchema = new Schema<CrmLocationActorRef>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 120 },
    role: { type: String, required: true, maxlength: 40 },
  },
  { _id: false },
);

const CrmLocationSchema: Schema<ICrmLocation> = new Schema(
  {
    organizationId: { type: String, required: true },
    code: { type: String, required: true, immutable: true, trim: true, lowercase: true, minlength: 2, maxlength: 40, match: CRM_LOCATION_CODE_PATTERN },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    aliases: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
    aliasKeys: {
      type: [{ type: String, required: true }],
      validate: { validator: (keys: string[]) => Array.isArray(keys) && keys.length > 0, message: 'A location needs at least one alias key' },
    },
    status: { type: String, enum: CRM_LOCATION_STATUSES, default: 'active', required: true },
    archivedAt: { type: Date, default: null },
    revision: { type: Number, required: true, min: 1, default: 1 },
    createdBy: { type: CrmLocationActorSchema, required: true },
    updatedBy: { type: CrmLocationActorSchema, required: true },
  },
  { timestamps: true },
);

CrmLocationSchema.index({ organizationId: 1, code: 1 }, { unique: true, name: 'crm_location_org_code' });
CrmLocationSchema.index({ organizationId: 1, aliasKeys: 1 }, { unique: true, name: 'crm_location_org_alias' });
CrmLocationSchema.index({ organizationId: 1, status: 1, name: 1 }, { name: 'crm_location_org_status_name' });

const CrmLocation = mongoose.model<ICrmLocation>('CrmLocation', CrmLocationSchema);

export default CrmLocation;
