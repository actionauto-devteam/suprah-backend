const findUsers = jest.fn();
const findHost = jest.fn();
const findCrmUserById = jest.fn();
const upsertNotification = jest.fn();
const updateMeeting = jest.fn();
const push = jest.fn();
const genericPush = jest.fn();
const updateNotification = jest.fn();
const emitToUser = jest.fn();
const emitToCrmUser = jest.fn();
const deviceStates = () => updateNotification.mock.calls.filter(([, update]) => update.$set?.['metadata.devicePush'])
  .map(([, update]) => update.$set['metadata.devicePush']);

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
  __esModule: true, default: { findOneAndUpdate: upsertNotification, updateOne: updateNotification },
}));
jest.mock('../../src/services/unifiedPush.service', () => ({
  __esModule: true, default: { sendToUser: genericPush },
}));
jest.mock('../../src/services/crmPush.service', () => ({ CrmPushService: { sendToUsers: push } }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser, emitToCrmUser }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import { notifyMeetingCreated, notifyMeetingReminder } from '../../src/services/suprahMeetNotification.service';

const meeting: any = {
  _id: 'meeting-1', organizationId: 'org-1', hostCrmUserId: 'host',
  invitees: ['person'], inviteAll: false, title: 'Planning', code: 'MEET-1234',
  status: 'scheduled',
  scheduledAt: new Date('2026-10-20T18:00:00Z'),
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-20T17:45:00Z').getTime());
  const saved = new Map<string, any>();
  updateNotification.mockImplementation(async (filter, update) => {
    const row = saved.get(String(filter._id));
    if (row && update.$set?.['metadata.devicePush']) row.metadata.devicePush = update.$set['metadata.devicePush'];
    return { modifiedCount: 1 };
  });
  upsertNotification.mockImplementation(async (filter, update) => {
    const key = String(filter._id);
    const existing = saved.get(key);
    const value = existing || { ...update.$setOnInsert, _id: key };
    saved.set(key, value);
    return { value, lastErrorObject: { updatedExisting: Boolean(existing) } };
  });
  findUsers.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'person' }] }) });
  findHost.mockReturnValue({ select: () => ({ lean: async () => ({ fullName: 'Taylor Reed' }) }) });
  findCrmUserById.mockResolvedValue({ _id: 'person', organizationId: 'org-1', notificationPreferences: { crm: true }, pushSubscriptions: [{ endpoint: 'pc' }, { endpoint: 'phone' }] });
  updateMeeting.mockResolvedValue({ modifiedCount: 1 });
  push.mockImplementation(async (_ids, _payload, options) => {
    for (const endpoint of ['pc', 'phone']) if (!options.excludeEndpoints?.includes(endpoint)) options.onDelivered?.(endpoint);
    return { sent: 2, failed: 0, pruned: 0, skippedNoSubscriptions: 0, skippedNoMatchingHint: 0 };
  });
});

afterEach(() => jest.restoreAllMocks());

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
  expect(push.mock.calls.every(([ids, , options]) => ids[0] === 'person' && options.ttlSeconds > 0)).toBe(true);
  expect(genericPush).not.toHaveBeenCalled();
});

it('retrying an accepted event reuses its row and does not re-alert the same devices', async () => {
  await notifyMeetingCreated(meeting);
  await notifyMeetingCreated(meeting);
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:30Z'));
  expect(push).toHaveBeenCalledTimes(2);
  expect(emitToCrmUser).toHaveBeenCalledTimes(2);
});

it('keeps the meeting notification pending when device delivery fails', async () => {
  push.mockResolvedValueOnce({ sent: 0, failed: 1, pruned: 0 });
  await expect(notifyMeetingCreated(meeting)).rejects.toThrow('Device push failed');
  expect(updateMeeting).not.toHaveBeenCalled();
});

it('does not describe an instant room as live before the host starts it', async () => {
  await notifyMeetingCreated({ ...meeting, scheduledAt: null });
  const persisted = upsertNotification.mock.calls[0][1].$setOnInsert;
  expect(persisted.message).toContain('as soon as the host starts it');
  expect(persisted.message).not.toContain('live now');
});

it('respects CRM and meeting-type notification preferences', async () => {
  findCrmUserById.mockResolvedValueOnce({ organizationId: 'org-1', notificationPreferences: { crm: false } });
  await notifyMeetingCreated(meeting);
  findCrmUserById.mockResolvedValueOnce({ organizationId: 'org-1', notificationPreferences: { crm: true, mutedTypes: ['suprah_meet_reminder'] } });
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  expect(upsertNotification).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it('keeps zero-subscription delivery pending instead of treating a bell notification as a successful device alert', async () => {
  push.mockResolvedValueOnce({ sent: 0, failed: 0, pruned: 0, skippedNoSubscriptions: 1, skippedNoMatchingHint: 0 });
  await expect(notifyMeetingCreated(meeting)).rejects.toThrow('No registered device accepted');
  expect(updateMeeting).not.toHaveBeenCalled();
  expect(deviceStates()[0]).toMatchObject({ status: 'pending', noSubscriptions: true });
  await notifyMeetingCreated(meeting);
  expect(push).toHaveBeenCalledTimes(2);
  expect(emitToCrmUser).toHaveBeenCalledTimes(1);
  expect(updateMeeting).toHaveBeenCalledTimes(1);
});
it('retries a failed phone without notifying a PC that already accepted the same event', async () => {
  push.mockImplementationOnce(async (_ids, _payload, options) => {
    options.onDelivered('pc');
    return { sent: 1, failed: 1, pruned: 0, skippedNoSubscriptions: 0, skippedNoMatchingHint: 0 };
  });
  await expect(notifyMeetingCreated(meeting)).rejects.toThrow('Device push failed');
  await notifyMeetingCreated(meeting);
  expect(push.mock.calls[1][2].excludeEndpoints).toEqual(['pc']);
  expect(deviceStates()[1]).toMatchObject({ status: 'sent', accepted: 2 });
  const serialized = JSON.stringify(updateNotification.mock.calls.map(([, update]) => update));
  expect(serialized).not.toContain('"pc"');
  expect(serialized).not.toContain('"phone"');
});
it('expires an old reminder rather than replaying it as a new device alert after the meeting time', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-20T18:01:00Z').getTime());
  await notifyMeetingReminder(meeting, new Date('2026-10-20T17:50:00Z'));
  expect(push).not.toHaveBeenCalled();
  expect(deviceStates()[0].status).toBe('expired');
});

it('does not double-send when another worker already owns the event delivery lease', async () => {
  updateNotification.mockResolvedValueOnce({ modifiedCount: 0 });
  await expect(notifyMeetingCreated(meeting)).rejects.toThrow('already being processed');
  expect(updateNotification.mock.calls[0][0]).toMatchObject({
    'metadata.devicePush.status': { $nin: ['sent', 'expired'] },
    'metadata.devicePush.attemptedAt': { $exists: false },
  });
  expect(push).not.toHaveBeenCalled();
  expect(updateMeeting).not.toHaveBeenCalled();
});
