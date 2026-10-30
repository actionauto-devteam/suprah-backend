const findMeetings = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({
  __esModule: true,
  default: { find: findMeetings },
}));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({
  MEET_REMINDER_WINDOW_MS: 600_000,
  notifyMeetingCreated: jest.fn(),
  notifyMeetingLive: jest.fn(),
}));
jest.mock('../../src/services/suprahMeetPresence.service', () => ({
  meetingEndedMessage: () => 'This meeting has already ended.',
  clearParticipantSessions: jest.fn(),
  hasParticipantSession: jest.fn(),
  isHostPresent: jest.fn(),
  leaveParticipantSession: jest.fn(),
  meetingTimerSnapshot: () => ({ elapsedMs: 0, running: false, hostPresent: false }),
  reconcileMeetingTimer: jest.fn(),
  stopMeetingTimer: jest.fn(),
  touchParticipantSession: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';

const queryResult = (rows: unknown[]) => ({
  sort: jest.fn(() => ({
    limit: jest.fn(() => ({ lean: jest.fn(async () => rows) })),
  })),
});

const alertQueryResult = (rows: unknown[]) => ({
  select: jest.fn(() => ({
    limit: jest.fn(() => ({ lean: jest.fn(async () => rows) })),
  })),
});

beforeEach(() => findMeetings.mockReset());

it('fetches active meetings separately so history cannot hide the current schedule', async () => {
  const active = [{ _id: 'active', code: 'MEET-1000', title: 'Next', status: 'scheduled', hostCrmUserId: 'person' }];
  const history = [{ _id: 'ended', code: 'MEET-1001', title: 'Old', status: 'ended', hostCrmUserId: 'person' }];
  findMeetings
    .mockReturnValueOnce(queryResult(active))
    .mockReturnValueOnce(queryResult(history));
  const res: any = { json: jest.fn() };

  await (controller.listMeetings as any)({
    crmUser: { _id: 'person', organizationId: 'org-1', role: 'employee' },
  }, res, jest.fn());

  expect(findMeetings).toHaveBeenCalledTimes(2);
  expect(findMeetings.mock.calls[0][0]).toMatchObject({ status: { $in: ['scheduled', 'live'] } });
  expect(findMeetings.mock.calls[0][0].$or).toContainEqual({ visibility: { $ne: 'private' } });
  expect(findMeetings.mock.calls[1][0]).toMatchObject({ status: 'ended' });
  expect(res.json.mock.calls[0][0].data.meetings.map((meeting: any) => meeting.code))
    .toEqual(['MEET-1000', 'MEET-1001']);
});

it('surfaces public live and starting-soon rooms in the in-app alert feed', async () => {
  findMeetings
    .mockReturnValueOnce(alertQueryResult([]))
    .mockReturnValueOnce(alertQueryResult([]));
  const res: any = { json: jest.fn() };

  await (controller.getAlerts as any)({
    crmUser: { _id: 'person', organizationId: 'org-1', role: 'employee' },
  }, res, jest.fn());

  expect(findMeetings).toHaveBeenCalledTimes(2);
  expect(findMeetings.mock.calls[0][0].$or).toContainEqual({ visibility: { $ne: 'private' } });
  expect(findMeetings.mock.calls[1][0].$or).toContainEqual({ visibility: { $ne: 'private' } });
});
