import mongoose, { Document, Schema } from 'mongoose';

/**
 * Suprah Pulse360 — Work Health Score snapshot.
 *
 * One document per user (upserted, not appended) holding the current score
 * plus a bounded trend array. Keeping this as a single row per user means the
 * manager dashboard is one indexed find() rather than an aggregation over the
 * signal firehose, and it survives PulseSignal's 180-day TTL — the trend line
 * is the long-term memory.
 */

export const PULSE_BANDS = ['excellent', 'healthy', 'watch', 'at_risk', 'critical'] as const;
export type PulseBand = (typeof PULSE_BANDS)[number];

/** Score → band. Single source of truth; the frontend imports the same cuts. */
export function bandForScore(score: number): PulseBand {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'healthy';
  if (score >= 55) return 'watch';
  if (score >= 40) return 'at_risk';
  return 'critical';
}

export interface IPulseComponents {
  /** Clocking in consistently, breaks within policy. */
  attendance: number;
  /** Assigned vs finished over the rolling window. */
  taskCompletion: number;
  /** On-time delivery; overdue items drag this down hardest. */
  timeliness: number;
  /** Breadth and recency of real CRM work, not just page loads. */
  engagement: number;
  /** How fast newly assigned work gets its first touch. */
  responsiveness: number;
}

export interface IPulseHealth extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userModel: 'CrmUser' | 'User';
  fullName: string;
  email: string;
  avatar?: string;
  department?: string;
  role?: string;

  score: number;
  band: PulseBand;
  /** score - previous score, so the UI can show direction without a lookup. */
  delta: number;
  components: IPulseComponents;

  stats: {
    openTasks: number;
    overdueTasks: number;
    dueSoonTasks: number;
    completedInWindow: number;
    activeProjects: number;
    openAlerts: number;
    criticalAlerts: number;
    /** Weighted engagement points in the window. */
    engagementPoints: number;
    /** Minutes since the last non-passive signal. */
    minutesSinceMeaningfulWork: number | null;
    idleMinutesToday: number;
    shiftMinutesToday: number;
    daysAttendedInWindow: number;
    onTimeCompletionRate: number;
    medianFirstTouchHours: number | null;
  };

  /** Live presence derived at compute time. */
  workState: 'working' | 'on_break' | 'idle' | 'off_shift' | 'absent';
  isOnShift: boolean;
  shiftStartedAt?: Date;
  lastSignalAt?: Date;

  /** Bounded ring buffer — newest last, capped at 60 entries by the service. */
  trend: Array<{ at: Date; score: number; band: PulseBand }>;

  windowDays: number;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ComponentsSchema = new Schema<IPulseComponents>(
  {
    attendance: { type: Number, default: 0 },
    taskCompletion: { type: Number, default: 0 },
    timeliness: { type: Number, default: 0 },
    engagement: { type: Number, default: 0 },
    responsiveness: { type: Number, default: 0 },
  },
  { _id: false }
);

const PulseHealthSchema = new Schema<IPulseHealth>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    userModel: { type: String, enum: ['CrmUser', 'User'], default: 'CrmUser' },
    fullName: { type: String, default: '' },
    email: { type: String, default: '' },
    avatar: { type: String },
    department: { type: String, default: null },
    role: { type: String },

    score: { type: Number, default: 0 },
    band: { type: String, enum: PULSE_BANDS, default: 'watch' },
    delta: { type: Number, default: 0 },
    components: { type: ComponentsSchema, default: () => ({}) },

    stats: {
      openTasks: { type: Number, default: 0 },
      overdueTasks: { type: Number, default: 0 },
      dueSoonTasks: { type: Number, default: 0 },
      completedInWindow: { type: Number, default: 0 },
      activeProjects: { type: Number, default: 0 },
      openAlerts: { type: Number, default: 0 },
      criticalAlerts: { type: Number, default: 0 },
      engagementPoints: { type: Number, default: 0 },
      minutesSinceMeaningfulWork: { type: Number, default: null },
      idleMinutesToday: { type: Number, default: 0 },
      shiftMinutesToday: { type: Number, default: 0 },
      daysAttendedInWindow: { type: Number, default: 0 },
      onTimeCompletionRate: { type: Number, default: 0 },
      medianFirstTouchHours: { type: Number, default: null },
    },

    workState: {
      type: String,
      enum: ['working', 'on_break', 'idle', 'off_shift', 'absent'],
      default: 'off_shift',
    },
    isOnShift: { type: Boolean, default: false },
    shiftStartedAt: { type: Date },
    lastSignalAt: { type: Date },

    trend: [
      {
        _id: false,
        at: { type: Date },
        score: { type: Number },
        band: { type: String, enum: PULSE_BANDS },
      },
    ],

    windowDays: { type: Number, default: 14 },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

PulseHealthSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
PulseHealthSchema.index({ organizationId: 1, score: 1 });
PulseHealthSchema.index({ organizationId: 1, department: 1, band: 1 });
PulseHealthSchema.index({ organizationId: 1, workState: 1 });

const PulseHealth = mongoose.model<IPulseHealth>('PulseHealth', PulseHealthSchema);

export default PulseHealth;
