const findMeeting = jest.fn();
const startCaptions = jest.fn();
const stopCaptions = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { findOne: findMeeting } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({
  startMeetingCaptions: startCaptions, stopMeetingCaptions: stopCaptions,
}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ MEET_REMINDER_WINDOW_MS: 600_000 }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';

let meeting: any;
const request = (body: any = { enabled: true }, id = 'host', role = 'employee') => ({
  crmUser: { _id: id, organizationId: 'org-1', role }, params: { code: 'MEET-1234' }, body,
});
const invoke = (req: any, res: any = { json: jest.fn() }) => (controller.setCaptions as any)(req, res, jest.fn());

beforeEach(() => {
  jest.resetAllMocks();
  meeting = {
    _id: 'meet-1', hostCrmUserId: 'host', status: 'live', chimeMeetingId: 'chime-1',
    captionLanguage: 'en-US', captionsEnabled: false, save: jest.fn().mockResolvedValue(undefined),
  };
  findMeeting.mockResolvedValue(meeting);
  startCaptions.mockResolvedValue(undefined);
  stopCaptions.mockResolvedValue(undefined);
});

it('starts English captions on the actual meeting audio', async () => {
  const res = { json: jest.fn() };
  await invoke(request({ enabled: true, languageCode: 'en-US' }), res);
  expect(startCaptions).toHaveBeenCalledWith('chime-1', 'en-US');
  expect(meeting.captionsEnabled).toBe(true);
  expect(meeting.captionLanguage).toBe('en-US');
  expect(meeting.save).toHaveBeenCalledTimes(1);
  expect(res.json.mock.calls[0][0].data).toEqual({ enabled: true, languageCode: 'en-US' });
});

it('defaults a legacy meeting to English US', async () => {
  delete meeting.captionLanguage;
  await invoke(request());
  expect(startCaptions).toHaveBeenCalledWith('chime-1', 'en-US');
});

it('only the host can stop shared transcription', async () => {
  meeting.captionsEnabled = true;
  await invoke(request({ enabled: false }));
  expect(stopCaptions).toHaveBeenCalledWith('chime-1');
  expect(meeting.captionsEnabled).toBe(false);
});

it.each(['employee', 'admin', 'manager', 'super_admin'])('rejects a non-host %s before calling AWS', async (role) => {
  await expect(invoke(request({ enabled: true }, 'participant', role))).rejects.toMatchObject({ statusCode: 403 });
  expect(startCaptions).not.toHaveBeenCalled();
  expect(meeting.save).not.toHaveBeenCalled();
});

it.each(['scheduled', 'ended'])('rejects captions for a %s meeting', async (status) => {
  meeting.status = status;
  await expect(invoke(request())).rejects.toMatchObject({ statusCode: 409 });
  expect(startCaptions).not.toHaveBeenCalled();
});

it('requires an existing Chime session', async () => {
  delete meeting.chimeMeetingId;
  await expect(invoke(request())).rejects.toMatchObject({ statusCode: 409 });
});

it.each([{ enabled: 'true' }, { enabled: true, languageCode: 'fil-PH' }, { enabled: true, languageCode: 'es-US' }, { enabled: true, languageCode: {} }])(
  'validates caption settings before creating a transcription stream', async (body) => {
    await expect(invoke(request(body))).rejects.toMatchObject({ statusCode: 400 });
    expect(startCaptions).not.toHaveBeenCalled();
  },
);

it('keeps the existing state on AWS failure and returns a useful setup error', async () => {
  startCaptions.mockRejectedValue({ name: 'AccessDeniedException' });
  await expect(invoke(request())).rejects.toMatchObject({
    statusCode: 502, message: 'Live captions are not configured on the server yet. Contact your administrator.',
  });
  expect(meeting.captionsEnabled).toBe(false);
  expect(meeting.save).not.toHaveBeenCalled();
});

it('does not disable captions locally if AWS cannot stop the stream', async () => {
  meeting.captionsEnabled = true;
  stopCaptions.mockRejectedValue(new Error('provider down'));
  await expect(invoke(request({ enabled: false }))).rejects.toMatchObject({ statusCode: 502 });
  expect(meeting.captionsEnabled).toBe(true);
  expect(meeting.save).not.toHaveBeenCalled();
});

it('scopes meeting lookup to the authenticated organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invoke(request())).rejects.toMatchObject({ statusCode: 404 });
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
  expect(startCaptions).not.toHaveBeenCalled();
});
