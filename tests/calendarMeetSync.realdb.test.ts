import mongoose from 'mongoose';
jest.mock('../src/services/suprahMeetNotification.service', () => ({ notifyMeetingCreated: jest.fn() }));
import { CalendarEvent } from '../src/models/calendarEvent.model';
import Meeting from '../src/models/Meeting.model';
import CrmUser from '../src/models/CrmUser.model';
import Organization from '../src/models/Organization.model';
import { syncCalendarMeeting } from '../src/services/calendarMeetSync.service';
import googleCalendar from '../src/services/googleCalendar.service';

describe('calendar rooms with the isolated database', () => {
const org = new mongoose.Types.ObjectId(), otherOrg = new mongoose.Types.ObjectId();
const host = new mongoose.Types.ObjectId(), colleague = new mongoose.Types.ObjectId(), foreign = new mongoose.Types.ObjectId();
const start = new Date(Date.now() + 3_600_000);
const later = () => new Date(start.getTime() + 3_600_000);
const defer = (event: any) => Object.assign(event, { deferNotifications: true });

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(mongoose.connection.host) || !mongoose.connection.name.includes('test')) {
    throw new Error('Calendar integration tests require the isolated local test database');
  }
  await Organization.collection.insertMany([{ _id: org, name: 'Calendar test', slug: String(org), status: 'active' },
    { _id: otherOrg, name: 'Other calendar test', slug: String(otherOrg), status: 'active' }] as any[]);
  await CrmUser.collection.insertMany([
    { _id: host, organizationId: org, email: `host-${org}@example.test`, fullName: 'Host', username: String(host), isActive: true,
      googleCalendar: { calendarConnected: true } },
    { _id: colleague, organizationId: org, email: `colleague-${org}@example.test`, fullName: 'Colleague', username: String(colleague), isActive: true },
    { _id: foreign, organizationId: otherOrg, email: `foreign-${org}@example.test`, fullName: 'Other organization', username: String(foreign), isActive: true },
  ] as any[]);
});
afterAll(async () => {
  await Promise.all([CalendarEvent.deleteMany({ organizationId: org }), Meeting.deleteMany({ organizationId: org }),
    CrmUser.deleteMany({ _id: { $in: [host, colleague, foreign] } }), Organization.deleteMany({ _id: { $in: [org, otherOrg] } })]);
});

async function event(title: string) {
  return CalendarEvent.create({ organizationId: org, createdBy: host, type: 'meeting', title, start,
    end: later(), assignees: [colleague, foreign], meetingSyncPending: true });
}

it('persists one private room, excludes another organization, and retains the code after rescheduling', async () => {
  const source = await event('HR planning');
  await syncCalendarMeeting(defer(source));
  const first = await Meeting.findOne({ calendarSourceId: `calendar:${source._id}` });
  expect(first).toMatchObject({ visibility: 'private', title: 'HR planning' });
  expect(first!.code).toMatch(/^MEET-\d{8}$/);
  expect(first!.invitees.map(String)).toEqual([String(colleague)]);
  expect((await CalendarEvent.findById(source._id))!.meetingSyncPending).toBe(false);
  source.start = later(); source.end = new Date(source.start.getTime() + 3_600_000);
  await source.save(); await syncCalendarMeeting(defer(source));
  const rooms = await Meeting.find({ calendarSourceId: `calendar:${source._id}` });
  expect(rooms).toHaveLength(1);
  expect(rooms[0].code).toBe(first!.code);
  expect(rooms[0].scheduledAt!.getTime()).toBe(source.start.getTime());
});

it('concurrent workers produce one source room instead of duplicate schedules', async () => {
  const source = await event('Concurrent schedule');
  const second = (await CalendarEvent.findById(source._id))!;
  await Promise.all([syncCalendarMeeting(defer(source)), syncCalendarMeeting(defer(second))]);
  expect(await Meeting.countDocuments({ calendarSourceId: `calendar:${source._id}` })).toBe(1);
});

it('cancellation removes its pending room and preserves ended call history', async () => {
  const source = await event('Cancelled schedule');
  await syncCalendarMeeting(defer(source));
  await Meeting.create({ organizationId: org, hostCrmUserId: host, code: 'MEET-0000', title: 'Earlier call',
    calendarSourceId: `calendar:${source._id}`, status: 'ended' });
  source.status = 'cancelled'; source.meetingSyncPending = true; await source.save();
  await syncCalendarMeeting(defer(source));
  expect(await Meeting.countDocuments({ calendarSourceId: `calendar:${source._id}`, status: 'scheduled' })).toBe(0);
  expect(await Meeting.countDocuments({ calendarSourceId: `calendar:${source._id}`, status: 'ended' })).toBe(1);
  const saved = (await CalendarEvent.findById(source._id))!;
  expect(saved.meetingLink).toBeUndefined(); expect(saved.meetingSyncPending).toBe(false);
});

it('the database lease rejects overlapping Google synchronization and is released after completion', async () => {
  let finish!: (value: number) => void;
  const internal = jest.spyOn(googleCalendar as any, 'syncInternal').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = googleCalendar.syncCrmUserCalendar(String(host));
  try {
    for (let attempt = 0; attempt < 100 && !finish; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(finish).toBeDefined();
    await expect(googleCalendar.syncCrmUserCalendar(String(host))).rejects.toThrow('already running');
    finish(1); await first;
    const saved = await CrmUser.findById(host).lean();
    expect(saved!.googleCalendar?.syncClaimToken).toBeUndefined();
  } finally {
    finish?.(1);
    await first.catch(() => undefined);
    internal.mockRestore();
  }
});
});
