import mongoose from 'mongoose';
jest.mock('../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
import Meeting from '../src/models/Meeting.model';
import { previewUnusedMeetings, removeUnusedMeetings } from '../src/controllers/suprahMeetCleanup.controller';

describe('unused Meet schedule cleanup', () => {
  const org = new mongoose.Types.ObjectId(), otherOrg = new mongoose.Types.ObjectId();
  const admin = new mongoose.Types.ObjectId(), qa = new mongoose.Types.ObjectId();
  const ids = Array.from({ length: 9 }, () => new mongoose.Types.ObjectId());
  const user = { _id: admin, organizationId: org, role: 'admin' };
  const response = () => ({ json: jest.fn() });
  const invoke = (handler: unknown, req: unknown, res: unknown) => (handler as any)(req, res, jest.fn());
  beforeEach(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(mongoose.connection.host) || !mongoose.connection.name.includes('test')) {
      throw new Error('Cleanup tests require a local test database');
    }
    const base = { organizationId: org, hostCrmUserId: qa, status: 'scheduled', title: 'Instant meeting',
      participants: [], recording: { status: 'idle' }, ai: { status: 'idle' } };
    await Meeting.collection.insertMany([
      { ...base, _id: ids[0], code: 'MEET-9100' },
      { ...base, _id: ids[1], code: 'MEET-9101', title: 'Daily Online Web Dev & CRM QA Sync' },
      { ...base, _id: ids[2], code: 'MEET-9102', status: 'live' },
      { ...base, _id: ids[3], code: 'MEET-9103', status: 'ended', ai: { status: 'ready', summary: { overview: 'Call summary' } } },
      { ...base, _id: ids[4], code: 'MEET-9104', calendarSourceId: 'calendar:owned-schedule' },
      { ...base, _id: ids[5], code: 'MEET-9105', organizationId: otherOrg },
      { ...base, _id: ids[6], code: 'MEET-9106', hostCrmUserId: admin },
      { ...base, _id: ids[7], code: 'MEET-9107', recording: { status: 'ready', videoKey: 'keep-video' } },
      { ...base, _id: ids[8], code: 'MEET-9108', participants: [{ crmUserId: qa, fullName: 'QA', joinedAt: new Date() }] },
    ]);
  });
  afterEach(async () => { await Meeting.deleteMany({ _id: { $in: ids }, organizationId: { $in: [org, otherOrg] } }); });

  it('previews eligible team drafts for admins and preserves the named daily series', async () => {
    const res = response(); await invoke(previewUnusedMeetings, { crmUser: user }, res);
    expect(res.json.mock.calls[0][0].data.meetings.map((row: any) => String(row._id)).sort())
      .toEqual([ids[0], ids[6]].map(String).sort());
  });
  it('employees see and remove their own unused drafts only', async () => {
    const employee = { ...user, role: 'employee' };
    const res = response(); await invoke(previewUnusedMeetings, { crmUser: employee }, res);
    expect(res.json.mock.calls[0][0].data.meetings.map((row: any) => String(row._id))).toEqual([String(ids[6])]);
    await invoke(removeUnusedMeetings, { crmUser: employee, body: { ids: ids.map(String) } }, response());
    expect(await Meeting.findById(ids[0])).not.toBeNull();
    expect(await Meeting.findById(ids[6])).toBeNull();
  });
  it('rechecks status, title, tenant, call history and media even for forged selections', async () => {
    const res = response();
    await invoke(removeUnusedMeetings, { crmUser: user, body: { ids: ids.map(String) } }, res);
    expect(res.json.mock.calls[0][0].data.deletedCount).toBe(2);
    for (const index of [1, 2, 3, 4, 5, 7, 8]) expect(await Meeting.findById(ids[index])).not.toBeNull();
  });
  it('keeps a schedule that becomes live after the preview and leaves unselected drafts alone', async () => {
    await invoke(previewUnusedMeetings, { crmUser: user }, response());
    await Meeting.updateOne({ _id: ids[0] }, { $set: { status: 'live' } });
    const res = response(); await invoke(removeUnusedMeetings, { crmUser: user, body: { ids: [String(ids[0])] } }, res);
    expect(res.json.mock.calls[0][0].data.deletedCount).toBe(0);
    expect(await Meeting.findById(ids[6])).not.toBeNull();
  });
  it('rejects unauthenticated requests, empty selections and invalid ids', async () => {
    await expect(invoke(removeUnusedMeetings, { body: { ids: ids.map(String) } }, response())).rejects.toMatchObject({ statusCode: 401 });
    for (const selected of [[], ['not-an-id']]) {
      await expect(invoke(removeUnusedMeetings, { crmUser: user, body: { ids: selected } }, response())).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await Meeting.countDocuments({ _id: { $in: ids } })).toBe(9);
  });
});
