import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * CalendarEvent — single source of truth for non-appointment calendar items:
 * events, tasks, reminders, and meetings. Appointments stay in their own
 * collection and are merged into the feed at read time.
 * Tenancy is organizationId, matching crmAuth's req.orgId.
 */

export type CalendarItemType = "event" | "task" | "reminder" | "meeting";
export type CalendarItemStatus = "scheduled" | "completed" | "cancelled";

export interface ICalendarEvent extends Document {
  organizationId: Types.ObjectId;
  type: CalendarItemType;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /**
   * Multi-day with a fixed daily window: spans every day from start to end
   * but only occupies dailyStartTime→dailyEndTime ("HH:mm") each day.
   */
  repeatsDailyWindow: boolean;
  dailyStartTime?: string;
  dailyEndTime?: string;
  /**
   * Optional subset of days ("YYYY-MM-DD") the daily window runs on.
   * Empty/absent = every day in the start–end range.
   */
  includedDates?: string[];
  createdBy: Types.ObjectId;
  assignees: Types.ObjectId[];
  meetingLink?: string;
  meetingRoomName?: string;
  status: CalendarItemStatus;
  color?: string;
  /** "YYYY-MM-DD" (America/Denver) the "starts today" reminder last fired — dedupe key so it only sends once per day. */
  lastReminderSentDay?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CalendarEventSchema = new Schema<ICalendarEvent>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["event", "task", "reminder", "meeting"],
      required: true,
      default: "event",
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000 },
    start: { type: Date, required: true },
    end: {
      type: Date,
      required: true,
      validate: {
        validator(this: ICalendarEvent, v: Date) {
          return v >= this.start;
        },
        message: "End must be on or after start.",
      },
    },
    allDay: { type: Boolean, default: false },
    repeatsDailyWindow: { type: Boolean, default: false },
    dailyStartTime: {
      type: String,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
      required: function (this: ICalendarEvent) {
        return this.repeatsDailyWindow;
      },
    },
    dailyEndTime: {
      type: String,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
      required: function (this: ICalendarEvent) {
        return this.repeatsDailyWindow;
      },
    },
    includedDates: [{ type: String, match: /^\d{4}-\d{2}-\d{2}$/ }],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "CrmUser",
      required: true,
      index: true,
    },
    assignees: [{ type: Schema.Types.ObjectId, ref: "CrmUser", index: true }],
    meetingLink: { type: String, trim: true },
    meetingRoomName: { type: String, trim: true },
    status: {
      type: String,
      enum: ["scheduled", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    color: { type: String, trim: true },
    lastReminderSentDay: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  },
  { timestamps: true }
);

CalendarEventSchema.index({ organizationId: 1, start: 1, end: 1 });
CalendarEventSchema.index({ organizationId: 1, assignees: 1, start: 1 });
CalendarEventSchema.index({ organizationId: 1, createdBy: 1, start: 1 });

export const CalendarEvent = mongoose.model<ICalendarEvent>(
  "CalendarEvent",
  CalendarEventSchema
);
