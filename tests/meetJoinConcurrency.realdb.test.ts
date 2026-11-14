import mongoose from 'mongoose';
import Meeting from '../src/models/Meeting.model';
import { persistMeetingJoin } from '../src/services/suprahMeetJoin.service';
import { touchParticipantSession } from '../src/services/suprahMeetPresence.service';
jest.mock('../src/services/suprahMeetNotification.service', () => ({ notifyMeetingLive: jest.fn() }));
import { claimHostMeetingEnd } from '../src/services/suprahMeetLifecycle.service';

describe('atomic Meet attendee joins', () => {
  const org = new mongoose.Types.ObjectId(), host = new mongoose.Types.ObjectId();
  beforeEach(() => {
    if (mongoose.connection.host !== '127.0.0.1' || !mongoose.connection.name.includes('test')) throw new Error('Isolated local test database required');
  });
  afterEach(async () => { await Meeting.deleteMany({ organizationId: org }); });
  const create = () => Meeting.create({ organizationId: org, hostCrmUserId: host,
    code: 'MEET-8901', title: 'Concurrent joining', status: 'live', scheduledAt: new Date(Date.now() - 60_000) });
  const add = (id: mongoose.Types.ObjectId, attendeeId: string) => (current: any) => {
    let person = current.participants.find((row: any) => String(row.crmUserId) === String(id));
    if (!person) { current.participants.push({ crmUserId: id, fullName: 'Test participant', role: 'participant', joinedAt: new Date() }); person = current.participants.at(-1); }
    touchParticipantSession(person, attendeeId);
  };

  it('retains both participants when first joins overlap', async () => {
    const source = await create();
    const a = new mongoose.Types.ObjectId(), b = new mongoose.Types.ObjectId();
    await Promise.all([persistMeetingJoin(source, { meetingId: 'shared-media' }, add(a, 'a1')),
      persistMeetingJoin(source, { meetingId: 'shared-media' }, add(b, 'b1'))]);
    const room = (await Meeting.findById(source._id))!;
    expect(room.participants.map(person => String(person.crmUserId)).sort()).toEqual([String(a), String(b)].sort());
    expect(room.get('__v')).toBe(2);
  });

  it('retains both device sessions for simultaneous joins by the same host', async () => {
    const source = await create();
    await Promise.all([persistMeetingJoin(source, { meetingId: 'shared-media' }, add(host, 'host-a')),
      persistMeetingJoin(source, { meetingId: 'shared-media' }, add(host, 'host-b'))]);
    const room = (await Meeting.findById(source._id))!;
    expect(room.participants).toHaveLength(1);
    expect(room.participants[0].sessions!.map(session => session.attendeeId).sort()).toEqual(['host-a', 'host-b']);
  });

  it('handles a group joining together without dropping participants', async () => {
    const source = await create();
    const people = Array.from({ length: 10 }, () => new mongoose.Types.ObjectId());
    await Promise.all(people.map((person, index) => persistMeetingJoin(source, { meetingId: 'shared-media' }, add(person, `attendee-${index}`))));
    expect((await Meeting.findById(source._id))!.participants).toHaveLength(10);
  });

  it('claims host ending before later joins and preserves the complete roster as history', async () => {
    const source = await create();
    const participant = new mongoose.Types.ObjectId();
    await persistMeetingJoin(source, { meetingId: 'shared-media' }, add(participant, 'person'));
    const ended = await claimHostMeetingEnd(source, host);
    expect(ended.claimed).toBe(true);
    expect(ended.meeting.status).toBe('ended');
    expect(ended.meeting.participants).toHaveLength(1);
    expect(ended.meeting.participants[0].sessions).toHaveLength(0);
    await expect(persistMeetingJoin(source, { meetingId: 'shared-media' }, add(host, 'host'))).rejects.toMatchObject({ statusCode: 410 });
    expect((await claimHostMeetingEnd(source, host)).claimed).toBe(false);
  });

  it('cannot resurrect a room ended after the join request began', async () => {
    const source = await create(); await Meeting.updateOne({ _id: source._id }, { $set: { status: 'ended' } });
    await expect(persistMeetingJoin(source, { meetingId: 'media' }, add(host, 'host'))).rejects.toMatchObject({ statusCode: 410 });
    expect((await Meeting.findById(source._id))!.status).toBe('ended');
  });

  it('cannot recreate an unused schedule removed while AWS was issuing an attendee', async () => {
    const source = await create(); await Meeting.deleteOne({ _id: source._id });
    await expect(persistMeetingJoin(source, { meetingId: 'media' }, add(host, 'host'))).rejects.toMatchObject({ statusCode: 404 });
    expect(await Meeting.findById(source._id)).toBeNull();
  });

  it('rechecks admission against the latest document before saving an attendee', async () => {
    const source = await create();
    await Meeting.updateOne({ _id: source._id }, { $set: { removedParticipantIds: [String(host)] } });
    await expect(persistMeetingJoin(source, { meetingId: 'media' }, current => {
      if (current.removedParticipantIds.includes(String(host))) throw Object.assign(new Error('Removed'), { statusCode: 403 });
      add(host, 'host')(current);
    })).rejects.toMatchObject({ statusCode: 403 });
    expect((await Meeting.findById(source._id))!.participants).toHaveLength(0);
  });
});
