const findUsers = jest.fn();
const findHost = jest.fn();
const findCrmUserById = jest.fn();
const upsertNotification = jest.fn();
const updateMeeting = jest.fn();
const push = jest.fn();
const emitToUser = jest.fn();
const emitToCrmUser = jest.fn();

jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true, default: { updateOne: updateMeeting },
}));
jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true, default: { find: findUsers, findOne: findHost, findById: findCrmUserById },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true, default: { findById: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../src/models/Notification.model', () => ({
  __esModule: true, default: { findOneAndUpdate: upsertNotification },
}));
jest.mock('../../src/services/unifiedPush.service', () => ({
  __esModule: true, default: { sendToUser: push },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser, emitToCrmUser }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import { notifyMeetingCreated, notifyMeetingReminder } from '../../src/services/suprahMeetNotification.service';

const meeting: any = {
  _id: 'meeting-1', organizationId: 'org-1', hostCrmUserId: 'host',
  invitees: ['person'], inviteAll: false, title: 'Planning', code: 'MEET-1234',
  scheduledAt: new Date('2026-10-20T18:00:00Z'),
};

beforeEach(() => {
  jest.resetAllMocks();
  const saved = new Map<string, any>();
  upsertNotification.mockImplementation(async (filter, update) => {
    const key = String(filter._id);
    const existing = saved.get(key);
    const value = existing || { ...update.$setOnInsert, _id: key };
    saved.set(key, value);
    return { value, lastErrorObject: { updatedExisting: Boolean(existing) } };
  });
  findUsers.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'person' }] }) });
  findHost.mockReturnValue({ select: () => ({ lean: async () => ({ fullName: 'Taylor Reed' }) }) });
  findCrmUserById.mockResolvedValue({ _id: 'person', organizationId: 'org-1', notificationPreferences: { crm: true } });
  updateMeeting.mockResolvedValue({ modifiedCount: 1 });
  push.mockResolvedValue({ sent: 1 });
});

it('persists both stages in the CRM bell and delivers distinct socket/push notices with a room URL', async () => {
  await notifyMeetingCreated(meeting);
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  expect(upsertNotification.mock.calls.map(([, update]) => update.$setOnInsert.type))
    .toEqual(['suprah_meet_invited', 'suprah_meet_reminder']);
  expect(upsertNotification.mock.calls.every(([, update]) => update.$setOnInsert.category === 'crm')).toBe(true);
  expect(emitToCrmUser.mock.calls.map(([, event]) => event)).toEqual(['crm:notification:new', 'crm:notification:new']);
  expect(push).toHaveBeenCalledTimes(2);
  const payloads = push.mock.calls.map(([, payload]) => payload);
  expect(payloads.every((payload) => payload.data.url === '/crm/suprah-meet/room/MEET-1234')).toBe(true);
  expect(payloads[0].tag).not.toBe(payloads[1].tag);
  expect(payloads[0].source).toBe('Suprah Meet');
  // Meeting alerts must bypass the SW's ordinary background burst summary so
  // their distinct room URL remains immediately tappable on desktop and PWA.
  expect(payloads.every((payload) => payload.data.soundProfile === 'attention')).toBe(true);
  expect(payloads.every((payload) => payload.data.priority === 'high')).toBe(true);
  expect(payloads.every((payload) => payload.data.meetingTitle === 'Planning')).toBe(true);
  expect(push.mock.calls.every(([, , includeSpace]) => includeSpace === false)).toBe(true);
});

it('retrying the same event does not emit or push a second notification', async () => {
  await notifyMeetingCreated(meeting);
  await notifyMeetingCreated(meeting);
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:30Z'));
  expect(push).toHaveBeenCalledTimes(2);
  expect(emitToCrmUser).toHaveBeenCalledTimes(2);
});

it('respects CRM and meeting-type notification preferences', async () => {
  findCrmUserById.mockResolvedValueOnce({ organizationId: 'org-1', notificationPreferences: { crm: false } });
  await notifyMeetingCreated(meeting);
  findCrmUserById.mockResolvedValueOnce({ organizationId: 'org-1', notificationPreferences: { crm: true, mutedTypes: ['suprah_meet_reminder'] } });
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  expect(upsertNotification).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
