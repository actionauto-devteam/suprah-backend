import mongoose, { Document, Schema } from 'mongoose';

export const CRM_DATA_SYNC_TYPES = ['appointment'] as const;
export type CrmDataSyncType = (typeof CRM_DATA_SYNC_TYPES)[number];

export interface ICrmDataSync extends Document {
  organizationId: string;
  type: CrmDataSyncType;
  name: string;
  status: 'active' | 'inactive';
  locations: { mode: 'all' | 'specific'; ids: string[] };
  setupComplete: boolean;
  createdBy: { userId: string; name: string };
  updatedBy: { userId: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 120 },
  },
  { _id: false },
);

const CrmDataSyncSchema = new Schema<ICrmDataSync>(
  {
    organizationId: { type: String, required: true },
    type: { type: String, enum: CRM_DATA_SYNC_TYPES, required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    status: { type: String, enum: ['active', 'inactive'], required: true, default: 'active' },
    locations: {
      mode: { type: String, enum: ['all', 'specific'], required: true, default: 'all' },
      ids: { type: [String], default: [] },
    },
    setupComplete: { type: Boolean, default: false },
    createdBy: { type: ActorSchema, required: true },
    updatedBy: { type: ActorSchema, required: true },
  },
  { timestamps: true },
);

CrmDataSyncSchema.index({ organizationId: 1, updatedAt: -1 });

const CrmDataSync = mongoose.model<ICrmDataSync>('CrmDataSync', CrmDataSyncSchema);

export default CrmDataSync;
