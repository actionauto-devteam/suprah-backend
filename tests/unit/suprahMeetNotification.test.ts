const findUsers = jest.fn();
const findHost = jest.fn();
const createNotification = jest.fn();
const updateMeeting = jest.fn();

jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true, default: { updateOne: updateMeeting },
}));
jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true, default: { find: findUsers, findOne: findHost },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true, default: { createNotification },
}));

import { notifyMeetingCreated, notifyMeetingReminder } from '../../src/services/suprahMeetNotification.service';

const now = new Date('2026-10-20T17:50:00Z');
const buildMeeting = (overrides: Record<string, unknown> = {}): any => ({
  _id: 'meeting-1', organizationId: 'org-1', hostCrmUserId: 'host',
  invitees: ['host', 'person-1', 'person-1', 'department-member'], inviteAll: false,
  title: 'Team planning', code: 'MEET-1234', scheduledAt: new Date('2026-10-20T18:00:00Z'),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  findHost.mockReturnValue({ select: () => ({ lean: async () => ({ fullName: 'Taylor Reed' }) }) });
  findUsers.mockReturnValue({ select: () => ({ lean: async () => [
    { _id: 'host' }, { _id: 'person-1' }, { _id: 'person-1' }, { _id: 'department-member' },
  ] }) });
  createNotification.mockReset().mockResolvedValue({ _id: 'notice' });
  updateMeeting.mockResolvedValue({ modifiedCount: 1 });
});

it('invites each active org-scoped recipient once, excluding the creator', async () => {
  await notifyMeetingCreated(buildMeeting());
  expect(findUsers).toHaveBeenCalledWith({
    organizationId: 'org-1', isActive: true, isSystem: { $ne: true },
    _id: { $in: ['host', 'person-1', 'department-member'] },
  });
  expect(findHost).toHaveBeenCalledWith({ _id: 'host', organizationId: 'org-1' });
  expect(createNotification.mock.calls.map(([notice]) => notice.userId)).toEqual(['person-1', 'department-member']);
  const notice = createNotification.mock.calls[0][0];
  expect(notice.type).toBe('suprah_meet_invited');
  expect(notice.title).toBe('Taylor invited you to a meeting');
  expect(notice.message).toContain('Taylor created "Team planning"');
  expect(notice.message).toContain('12:00 PM MDT');
  expect(notice.message).toContain('Upcoming');
  expect(notice.metadata.route).toBe('/crm/suprah-meet/room/MEET-1234');
  expect(notice.metadata.pushSource).toBe('Suprah Meet');
  expect(updateMeeting).toHaveBeenCalledWith(
    { _id: 'meeting-1', organizationId: 'org-1' },
    { $set: { invitationNotificationPending: false } },
  );
});

it('invite-all expands only within the same active organization audience', async () => {
  await notifyMeetingCreated(buildMeeting({ inviteAll: true, invitees: [] }));
  expect(findUsers.mock.calls[0][0]).toEqual({
    organizationId: 'org-1', isActive: true, isSystem: { $ne: true },
  });
  expect(createNotification).toHaveBeenCalledTimes(2);
});

it('instant invitations say live now without an Upcoming/date claim', async () => {
  await notifyMeetingCreated(buildMeeting({ scheduledAt: null }));
  const notice = createNotification.mock.calls[0][0];
  expect(notice.message).toContain('live now');
  expect(notice.message).not.toContain('Upcoming');
});

it('keeps the durable invitation pending on partial persistence failure', async () => {
  createNotification.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(notifyMeetingCreated(buildMeeting())).rejects.toThrow('database unavailable');
  expect(updateMeeting).not.toHaveBeenCalled();
});

it('retries use the same idempotency keys, with separate keys for each recurring session', async () => {
  await notifyMeetingCreated(buildMeeting());
  const firstKey = createNotification.mock.calls[0][0].idempotencyKey;
  createNotification.mockClear();
  await notifyMeetingCreated(buildMeeting());
  expect(createNotification.mock.calls[0][0].idempotencyKey).toBe(firstKey);
  createNotification.mockClear();
  await notifyMeetingCreated(buildMeeting({ _id: 'meeting-2' }));
  expect(createNotification.mock.calls[0][0].idempotencyKey).not.toBe(firstKey);
});

it('ten-minute reminders include the host, timing and join link', async () => {
  await notifyMeetingReminder(buildMeeting(), now);
  expect(createNotification.mock.calls.map(([notice]) => notice.userId)).toEqual(['host', 'person-1', 'department-member']);
  const notice = createNotification.mock.calls[0][0];
  expect(notice.type).toBe('suprah_meet_reminder');
  expect(notice.message).toContain("Taylor's meeting");
  expect(notice.message).toContain('starts in 10 minutes');
  expect(notice.message).toContain('join the meeting now');
  expect(notice.metadata.route).toBe('/crm/suprah-meet/room/MEET-1234');
});

it('reminder retries reuse the event key, but rescheduled sessions get a new key', async () => {
  await notifyMeetingReminder(buildMeeting(), now);
  const key = createNotification.mock.calls[0][0].idempotencyKey;
  createNotification.mockClear();
  await notifyMeetingReminder(buildMeeting(), new Date(now.getTime() + 30_000));
  expect(createNotification.mock.calls[0][0].idempotencyKey).toBe(key);
  createNotification.mockClear();
  await notifyMeetingReminder(buildMeeting({ scheduledAt: new Date('2026-10-21T18:00:00Z') }), now);
  expect(createNotification.mock.calls[0][0].idempotencyKey).not.toBe(key);
});

it('uses MST in winter instead of hardcoding MDT', async () => {
  await notifyMeetingCreated(buildMeeting({ scheduledAt: new Date('2026-12-01T19:00:00Z') }));
  expect(createNotification.mock.calls[0][0].message).toContain('12:00 PM MST');
});

it('honors suppressed notifications without leaving an endless pending retry', async () => {
  createNotification.mockResolvedValue(null);
  await notifyMeetingCreated(buildMeeting());
  expect(updateMeeting).toHaveBeenCalledTimes(1);
});
