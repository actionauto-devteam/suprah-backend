const findMeetings = jest.fn();
const claimMeeting = jest.fn();
const findById = jest.fn();
const updateMeeting = jest.fn();
const notifyCreated = jest.fn();
const notifyReminder = jest.fn();
const notifyLive = jest.fn();
const logError = jest.fn();

jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true, default: { find: findMeetings, findOneAndUpdate: claimMeeting, findById, updateOne: updateMeeting },
}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({
  MEET_REMINDER_WINDOW_MS: 10 * 60_000,
  notifyMeetingCreated: notifyCreated, notifyMeetingLive: notifyLive, notifyMeetingReminder: notifyReminder,
}));
const deleteChime = jest.fn();
const stopRecording = jest.fn();
jest.mock('../../src/services/suprahMeetAws.service', () => ({ deleteChimeMeeting: deleteChime, stopRecordingPipelines: stopRecording }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: logError } }));

import { openScheduledMeeting, reconcilePersistedPresence } from '../../src/services/suprahMeetLifecycle.service';
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
  deleteChime.mockResolvedValue(undefined);
  stopRecording.mockResolvedValue(undefined);
});

it('queries due dated meetings without requiring a host or opening future/instant rooms', async () => {
  await openDueMeetings(now);
  expect(findMeetings).toHaveBeenCalledWith({ status: 'scheduled', scheduledAt: { $lte: now, $ne: null } });
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
  findMeetings.mockReset().mockReturnValue(query([liveMeeting]));
  await reconcileSuprahMeetPresence(now);
  expect(notifyLive).toHaveBeenCalledWith(liveMeeting);
});

const abandoned = () => ({
  _id: 'abandoned', organizationId: 'org-1', status: 'live', hostCrmUserId: 'host',
  createdAt: new Date(now.getTime() - 60 * 60_000), updatedAt: new Date(now.getTime() - 30 * 60_000),
  participants: [], timerElapsedMs: 0, chimeMeetingId: 'chime-old',
  recording: { status: 'recording', capturePipelineId: 'capture-old' },
});

it('ends abandoned rooms atomically and closes media resources while preserving history', async () => {
  const old = abandoned();
  findMeetings.mockReset().mockReturnValue(query([old]));
  claimMeeting.mockResolvedValue({ ...old, status: 'ended' });
  stopRecording.mockResolvedValue(undefined);
  deleteChime.mockResolvedValue(undefined);
  await reconcileSuprahMeetPresence(now);
  expect(claimMeeting).toHaveBeenCalledWith(expect.objectContaining({
    _id: old._id, organizationId: old.organizationId, status: 'live', updatedAt: old.updatedAt,
  }), { $set: expect.objectContaining({ status: 'ended', endedAt: now, liveNotificationPending: false }) }, { new: true });
  expect(stopRecording).toHaveBeenCalledWith('capture-old');
  expect(deleteChime).toHaveBeenCalledWith('chime-old');
  expect(updateMeeting).toHaveBeenCalledWith({ _id: old._id, status: 'ended' }, { $set: {
    'recording.status': 'processing', 'recording.stoppedAt': now,
  } });
  expect(notifyLive).not.toHaveBeenCalled();
});

it('does not terminate media when a heartbeat or rejoin changes the room during the sweep', async () => {
  findMeetings.mockReset().mockReturnValue(query([abandoned()]));
  claimMeeting.mockResolvedValue(null);
  findById.mockResolvedValue({ ...abandoned(), updatedAt: now });
  await reconcileSuprahMeetPresence(now);
  expect(stopRecording).not.toHaveBeenCalled();
  expect(deleteChime).not.toHaveBeenCalled();
});

