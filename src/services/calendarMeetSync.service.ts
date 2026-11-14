import { createHash, randomInt } from 'crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import Meeting from '../models/Meeting.model';
import { CalendarEvent, ICalendarEvent } from '../models/calendarEvent.model';
import { notifyMeetingCreated } from './suprahMeetNotification.service';
import logger from '../utils/logger';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';

const TZ = 'America/Denver';
export type MeetingCalendarSource = Pick<ICalendarEvent,
  'organizationId' | 'createdBy' | 'type' | 'status' | 'deletedAt' | 'title' | 'assignees' |
  'start' | 'end' | 'repeatsDailyWindow' | 'dailyStartTime' | 'includedDates' |
  'generateMeetingLink' | 'meetingLink' | 'meetingRoomName'> & {
    _id: unknown; sourceKey?: string; deferNotifications?: boolean; meetingSyncPending?: boolean; save(): Promise<unknown>;
  };

/** Each daily window gets its own room, recording, and reminders. */
export function calendarMeetingTimes(event: Pick<ICalendarEvent,
  'start' | 'end' | 'repeatsDailyWindow' | 'dailyStartTime' | 'includedDates'>): Date[] {
  if (!event.repeatsDailyWindow) return [new Date(event.start)];
  const first = formatInTimeZone(event.start, TZ, 'yyyy-MM-dd');
  const last = formatInTimeZone(event.end, TZ, 'yyyy-MM-dd');
  if ((Date.parse(last) - Date.parse(first)) / 86_400_000 >= 120) {
    throw new ApiError(400, 'Recurring calendar meetings can span at most 120 days.');
  }
  const included = new Set(event.includedDates ?? []);
  const result: Date[] = [];
  for (let cursor = new Date(`${first}T12:00:00Z`); result.length < 120; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10);
    if (day > last) break;
    if (!included.size || included.has(day)) {
      result.push(fromZonedTime(`${day}T${event.dailyStartTime || '09:00'}:00`, TZ));
    }
  }
  return result;
}

