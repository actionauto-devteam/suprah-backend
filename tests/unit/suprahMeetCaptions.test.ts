const findMeeting = jest.fn();
const startCaptions = jest.fn();
const stopCaptions = jest.fn();
const claimCaptions = jest.fn();
const updateMeeting = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: {
  findOne: findMeeting, findOneAndUpdate: claimCaptions, updateOne: updateMeeting,
} }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({
  startMeetingCaptions: startCaptions, stopMeetingCaptions: stopCaptions,
}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ MEET_REMINDER_WINDOW_MS: 600_000 }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';
import jwt from 'jsonwebtoken';

let meeting: any;
const request = (body: any = { enabled: true }, id = 'host', role = 'employee') => ({
  crmUser: { _id: id, organizationId: 'org-1', role }, params: { code: 'MEET-1234' }, body,
});
const invoke = (req: any, res: any = { json: jest.fn() }) => (controller.setCaptions as any)(req, res, jest.fn());

beforeEach(() => {
  jest.resetAllMocks();
  meeting = {
    _id: 'meet-1', organizationId: 'org-1', code: 'MEET-1234', hostCrmUserId: 'host', status: 'live', chimeMeetingId: 'chime-1',
    participants: [{ crmUserId: 'host' }, { crmUserId: 'participant' }, { isGuest: true, guestId: 'guest-1' }],
    captionLanguage: 'en-US', captionsEnabled: false, save: jest.fn().mockResolvedValue(undefined),
  };
  findMeeting.mockResolvedValue(meeting);
  startCaptions.mockResolvedValue(undefined);
  stopCaptions.mockResolvedValue(undefined);
  claimCaptions.mockResolvedValue(meeting);
  updateMeeting.mockImplementation(async (_filter, update) => { Object.assign(meeting, update.$set); return { modifiedCount: 1 }; });
});

it('starts English captions on the actual meeting audio', async () => {
  const res = { json: jest.fn() };
  await invoke(request({ enabled: true, languageCode: 'en-US' }), res);
  expect(startCaptions).toHaveBeenCalledWith('chime-1', 'en-US');
  expect(meeting.captionsEnabled).toBe(true);
  expect(meeting.captionLanguage).toBe('en-US');
  expect(updateMeeting).toHaveBeenCalledTimes(1);
  expect(res.json.mock.calls[0][0].data).toEqual({ enabled: true, languageCode: 'en-US', pending: false, reused: false });
});

it('defaults a legacy meeting to English US', async () => {
  delete meeting.captionLanguage;
  await invoke(request());
  expect(startCaptions).toHaveBeenCalledWith('chime-1', 'en-US');
});

it('does not allow a viewer to stop captions for everyone', async () => {
  meeting.captionsEnabled = true;
  await expect(invoke(request({ enabled: false }))).rejects.toMatchObject({ statusCode: 400 });
  expect(stopCaptions).not.toHaveBeenCalled();
  expect(meeting.captionsEnabled).toBe(true);
});

it.each(['employee', 'admin', 'manager', 'super_admin'])('allows a joined non-host %s without host approval', async (role) => {
  await invoke(request({ enabled: true }, 'participant', role));
  expect(startCaptions).toHaveBeenCalledWith('chime-1', 'en-US');
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

it('reuses active captions without restarting AWS', async () => {
  meeting.captionsEnabled = true;
  await invoke(request({ enabled: true }, 'participant'));
  expect(meeting.captionsEnabled).toBe(true);
  expect(startCaptions).not.toHaveBeenCalled();
  expect(claimCaptions).not.toHaveBeenCalled();
});

it('rejects an organization member who has not joined the meeting', async () => {
  await expect(invoke(request({ enabled: true }, 'outsider'))).rejects.toMatchObject({ statusCode: 403 });
  expect(startCaptions).not.toHaveBeenCalled();
});

it('rejects a former participant who has already left', async () => {
  meeting.participants[1].leftAt = new Date();
  await expect(invoke(request({ enabled: true }, 'participant'))).rejects.toMatchObject({ statusCode: 403 });
});

it('uses a bounded claim when participants enable CC simultaneously', async () => {
  claimCaptions.mockResolvedValue(null);
  const res = { json: jest.fn() };
  await invoke(request({ enabled: true }, 'participant'), res);
  expect(startCaptions).not.toHaveBeenCalled();
  expect(res.json.mock.calls[0][0].data.pending).toBe(true);
  expect(claimCaptions.mock.calls[0][0]).toMatchObject({
    organizationId: 'org-1', chimeMeetingId: 'chime-1', captionsEnabled: { $ne: true }, status: 'live',
  });
});

it('lets a participant retry an asynchronously failed stream', async () => {
  meeting.captionsEnabled = true;
  await invoke(request({ enabled: true, retry: true }, 'participant'));
  expect(startCaptions).toHaveBeenCalledTimes(1);
  expect(claimCaptions.mock.calls[0][0].captionsEnabled).toBeUndefined();
});

const guestRequest = (overrides: Record<string, unknown> = {}) => ({
  params: { code: 'MEET-1234' }, body: { enabled: true }, headers: {
    authorization: `Bearer ${jwt.sign({ guest: true, guestId: 'guest-1', code: 'MEET-1234', organizationId: 'org-1', ...overrides },
      process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'suprah-meet-guest-dev-secret', { expiresIn: '1h' })}`,
  },
});
const invokeGuest = (req: any) => (controller.guestCaptions as any)(req, { json: jest.fn() }, jest.fn());

it('allows an admitted, joined guest to enable captions with their meeting pass', async () => {
  await invokeGuest(guestRequest());
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
  expect(startCaptions).toHaveBeenCalledTimes(1);
});

it('rejects a guest pass from another meeting before querying records', async () => {
  await expect(invokeGuest(guestRequest({ code: 'MEET-9999' }))).rejects.toMatchObject({ statusCode: 401 });
  expect(findMeeting).not.toHaveBeenCalled();
  expect(startCaptions).not.toHaveBeenCalled();
});

it('rejects a waiting-room guest who has not actually joined', async () => {
  meeting.participants = [{ crmUserId: 'host' }];
  await expect(invokeGuest(guestRequest())).rejects.toMatchObject({ statusCode: 403 });
  expect(startCaptions).not.toHaveBeenCalled();
});

it('rejects an expired or invalid guest pass', async () => {
  const req = guestRequest();
  req.headers.authorization = 'Bearer invalid';
  await expect(invokeGuest(req)).rejects.toMatchObject({ statusCode: 401 });
  expect(startCaptions).not.toHaveBeenCalled();
});

it('a guest pass cannot select the same meeting code in a different organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invokeGuest(guestRequest({ organizationId: 'other-org' }))).rejects.toMatchObject({ statusCode: 404 });
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'other-org', code: 'MEET-1234' });
  expect(startCaptions).not.toHaveBeenCalled();
});

it('scopes meeting lookup to the authenticated organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invoke(request())).rejects.toMatchObject({ statusCode: 404 });
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
  expect(startCaptions).not.toHaveBeenCalled();
});
