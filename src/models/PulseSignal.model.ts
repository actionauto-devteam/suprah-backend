import mongoose, { Document, Schema } from 'mongoose';

/**
 * Suprah Pulse360 — activity timeline.
 *
 * Append-only record of every meaningful work event a CRM user produces. This
 * is the raw material the scoring engine and the manager-facing timeline both
 * read from. Two things write here:
 *
 *   1. pulseTrack.middleware.ts — passive, throttled ingest of ordinary CRM
 *      traffic (which module, which verb, which resource). This is what lets
 *      Pulse360 see engagement across EVERY module without every controller
 *      controller needing to opt in.
 *   2. pulse360.service.recordSignal() — explicit, high-value events
 *      (task completed, approval granted, deadline hit, shift started).
 *
 * Signals are deliberately cheap: no population, no fan-out on write. Anything
 * expensive happens in the scheduled sweeps.
 */

export type PulseSignalType =
  | 'task.created'
  | 'task.assigned'
  | 'task.status_changed'
  | 'task.completed'
  | 'task.commented'
  | 'task.attachment'
  | 'project.assigned'
  | 'project.milestone'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.rejected'
  | 'document.updated'
  | 'customer.interaction'
  | 'lead.touched'
  | 'deal.moved'
  | 'message.sent'
  | 'feed.posted'
  | 'attendance.time_in'
  | 'attendance.time_out'
  | 'attendance.break_in'
  | 'attendance.break_out'
  | 'attendance.absence'
  | 'crm.navigation'
  | 'crm.mutation'
  | 'pulse.alert_raised'
  | 'pulse.alert_acknowledged'
  | 'pulse.alert_resolved'
  | 'pulse.nudge_received';

export interface IPulseSignal extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** Which collection userId points at. Synthetic admins resolve to 'User'. */
  userModel: 'CrmUser' | 'User';
  department?: string;
  type: PulseSignalType;
  /** Human-facing module bucket: "Projects", "Mail", "TimeProof", ... */
  module: string;
  title: string;
  description?: string;
  /** What this signal is about, for deep-linking and dedupe. */
  refType?: string;
  refId?: string;
  /** In-app path the timeline entry links to. */
  url?: string;
  /**
   * Engagement weight. Passive navigation is ~1; completing a task is ~10.
   * The scoring engine sums weights rather than counting rows so that ten
   * page loads never look like ten finished deliverables.
   */
  weight: number;
  /** True for signals produced by passive middleware ingest. */
  passive: boolean;
  meta?: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PulseSignalSchema = new Schema<IPulseSignal>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userModel: { type: String, enum: ['CrmUser', 'User'], default: 'CrmUser' },
    department: { type: String, default: null },
    type: { type: String, required: true },
    module: { type: String, required: true, default: 'CRM' },
    title: { type: String, required: true },
    description: { type: String },
    refType: { type: String },
    refId: { type: String },
    url: { type: String },
    weight: { type: Number, default: 1 },
    passive: { type: Boolean, default: false },
    meta: { type: Schema.Types.Mixed },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Primary read path: "this user's timeline, newest first".
PulseSignalSchema.index({ organizationId: 1, userId: 1, occurredAt: -1 });
// Org-wide sweeps: "who has produced nothing since X".
PulseSignalSchema.index({ organizationId: 1, occurredAt: -1 });
// Resolve-on-progress: "did anything happen against this task?"
PulseSignalSchema.index({ refType: 1, refId: 1, occurredAt: -1 });

/**
 * 180-day retention. Long enough for performance-review windows and trend
 * analysis, short enough that a chatty org's passive signals never become the
 * kind of runaway collection that ate the Atlas quota last time. Health
 * snapshots (PulseHealth) keep the long-term trend line, so expiring raw
 * signals loses granularity, not history.
 */
PulseSignalSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const PulseSignal = mongoose.model<IPulseSignal>('PulseSignal', PulseSignalSchema);

export default PulseSignal;
