import mongoose from 'mongoose';
const crmById = jest.fn(), crmFind = jest.fn(), crmUpdate = jest.fn();
const crmClaim = jest.fn();
const appointmentFind = jest.fn(), appointmentWrite = jest.fn(), appointmentUpdate = jest.fn();
const syncRoom = jest.fn(), deleteRooms = jest.fn();
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: crmById, find: crmFind, updateOne: crmUpdate, findOneAndUpdate: crmClaim } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {
  find: appointmentFind, bulkWrite: appointmentWrite, updateMany: appointmentUpdate } }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { deleteMany: deleteRooms } }));
jest.mock('../../src/services/calendarMeetSync.service', () => ({ syncCalendarMeeting: syncRoom }));
import service from '../../src/services/googleCalendar.service';

const userId = new mongoose.Types.ObjectId(), orgId = new mongoose.Types.ObjectId();
let fetchEvents: jest.SpyInstance;
let entries: any[];
beforeEach(() => {
  jest.clearAllMocks(); delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
  entries = [{ id: 'event-one', summary: 'HR planning', organizer: { self: true },
    start: { dateTime: '2030-03-09T16:00:00Z' }, end: { dateTime: '2030-03-09T17:00:00Z' },
    attendees: [{ email: 'colleague@example.test' }, { email: 'declined@example.test', responseStatus: 'declined' }] }];
  jest.spyOn(service as any, 'getCalendarClient').mockResolvedValue({});
  jest.spyOn(service as any, 'getSyncWindow').mockReturnValue({ timeMin: new Date('2030-01-01'), timeMax: new Date('2030-12-31') });
  fetchEvents = jest.spyOn(service as any, 'fetchAllEventsFromGoogle').mockImplementation(async () => ({ items: entries, nextSyncToken: 'new-token' }));
  crmById.mockResolvedValue({ _id: userId, organizationId: orgId, googleCalendar: { lastSyncAt: new Date(), syncToken: 'legacy-token' } });
  crmClaim.mockReturnValue({ select: async () => ({ _id: userId }) });
  crmUpdate.mockResolvedValue({ matchedCount: 1 });
  crmFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: userId }] }) });
  appointmentFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  appointmentWrite.mockResolvedValue({ insertedCount: 1, modifiedCount: 0 });
  syncRoom.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('upgrades an already-connected calendar and creates a room for an owned timed meeting', async () => {
  await service.syncCrmUserCalendar(String(userId));
  expect(fetchEvents.mock.calls[0]).toHaveLength(3); // full pass instead of reusing its legacy sync token
  expect(syncRoom).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: `google:${userId}:event-one`,
    title: 'HR planning', status: 'scheduled', createdBy: userId, organizationId: orgId }));
  expect(crmFind.mock.calls[0][0].email.$in).toEqual(['colleague@example.test']);
  expect(crmUpdate).toHaveBeenCalledWith({ _id: String(userId) }, expect.objectContaining({ $set: { 'googleCalendar.meetRoomsSyncedAt': expect.any(Date) } }));
});

it('creates a Suprah room when a Google Calendar event already has a Google Meet conference', async () => {
  entries[0] = { ...entries[0], summary: 'Weekly HR planning', attendees: [],
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } },
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] } };
  await service.syncCrmUserCalendar(String(userId));
  expect(syncRoom).toHaveBeenCalledTimes(1);
  expect(syncRoom.mock.calls[0][0]).toMatchObject({ title: 'Weekly HR planning', generateMeetingLink: true,
    start: new Date('2030-03-09T16:00:00Z'), sourceKey: `google:${userId}:event-one` });
  // Its existing Google invitation keeps its Google Meet link.
  expect(appointmentWrite.mock.calls[0][0][0].insertOne.document.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
});

it('creates a separate Suprah session for each expanded Google recurring meeting', async () => {
  const first = { ...entries[0], id: 'series_20300309T160000Z', recurringEventId: 'series',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    originalStartTime: { dateTime: '2030-03-09T16:00:00Z' } };
  entries = [first, { ...first, id: 'series_20300316T150000Z',
    start: { dateTime: '2030-03-16T15:00:00Z' }, end: { dateTime: '2030-03-16T16:00:00Z' },
    originalStartTime: { dateTime: '2030-03-16T15:00:00Z' } }];
  await service.syncCrmUserCalendar(String(userId));
  expect(syncRoom.mock.calls.map(([source]) => source.sourceKey)).toEqual([
    `google:${userId}:series_20300309T160000Z`, `google:${userId}:series_20300316T150000Z`,
  ]);
  expect(syncRoom.mock.calls.map(([source]) => source.start.toISOString())).toEqual([
    '2030-03-09T16:00:00.000Z', '2030-03-16T15:00:00.000Z',
  ]);
});

