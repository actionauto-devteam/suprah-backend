/**
 * Deal Desk supporting collections: settings, lenders, FM presence,
 * deal thread messages, audit events, and the per-org deal number counter.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';
import { DEFAULT_ACCEPT_WINDOW_SECONDS, DEFAULT_SLA_MINUTES } from '../services/dealDesk/constants';

/* ───────────────────────── Settings ───────────────────────── */

export interface IDealDeskSettings extends Document {
  organizationId: Types.ObjectId;
  reviewerIds: Types.ObjectId[];
  financeManagerIds: Types.ObjectId[];
  managerIds: Types.ObjectId[];
  acceptWindowSeconds: number;
  maxRoundsBeforeEscalation: number;
  maxActiveDealsPerFm: number;
  slaMinutes: Record<string, number>;
  defaultTaxRate: number;
  defaultDocFee: number;
  maxRateMarkup: number;
  aiEnabled: boolean;
  requireDocsToSubmit: boolean;
  widget: {
    enabled: boolean;
    allowedOrigins: string[];
    depositAmount: number;
    headline?: string;
    accentColor?: string;
  };
  updatedBy?: Types.ObjectId;
}

const DealDeskSettingsSchema = new Schema<IDealDeskSettings>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, unique: true },
    reviewerIds: [{ type: Schema.Types.ObjectId }],
    financeManagerIds: [{ type: Schema.Types.ObjectId }],
    managerIds: [{ type: Schema.Types.ObjectId }],
    acceptWindowSeconds: { type: Number, default: DEFAULT_ACCEPT_WINDOW_SECONDS, min: 60, max: 1800 },
    maxRoundsBeforeEscalation: { type: Number, default: 1, min: 1, max: 5 },
    maxActiveDealsPerFm: { type: Number, default: 3, min: 1, max: 20 },
    slaMinutes: { type: Schema.Types.Mixed, default: () => ({ ...DEFAULT_SLA_MINUTES }) },
    defaultTaxRate: { type: Number, default: 7.25 },
    defaultDocFee: { type: Number, default: 399 },
    maxRateMarkup: { type: Number, default: 2 },
    aiEnabled: { type: Boolean, default: true },
    requireDocsToSubmit: { type: Boolean, default: true },
    widget: {
      enabled: { type: Boolean, default: false },
      allowedOrigins: [{ type: String }],
      depositAmount: { type: Number, default: 500 },
      headline: String,
      accentColor: String,
    },
    updatedBy: Schema.Types.ObjectId,
  },
  { timestamps: true, collection: 'dealdesk_settings' },
);

export const DealDeskSettings =
  (mongoose.models.DealDeskSettings as mongoose.Model<IDealDeskSettings>) ||
  mongoose.model<IDealDeskSettings>('DealDeskSettings', DealDeskSettingsSchema);

/* ───────────────────────── Lenders ───────────────────────── */

export interface ILenderRateTier {
  minScore: number;
  rate: number;
}

export interface IDealDeskLender extends Document {
  organizationId: Types.ObjectId;
  name: string;
  type: 'bank' | 'credit_union' | 'captive' | 'subprime' | 'other';
  active: boolean;
  minScore?: number;
  maxLtv?: number;
  maxDti?: number;
  maxPti?: number;
  maxTerm?: number;
  minAmount?: number;
  maxAmount?: number;
  maxMileage?: number;
  maxVehicleAge?: number;
  rateTiers: ILenderRateTier[];
  notes?: string;
}

const DealDeskLenderSchema = new Schema<IDealDeskLender>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['bank', 'credit_union', 'captive', 'subprime', 'other'], default: 'bank' },
    active: { type: Boolean, default: true },
    minScore: Number,
    maxLtv: Number,
    maxDti: Number,
    maxPti: Number,
    maxTerm: Number,
    minAmount: Number,
    maxAmount: Number,
    maxMileage: Number,
    maxVehicleAge: Number,
    rateTiers: [{ minScore: Number, rate: Number, _id: false }],
    notes: String,
  },
  { timestamps: true, collection: 'dealdesk_lenders' },
);

export const DealDeskLender =
  (mongoose.models.DealDeskLender as mongoose.Model<IDealDeskLender>) ||
  mongoose.model<IDealDeskLender>('DealDeskLender', DealDeskLenderSchema);

/* ───────────────────────── FM presence ───────────────────────── */

export interface IDealDeskFmPresence extends Document {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  available: boolean;
  lastAssignedAt?: Date;
  activeDealCount: number;
  updatedAt: Date;
}

const DealDeskFmPresenceSchema = new Schema<IDealDeskFmPresence>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, default: '' },
    available: { type: Boolean, default: false },
    lastAssignedAt: Date,
    activeDealCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'dealdesk_fm_presence' },
);
DealDeskFmPresenceSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export const DealDeskFmPresence =
  (mongoose.models.DealDeskFmPresence as mongoose.Model<IDealDeskFmPresence>) ||
  mongoose.model<IDealDeskFmPresence>('DealDeskFmPresence', DealDeskFmPresenceSchema);

/* ───────────────────────── Thread messages ───────────────────────── */

export interface IDealDeskMessage extends Document {
  organizationId: Types.ObjectId;
  dealId: Types.ObjectId;
  kind: 'user' | 'system' | 'ai';
  authorId?: Types.ObjectId;
  authorName?: string;
  body: string;
  createdAt: Date;
}

const DealDeskMessageSchema = new Schema<IDealDeskMessage>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    dealId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['user', 'system', 'ai'], default: 'user' },
    authorId: Schema.Types.ObjectId,
    authorName: String,
    body: { type: String, required: true, maxlength: 4000 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'dealdesk_messages' },
);
DealDeskMessageSchema.index({ dealId: 1, createdAt: 1 });

export const DealDeskMessage =
  (mongoose.models.DealDeskMessage as mongoose.Model<IDealDeskMessage>) ||
  mongoose.model<IDealDeskMessage>('DealDeskMessage', DealDeskMessageSchema);

/* ───────────────────────── Audit events ───────────────────────── */

export interface IDealDeskEvent extends Document {
  organizationId: Types.ObjectId;
  dealId: Types.ObjectId;
  action: string;
  actorId?: Types.ObjectId;
  actorName?: string;
  from?: string;
  to?: string;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const DealDeskEventSchema = new Schema<IDealDeskEvent>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    dealId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    actorId: Schema.Types.ObjectId,
    actorName: String,
    from: String,
    to: String,
    meta: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'dealdesk_events' },
);
DealDeskEventSchema.index({ dealId: 1, createdAt: 1 });
DealDeskEventSchema.index({ organizationId: 1, createdAt: -1 });

export const DealDeskEvent =
  (mongoose.models.DealDeskEvent as mongoose.Model<IDealDeskEvent>) ||
  mongoose.model<IDealDeskEvent>('DealDeskEvent', DealDeskEventSchema);

/* ───────────────────────── Deal number counter ───────────────────────── */

const DealDeskCounterSchema = new Schema(
  { organizationId: { type: Schema.Types.ObjectId, required: true, unique: true }, seq: { type: Number, default: 1000 } },
  { collection: 'dealdesk_counters' },
);

export const DealDeskCounter =
  (mongoose.models.DealDeskCounter as mongoose.Model<{ organizationId: Types.ObjectId; seq: number }>) ||
  mongoose.model('DealDeskCounter', DealDeskCounterSchema);

export async function nextDealNumber(organizationId: Types.ObjectId | string): Promise<number> {
  const doc = await DealDeskCounter.findOneAndUpdate(
    { organizationId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return (doc as any).seq;
}
