import mongoose from 'mongoose';
import { CalendarEvent } from '../models/calendarEvent.model';
import { emitCalendarChange } from './calendarSocket.service';
import { IProjectTask } from '../models/ProjectTask.model';

/**
 * projectCalendarSync — keeps Suprah Calendar in lockstep with task deadlines.
 *
 * Every task that has a deadline owns exactly one CalendarEvent (type "task"),
 * referenced by task.calendarEventId:
 *   deadline set          → event created
 *   deadline/title change → event updated
 *   assignees change      → event assignees updated
 *   status → completed    → event status "completed"
 *   deadline removed      → event deleted
 *   task deleted          → event deleted
 *
 * Everything here is BEST-EFFORT: calendar sync must never fail the task
 * mutation, so callers `await` these helpers but errors are swallowed and
 * logged. Real-time fan-out reuses the calendar's own socket service, so the
 * Suprah Calendar UI updates instantly with no refetch.
 */

const log = (msg: string, err?: unknown) =>
  console.warn(`[projectCalendarSync] ${msg}`, err ?? '');

/** Event window: startDate→deadline when both exist, else a 1-hour block ending at the deadline. */
function eventWindow(task: IProjectTask): { start: Date; end: Date } | null {
  if (!task.deadline) return null;
  const end = new Date(task.deadline);
  const start =
    task.startDate && new Date(task.startDate) < end
      ? new Date(task.startDate)
      : new Date(end.getTime() - 60 * 60 * 1000);
  return { start, end };
}

/**
 * Create/update/delete the linked calendar event to match the task's current
 * state. Returns the (possibly changed) calendarEventId so the caller can
 * persist it on the task document.
 */
export async function syncTaskToCalendar(
  task: IProjectTask,
  actorId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> {
  try {
    const orgId = task.organizationId.toString();
    const window = eventWindow(task);

    // ── No deadline (anymore): remove any linked event ──
    if (!window) {
      if (task.calendarEventId) {
        await CalendarEvent.deleteOne({ _id: task.calendarEventId });
        emitCalendarChange('calendar:deleted', orgId, {
          source: 'calendarEvent',
          id: String(task.calendarEventId),
        });
      }
      return null;
    }

    const fields = {
      title: `Task: ${task.title}`,
      description: task.description || undefined,
      start: window.start,
      end: window.end,
      assignees: task.assigneeIds,
      status: task.status === 'completed' ? ('completed' as const) : ('scheduled' as const),
      color: 'task',
    };

    // ── Update the existing linked event ──
    if (task.calendarEventId) {
      const doc = await CalendarEvent.findOneAndUpdate(
        { _id: task.calendarEventId, deletedAt: null },
        { $set: fields },
        { new: true },
      )
        .populate([
          { path: 'createdBy', select: 'fullName username email' },
          { path: 'assignees', select: 'fullName username email' },
        ])
        .lean();
      if (doc) {
        emitCalendarChange('calendar:updated', orgId, {
          source: 'calendarEvent',
          item: mapEventForSocket(doc),
        });
        return task.calendarEventId;
      }
      // Linked event vanished (deleted from the calendar UI) — fall through
      // and recreate it so the modules stay consistent.
    }

    // ── Create a fresh linked event ──
    const created = await CalendarEvent.create({
      organizationId: task.organizationId,
      type: 'task',
      allDay: false,
      repeatsDailyWindow: false,
      createdBy: task.createdBy ?? actorId,
      ...fields,
    });
    const populated = await CalendarEvent.findById(created._id)
      .populate([
        { path: 'createdBy', select: 'fullName username email' },
        { path: 'assignees', select: 'fullName username email' },
      ])
      .lean();
    emitCalendarChange('calendar:created', orgId, {
      source: 'calendarEvent',
      item: mapEventForSocket(populated),
    });
    return created._id as mongoose.Types.ObjectId;
  } catch (err) {
    log('sync failed (task mutation unaffected)', err);
    return task.calendarEventId ?? null;
  }
}

/** Remove the linked event when a task is deleted. Best-effort. */
export async function removeTaskCalendarEvent(task: IProjectTask): Promise<void> {
  try {
    if (!task.calendarEventId) return;
    await CalendarEvent.deleteOne({ _id: task.calendarEventId });
    emitCalendarChange('calendar:deleted', task.organizationId.toString(), {
      source: 'calendarEvent',
      id: String(task.calendarEventId),
    });
  } catch (err) {
    log('event cleanup failed', err);
  }
}

/** Same FeedItem shape the calendar controller broadcasts (viewer fields stripped). */
function mapEventForSocket(doc: any) {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    source: 'calendarEvent',
    type: doc.type,
    title: doc.title,
    description: doc.description,
    start: doc.start,
    end: doc.end,
    allDay: doc.allDay,
    repeatsDailyWindow: doc.repeatsDailyWindow,
    dailyStartTime: doc.dailyStartTime,
    dailyEndTime: doc.dailyEndTime,
    includedDates: doc.includedDates,
    status: doc.status,
    color: doc.color,
    meetingLink: doc.meetingLink,
    createdBy: doc.createdBy,
    assignees: doc.assignees,
  };
}