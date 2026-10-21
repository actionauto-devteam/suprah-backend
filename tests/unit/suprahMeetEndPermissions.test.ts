const findMeeting = jest.fn();
const deleteChimeMeeting = jest.fn();
const stopRecordingPipelines = jest.fn();
const getChimeMeeting = jest.fn();
const createChimeAttendee = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { findOne: findMeeting } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({
  deleteChimeMeeting, stopRecordingPipelines, getChimeMeeting, createChimeAttendee,
}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ MEET_REMINDER_WINDOW_MS: 600_000 }));
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
  deleteChimeMeeting.mockResolvedValue(undefined);
  stopRecordingPipelines.mockResolvedValue(undefined);
  getChimeMeeting.mockResolvedValue({ MeetingId: 'chime-1' });
  createChimeAttendee.mockResolvedValue({ AttendeeId: 'attendee-1' });
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

it('does not grant access to a meeting outside the caller organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invoke(controller.endMeeting, request('host'), response()))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
  expect(deleteChimeMeeting).not.toHaveBeenCalled();
});
