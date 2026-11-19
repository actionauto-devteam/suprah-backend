import mongoose from 'mongoose';
jest.mock('../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../src/services/calendarMeetSync.service', () => ({ recoverCalendarMeetings: jest.fn() }));
jest.mock('../src/services/suprahMeetAws.service', () => ({}));
jest.mock('../src/services/suprahMeetAI.service', () => ({}));
jest.mock('../src/services/suprahMeetMail.service', () => ({}));
jest.mock('../src/services/suprahMeetNotification.service', () => ({ notifyMeetingCreated: jest.fn().mockResolvedValue(undefined) }));
import controller from '../src/controllers/suprahMeet.controller';
import Meeting from '../src/models/Meeting.model';
import CrmUser from '../src/models/CrmUser.model';

const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const invoke = (handler: any, req: any, res: any) => handler(req, res, jest.fn());

describe('two-person scheduling with the isolated database', () => {
  const org = new mongoose.Types.ObjectId(), otherOrg = new mongoose.Types.ObjectId();
  const host = new mongoose.Types.ObjectId(), colleague = new mongoose.Types.ObjectId();
  const outsider = new mongoose.Types.ObjectId(), foreign = new mongoose.Types.ObjectId();
  const user = (id: mongoose.Types.ObjectId, organizationId = org) => ({ _id: id, organizationId, role: 'employee' });

  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || !mongoose.connection.name.includes('test')) {
      throw new Error('Isolated local test database required');
    }
    await CrmUser.collection.insertMany([host, colleague, outsider, foreign].map(id => ({
      _id: id, organizationId: id === foreign ? otherOrg : org, fullName: 'Scheduling test',
      email: `${id}@example.test`, username: String(id), isActive: true,
    })));
  });
  afterAll(async () => {
    await Meeting.deleteMany({ organizationId: org });
    await CrmUser.deleteMany({ _id: { $in: [host, colleague, outsider, foreign] } });
  });

  it('returns the saved schedule to host and invitee without exposing a private meeting to others', async () => {
    const start = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(Date.now() + 86_400_000)).replace(' ', 'T');
    const created = response();
    await invoke(controller.createMeeting, { crmUser: user(host), body: {
      title: 'Two-person private schedule', visibility: 'private', invitees: [String(colleague)], scheduledAt: start,
    } }, created);
    expect(created.status).toHaveBeenCalledWith(201);
    const saved = created.json.mock.calls[0][0].data;
    const persisted = await Meeting.findOne({ organizationId: org, code: saved.code });
    expect(persisted!.status).toBe('scheduled');
    expect(persisted!.invitees.map(String)).toEqual([String(colleague)]);
    expect(persisted!.participants).toHaveLength(0);
    for (const [viewer, visible] of [[user(host), true], [user(colleague), true],
      [user(outsider), false], [user(foreign, otherOrg), false]] as const) {
      const listed = response();
      await invoke(controller.listMeetings, { crmUser: viewer }, listed);
      const rows = listed.json.mock.calls[0][0].data.meetings;
      expect(rows.some((meeting: any) => meeting.code === saved.code)).toBe(visible);
    }
  });
});
