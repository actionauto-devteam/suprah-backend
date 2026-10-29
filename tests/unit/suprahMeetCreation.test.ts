const createMeeting = jest.fn();
const findUsers = jest.fn();
const findMeeting = jest.fn();
const updateMeeting = jest.fn();
const notifyCreated = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true, default: { create: createMeeting, findOne: findMeeting, updateOne: updateMeeting, findById: jest.fn() },
}));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { find: findUsers } }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({
  MEET_REMINDER_WINDOW_MS: 600_000, notifyMeetingCreated: notifyCreated,
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';
import Meeting from '../../src/models/Meeting.model';

const host = { _id: 'host', organizationId: 'org-1', role: 'employee' };
const response = () => { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; };
const invoke = (handler: any, req: any, res: any) => handler(req, res, jest.fn());

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-20T15:00:00Z').getTime());
  createMeeting.mockImplementation(async (data) => ({ ...data, _id: `session-${createMeeting.mock.calls.length}` }));
  notifyCreated.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('keeps an instant room reserved until its host joins and queues its invitation', async () => {
  const res = response();
  await invoke(controller.createMeeting, { crmUser: host, body: { title: 'Quick call' } }, res);
  expect(createMeeting.mock.calls[0][0]).toMatchObject({ status: 'scheduled', invitationNotificationPending: true });
  expect(notifyCreated).toHaveBeenCalledWith(expect.objectContaining({ title: 'Quick call', _id: 'session-1' }));
  expect(res.status).toHaveBeenCalledWith(201);
});

it('notifies for every recurring session, keeping Mountain wall time conversion', async () => {
  const res = response();
  await invoke(controller.createMeeting, { crmUser: host, body: {
    title: 'Planning', inviteAll: true, occurrences: ['2026-10-21T12:00', '2026-10-22T12:00'],
  } }, res);
  await Promise.resolve();
  expect(notifyCreated).toHaveBeenCalledTimes(2);
  expect(createMeeting.mock.calls[0][0]).toMatchObject({
    invitationNotificationPending: true, scheduledAt: new Date('2026-10-21T18:00:00Z'),
  });
  expect(createMeeting.mock.calls[1][0].seriesId).toBe(createMeeting.mock.calls[0][0].seriesId);
  expect(res.json.mock.calls[0][0].data.seriesCount).toBe(2);
});

it('expands selected departments and deduplicates people already invited directly', async () => {
  const person = '507f1f77bcf86cd799439011';
  const colleague = '507f1f77bcf86cd799439012';
  findUsers
    .mockReturnValueOnce({ select: () => ({ lean: async () => [{ _id: person }] }) })
    .mockReturnValueOnce({ select: () => ({ lean: async () => [{ _id: person }, { _id: colleague }] }) });
  const res = response();
  await invoke(controller.createMeeting, { crmUser: host, body: {
    title: 'Department sync', invitees: [person], inviteDepartments: ['sales'],
    scheduledAt: '2026-10-21T12:00',
  } }, res);
  expect(findUsers.mock.calls[0][0]).toMatchObject({ organizationId: 'org-1' });
  expect(findUsers.mock.calls[1][0]).toEqual({
    organizationId: 'org-1', isActive: true, isSystem: { $ne: true }, department: { $in: ['sales'] },
  });
  expect(notifyCreated).toHaveBeenCalledWith(expect.objectContaining({
    invitees: [person, colleague], inviteDepartments: ['sales'],
  }));
});

it('returns the created meeting on notification failure, retaining durable recovery state', async () => {
  notifyCreated.mockRejectedValue(new Error('notification DB unavailable'));
  const res = response();
  await invoke(controller.createMeeting, { crmUser: host, body: { inviteAll: true, scheduledAt: '2026-10-21T12:00' } }, res);
  expect(res.status).toHaveBeenCalledWith(201);
  expect(createMeeting.mock.calls[0][0].invitationNotificationPending).toBe(true);
});

it('rejects a scheduled meeting with nobody selected to see or receive its alerts', async () => {
  const res = response();
  await expect(invoke(controller.createMeeting, {
    crmUser: host, body: { scheduledAt: '2026-10-21T12:00', invitees: [], inviteAll: false },
  }, res)).rejects.toThrow('Choose at least one person');
  expect(createMeeting).not.toHaveBeenCalled();
});

it('rescheduling resets the sent marker and invalidates an old reminder lease', async () => {
  const scheduled: any = { _id: 'meeting-1', hostCrmUserId: 'host', status: 'scheduled' };
  findMeeting.mockResolvedValue(scheduled);
  (Meeting.findById as jest.Mock).mockReturnValue({ lean: async () => ({ ...scheduled, invitees: [] }) });
  const res = response();
  await invoke(controller.updateMeeting, {
    crmUser: host, params: { code: 'MEET-1234' }, query: {}, body: { scheduledAt: '2026-10-21T12:00' },
  }, res);
  expect(updateMeeting.mock.calls[0][1].$set).toMatchObject({
    scheduledAt: new Date('2026-10-21T18:00:00Z'),
    reminderSentAt: null, reminderClaimToken: null, reminderClaimUntil: null,
  });
});