export async function syncCalendarMeeting(event: MeetingCalendarSource): Promise<void> {
  const source = event.sourceKey || `calendar:${event._id}`;
  const scope = { organizationId: event.organizationId, calendarSourceId: source };
  if (event.deletedAt || event.status !== 'scheduled' || event.type !== 'meeting' || event.generateMeetingLink === false) {
    // Never tear down a room in progress or its saved recording.
    await Meeting.deleteMany({ ...scope, status: 'scheduled' });
    if (event.meetingRoomName || event.meetingSyncPending) {
      event.meetingLink = undefined;
      event.meetingRoomName = undefined;
      event.meetingSyncPending = false;
      await event.save();
    }
    return;
  }
  const times = calendarMeetingTimes(event);
  const keyOf = (date: Date) => event.repeatsDailyWindow ? formatInTimeZone(date, TZ, 'yyyy-MM-dd') : 'single';
  const keys = times.map(keyOf);
  await Meeting.deleteMany({ ...scope, status: 'scheduled', calendarOccurrenceKey: { $nin: keys } });
  const requested = [...new Set(event.assignees.map(id => String((id as any)?._id ?? id)))];
  const audience = (await CrmUser.find({ _id: { $in: requested }, organizationId: event.organizationId,
    isActive: { $ne: false } }).select('_id').lean()).map(user => user._id);
  const rooms = [];
  for (const scheduledAt of times) {
    const key = keyOf(scheduledAt);
    let id = createHash('sha256').update(`${event.organizationId}:${source}:${key}`).digest('hex').slice(0, 24);
    let room = await Meeting.findById(id);
    // Reusing an old calendar item for a later session must preserve the old
    // call and create a new room. Subsequent edits reuse its upcoming room.
    if (!event.repeatsDailyWindow && room && room.status !== 'scheduled' && room.scheduledAt?.getTime() !== scheduledAt.getTime()) {
      const upcoming = await Meeting.findOne({ ...scope, status: 'scheduled', calendarOccurrenceKey: key });
      if (upcoming) { room = upcoming; id = String(upcoming._id); }
      else {
        id = createHash('sha256').update(`${event.organizationId}:${source}:${scheduledAt.toISOString()}`).digest('hex').slice(0, 24);
        room = await Meeting.findById(id);
      }
    }
    if (!room && scheduledAt.getTime() < Date.now() - 60_000) continue;
    if (!room) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          room = await Meeting.findOneAndUpdate({ _id: id, organizationId: event.organizationId }, { $setOnInsert: {
            // Imports can expand hundreds of recurring sessions. Keep them
            // out of the 9,000-code namespace used by manual meetings.
            ...scope, calendarOccurrenceKey: key, code: `MEET-${randomInt(10_000_000, 100_000_000)}`,
            title: event.title, hostCrmUserId: (event.createdBy as any)?._id ?? event.createdBy,
            scheduledAt, status: 'scheduled', visibility: 'private',
            invitees: audience, inviteAll: false, invitationNotificationPending: true,
          } }, { upsert: true, new: true, setDefaultsOnInsert: true });
          break;
        } catch (error: any) { if (error?.code !== 11000 || attempt === 4) throw error; }
      }
    }
    if (!room) continue;
    if (room.status === 'scheduled') {
      const rescheduled = room.scheduledAt?.getTime() !== scheduledAt.getTime();
      const audienceChanged = JSON.stringify((room.invitees ?? []).map(String).sort()) !==
        JSON.stringify(audience.map(String).sort());
      room = await Meeting.findOneAndUpdate({ _id: room._id, status: 'scheduled' }, { $set: {
        title: event.title, invitees: audience, scheduledAt,
        ...(audienceChanged ? { invitationNotificationPending: true } : {}),
        ...(rescheduled ? { reminderSentAt: null, reminderClaimToken: null, reminderClaimUntil: null,
          invitationNotificationPending: true } : {}),
      } }, { new: true }) ?? room;
    }
    rooms.push(room);
    if (room.invitationNotificationPending && !event.deferNotifications && times.length === 1) {
      const meetingId = room._id;
      void notifyMeetingCreated(room).catch(error => logger.error({ error, meetingId }, '[CalendarMeet] Invitation pending retry'));
    }
  }
  const next = rooms.find(room => room.status !== 'ended' && (room.scheduledAt?.getTime() ?? 0) >= Date.now()) ?? rooms[0];
  if (next) {
    event.meetingLink = `/crm/suprah-meet/room/${encodeURIComponent(next.code)}`;
    event.meetingRoomName = next.code;
  }
  if (next || event.meetingSyncPending) {
    event.meetingSyncPending = false;
    await event.save();
  }
}

/** Recover upcoming legacy calendar meetings which never had a room. */
const recoveryByOrg = new Map<string, { until: number; task: Promise<void> }>();
export async function recoverCalendarMeetings(organizationId: unknown): Promise<void> {
  const orgKey = String(organizationId);
  const current = recoveryByOrg.get(orgKey);
  if (current && current.until > Date.now()) return current.task;
  for (const [key, entry] of recoveryByOrg) if (entry.until <= Date.now()) recoveryByOrg.delete(key);
  const entry = { until: Infinity, task: Promise.resolve() };
  const task = recoverUpcomingCalendarMeetings(organizationId).finally(() => { entry.until = Date.now() + 60_000; });
  entry.task = task;
  recoveryByOrg.set(orgKey, entry);
  return task;
}

async function recoverUpcomingCalendarMeetings(organizationId: unknown): Promise<void> {
  const events = await CalendarEvent.find({ organizationId, $or: [
    { meetingSyncPending: true },
    { deletedAt: null, type: 'meeting', status: 'scheduled', generateMeetingLink: { $ne: false },
      meetingLink: { $in: [null, ''] }, end: { $gte: new Date() },
      $or: [{ start: { $gte: new Date(Date.now() - 60_000) } }, { repeatsDailyWindow: true }] },
  ],
  }).sort({ start: 1 }).limit(50);
  for (const event of events) {
    try { await syncCalendarMeeting(Object.assign(event, { deferNotifications: true })); }
    catch (error) { logger.error({ error, calendarEventId: event._id }, '[CalendarMeet] Room recovery will retry'); }
  }
}
