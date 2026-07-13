import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * CalendarEvent
 * -------------
 * Single source of truth for non-appointment calendar items:
 * events, tasks, reminders, and meetings.
 *
 * Appointments are NOT duplicated here — they remain in the existing
 * Appointment collection and are merged into the calendar feed at
 * read time (see calendar.controller.ts). This guarantees the
 * Appointment Page calendar and Suprah Calendar can never drift.
 */

export type CalendarItemType = "event" | "task" | "reminder" | "meeting";
export type CalendarItemStatus = "scheduled" | "completed" | "cancelled";

export interface ICalendarEvent extends Document {
  dealershipId: Types.ObjectId;
  type: CalendarItemType;
  title: string;
  description?: string;

  /** Overall window. For single-day items, start/end are the exact times. */
  start: Date;
  end: Date;
  allDay: boolean;

  /**
   * Multi-day-with-fixed-daily-window support.
   * When true, the item spans every day from `start` to `end`,
   * but only occupies dailyStartTime → dailyEndTime each day
   * (e.g. a 3-day training that runs 09:00–12:00 daily).
   * Times are "HH:mm" 24h strings in the dealership's local timezone.
   */
  repeatsDailyWindow: boolean;
  dailyStartTime?: string;
  dailyEndTime?: string;

  createdBy: Types.ObjectId;
  assignees: Types.ObjectId[];

  /** Populated when the user generates a Supra-Space meeting link. */
  meetingLink?: string;
  meetingRoomName?: string;

  status: CalendarItemStatus;
  color?: string;

  createdAt: Date;
  updatedAt: Date;
}

const CalendarEventSchema = new Schema<ICalendarEvent>(
  {
    dealershipId: {
      type: Schema.Types.ObjectId,
      ref: "Dealership",
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
  },
  { timestamps: true }
);

/** Range queries: everything overlapping a visible window for a tenant. */
CalendarEventSchema.index({ dealershipId: 1, start: 1, end: 1 });
/** My Schedule queries. */
CalendarEventSchema.index({ dealershipId: 1, assignees: 1, start: 1 });
CalendarEventSchema.index({ dealershipId: 1, createdBy: 1, start: 1 });

export const CalendarEvent = mongoose.model<ICalendarEvent>(
  "CalendarEvent",
  CalendarEventSchema
);
