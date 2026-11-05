import mongoose, { Document, Schema } from 'mongoose';

export const CRM_AUTOMATION_RUN_STATUSES = ['filtered', 'waiting', 'running', 'completed', 'stopped', 'failed'] as const;
export type CrmAutomationRunStatus = (typeof CRM_AUTOMATION_RUN_STATUSES)[number];

export interface CrmAutomationRunLog {
  stepId: string;
  type: string;
  status: 'sent' | 'test' | 'skipped' | 'failed' | 'done';
  detail: string;
  at: Date;
}

export interface ICrmAutomationRun extends Document {
  organizationId: string;
  automationId: mongoose.Types.ObjectId;
  automationName: string;
  mode: 'live' | 'test';
  event: string;
  eventKey: string;
  triggerAt: Date;
  targetAt: Date | null;
  appointmentId: string | null;
  contact: { leadId: string | null; name: string; firstName: string; phone: string; email: string };
  location: string;
  repeatKey: string | null;
  pathRepeatKeys: string[];
  settings: { sendingHours: string; stopOnReply: boolean; cancelFirstOnReply: boolean; aiContinuesOnReply: boolean; stopOnFailure: boolean };
  steps: Array<{ id: string; type: string; config: Record<string, unknown> }>;
  status: CrmAutomationRunStatus;
  reason: string | null;
  stepIndex: number;
  notBefore: Date | null;
  nextRunAt: Date | null;
  leaseUntil: Date | null;
  sentAnyMessage: boolean;
  stopAfterMessage: boolean;
  log: CrmAutomationRunLog[];
  createdAt: Date;
  updatedAt: Date;
}

const LogSchema = new Schema<CrmAutomationRunLog>(
  {
    stepId: { type: String, required: true },
    type: { type: String, required: true },
    status: { type: String, enum: ['sent', 'test', 'skipped', 'failed', 'done'], required: true },
    detail: { type: String, default: '', maxlength: 2000 },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const CrmAutomationRunSchema = new Schema<ICrmAutomationRun>(
  {
    organizationId: { type: String, required: true },
    automationId: { type: Schema.Types.ObjectId, ref: 'CrmAutomation', required: true },
    automationName: { type: String, required: true },
    mode: { type: String, enum: ['live', 'test'], required: true },
    event: { type: String, required: true },
    eventKey: { type: String, required: true },
    triggerAt: { type: Date, required: true },
    targetAt: { type: Date, default: null },
    appointmentId: { type: String, default: null },
    contact: {
      leadId: { type: String, default: null },
      name: { type: String, default: '' },
      firstName: { type: String, default: '' },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
    },
    location: { type: String, default: '' },
    repeatKey: { type: String, default: null },
    pathRepeatKeys: { type: [String], default: [] },
    settings: { type: Schema.Types.Mixed, default: {} },
    steps: { type: Schema.Types.Mixed, default: [] },
    status: { type: String, enum: CRM_AUTOMATION_RUN_STATUSES, required: true },
    reason: { type: String, default: null },
    stepIndex: { type: Number, default: 0 },
    notBefore: { type: Date, default: null },
    nextRunAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    sentAnyMessage: { type: Boolean, default: false },
    stopAfterMessage: { type: Boolean, default: false },
    log: { type: [LogSchema], default: [] },
  },
  { timestamps: true },
);

CrmAutomationRunSchema.index({ automationId: 1, eventKey: 1 }, { unique: true });
CrmAutomationRunSchema.index({ status: 1, nextRunAt: 1 });
CrmAutomationRunSchema.index({ organizationId: 1, createdAt: -1 });
CrmAutomationRunSchema.index({ organizationId: 1, 'log.at': -1 });
CrmAutomationRunSchema.index({ organizationId: 1, 'contact.leadId': 1, status: 1 });
CrmAutomationRunSchema.index({ organizationId: 1, appointmentId: 1, event: 1 });
CrmAutomationRunSchema.index({ automationId: 1, repeatKey: 1, createdAt: -1 });
CrmAutomationRunSchema.index({ automationId: 1, pathRepeatKeys: 1, createdAt: -1 });
CrmAutomationRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const CrmAutomationRun = mongoose.model<ICrmAutomationRun>('CrmAutomationRun', CrmAutomationRunSchema);

export default CrmAutomationRun;
