const findById = jest.fn();
const upsert = jest.fn();
const remove = jest.fn();
const findUsers = jest.fn();
const findUpcoming = jest.fn();
const notify = jest.fn();
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true,
  default: { findById, findOne: findUpcoming, findOneAndUpdate: upsert, deleteMany: remove } }));
jest.mock('../../src/models/calendarEvent.model', () => ({ CalendarEvent: {} }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { find: findUsers } }));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ notifyMeetingCreated: notify }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
import { calendarMeetingTimes, syncCalendarMeeting } from '../../src/services/calendarMeetSync.service';

function event(overrides: Record<string, unknown> = {}): any {
  return { _id: 'event-one', organizationId: 'org-one', createdBy: 'host', title: 'HR planning',
    type: 'meeting', status: 'scheduled', start: new Date('2030-03-09T16:00:00Z'),
    end: new Date('2030-03-09T17:00:00Z'), repeatsDailyWindow: false,
    assignees: ['colleague', 'foreign-user'], generateMeetingLink: true, save: jest.fn(), ...overrides };
}
beforeEach(() => {
  jest.clearAllMocks();
  findById.mockResolvedValue(null);
  findUpcoming.mockResolvedValue(null);
  upsert.mockImplementation(async (filter, update) => ({ _id: filter._id, code: 'MEET-1000',
    status: 'scheduled', ...update.$setOnInsert, ...update.$set }));
  notify.mockResolvedValue(undefined);
  findUsers.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'colleague' }] }) });
});

it('creates a private Meet room and stores its join link on a calendar meeting', async () => {
  const source = event();
  await syncCalendarMeeting(source);
  const inserted = upsert.mock.calls.find(([, update]) => update.$setOnInsert)?.[1].$setOnInsert;
  expect(inserted).toMatchObject({ organizationId: 'org-one', calendarSourceId: 'calendar:event-one',
    hostCrmUserId: 'host', invitees: ['colleague'], visibility: 'private', status: 'scheduled' });
  expect(findUsers.mock.calls[0][0].organizationId).toBe('org-one');
  expect(source.meetingLink).toMatch(/\/crm\/suprah-meet\/room\/MEET-\d{4}$/);
  expect(source.save).toHaveBeenCalled();
});

it('rescheduling preserves the room code and resets its reminder', async () => {
  findById.mockResolvedValue({ _id: 'same-room', code: 'MEET-1234', status: 'scheduled',
    scheduledAt: new Date('2030-03-08T16:00:00Z') });
  upsert.mockImplementation(async (filter, update) => ({ _id: filter._id, code: 'MEET-1234',
    status: 'scheduled', ...update.$set }));
  const source = event();
  await syncCalendarMeeting(source);
  expect(upsert.mock.calls[0][1].$set).toMatchObject({ scheduledAt: source.start, reminderSentAt: null,
    invitationNotificationPending: true });
  expect(source.meetingLink).toContain('MEET-1234');
});

it.each([{ deletedAt: new Date() }, { status: 'cancelled' }, { generateMeetingLink: false }, { type: 'task' }])(
  'cancellation/removal/opt-out only removes scheduled source rooms: %o', async override => {
    await syncCalendarMeeting(event(override));
    expect(remove).toHaveBeenCalledWith({ organizationId: 'org-one', calendarSourceId: 'calendar:event-one', status: 'scheduled' });
    expect(upsert).not.toHaveBeenCalled();
  });

it('daily windows honor selected days and Mountain daylight saving time', () => {
  const times = calendarMeetingTimes(event({ repeatsDailyWindow: true, dailyStartTime: '09:00',
    end: new Date('2030-03-11T17:00:00Z'), includedDates: ['2030-03-09', '2030-03-10'] }));
  expect(times.map(time => time.toISOString())).toEqual(['2030-03-09T16:00:00.000Z', '2030-03-10T15:00:00.000Z']);
});

it('syncing an existing live or ended room preserves its history and audience', async () => {
  findById.mockResolvedValue({ _id: 'live', code: 'MEET-1234', status: 'live', scheduledAt: new Date('2030-03-09T16:00:00Z') });
  await syncCalendarMeeting(event());
  expect(upsert).not.toHaveBeenCalled();
  expect(remove.mock.calls[0][0].status).toBe('scheduled');
});

it('a later session on a reused calendar item gets a new room and preserves the ended call', async () => {
  findById.mockResolvedValueOnce({ _id: 'old', code: 'MEET-1111', status: 'ended',
    scheduledAt: new Date('2030-03-08T16:00:00Z') }).mockResolvedValue(null);
  const source = event();
  await syncCalendarMeeting(source);
  expect(upsert.mock.calls[0][0]._id).not.toBe('old');
  expect(upsert.mock.calls[0][1].$setOnInsert.scheduledAt).toEqual(source.start);
});

it('bulk imports leave invitations for the bounded notification worker', async () => {
  const source = event({ deferNotifications: true });
  await syncCalendarMeeting(source);
  expect(notify).not.toHaveBeenCalled();
  expect(upsert.mock.calls[0][1].$setOnInsert.invitationNotificationPending).toBe(true);
});
