const findMeeting = jest.fn(), updateMeeting = jest.fn(), sendEmail = jest.fn();
const claimMeeting = jest.fn();
const presign = jest.fn();
jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/config', () => ({ __esModule: true, default: {
  jwt: { crmJwtSecret: 'test-meeting-secret' }, frontendUrl: 'https://suprah.example.test' } }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { findOne: findMeeting, findOneAndUpdate: claimMeeting, updateOne: updateMeeting } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({ presignGet: presign }));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({ mailConfigured: () => true, sendRecordingEmail: sendEmail }));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({}));
jest.mock('../../src/services/suprahMeetPresence.service', () => ({}));
jest.mock('../../src/services/suprahMeetLifecycle.service', () => ({}));
jest.mock('../../src/services/calendarMeetSync.service', () => ({}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
import controller from '../../src/controllers/suprahMeet.controller';

let meeting: any, locked: boolean;
beforeEach(() => {
  jest.clearAllMocks(); locked = false;
  meeting = { _id: 'meeting', organizationId: 'org', hostCrmUserId: 'host', code: 'MEET-1234', title: 'HR planning',
    recording: { status: 'ready', videoKey: 'private-recording' }, ai: { status: 'ready', summary: { overview: 'Decisions' } } };
  findMeeting.mockImplementation(async () => meeting);
  claimMeeting.mockImplementation(async () => { if (locked) return null; locked = true; return meeting; });
  updateMeeting.mockImplementation(async (_filter, update) => {
    if (update.$set?.distribution) { meeting.distribution = update.$set.distribution; locked = false; return { matchedCount: 1 }; }
    if (update.$set?.['distribution.claimToken'] === null) locked = false;
    return { matchedCount: 1 };
  });
  sendEmail.mockResolvedValue(undefined);
  presign.mockResolvedValue('https://storage.example.test/signed-video');
});
const recipient = (email: string) => ({ email, name: email.split('@')[0], kind: 'internal' });
async function distribute(recipients: any[], extra = {}) {
  const res: any = { json: jest.fn() };
  await (controller.distributeRecording as any)({ crmUser: { _id: 'host', organizationId: 'org' },
    params: { code: 'MEET-1234' }, body: { recipients, ...extra } }, res);
  return res.json.mock.calls[0][0].data;
}
it('normalizes and deduplicates email addresses and ignores malformed recipient rows', async () => {
  const result = await distribute([recipient('TAYLOR@example.test'), recipient('taylor@example.test'), null, {}]);
  expect(result.sent).toBe(1); expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][0].link).toMatch(/^https:\/\/suprah.example.test\/meet\/recording\/MEET-1234\?t=/);
});
it('all-failed sends remain retryable and never get an already-sent timestamp', async () => {
  sendEmail.mockRejectedValueOnce(new Error('Mail unavailable'));
  expect((await distribute([recipient('taylor@example.test')])).failed).toBe(1);
  expect(meeting.distribution.sentAt).toBeUndefined();
  expect((await distribute([recipient('taylor@example.test')])).sent).toBe(1);
});
it('partial retries skip successful recipients unless resend is explicit', async () => {
  sendEmail.mockImplementation(async ({ to }) => { if (to === 'casey@example.test') throw new Error('Temporary failure'); });
  const people = [recipient('taylor@example.test'), recipient('casey@example.test')];
  await distribute(people);
  sendEmail.mockReset().mockResolvedValue(undefined);
  expect((await distribute(people)).sent).toBe(1);
  expect(sendEmail.mock.calls.map(([options]) => options.to)).toEqual(['casey@example.test']);
  expect(meeting.distribution.recipients.filter((r: any) => r.status === 'sent')).toHaveLength(2);
});
it('concurrent send requests cannot email the same batch twice', async () => {
  let release!: () => void;
  sendEmail.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const first = distribute([recipient('taylor@example.test')]);
  await new Promise(resolve => setImmediate(resolve));
  await expect(distribute([recipient('taylor@example.test')])).rejects.toThrow('already being sent');
  release(); await first;
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
it('supports a ready summary without a recording and waits for active AI generation', async () => {
  meeting.recording = { status: 'failed' };
  await distribute([recipient('taylor@example.test')]);
  expect(sendEmail.mock.calls[0][0].recordingAvailable).toBe(false);
  meeting.ai.status = 'summarizing';
  await expect(distribute([recipient('casey@example.test')])).rejects.toThrow('still generating');
});

it('email links bind recording access to the exact meeting and organization', async () => {
  await distribute([recipient('taylor@example.test')]);
  const token = new URL(sendEmail.mock.calls[0][0].link).searchParams.get('t');
  findMeeting.mockClear();
  const res: any = { json: jest.fn() };
  await (controller.recordingAccess as any)({ query: { t: token }, params: { code: 'MEET-1234' } }, res);
  expect(findMeeting).toHaveBeenCalledWith({ _id: 'meeting', organizationId: 'org', code: 'MEET-1234' });
  expect(res.json.mock.calls[0][0].data.videoUrl).toBe('https://storage.example.test/signed-video');
});

it('a stale pre-claim snapshot cannot resend a report completed by another request', async () => {
  findMeeting.mockImplementation(async () => ({ ...meeting, distribution: undefined }));
  claimMeeting.mockImplementation(async () => ({ ...meeting, distribution: {
    sentAt: new Date(), recipients: [{ email: 'taylor@example.test', status: 'sent' }],
  } }));
  await expect(distribute([recipient('taylor@example.test')])).rejects.toThrow('already sent');
  expect(sendEmail).not.toHaveBeenCalled();
});

it('one recipient row cannot contain multiple email addresses', async () => {
  await expect(distribute([recipient('one@example.test,two@example.test')])).rejects.toThrow('valid email');
  expect(claimMeeting).not.toHaveBeenCalled();
});
