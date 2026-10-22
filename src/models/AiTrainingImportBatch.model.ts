import mongoose, { Document, Schema } from 'mongoose';
import { makeAppendOnly } from '../utils/appendOnlySchema';
import { TrainingActorSchema, type TrainingActorRef } from './AiTrainingPolicy.model';

export const IMPORT_SOURCE_SYSTEMS = ['podium'] as const;
export const IMPORT_MODES = ['initial', 'incremental'] as const;
export const IMPORT_FORMATS = ['csv', 'json', 'paste', 'manual'] as const;
export const IMPORT_BUSINESS_CONTACT_KINDS = ['phone', 'email', 'domain'] as const;

export type ImportMode = (typeof IMPORT_MODES)[number];
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export type ImportBusinessContactKind = (typeof IMPORT_BUSINESS_CONTACT_KINDS)[number];

export interface ImportLocationMapping {
  sourceLabel: string;
  sourceKey: string;
  scope: 'all' | 'location';
  locationId?: mongoose.Types.ObjectId;
  locationCode?: string;
}

export interface IAiTrainingImportBatch extends Document {
  organizationId: string;
  batchNumber: number;
  sourceSystem: 'podium';
  mode: ImportMode;
  fullSnapshot: boolean;
  format: ImportFormat;
  fileName?: string;
  fileNameWithheld?: boolean;
  contentSha256: string;
  contentBytes: number;
  rowCount: number;
  statusCounts: Map<string, number>;
  proposalsCreated: number;
  proposalsUpdated: number;
  locationMappings: ImportLocationMapping[];
  businessContacts: Array<{ kind: ImportBusinessContactKind; value: string }>;
  attestation: { confirmed: boolean; version: string; by: TrainingActorRef; at: Date };
  retention: { convertedDays: number; parkedDays: number; rejectedDays: number };
  missingFromSnapshot: Array<{ sourceKey: string; itemId: mongoose.Types.ObjectId; title?: string }>;
  missingFromSnapshotCount: number;
  engineVersion: string;
  previewHash: string;
  createdBy: TrainingActorRef;
  createdAt: Date;
}

const AiTrainingImportBatchSchema: Schema<IAiTrainingImportBatch> = new Schema(
  {
    organizationId: { type: String, required: true },
    batchNumber: { type: Number, required: true, min: 1 },
    sourceSystem: { type: String, enum: IMPORT_SOURCE_SYSTEMS, required: true, default: 'podium' },
    mode: { type: String, enum: IMPORT_MODES, required: true },
    fullSnapshot: { type: Boolean, required: true, default: false },
    format: { type: String, enum: IMPORT_FORMATS, required: true },
    fileName: { type: String, trim: true, maxlength: 120 },
    fileNameWithheld: { type: Boolean },
    contentSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    contentBytes: { type: Number, required: true, min: 0 },
    rowCount: { type: Number, required: true, min: 0 },
    statusCounts: { type: Map, of: Number, default: {} },
    proposalsCreated: { type: Number, required: true, min: 0, default: 0 },
    proposalsUpdated: { type: Number, required: true, min: 0, default: 0 },
    locationMappings: {
      type: [{
        _id: false,
        sourceLabel: { type: String, trim: true, maxlength: 80 },
        sourceKey: { type: String, trim: true, maxlength: 80 },
        scope: { type: String, enum: ['all', 'location'], required: true },
        locationId: { type: Schema.Types.ObjectId, ref: 'CrmLocation' },
        locationCode: { type: String, trim: true, maxlength: 40 },
      }],
      default: [],
    },
    businessContacts: {
      type: [{
        _id: false,
        kind: { type: String, enum: IMPORT_BUSINESS_CONTACT_KINDS, required: true },
        value: { type: String, required: true, trim: true, maxlength: 120 },
      }],
      default: [],
    },
    attestation: {
      confirmed: { type: Boolean, required: true },
      version: { type: String, required: true, trim: true, maxlength: 20 },
      by: { type: TrainingActorSchema, required: true },
      at: { type: Date, required: true },
    },
    retention: {
      convertedDays: { type: Number, required: true },
      parkedDays: { type: Number, required: true },
      rejectedDays: { type: Number, required: true },
    },
    missingFromSnapshot: {
      type: [{
        _id: false,
        sourceKey: { type: String, required: true, maxlength: 64 },
        itemId: { type: Schema.Types.ObjectId, ref: 'AiTrainingImportItem', required: true },
        title: { type: String, trim: true, maxlength: 120 },
      }],
      default: [],
    },
    missingFromSnapshotCount: { type: Number, required: true, min: 0, default: 0 },
    engineVersion: { type: String, required: true, trim: true, maxlength: 40 },
    previewHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    createdBy: { type: TrainingActorSchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AiTrainingImportBatchSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'ai_import_batch_org_recent' });
AiTrainingImportBatchSchema.index({ organizationId: 1, batchNumber: 1 }, { unique: true, name: 'ai_import_batch_org_number' });
makeAppendOnly(AiTrainingImportBatchSchema, 'AiTrainingImportBatch');

const AiTrainingImportBatch = mongoose.model<IAiTrainingImportBatch>('AiTrainingImportBatch', AiTrainingImportBatchSchema);

export default AiTrainingImportBatch;
