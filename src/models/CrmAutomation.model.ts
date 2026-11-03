import mongoose, { Document, Schema } from 'mongoose';

export const CRM_AUTOMATION_STATUSES = ['draft', 'test', 'active', 'inactive'] as const;
export type CrmAutomationStatus = (typeof CRM_AUTOMATION_STATUSES)[number];

export interface CrmAutomationActorRef {
  userId: string;
  name: string;
}

export interface CrmAutomationFilter {
  field: string;
  operator: string;
  value: string | null;
}

export interface CrmAutomationTrigger {
  source: string;
  event: string | null;
  date: string | null;
  time: string | null;
  filters: CrmAutomationFilter[];
  repeat: { mode: 'every_time' | 'once_per_days'; days: number | null; per: string[] };
  sendingHours: 'sending_hours' | 'any_time';
  stopOnReply: boolean;
  cancelFirstOnReply: boolean;
  aiContinuesOnReply: boolean;
  stopOnFailure: boolean;
}

export interface CrmAutomationStep {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface CrmAutomationAlerts {
  enabled: boolean;
  condition: 'min_events' | 'percentage_drop';
  minEvents: number;
  days: number;
  dropPercent: number;
  userIds: string[];
  lastCheckedAt: Date | null;
  lastAlertAt: Date | null;
}

export interface ICrmAutomation extends Document {
  organizationId: string;
  name: string;
  locations: { mode: 'all' | 'specific'; ids: string[] };
  trigger: CrmAutomationTrigger | null;
  steps: CrmAutomationStep[];
  status: CrmAutomationStatus;
  statusChangedAt: Date | null;
  tags: string[];
  alerts: CrmAutomationAlerts;
  createdBy: CrmAutomationActorRef;
  updatedBy: CrmAutomationActorRef;
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema<CrmAutomationActorRef>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 120 },
  },
  { _id: false },
);

const FilterSchema = new Schema<CrmAutomationFilter>(
  {
    field: { type: String, required: true },
    operator: { type: String, required: true },
    value: { type: String, default: null },
  },
  { _id: false },
);

const TriggerSchema = new Schema<CrmAutomationTrigger>(
  {
    source: { type: String, required: true },
    event: { type: String, default: null },
    date: { type: String, default: null },
    time: { type: String, default: null },
    filters: { type: [FilterSchema], default: [] },
    repeat: {
      mode: { type: String, enum: ['every_time', 'once_per_days'], default: 'once_per_days' },
      days: { type: Number, default: 365 },
      per: { type: [String], default: ['customer_phone'] },
    },
    sendingHours: { type: String, enum: ['sending_hours', 'any_time'], default: 'sending_hours' },
    stopOnReply: { type: Boolean, default: true },
    cancelFirstOnReply: { type: Boolean, default: true },
    aiContinuesOnReply: { type: Boolean, default: false },
    stopOnFailure: { type: Boolean, default: false },
  },
  { _id: false },
);

const StepSchema = new Schema<CrmAutomationStep>(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const CrmAutomationSchema = new Schema<ICrmAutomation>(
  {
    organizationId: { type: String, required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    locations: {
      mode: { type: String, enum: ['all', 'specific'], required: true, default: 'all' },
      ids: { type: [String], default: [] },
    },
    trigger: { type: TriggerSchema, default: null },
    steps: { type: [StepSchema], default: [] },
    status: { type: String, enum: CRM_AUTOMATION_STATUSES, required: true, default: 'draft' },
    statusChangedAt: { type: Date, default: null },
    tags: { type: [{ type: String, trim: true, maxlength: 30 }], default: [] },
    alerts: {
      enabled: { type: Boolean, default: false },
      condition: { type: String, enum: ['min_events', 'percentage_drop'], default: 'min_events' },
      minEvents: { type: Number, default: 1 },
      days: { type: Number, default: 7 },
      dropPercent: { type: Number, default: 50 },
      userIds: { type: [String], default: [] },
      lastCheckedAt: { type: Date, default: null },
      lastAlertAt: { type: Date, default: null },
    },
    createdBy: { type: ActorSchema, required: true },
    updatedBy: { type: ActorSchema, required: true },
  },
  { timestamps: true },
);

CrmAutomationSchema.index({ organizationId: 1, updatedAt: -1 });

const CrmAutomation = mongoose.model<ICrmAutomation>('CrmAutomation', CrmAutomationSchema);

export default CrmAutomation;
