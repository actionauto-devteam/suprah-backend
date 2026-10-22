import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { CRM_LOCATION_STATUSES, CrmLocationActorRef, CrmLocationActorSchema, CrmLocationStatus } from './CrmLocation.model';

export const CRM_LOCATION_AUDIT_ACTIONS = ['created', 'updated', 'archived', 'restored'] as const;
export type CrmLocationAuditAction = (typeof CRM_LOCATION_AUDIT_ACTIONS)[number];

export interface CrmLocationSnapshot {
  code?: string;
  name: string;
  aliases: string[];
  status: CrmLocationStatus;
}

export interface ICrmLocationAudit extends Document {
  organizationId: string;
  locationId: mongoose.Types.ObjectId;
  action: CrmLocationAuditAction;
  revision: number;
  before?: CrmLocationSnapshot;
  after: CrmLocationSnapshot;
  actor: CrmLocationActorRef;
  createdAt: Date;
}

const snapshotFields = () => ({
  code: { type: String, maxlength: 40 },
  name: { type: String, required: true, maxlength: 80 },
  aliases: { type: [{ type: String, maxlength: 80 }], default: [] },
  status: { type: String, enum: CRM_LOCATION_STATUSES, required: true },
});

const CrmLocationAuditSchema: Schema<ICrmLocationAudit> = new Schema(
  {
    organizationId: { type: String, required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'CrmLocation', required: true },
    action: { type: String, enum: CRM_LOCATION_AUDIT_ACTIONS, required: true },
    revision: { type: Number, required: true, min: 1 },
    before: { type: new Schema(snapshotFields(), { _id: false }), default: undefined },
    after: { type: new Schema(snapshotFields(), { _id: false }), required: true },
    actor: { type: CrmLocationActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CrmLocationAuditSchema.index({ organizationId: 1, locationId: 1, createdAt: -1 }, { name: 'crm_location_audit_location' });
CrmLocationAuditSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'crm_location_audit_org_recent' });
makeAppendOnly(CrmLocationAuditSchema, 'CrmLocationAudit');

const CrmLocationAudit = mongoose.model<ICrmLocationAudit>('CrmLocationAudit', CrmLocationAuditSchema);

export default CrmLocationAudit;
