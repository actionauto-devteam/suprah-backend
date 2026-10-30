const findMeeting = jest.fn();
const transitionMeeting = jest.fn();
const deleteScheduled = jest.fn();
const deleteSeries = jest.fn();
const updateScheduled = jest.fn();
const updateSeries = jest.fn();
const findById = jest.fn();
const deleteChimeMeeting = jest.fn();
const stopRecordingPipelines = jest.fn();
const getChimeMeeting = jest.fn();
const createChimeMeeting = jest.fn();
const createChimeAttendee = jest.fn();
const deleteChimeAttendee = jest.fn();
const setChimeAttendeeMuted = jest.fn();
const notifyMeetingLive = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { findOne: findMeeting, findOneAndUpdate: transitionMeeting, deleteOne: deleteScheduled, deleteMany: deleteSeries, updateOne: updateScheduled, updateMany: updateSeries, findById } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({
  deleteChimeMeeting, stopRecordingPipelines, getChimeMeeting, createChimeMeeting, createChimeAttendee,
  deleteChimeAttendee, setChimeAttendeeMuted,
}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ MEET_REMINDER_WINDOW_MS: 600_000, notifyMeetingLive }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';

const response = () => {
  const res: any = { json: jest.fn() };
  return res;
};
const request = (id: string, role = 'employee') => ({
  crmUser: { _id: id, organizationId: 'org-1', role, fullName: 'Taylor Reed' },
  params: { code: 'MEET-1234' },
});
const invoke = (handler: any, req: any, res: any) => handler(req, res, jest.fn());
let meeting: any;

beforeEach(() => {
  jest.resetAllMocks();
  meeting = {
    _id: 'meeting-1', organizationId: 'org-1', hostCrmUserId: 'host',
    code: 'MEET-1234', title: 'Planning', visibility: 'public', status: 'live',
    chimeMeetingId: 'chime-1', invitees: [], recording: { status: 'idle' },
    participants: [
      { crmUserId: 'host', fullName: 'Host' },
      { crmUserId: 'participant', fullName: 'Participant' },
    ],
    save: jest.fn().mockResolvedValue(undefined),
  };
  findMeeting.mockResolvedValue(meeting);
  transitionMeeting.mockImplementation(async (_filter, update) => Object.assign(meeting, update.$set));
  deleteChimeMeeting.mockResolvedValue(undefined);
  stopRecordingPipelines.mockResolvedValue(undefined);
  getChimeMeeting.mockResolvedValue({ MeetingId: 'chime-1' });
  createChimeAttendee.mockResolvedValue({ AttendeeId: 'attendee-1' });
  deleteChimeAttendee.mockResolvedValue(undefined);
  setChimeAttendeeMuted.mockResolvedValue(undefined);
  notifyMeetingLive.mockResolvedValue(undefined);
});

it.each(['employee', 'admin', 'manager', 'super_admin'])(
  'rejects a non-host %s even when the host has left', async (role) => {
    meeting.participants[0].leftAt = new Date();
    await expect(invoke(controller.endMeeting, request('participant', role), response()))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only the meeting host can end the meeting for everyone.' });
    expect(meeting.status).toBe('live');
    expect(meeting.save).not.toHaveBeenCalled();
    expect(stopRecordingPipelines).not.toHaveBeenCalled();
    expect(deleteChimeMeeting).not.toHaveBeenCalled();
  },
);

it('rejects a non-host when the host is still in the room', async () => {
  await expect(invoke(controller.endMeeting, request('participant', 'admin'), response()))
    .rejects.toMatchObject({ statusCode: 403 });
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
});

it('allows the creator to end for everyone and closes the recording and participants', async () => {
  meeting.recording = { status: 'recording', capturePipelineId: 'capture-1' };
  const res = response();
  await invoke(controller.endMeeting, request('host'), res);
  expect(stopRecordingPipelines).toHaveBeenCalledWith('capture-1');
  expect(deleteChimeMeeting).toHaveBeenCalledWith('chime-1');
  expect(meeting.recording.status).toBe('processing');
  expect(meeting.status).toBe('ended');
  expect(meeting.endedAt).toBeInstanceOf(Date);
  expect(meeting.participants.every((person: any) => person.leftAt instanceof Date)).toBe(true);
  expect(meeting.save).toHaveBeenCalledTimes(1);
});

it('lets the host end the meeting even if their previous participant entry has left', async () => {
  meeting.participants[0].leftAt = new Date();
  await invoke(controller.endMeeting, request('host'), response());
  expect(meeting.status).toBe('ended');
});

it('a repeated host end succeeds without repeating AWS side effects', async () => {
  meeting.status = 'ended';
  await invoke(controller.endMeeting, request('host'), response());
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
  expect(meeting.save).not.toHaveBeenCalled();
});

