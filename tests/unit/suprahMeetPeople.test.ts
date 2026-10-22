const findMeeting = jest.fn();
const findUsers = jest.fn();
const lean = jest.fn();

jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: { findOne: findMeeting } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { find: findUsers } }));
jest.mock('../../src/services/suprahMeetAws.service', () => ({}));
jest.mock('../../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../../src/services/suprahMeetNotification.service', () => ({ MEET_REMINDER_WINDOW_MS: 600_000 }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

import controller from '../../src/controllers/suprahMeet.controller';

let meeting: any;
const request = () => ({
  crmUser: { _id: 'viewer', organizationId: 'org-1', role: 'employee' }, params: { code: 'meet-1234' },
});
const invoke = async () => {
  const res = { json: jest.fn() };
  await (controller.getPeople as any)(request(), res, jest.fn());
  return res.json.mock.calls[0][0].data;
};

beforeEach(() => {
  jest.resetAllMocks();
  meeting = {
    _id: 'meet-1', organizationId: 'org-1', code: 'MEET-1234', hostCrmUserId: 'host',
    inviteAll: false, invitees: ['invited-1', 'invited-2'],
    participants: [
      { crmUserId: 'host', fullName: 'Host Person' },
      { crmUserId: 'invited-1', fullName: 'Invited One', leftAt: new Date('2026-10-22T15:00:00Z') },
      { isGuest: true, guestId: 'g-1', fullName: 'Outside Guest' },
      { isGuest: true, fullName: 'No Guest Id' },
    ],
  };
  findMeeting.mockResolvedValue(meeting);
  lean.mockResolvedValue([
    { _id: 'host', fullName: 'Host Person', department: 'Sales' },
    { _id: 'invited-1', fullName: 'Invited One', avatar: 'a.png' },
    { _id: 'invited-2', fullName: 'Invited Two' },
  ]);
  findUsers.mockReturnValue({ select: () => ({ limit: () => ({ lean }) }) });
});

it('looks up the meeting inside the viewer organization by upper-cased code', async () => {
  await invoke();
  expect(findMeeting).toHaveBeenCalledWith({ organizationId: 'org-1', code: 'MEET-1234' });
});

it('returns host, invitees and past participants with their status', async () => {
  const data = await invoke();
  expect(findUsers).toHaveBeenCalledWith({
    organizationId: 'org-1', _id: { $in: ['host', 'invited-1', 'invited-2'] },
  });
  expect(data.hostCrmUserId).toBe('host');
  const byId = Object.fromEntries(data.people.map((p: any) => [p.crmUserId, p]));
  expect(byId.host).toMatchObject({ isHost: true, joinedBefore: true, department: 'Sales' });
  expect(byId['invited-1']).toMatchObject({ isHost: false, joinedBefore: true, avatar: 'a.png' });
  expect(byId['invited-1'].leftAt).toEqual(new Date('2026-10-22T15:00:00Z'));
  expect(byId['invited-2']).toMatchObject({ joinedBefore: false, leftAt: null });
});

it('includes guests who joined, keyed like the live roster', async () => {
  const data = await invoke();
  const guests = data.people.filter((p: any) => p.isGuest);
  expect(guests).toHaveLength(1);
  expect(guests[0]).toMatchObject({ crmUserId: 'guest:g-1', fullName: 'Outside Guest', joinedBefore: true });
});

it('lists every active org member when the whole organization is invited', async () => {
  meeting.inviteAll = true;
  await invoke();
  expect(findUsers).toHaveBeenCalledWith({
    organizationId: 'org-1',
    isSystem: { $ne: true },
    $or: [{ isActive: true }, { _id: { $in: ['host', 'invited-1', 'invited-2'] } }],
  });
});

it('returns 404 when the code is not in the viewer organization', async () => {
  findMeeting.mockResolvedValue(null);
  await expect(invoke()).rejects.toMatchObject({ statusCode: 404 });
});
