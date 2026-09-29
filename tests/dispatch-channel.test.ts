/**
 * Dispatch Chat channels — the business rules end to end:
 * staff create; anyone on the platform can be added; creator and
 * administrators manage people and roles (never the creator); members
 * suggest and an administrator approves; people who leave or are removed lose
 * access; the creator closes the channel and its history stays readable.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Notification from '../src/models/Notification.model';
import DispatchChannel from '../src/models/DispatchChannel.model';
import DispatchChannelMessage from '../src/models/DispatchChannelMessage.model';
import tokenService from '../src/services/token.service';
import { storageService } from '../src/services/storage.service';

const DOMAIN = '@dispatch-channel-test.com';
const SLUGS = ['dispatch-channel-test-a', 'dispatch-channel-test-b'];

let orgA: any;
let orgB: any;
const people: Record<string, { user: any; token: string }> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
const id = (who: string) => String(people[who].user._id);

async function makeUser(key: string, role: string, org?: any) {
  const user = await User.create({
    email: `${key}${DOMAIN}`,
    name: `Channel ${key}`,
    role,
    ...(org ? { organizationId: org._id } : {}),
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  people[key] = { user, token: tokenService.generateAccessToken(user as any) };
}

async function cleanUp() {
  const users = await User.find({ email: { $regex: /@dispatch-channel-test\.com$/ } }).select('_id');
  const ids = users.map((u) => u._id);
  const channels = await DispatchChannel.find({ createdBy: { $in: ids } }).select('_id');
  await DispatchChannelMessage.deleteMany({ channelId: { $in: channels.map((c) => c._id) } });
  await DispatchChannel.deleteMany({ _id: { $in: channels.map((c) => c._id) } });
  await Notification.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await Organization.deleteMany({ slug: { $in: SLUGS } });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  orgA = await Organization.create({ name: 'Channel Test Org A', slug: SLUGS[0], status: 'active' });
  orgB = await Organization.create({ name: 'Channel Test Org B', slug: SLUGS[1], status: 'active' });
  await makeUser('creator', 'admin', orgA);
  await makeUser('otherStaff', 'employee', orgB);
  await makeUser('driverOne', 'driver');
  await makeUser('driverTwo', 'driver');
  await makeUser('customer', 'customer', orgA);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Dispatch Chat channels', () => {
  let channelId: string;

  it('only staff create channels, and people from any organization join right away', async () => {
    await request(app).post('/api/dispatch-channels').set(auth('driverOne')).send({ name: 'Drivers only' }).expect(403);
    await request(app).get('/api/dispatch-channels').set(auth('customer')).expect(403);

    const created = await request(app)
      .post('/api/dispatch-channels')
      .set(auth('creator'))
      .send({ name: 'Denver lane', description: 'Colorado runs', memberIds: [id('otherStaff'), id('driverOne')] })
      .expect(201);
    channelId = created.body.data.id;
    expect(created.body.data.myRole).toBe('admin');
    expect(created.body.data.members).toHaveLength(3);
    const staffRow = created.body.data.members.find((member: any) => member.id === id('otherStaff'));
    expect(staffRow).toMatchObject({ kind: 'staff', organizationName: 'Channel Test Org B', role: 'member' });
    // Members never see each other's email or phone.
    expect(JSON.stringify(created.body.data.members)).not.toMatch(/@dispatch-channel-test\.com/);

    const list = await request(app).get('/api/dispatch-channels').set(auth('driverOne')).expect(200);
    expect(list.body.data.channels.map((channel: any) => channel.id)).toContain(channelId);
    expect(await Notification.countDocuments({ userId: people.driverOne.user._id, type: 'dispatch_channel', title: 'Added to a Channel' })).toBe(1);
  });

  it('messages are stored once per retry and counted as unread until read', async () => {
    const send = () =>
      request(app)
        .post(`/api/dispatch-channels/${channelId}/messages`)
        .set(auth('driverOne'))
        .send({ content: 'Loaded and rolling', clientMessageId: 'retry-key-0001' });
    await send().expect(201);
    await send().expect(200);
    expect(await DispatchChannelMessage.countDocuments({ channelId, messageType: 'message' })).toBe(1);

    const before = await request(app).get('/api/dispatch-channels').set(auth('creator')).expect(200);
    expect(before.body.data.channels.find((c: any) => c.id === channelId).unreadCount).toBe(1);
    await request(app).post(`/api/dispatch-channels/${channelId}/read`).set(auth('creator')).send({}).expect(200);
    const after = await request(app).get('/api/dispatch-channels').set(auth('creator')).expect(200);
    expect(after.body.data.channels.find((c: any) => c.id === channelId).unreadCount).toBe(0);

    const page = await request(app).get(`/api/dispatch-channels/${channelId}/messages`).set(auth('otherStaff')).expect(200);
    expect(page.body.data.messages.some((message: any) => message.content === 'Loaded and rolling')).toBe(true);
  });

  it('members suggest people and an administrator approves them', async () => {
    await request(app)
      .post(`/api/dispatch-channels/${channelId}/members`)
      .set(auth('driverOne'))
      .send({ userIds: [id('driverTwo')] })
      .expect(403);

    const search = await request(app).get('/api/dispatch-channels/people').query({ search: 'Channel driverTwo' }).set(auth('driverOne')).expect(200);
    expect(search.body.data.people.map((person: any) => person.id)).toEqual([id('driverTwo')]);
    expect(JSON.stringify(search.body.data.people)).not.toMatch(/@/);

    const suggested = await request(app)
      .post(`/api/dispatch-channels/${channelId}/suggestions`)
      .set(auth('driverOne'))
      .send({ userId: id('driverTwo') })
      .expect(201);
    expect(suggested.body.data.suggestions).toHaveLength(1);
    expect(await Notification.countDocuments({ userId: people.creator.user._id, title: 'Channel Suggestion' })).toBe(1);

    const detail = await request(app).get(`/api/dispatch-channels/${channelId}`).set(auth('creator')).expect(200);
    const suggestionId = detail.body.data.suggestions[0].id;
    const approved = await request(app)
      .post(`/api/dispatch-channels/${channelId}/suggestions/${suggestionId}/approve`)
      .set(auth('creator'))
      .expect(200);
    expect(approved.body.data.members.some((member: any) => member.id === id('driverTwo'))).toBe(true);
    expect(await Notification.countDocuments({ userId: people.driverOne.user._id, title: 'Suggestion Approved' })).toBe(1);
  });

  it('administrators manage people and roles, but nobody can remove or demote the creator', async () => {
    await request(app)
      .patch(`/api/dispatch-channels/${channelId}/members/${id('otherStaff')}/role`)
      .set(auth('creator'))
      .send({ role: 'admin' })
      .expect(200);
    expect(await Notification.countDocuments({ userId: people.otherStaff.user._id, title: 'Channel Role Changed' })).toBe(1);

    await request(app).delete(`/api/dispatch-channels/${channelId}/members/${id('creator')}`).set(auth('otherStaff')).expect(403);
    await request(app)
      .patch(`/api/dispatch-channels/${channelId}/members/${id('creator')}/role`)
      .set(auth('otherStaff'))
      .send({ role: 'member' })
      .expect(403);

    await request(app).delete(`/api/dispatch-channels/${channelId}/members/${id('driverOne')}`).set(auth('otherStaff')).expect(200);
    // Removed: the channel and its history are gone for them.
    await request(app).get(`/api/dispatch-channels/${channelId}`).set(auth('driverOne')).expect(404);
    await request(app).get(`/api/dispatch-channels/${channelId}/messages`).set(auth('driverOne')).expect(404);
    const list = await request(app).get('/api/dispatch-channels').set(auth('driverOne')).expect(200);
    expect(list.body.data.channels.some((channel: any) => channel.id === channelId)).toBe(false);
  });

  it('anyone but the creator can leave, and the creator closes the channel', async () => {
    await request(app).post(`/api/dispatch-channels/${channelId}/leave`).set(auth('creator')).expect(400);
    await request(app).post(`/api/dispatch-channels/${channelId}/leave`).set(auth('driverTwo')).expect(200);
    await request(app).get(`/api/dispatch-channels/${channelId}`).set(auth('driverTwo')).expect(404);

    await request(app).post(`/api/dispatch-channels/${channelId}/close`).set(auth('otherStaff')).expect(403);
    const closed = await request(app).post(`/api/dispatch-channels/${channelId}/close`).set(auth('creator')).expect(200);
    expect(closed.body.data.status).toBe('closed');

    await request(app)
      .post(`/api/dispatch-channels/${channelId}/messages`)
      .set(auth('otherStaff'))
      .send({ content: 'Anyone there?' })
      .expect(409);
    const history = await request(app).get(`/api/dispatch-channels/${channelId}/messages`).set(auth('otherStaff')).expect(200);
    expect(history.body.data.messages.length).toBeGreaterThan(0);
  });
});

describe('Dispatch Chat channel photos, files, edits and deletes', () => {
  // A real PNG header, so the file-type check accepts it.
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  let channelId: string;
  let uploadSpy: jest.SpyInstance;
  let deleteSpy: jest.SpyInstance;

  const sendText = async (who: string, content: string) =>
    (await request(app).post(`/api/dispatch-channels/${channelId}/messages`).set(auth(who)).send({ content }).expect(201)).body.data;
  const sendPhoto = (who: string, content = '', clientMessageId?: string) => {
    const req = request(app).post(`/api/dispatch-channels/${channelId}/attachments`).set(auth(who));
    if (content) req.field('content', content);
    if (clientMessageId) req.field('clientMessageId', clientMessageId);
    return req.attach('files', PNG, { filename: 'damage.png', contentType: 'image/png' });
  };

  beforeAll(async () => {
    uploadSpy = jest
      .spyOn(storageService, 'upload')
      .mockImplementation(async (file: any, folder: string) => `${folder}/${file.originalname}`);
    jest.spyOn(storageService, 'getSignedUrl').mockImplementation(async (key: string) => `https://files.example.test/${key}?signature=abc`);
    deleteSpy = jest.spyOn(storageService, 'delete').mockResolvedValue(undefined);

    const created = await request(app)
      .post('/api/dispatch-channels')
      .set(auth('creator'))
      .send({ name: 'Photo lane', memberIds: [id('driverOne'), id('driverTwo')] })
      .expect(201);
    channelId = created.body.data.id;
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('members send photos and files once per retry, with private links only', async () => {
    const first = await sendPhoto('driverOne', 'Damage on the left door', 'photo-retry-0001').expect(201);
    const message = first.body.data;
    expect(message.content).toBe('Damage on the left door');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ originalName: 'damage.png', mimeType: 'image/png', available: true });
    expect(message.attachments[0].url).toMatch(/^https:\/\/files\.example\.test\//);
    expect(JSON.stringify(message)).not.toMatch(/fileKey/);

    await sendPhoto('driverOne', 'Damage on the left door', 'photo-retry-0001').expect(200);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(await DispatchChannelMessage.countDocuments({ channelId, messageType: 'message' })).toBe(1);

    await sendPhoto('driverTwo').expect(201);
    const list = await request(app).get('/api/dispatch-channels').set(auth('creator')).expect(200);
    expect(list.body.data.channels.find((c: any) => c.id === channelId).lastMessagePreview).toBe('Sent a photo');

    await request(app)
      .post(`/api/dispatch-channels/${channelId}/attachments`)
      .set(auth('driverOne'))
      .attach('files', Buffer.from('MZ'), { filename: 'tool.exe', contentType: 'application/octet-stream' })
      .expect(400);
    await request(app).post(`/api/dispatch-channels/${channelId}/attachments`).set(auth('customer')).attach('files', PNG, 'x.png').expect(403);
  });

  it('people edit only their own messages', async () => {
    const message = await sendText('driverOne', 'Arriving at 4');
    const path = `/api/dispatch-channels/${channelId}/messages/${message.id}`;

    await request(app).patch(path).set(auth('driverTwo')).send({ content: 'Hacked' }).expect(403);
    // Administrators can delete other people's messages, but not change them.
    await request(app).patch(path).set(auth('creator')).send({ content: 'Changed' }).expect(403);
    await request(app).patch(path).set(auth('driverOne')).send({ content: '   ' }).expect(400);

    const edited = await request(app).patch(path).set(auth('driverOne')).send({ content: 'Arriving at 5' }).expect(200);
    expect(edited.body.data).toMatchObject({ content: 'Arriving at 5' });
    expect(edited.body.data.editedAt).toBeTruthy();

    const list = await request(app).get('/api/dispatch-channels').set(auth('creator')).expect(200);
    expect(list.body.data.channels.find((c: any) => c.id === channelId).lastMessagePreview).toBe('Arriving at 5');

    const systemLine: any = await DispatchChannelMessage.findOne({ channelId, messageType: 'system' }).lean();
    await request(app)
      .patch(`/api/dispatch-channels/${channelId}/messages/${systemLine._id}`)
      .set(auth('creator'))
      .send({ content: 'Rewritten' })
      .expect(404);
  });

  it('members delete their own messages and administrators delete anyone\'s', async () => {
    const own = await sendText('driverOne', 'Wrong load number');
    const other = (await sendPhoto('driverTwo', 'Receipt').expect(201)).body.data;

    await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${other.id}`).set(auth('driverOne')).expect(403);

    const deletedOwn = await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${own.id}`).set(auth('driverOne')).expect(200);
    expect(deletedOwn.body.data).toMatchObject({ content: '', deletedByAdmin: false });
    await request(app)
      .patch(`/api/dispatch-channels/${channelId}/messages/${own.id}`)
      .set(auth('driverOne'))
      .send({ content: 'Back again' })
      .expect(409);

    deleteSpy.mockClear();
    const removed = await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${other.id}`).set(auth('creator')).expect(200);
    expect(removed.body.data).toMatchObject({ content: '', attachments: [], deletedByAdmin: true });
    expect(deleteSpy).toHaveBeenCalledWith('dispatch-channel-attachments/damage.png', 'private');
    // Deleting twice is harmless.
    await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${other.id}`).set(auth('creator')).expect(200);

    const stored: any = await DispatchChannelMessage.findById(other.id).lean();
    expect(stored).toMatchObject({ content: '', attachments: [] });

    // Deleted messages don't count as unread.
    await request(app).post(`/api/dispatch-channels/${channelId}/read`).set(auth('driverOne')).send({}).expect(200);
    const unreadBefore = (await request(app).get('/api/dispatch-channels').set(auth('driverOne')).expect(200)).body.data.channels.find(
      (c: any) => c.id === channelId,
    ).unreadCount;
    const late = await sendText('driverTwo', 'Ignore that');
    await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${late.id}`).set(auth('driverTwo')).expect(200);
    const unreadAfter = (await request(app).get('/api/dispatch-channels').set(auth('driverOne')).expect(200)).body.data.channels.find(
      (c: any) => c.id === channelId,
    ).unreadCount;
    expect(unreadAfter).toBe(unreadBefore);
  });

  it('a closed channel can\'t be edited, but people can still delete their messages', async () => {
    const message = await sendText('driverTwo', 'Last note');
    await request(app).post(`/api/dispatch-channels/${channelId}/close`).set(auth('creator')).expect(200);

    await request(app)
      .patch(`/api/dispatch-channels/${channelId}/messages/${message.id}`)
      .set(auth('driverTwo'))
      .send({ content: 'Edited later' })
      .expect(409);
    await sendPhoto('driverTwo').expect(409);
    await request(app).delete(`/api/dispatch-channels/${channelId}/messages/${message.id}`).set(auth('driverTwo')).expect(200);
  });
});
