import { CalendarEvent } from '../models/calendarEvent.model';
import notificationService from './notification.service';
import { CALENDAR_TZ } from '../constants/calendarTimezone';

/**
 * calendarReminderSweep — proactive "your event starts today" notifications.
 *
 * Sweeps scheduled CalendarEvent docs whose `start` falls on the current
 * calendar day (Mountain Time, matching the Suprah Calendar rendering
 * convention) and notifies the creator + every assignee exactly once per
 * event per day via `lastReminderSentDay`.
 *
 * This intentionally only covers the discrete "event starts today" case —
 * the live "what's on my plate right now" digest (GET /api/calendar/
 * notifications-summary) stays a separate, request-time-computed widget on
 * the Calendar page itself; it is not migrated into discrete notifications
 * (see notification unification plan, Phase B3 risk #2).
 *
 * Wire-up: called from server.ts's scheduler startup block, alongside
 * startProjectDeadlineReminders().
 */

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

/** Calendar-day string (YYYY-MM-DD) for an instant, in Mountain Time. */
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: CALENDAR_TZ });

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startCalendarReminderSweep(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // First pass shortly after boot so restarts don't delay today's reminders.
  setTimeout(() => void sweep(), 25_000);
  console.log('[calendarReminderSweep] started (15-minute sweep, MT day windows)');
}

export function stopCalendarReminderSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function sweep(): Promise<void> {
  if (running) return; // never overlap slow sweeps
  running = true;
  try {
    const now = new Date();
    const today = dayKey(now);

    // Candidate window: events starting within +/-2 days of now, narrowed to
    // "actually starts today" below (a plain date-only query on `start`
    // would be wrong across the MT/UTC offset near midnight).
    const events = await CalendarEvent.find({
      status: 'scheduled',
      deletedAt: null,
      start: {
        $gte: new Date(now.getTime() - 2 * 86_400_000),
        $lte: new Date(now.getTime() + 2 * 86_400_000),
      },
      lastReminderSentDay: { $ne: today },
    })
      .select('title start createdBy assignees organizationId')
      .lean();

    if (events.length === 0) return;

    for (const event of events as any[]) {
      if (dayKey(new Date(event.start)) !== today) continue;

      // Claim the day atomically first — duplicate-proof across instances.
      // deletedAt: null re-checked here too (not just in the initial find) in
      // case the event was soft-deleted in the gap between fetch and claim.
      const claimed = await CalendarEvent.updateOne(
        { _id: event._id, lastReminderSentDay: { $ne: today }, deletedAt: null },
        { $set: { lastReminderSentDay: today } },
      );
      if (claimed.modifiedCount === 0) continue;

      const recipients = Array.from(new Set(
        [event.createdBy, ...(event.assignees || [])].map((id: any) => id.toString()),
      ));
      if (recipients.length === 0) continue;

      const startTime = new Date(event.start).toLocaleTimeString('en-US', {
        timeZone: CALENDAR_TZ,
        hour: 'numeric',
        minute: '2-digit',
      });
      const title = "Today's Event";
      const message = `"${event.title}" is scheduled for today at ${startTime}`;

      await Promise.allSettled(
        recipients.map((userId) =>
          notificationService.createNotification({
            userId,
            organizationId: event.organizationId.toString(),
            type: 'calendar_event_today',
            title,
            message,
            metadata: { eventId: String(event._id), route: '/crm/suprah-calendar' },
          }).catch((err) => console.warn('[calendarReminderSweep] unified notification failed', err))
        ),
      );
    }
  } catch (err) {
    console.warn('[calendarReminderSweep] sweep failed', err);
  } finally {
    running = false;
  }
}