it('a participant ending their own call leaves everyone else connected', async () => {
  await invoke(controller.leaveMeeting, request('participant', 'admin'), response());
  expect(meeting.participants[1].leftAt).toBeInstanceOf(Date);
  expect(meeting.participants[0].leftAt).toBeUndefined();
  expect(meeting.status).toBe('live');
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
  expect(stopRecordingPipelines).not.toHaveBeenCalled();
});

it.each([
  ['host', 'employee', true, true],
  ['participant', 'employee', false, false],
  ['participant', 'admin', true, false],
  ['participant', 'manager', true, false],
])('returns separate control/end permissions when %s (%s) joins', async (id, role, canControl, canEndForAll) => {
  const res = response();
  await invoke(controller.joinMeeting, request(id as string, role as string), res);
  expect(res.json.mock.calls[0][0].data.self).toMatchObject({ canControl, canEndForAll });
});

it('does not let an attendee open a meeting before its scheduled time', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() + 60_000);
  await expect(invoke(controller.joinMeeting, request('participant'), response()))
    .rejects.toMatchObject({ statusCode: 409, message: 'This meeting has not started yet. Wait for its scheduled time or for the host to start it early.' });
  expect(meeting.status).toBe('scheduled');
  expect(createChimeAttendee).not.toHaveBeenCalled();
});

it('opens a scheduled room for its host, but starts its clock only when another person joins', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() - 60_000);
  meeting.participants = [];
  await invoke(controller.joinMeeting, request('host'), response());
  expect(meeting.status).toBe('live');
  expect(meeting.startedAt).toBeUndefined();
  expect(notifyMeetingLive).toHaveBeenCalledWith(meeting);

  await invoke(controller.joinMeeting, request('participant'), response());
  expect(meeting.startedAt).toBeInstanceOf(Date);
  expect((meeting as any).timerActiveSince).toBeInstanceOf(Date);
});

it('keeps attendee audio moderation host-only and uses Chime enforcement', async () => {
  await expect(invoke(controller.setParticipantAudio, {
    ...request('participant', 'admin'), params: { code: 'MEET-1234', participantId: 'host' },
    body: { attendeeId: 'attendee-host', muted: true },
  }, response())).rejects.toMatchObject({ statusCode: 403 });

  await invoke(controller.setParticipantAudio, {
    ...request('host'), params: { code: 'MEET-1234', participantId: 'participant' },
    body: { attendeeId: 'attendee-participant', muted: true },
  }, response());
  expect(setChimeAttendeeMuted).toHaveBeenCalledWith('chime-1', 'attendee-participant', true);
});

it('pauses the elapsed clock when the host leaves without ending the room', async () => {
  meeting.timerElapsedMs = 30_000;
  meeting.timerActiveSince = new Date(Date.now() - 2_000);
  await invoke(controller.leaveMeeting, request('host'), response());
  expect(meeting.status).toBe('live');
  expect(meeting.timerActiveSince).toBeUndefined();
  expect(meeting.timerElapsedMs).toBeGreaterThanOrEqual(30_000);
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
});

it('does not admit a new attendee while the host has stepped away', async () => {
  meeting.participants[0].leftAt = new Date();
  await expect(invoke(controller.joinMeeting, request('participant'), response()))
    .rejects.toMatchObject({ statusCode: 409, message: 'The host has stepped away. You can join when they return.' });
  expect(createChimeAttendee).not.toHaveBeenCalled();
});

it('does not grant access to a meeting outside the caller organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invoke(controller.endMeeting, request('host'), response()))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
});

it.each(['employee', 'admin', 'manager', 'super_admin'])(
  'rejects non-host %s schedule edits and deletions', async (role) => {
    meeting.status = 'scheduled';
    await expect(invoke(controller.updateMeeting, request('participant', role), response()))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(invoke(controller.deleteMeeting, request('participant', role), response()))
      .rejects.toMatchObject({ statusCode: 403 });
  },
);

