import mongoose, { Document, Schema } from 'mongoose';

/**
 * Suprah Pulse360 — per-organization configuration.
 *
 * Everything the rules engine treats as a threshold lives here so tuning
 * Pulse360 for a department never means a deploy. Department overrides are a
 * sparse map keyed by the same department `key` used by Department.model.
 */

export interface IPulseThresholds {
  /** Minutes on shift with no meaningful signal before an idle alert. */
  idleWarningMinutes: number;
  /** Minutes before the idle alert escalates to critical. */
  idleCriticalMinutes: number;
  /** Hours a task can sit newly-assigned and untouched before a nudge. */
  firstTouchHours: number;
  /** Days without any task-level signal on an active project. */
  stalledProjectDays: number;
  /** Health score under which management gets an escalation. */
  lowHealthScore: number;
  /** Consecutive low computations required before escalating. */
  lowHealthStreak: number;
  /** Hours an approval can sit unactioned. */
  approvalSlaHours: number;
  /** Minutes of break allowed per shift before an attendance alert. */
  breakLimitMinutes: number;
  /** Local hour by which an expected employee should have clocked in. */
  expectedClockInHour: number;
}

export interface IPulseSetting extends Document {
  organizationId: mongoose.Types.ObjectId;
  enabled: boolean;

  /** Hours before a deadline at which reminders fire, descending. */
  deadlineOffsetsHours: number[];
  /** Once overdue, how often to re-surface, in hours. */
  overdueRepeatHours: number;

  thresholds: IPulseThresholds;

  /** Rolling window used by the scoring engine. */
  windowDays: number;

  /**
   * Component weights. Normalised at read time, so these are relative — an
   * org that cares more about deadlines than desk time just raises timeliness.
   */
  weights: {
    attendance: number;
    taskCompletion: number;
    timeliness: number;
    engagement: number;
    responsiveness: number;
  };

  notifications: {
    /** Show the blocking popup for anything at or above this severity. */
    popupMinSeverity: number;
    /** Hard ceiling on popups per user per hour. */
    maxPopupsPerHour: number;
    /** Minimum gap before the same concern re-fires. */
    cooldownMinutes: number;
    /** Suppress non-critical popups outside these local hours. */
    quietHoursStart: number;
    quietHoursEnd: number;
    /** Mirror critical alerts to the existing CRM web-push pipeline. */
    webPushEnabled: boolean;
    /** Also notify the user's manager on escalation. */
    escalateToManagers: boolean;
  };

  /** Departments Pulse360 ignores entirely. */
  exemptDepartments: string[];
  /** Sparse per-department overrides of any of the above. */
  departmentOverrides: Record<string, Partial<IPulseThresholds> & { enabled?: boolean }>;

  createdAt: Date;
  updatedAt: Date;
}

export const PULSE_DEFAULTS = {
  deadlineOffsetsHours: [72, 24, 4, 1],
  overdueRepeatHours: 12,
  windowDays: 14,
  thresholds: {
    idleWarningMinutes: 45,
    idleCriticalMinutes: 90,
    firstTouchHours: 24,
    stalledProjectDays: 3,
    lowHealthScore: 55,
    lowHealthStreak: 2,
    approvalSlaHours: 24,
    breakLimitMinutes: 65,
    expectedClockInHour: 10,
  } as IPulseThresholds,
  weights: {
    attendance: 20,
    taskCompletion: 25,
    timeliness: 20,
    engagement: 20,
    responsiveness: 15,
  },
  notifications: {
    popupMinSeverity: 50,
    maxPopupsPerHour: 4,
    cooldownMinutes: 90,
    quietHoursStart: 20,
    quietHoursEnd: 7,
    webPushEnabled: true,
    escalateToManagers: true,
  },
};

const PulseSettingSchema = new Schema<IPulseSetting>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
    enabled: { type: Boolean, default: true },

    deadlineOffsetsHours: { type: [Number], default: PULSE_DEFAULTS.deadlineOffsetsHours },
    overdueRepeatHours: { type: Number, default: PULSE_DEFAULTS.overdueRepeatHours },

    thresholds: {
      idleWarningMinutes: { type: Number, default: PULSE_DEFAULTS.thresholds.idleWarningMinutes },
      idleCriticalMinutes: { type: Number, default: PULSE_DEFAULTS.thresholds.idleCriticalMinutes },
      firstTouchHours: { type: Number, default: PULSE_DEFAULTS.thresholds.firstTouchHours },
      stalledProjectDays: { type: Number, default: PULSE_DEFAULTS.thresholds.stalledProjectDays },
      lowHealthScore: { type: Number, default: PULSE_DEFAULTS.thresholds.lowHealthScore },
      lowHealthStreak: { type: Number, default: PULSE_DEFAULTS.thresholds.lowHealthStreak },
      approvalSlaHours: { type: Number, default: PULSE_DEFAULTS.thresholds.approvalSlaHours },
      breakLimitMinutes: { type: Number, default: PULSE_DEFAULTS.thresholds.breakLimitMinutes },
      expectedClockInHour: { type: Number, default: PULSE_DEFAULTS.thresholds.expectedClockInHour },
    },

    windowDays: { type: Number, default: PULSE_DEFAULTS.windowDays },

    weights: {
      attendance: { type: Number, default: PULSE_DEFAULTS.weights.attendance },
      taskCompletion: { type: Number, default: PULSE_DEFAULTS.weights.taskCompletion },
      timeliness: { type: Number, default: PULSE_DEFAULTS.weights.timeliness },
      engagement: { type: Number, default: PULSE_DEFAULTS.weights.engagement },
      responsiveness: { type: Number, default: PULSE_DEFAULTS.weights.responsiveness },
    },

    notifications: {
      popupMinSeverity: { type: Number, default: PULSE_DEFAULTS.notifications.popupMinSeverity },
      maxPopupsPerHour: { type: Number, default: PULSE_DEFAULTS.notifications.maxPopupsPerHour },
      cooldownMinutes: { type: Number, default: PULSE_DEFAULTS.notifications.cooldownMinutes },
      quietHoursStart: { type: Number, default: PULSE_DEFAULTS.notifications.quietHoursStart },
      quietHoursEnd: { type: Number, default: PULSE_DEFAULTS.notifications.quietHoursEnd },
      webPushEnabled: { type: Boolean, default: PULSE_DEFAULTS.notifications.webPushEnabled },
      escalateToManagers: { type: Boolean, default: PULSE_DEFAULTS.notifications.escalateToManagers },
    },

    exemptDepartments: { type: [String], default: [] },
    departmentOverrides: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

const PulseSetting = mongoose.model<IPulseSetting>('PulseSetting', PulseSettingSchema);

export default PulseSetting;
