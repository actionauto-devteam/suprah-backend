import mongoose from 'mongoose';
jest.mock('../src/services/suprahMeetNotification.service', () => ({ notifyMeetingCreated: jest.fn() }));
import CrmUser from '../src/models/CrmUser.model';
import Meeting from '../src/models/Meeting.model';
import Appointment from '../src/models/Appointment.model';
import Notification from '../src/models/Notification.model';
import calendar from '../src/services/googleCalendar.service';

describe('Google ownership correction with the isolated database', () => {
  const org = new mongoose.Types.ObjectId(), otherOrg = new mongoose.Types.ObjectId();
  const host = new mongoose.Types.ObjectId(), colleague = new mongoose.Types.ObjectId(), outsider = new mongoose.Types.ObjectId();
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || !mongoose.connection.name.endsWith('_test')) {
      throw new Error('Isolated local test database required');
    }
    await CrmUser.collection.insertMany([
      { _id: host, organizationId: org, fullName: 'Owner', email: `owner-${org}@example.test`, username: String(host), isActive: true,
        googleCalendar: { calendarConnected: true, lastSyncAt: new Date(), meetRoomsSyncedAt: new Date(), meetRoomsSyncVersion: 1, syncToken: 'old' } },
      { _id: colleague, organizationId: org, fullName: 'Colleague', email: `crm-${org}@example.test`, username: String(colleague), isActive: true,
        googleCalendar: { calendarConnected: true, gmailAddress: 'calendar-alias@example.test' } },
      { _id: outsider, organizationId: otherOrg, fullName: 'Other tenant', email: `outsider-${org}@example.test`, username: String(outsider), isActive: true,
        googleCalendar: { calendarConnected: true, gmailAddress: 'calendar-alias@example.test' } },
    ] as any[]);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all([Meeting.deleteMany({ organizationId: org }), Appointment.deleteMany({ organizationId: String(org) }),
      CrmUser.deleteMany({ _id: { $in: [host, colleague, outsider] } }), Notification.deleteMany({ organizationId: String(org) })]);
  });

  it('removes only unused attendee copies, retains original rooms/history, and shares an owned room with Google-linked teammates', async () => {
    const start = new Date(Date.now() + 86_400_000);
    const source = `google:${host}:attendee-copy`;
    const base = { organizationId: org, hostCrmUserId: host, title: 'Calendar test call', scheduledAt: start };
    const unused = await Meeting.create({ ...base, code: 'MEET-8801', status: 'scheduled', calendarSourceId: source });
    const live = await Meeting.create({ ...base, code: 'MEET-8802', status: 'live', calendarSourceId: source });
    const history = await Meeting.create({ ...base, code: 'MEET-8803', status: 'scheduled', calendarSourceId: source,
      participants: [{ crmUserId: host, fullName: 'Owner', role: 'host', joinedAt: new Date(), leftAt: new Date() }] });
    const original = await Meeting.create({ ...base, code: 'MEET-8804', status: 'scheduled', title: 'Daily Online Web Dev & CRM QA Sync' });
    const notice = { organizationId: String(org), userId: colleague, category: 'calendar', title: 'Meeting alert', message: 'Test alert' };
    const duplicateInvite = await Notification.create({ ...notice, type: 'suprah_meet_invited', metadata: { meetingId: String(unused._id) } });
    const originalInvite = await Notification.create({ ...notice, type: 'suprah_meet_invited', metadata: { meetingId: String(original._id) } });
    const liveAlert = await Notification.create({ ...notice, type: 'suprah_meet_live', metadata: { meetingId: String(live._id) } });
    const event = { summary: 'Calendar test call', start: { dateTime: start.toISOString() },
      end: { dateTime: new Date(start.getTime() + 3_600_000).toISOString() },
      attendees: [{ email: 'CALENDAR-ALIAS@EXAMPLE.TEST' }] };
    jest.spyOn(calendar as any, 'getCalendarClient').mockResolvedValue({});
    const fetchEvents = jest.spyOn(calendar as any, 'fetchAllEventsFromGoogle').mockResolvedValue({
      items: [{ ...event, id: 'attendee-copy', organizer: { email: 'another-person@example.test' } },
        { ...event, id: 'owned-room', organizer: { self: true } }], nextSyncToken: 'corrected',
    });
    await calendar.syncCrmUserCalendar(String(host));
    expect(await Meeting.findById(unused._id)).toBeNull();
    for (const id of [live._id, history._id, original._id]) expect(await Meeting.exists({ _id: id })).toBeTruthy();
    const owned = (await Meeting.findOne({ calendarSourceId: `google:${host}:owned-room` }))!;
    expect(owned.invitees.map(String)).toEqual([String(colleague)]);
    expect(owned.invitationNotificationPending).toBe(false);
    expect(await Notification.findById(duplicateInvite._id)).toBeNull();
    expect(await Notification.exists({ _id: originalInvite._id })).toBeTruthy();
    expect(await Notification.exists({ _id: liveAlert._id })).toBeTruthy();
    expect((await CrmUser.findById(host))!.googleCalendar?.meetRoomsSyncVersion).toBe(2);
    expect(fetchEvents.mock.calls[0]).toHaveLength(3);
  });
});
