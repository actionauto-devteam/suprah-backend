import mongoose, { Document, Schema } from 'mongoose';

/**
 * Suprah Pulse360 — alerts.
 *
 * One row per *live concern*, not per notification delivery. A deadline that
 * fires reminders at 72h / 24h / 4h / overdue is a SINGLE alert row whose
 * priority escalates and whose `occurrences` counter increments — that is the
 * mechanism that stops Pulse360 becoming notification spam while still keeping
 * critical items visible until they're actually dealt with.
 *
 * Dedupe is enforced by a partial unique index on (organizationId, dedupeKey)
 * limited to `isOpen: true`. Closing an alert frees the key, so the same
 * concern can legitimately re-open later.
 */

export const PULSE_PRIORITIES = [
  'information',
  'reminder',
  'warning',
  'critical',
  'deadline',
  'productivity',
  'attendance',
  'manager_request',
  'approval_required',
  'escalation',
] as const;

export type PulsePriority = (typeof PULSE_PRIORITIES)[number];

/** Severity ladder used for sort order, popup gating and escalation. */
export const PULSE_SEVERITY: Record<PulsePriority, number> = {
  information: 10,
  reminder: 20,
  approval_required: 35,
  attendance: 40,
  productivity: 45,
  warning: 50,
  manager_request: 60,
  deadline: 70,
  critical: 90,
  escalation: 100,
};

export type PulseAlertStatus = 'pending' | 'delivered' | 'acknowledged' | 'snoozed' | 'resolved' | 'expired';

export interface IPulseAlert extends Document {
  organizationId: mongoose.Types.ObjectId;
  /** Who must act. */
  userId: mongoose.Types.ObjectId;
  userModel: 'CrmUser' | 'User';
  department?: string;

  /** Rule that produced this, e.g. 'task.overdue' or 'idle.during_shift'. */
  kind: string;
  priority: PulsePriority;
  severity: number;

  title: string;
  /** Why Pulse360 raised this, in plain language. */
  reason: string;
  /** What the user should actually do about it. */
  recommendedAction: string;
  /** Deep link to the exact task / project / customer / module. */
  actionUrl?: string;
  actionLabel?: string;

  refType?: string;
  refId?: string;
  /** Stable identity of the underlying concern. Drives dedupe + escalation. */
  dedupeKey: string;

  status: PulseAlertStatus;
  /** Mirrors `status in (pending, delivered, snoozed)`; indexed for dedupe. */
  isOpen: boolean;

  /** Times this concern re-fired without being resolved. */
  occurrences: number;
  firstFiredAt: Date;
  lastFiredAt: Date;
  deliveredAt?: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  snoozedUntil?: Date;
  /** Set when a low health score or repeat offence is surfaced to management. */
  escalatedAt?: Date;
  escalatedTo?: mongoose.Types.ObjectId[];
  /** Manager who raised a manual nudge, if applicable. */
  raisedBy?: mongoose.Types.ObjectId;
  /** Auto-expiry for time-boxed concerns (e.g. yesterday's idle warning). */
  expiresAt?: Date;
  /** Free-form payload the popup can render (counts, due dates, task names). */
  context?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

const PulseAlertSchema = new Schema<IPulseAlert>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userModel: { type: String, enum: ['CrmUser', 'User'], default: 'CrmUser' },
    department: { type: String, default: null },

    kind: { type: String, required: true },
    priority: { type: String, enum: PULSE_PRIORITIES, default: 'information' },
    severity: { type: Number, default: 10 },

    title: { type: String, required: true },
    reason: { type: String, required: true },
    recommendedAction: { type: String, required: true },
    actionUrl: { type: String },
    actionLabel: { type: String },

    refType: { type: String },
    refId: { type: String },
    dedupeKey: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'delivered', 'acknowledged', 'snoozed', 'resolved', 'expired'],
      default: 'pending',
    },
    isOpen: { type: Boolean, default: true },

    occurrences: { type: Number, default: 1 },
    firstFiredAt: { type: Date, default: Date.now },
    lastFiredAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date },
    acknowledgedAt: { type: Date },
    resolvedAt: { type: Date },
    snoozedUntil: { type: Date },
    escalatedAt: { type: Date },
    escalatedTo: [{ type: Schema.Types.ObjectId }],
    raisedBy: { type: Schema.Types.ObjectId },
    expiresAt: { type: Date },
    context: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

/**
 * Dedupe guard. partialFilterExpression uses a plain boolean equality rather
 * than `status: { $in: [...] }` because $in inside a partial index is only
 * supported on newer server versions — isOpen keeps this portable.
 */
PulseAlertSchema.index(
  { organizationId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } }
);

// The inbox query: my open alerts, most severe first.
PulseAlertSchema.index({ userId: 1, isOpen: 1, severity: -1, lastFiredAt: -1 });
// Manager dashboard: org-wide open alerts by department.
PulseAlertSchema.index({ organizationId: 1, isOpen: 1, department: 1, severity: -1 });
// Sweep support.
PulseAlertSchema.index({ isOpen: 1, snoozedUntil: 1 });
PulseAlertSchema.index({ isOpen: 1, expiresAt: 1 });

PulseAlertSchema.pre<IPulseAlert>('save', function (next) {
  // isOpen is derived state — never let a caller set it inconsistently.
  this.isOpen = ['pending', 'delivered', 'snoozed'].includes(this.status);
  next();
});

const PulseAlert = mongoose.model<IPulseAlert>('PulseAlert', PulseAlertSchema);

export default PulseAlert;