it('a Google edit updates the same source meeting rather than creating an unrelated schedule', async () => {
  await service.syncCrmUserCalendar(String(userId));
  const sourceKey = syncRoom.mock.calls[0][0].sourceKey;
  syncRoom.mockClear();
  entries[0] = { ...entries[0], summary: 'Rescheduled HR planning',
    start: { dateTime: '2030-03-09T18:00:00Z' }, end: { dateTime: '2030-03-09T19:00:00Z' } };
  await service.syncCrmUserCalendar(String(userId));
  expect(syncRoom.mock.calls[0][0]).toMatchObject({ sourceKey, title: 'Rescheduled HR planning',
    start: new Date('2030-03-09T18:00:00Z') });
});
it.each([
  { organizer: { self: false } },
  { start: { date: '2030-03-09' }, end: { date: '2030-03-10' } },
  { eventType: 'outOfOffice' },
])('does not create rooms for other organizers, all-day events or availability blocks: %o', async changes => {
  entries[0] = { ...entries[0], ...changes };
  await service.syncCrmUserCalendar(String(userId));
  expect(syncRoom).not.toHaveBeenCalled();
  expect(deleteRooms.mock.calls[0][0].status).toBe('scheduled');
});
it('applies a changed meeting date outside the rolling appointment window', async () => {
  entries[0] = { ...entries[0], start: { dateTime: '2031-02-01T16:00:00Z' },
    end: { dateTime: '2031-02-01T17:00:00Z' } };
  await service.syncCrmUserCalendar(String(userId));
  expect(appointmentWrite).not.toHaveBeenCalled();
  expect(syncRoom).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: `google:${userId}:event-one`,
    start: new Date('2031-02-01T16:00:00Z') }));
});
it('cancellation removes only pending source rooms and retains old calls', async () => {
  entries = [{ id: 'event-one', status: 'cancelled' }];
  await service.syncCrmUserCalendar(String(userId));
  expect(deleteRooms).toHaveBeenCalledWith({ organizationId: String(orgId),
    calendarSourceId: { $in: [`google:${userId}:event-one`] }, status: 'scheduled' });
});
it('a failed room sync never advances the Google sync token', async () => {
  syncRoom.mockRejectedValueOnce(new Error('Database temporarily unavailable'));
  await expect(service.syncCrmUserCalendar(String(userId))).rejects.toThrow('Database temporarily');
  expect(crmUpdate.mock.calls.some(([, update]) => update.$set?.['googleCalendar.syncToken'])).toBe(false);
  expect(crmUpdate.mock.calls.some(([, update]) => update.$unset?.['googleCalendar.syncClaimToken'] !== undefined)).toBe(true);
});

it('a claimed calendar cannot be synchronized by a second worker', async () => {
  crmClaim.mockReturnValue({ select: async () => null });
  await expect(service.syncCrmUserCalendar(String(userId))).rejects.toThrow('already running');
  expect(fetchEvents).not.toHaveBeenCalled();
});

it('a Google quota response never disconnects a healthy account', async () => {
  fetchEvents.mockRejectedValueOnce({ code: 403, message: 'User Rate Limit Exceeded',
    response: { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } });
  await expect(service.syncCrmUserCalendar(String(userId))).rejects.toMatchObject({ statusCode: 429 });
  expect(crmUpdate.mock.calls.some(([, update]) => update.$set?.['googleCalendar.calendarConnected'] === false)).toBe(false);
});

it('a real missing-scope response still asks the person to reconnect', async () => {
  fetchEvents.mockRejectedValueOnce({ code: 403, message: 'Insufficient Permission',
    response: { data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } });
  await expect(service.syncCrmUserCalendar(String(userId))).rejects.toMatchObject({ statusCode: 403 });
  expect(crmUpdate.mock.calls.some(([, update]) => update.$set?.['googleCalendar.calendarConnected'] === false)).toBe(true);
});