it('allows an ordinary host to edit their upcoming meeting with a scheduled-state guard', async () => {
  meeting.status = 'scheduled';
  updateScheduled.mockResolvedValue({ modifiedCount: 1 });
  findById.mockReturnValue({ lean: async () => ({ ...meeting, title: 'Updated' }) });
  const res = response();
  await invoke(controller.updateMeeting, { ...request('host'), body: { title: 'Updated' }, query: {} }, res);
  expect(updateScheduled).toHaveBeenCalledWith({ _id: 'meeting-1', hostCrmUserId: 'host', status: 'scheduled' },
    { $set: { title: 'Updated' } });
  expect(res.json.mock.calls[0][0].data.title).toBe('Updated');
});
it('limits host series deletion to their own scheduled sessions and organization', async () => {
  meeting.status = 'scheduled';
  meeting.seriesId = 'series-1';
  deleteSeries.mockResolvedValue({ deletedCount: 3 });
  await invoke(controller.deleteMeeting, { ...request('host'), query: { series: '1' } }, response());
  expect(deleteSeries).toHaveBeenCalledWith({ organizationId: 'org-1', seriesId: 'series-1',
    hostCrmUserId: 'host', status: 'scheduled' });
});
it('limits series editing to the host scheduled sessions without changing other session dates', async () => {
  meeting.status = 'scheduled';
  meeting.seriesId = 'series-1';
  updateSeries.mockResolvedValue({ modifiedCount: 3 });
  findById.mockReturnValue({ lean: async () => meeting });
  await invoke(controller.updateMeeting, { ...request('host'), query: { series: '1' }, body: { title: 'Series' } }, response());
  expect(updateSeries).toHaveBeenCalledWith({ organizationId: 'org-1', seriesId: 'series-1',
    hostCrmUserId: 'host', status: 'scheduled' }, { $set: { title: 'Series' } });
  expect(updateScheduled).not.toHaveBeenCalled();
});

it('does not report a successful edit if the host starts the meeting concurrently', async () => {
  meeting.status = 'scheduled';
  updateScheduled.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
  await expect(invoke(controller.updateMeeting, { ...request('host'), body: { title: 'Too late' }, query: {} }, response()))
    .rejects.toMatchObject({ statusCode: 409 });
});
it('does not report a successful deletion if the host starts the meeting concurrently', async () => {
  meeting.status = 'scheduled';
  deleteScheduled.mockResolvedValue({ deletedCount: 0 });
  await expect(invoke(controller.deleteMeeting, { ...request('host'), query: {} }, response()))
    .rejects.toMatchObject({ statusCode: 409 });
});

it('opens a due scheduled room and admits an invited attendee while its host is absent', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() - 1_000);
  meeting.participants = [];
  const res = response();
  await invoke(controller.joinMeeting, request('participant'), res);
  expect(transitionMeeting).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled', scheduledAt: meeting.scheduledAt }),
    { $set: { status: 'live', openedAt: meeting.scheduledAt, liveNotificationPending: true } }, { new: true });
  expect(res.json.mock.calls[0][0].data.meeting.status).toBe('live');
  expect(res.json.mock.calls[0][0].data.self.canEndForAll).toBe(false);
  expect(createChimeAttendee).toHaveBeenCalledTimes(1);
});
it('automatically clears the scheduled waiting gate at the scheduled time without a host', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() - 1_000);
  meeting.participants = [];
  const res = response();
  await invoke(controller.requestJoin, request('participant'), res);
  expect(res.json.mock.calls[0][0].data).toMatchObject({ admitted: true });
});
it('admits a public guest to a due scheduled room without its host', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() - 1_000);
  meeting.participants = [];
  const pass = response();
  await invoke(controller.guestRequest, { params: { code: meeting.code }, headers: {}, body: { name: 'Guest visitor' } }, pass);
  expect(pass.json.mock.calls[0][0].data.live).toBe(true);
  const token = pass.json.mock.calls[0][0].data.guestToken;
  const joined = response();
  await invoke(controller.guestJoin, { params: { code: meeting.code }, headers: { authorization: `Bearer ${token}` } }, joined);
  expect(joined.json.mock.calls[0][0].data.self.isGuest).toBe(true);
});
it('keeps private admission enforced after the scheduled room opens', async () => {
  meeting.status = 'scheduled';
  meeting.scheduledAt = new Date(Date.now() - 1_000);
  meeting.visibility = 'private';
  meeting.participants = [];
  meeting.waiting = [];
  await expect(invoke(controller.joinMeeting, request('unknown'), response())).rejects.toMatchObject({ statusCode: 403 });
  expect(createChimeAttendee).not.toHaveBeenCalled();
});

it('uses the same room creation token for simultaneous first scheduled attendees', async () => {
  meeting.status = 'live';
  meeting.scheduledAt = new Date(Date.now() - 1_000);
  meeting.chimeMeetingId = undefined;
  findMeeting.mockImplementation(async () => ({ ...meeting, participants: [], save: jest.fn() }));
  getChimeMeeting.mockResolvedValue(null);
  createChimeMeeting.mockResolvedValue({ MeetingId: 'shared-chime', MediaRegion: 'us-east-1' });
  await Promise.all([
    invoke(controller.joinMeeting, request('a'), response()),
    invoke(controller.joinMeeting, request('b'), response()),
  ]);
  expect(createChimeMeeting).toHaveBeenCalledTimes(2);
  expect(createChimeMeeting.mock.calls[0][1]).toBe(createChimeMeeting.mock.calls[1][1]);
  expect(createChimeMeeting.mock.calls[0][1]).toMatch(/^[a-f0-9]{64}$/);
});