it('opens at the scheduled boundary without opening even one millisecond early', async () => {
  const scheduled = { ...abandoned(), status: 'scheduled', scheduledAt: now, recording: { status: 'idle' } };
  expect(await openScheduledMeeting(scheduled as any, new Date(now.getTime() - 1))).toBe(scheduled);
  expect(claimMeeting).not.toHaveBeenCalled();
  claimMeeting.mockResolvedValue({ ...scheduled, status: 'live', openedAt: now });
  const opened = await openScheduledMeeting(scheduled as any, now);
  expect(opened.status).toBe('live');
  expect(opened.openedAt).toEqual(now);
  expect(notifyLive).toHaveBeenCalledTimes(1);
});
it('closes an old missed scheduled session as a no-show without announcing it as live now', async () => {
  const scheduled = { ...abandoned(), status: 'scheduled', scheduledAt: new Date(now.getTime() - 3_600_000), recording: { status: 'idle' } };
  findMeetings.mockReset().mockReturnValue(query([scheduled]));
  claimMeeting.mockImplementation(async (_filter, update) => ({ ...scheduled, ...update.$set }));
  await openDueMeetings(now);
  expect(claimMeeting.mock.calls[1][1].$set).toMatchObject({ status: 'ended', endedReason: 'no-show' });
  expect(notifyLive).not.toHaveBeenCalled();
});
it('does not revive a room concurrently ended or rescheduled by its host', async () => {
  const scheduled = { ...abandoned(), status: 'scheduled', scheduledAt: now };
  claimMeeting.mockResolvedValue(null);
  findById.mockResolvedValue({ ...scheduled, status: 'ended', endedReason: 'host-ended' });
  expect((await openScheduledMeeting(scheduled as any, now)).status).toBe('ended');
  expect(notifyLive).not.toHaveBeenCalled();
});

it('reconciles rooms beyond the first hundred even when the first batch stays unchanged', async () => {
  const active = Array.from({ length: 100 }, (_, i) => ({
    ...meeting, _id: `room-${String(i).padStart(3, '0')}`, status: 'live', scheduledAt: now,
    createdAt: now, participants: [], isModified: () => false,
  }));
  const old = abandoned();
  findMeetings.mockReset().mockReturnValueOnce(query(active)).mockReturnValueOnce(query([old]));
  claimMeeting.mockResolvedValue({ ...old, status: 'ended', recording: { status: 'idle' } });
  await reconcileSuprahMeetPresence(now);
  expect(findMeetings).toHaveBeenCalledTimes(2);
  expect(findMeetings.mock.calls[1][0]._id).toEqual({ $gt: 'room-099' });
  expect(claimMeeting).toHaveBeenCalledWith(expect.objectContaining({ _id: old._id }), expect.anything(), { new: true });
});
it('one failed scheduled room does not prevent the following room from opening', async () => {
  const first = { ...meeting, _id: 'first', status: 'scheduled', scheduledAt: now, participants: [] };
  const second = { ...first, _id: 'second' };
  findMeetings.mockReset().mockReturnValue(query([first, second]));
  claimMeeting.mockRejectedValueOnce(new Error('one bad room')).mockResolvedValueOnce({ ...second, status: 'live' });
  await openDueMeetings(now);
  expect(claimMeeting).toHaveBeenCalledTimes(2);
  expect(notifyLive).toHaveBeenCalledWith(expect.objectContaining({ _id: 'second' }));
});

it('a stale presence sweep cannot overwrite a newer foreground heartbeat', async () => {
  const old = { ...abandoned(), scheduledAt: now, isModified: () => true };
  const fresh = { ...old, updatedAt: now, participants: [{ crmUserId: 'person', sessions: [{ attendeeId: 'active', lastSeenAt: now }] }] };
  claimMeeting.mockResolvedValue(null);
  findById.mockResolvedValue(fresh);
  const result = await reconcilePersistedPresence(old as any, now);
  expect(claimMeeting).toHaveBeenCalledWith(expect.objectContaining({ _id: old._id, status: 'live', updatedAt: old.updatedAt }), expect.anything(), { new: true });
  expect(result).toBe(fresh);
  expect(result.participants[0].sessions?.[0].attendeeId).toBe('active');
});
