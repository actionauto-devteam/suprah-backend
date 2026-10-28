const findMeetings = jest.fn();
const claimMeeting = jest.fn();
const updateMeeting = jest.fn();
const notifyCreated = jest.fn();
const notifyReminder = jest.fn();
const notifyLive = jest.fn();
const logError = jest.fn();

jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true, default: { find: findMeetings, findOneAndUpdate: claimMeeting, updateOne: updateMeeting },
}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({
  MEET_REMINDER_WINDOW_MS: 10 * 60_000,
  notifyMeetingCreated: notifyCreated, notifyMeetingLive: notifyLive, notifyMeetingReminder: notifyReminder,
}));
jest.mock('../../src/services/suprahMeetAws.service', () => ({}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: logError } }));

import { openDueMeetings, reconcileSuprahMeetPresence, sendSuprahMeetNotifications } from '../../src/services/suprahMeetReminder.service';

const now = new Date('2026-10-20T17:50:00Z');
const meeting = { _id: 'meet-1', organizationId: 'org-1', scheduledAt: new Date('2026-10-20T18:00:00Z') };
const query = (rows: unknown[]) => ({ sort: () => ({ limit: async () => rows }) });

beforeEach(() => {
  jest.resetAllMocks();
  findMeetings.mockReturnValueOnce(query([])).mockReturnValueOnce(query([meeting]));
  claimMeeting.mockResolvedValue(meeting);
  updateMeeting.mockResolvedValue({ modifiedCount: 1 });
  notifyCreated.mockResolvedValue(undefined);
  notifyReminder.mockResolvedValue(undefined);
  notifyLive.mockResolvedValue(undefined);
});

it('never turns a due scheduled meeting live without the host', async () => {
  await openDueMeetings(now);
  expect(findMeetings).not.toHaveBeenCalled();
  expect(claimMeeting).not.toHaveBeenCalled();
});

it('queries only unsent, non-ended sessions within the next ten minutes', async () => {
  await sendSuprahMeetNotifications(now);
  expect(findMeetings.mock.calls[1][0]).toMatchObject({
    status: { $in: ['scheduled', 'live'] }, reminderSentAt: null,
    scheduledAt: { $gte: now, $lte: new Date('2026-10-20T18:00:00Z') },
  });
  expect(notifyReminder).toHaveBeenCalledWith(meeting, now);
});

it('claims atomically and marks sent only after successful delivery', async () => {
  await sendSuprahMeetNotifications(now);
  const [filter, update] = claimMeeting.mock.calls[0];
  expect(filter).toMatchObject({ _id: 'meet-1', scheduledAt: meeting.scheduledAt, reminderSentAt: null });
  expect(update.$set.reminderClaimToken).toEqual(expect.any(String));
  expect(updateMeeting).toHaveBeenCalledWith({
    _id: 'meet-1', organizationId: 'org-1', scheduledAt: meeting.scheduledAt,
    reminderClaimToken: update.$set.reminderClaimToken,
  }, { $set: {
    reminderSentAt: expect.any(Date), reminderClaimToken: null, reminderClaimUntil: null,
  } });
  expect(updateMeeting.mock.invocationCallOrder[0]).toBeGreaterThan(notifyReminder.mock.invocationCallOrder[0]);
});

it('does not send a meeting already claimed, changed or ended by another worker', async () => {
  claimMeeting.mockResolvedValue(null);
  await sendSuprahMeetNotifications(now);
  expect(notifyReminder).not.toHaveBeenCalled();
  expect(updateMeeting).not.toHaveBeenCalled();
});

it('releases failed claims without marking sent, permitting a later retry', async () => {
  notifyReminder.mockRejectedValue(new Error('database unavailable'));
  await sendSuprahMeetNotifications(now);
  expect(updateMeeting.mock.calls[0][1]).toEqual({ $set: { reminderClaimToken: null, reminderClaimUntil: null } });
  expect(logError).toHaveBeenCalled();
});

it('retries opted-in invitations without backfilling historical meetings', async () => {
  findMeetings.mockReset().mockReturnValueOnce(query([meeting])).mockReturnValueOnce(query([]));
  await sendSuprahMeetNotifications(now);
  expect(findMeetings.mock.calls[0][0]).toEqual({
    invitationNotificationPending: true, status: { $in: ['scheduled', 'live'] },
  });
  expect(notifyCreated).toHaveBeenCalledWith(meeting);
});

it('an invitation failure does not prevent due reminders from being processed', async () => {
  findMeetings.mockReset().mockReturnValueOnce(query([meeting])).mockReturnValueOnce(query([meeting]));
  notifyCreated.mockRejectedValue(new Error('partial delivery'));
  await sendSuprahMeetNotifications(now);
  expect(notifyReminder).toHaveBeenCalledTimes(1);
});

it('retries a live device notification while sweeping active presence', async () => {
  const liveMeeting = {
    ...meeting, status: 'live', participants: [], timerElapsedMs: 0,
    liveNotificationPending: true, isModified: () => false, save: jest.fn(),
  };
  findMeetings.mockReset().mockReturnValue({ limit: async () => [liveMeeting] });
  await reconcileSuprahMeetPresence(now);
  expect(notifyLive).toHaveBeenCalledWith(liveMeeting);
});
