/**
 * The driver's merged Dispatch Chat page:
 * - "New message" lists the dispatchers of the driver's current loads and
 *   loads delivered in the last 30 days, and nobody else;
 * - a driver starts a private conversation from one of those loads (the
 *   dispatcher comes from the load, never from the request);
 * - drivers pin conversations and channels they can open, privately.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Load from '../src/models/Load.model';
import Notification from '../src/models/Notification.model';
import DispatchChannel from '../src/models/DispatchChannel.model';
import DispatchChatThread from '../src/models/DispatchChatThread.model';
import DispatchChatMessage from '../src/models/DispatchChatMessage.model';
import DispatchChatPin from '../src/models/DispatchChatPin.model';
import tokenService from '../src/services/token.service';

const DOMAIN = '@driver-dispatch-inbox-test.com';
const SLUGS = ['driver-inbox-test-a', 'driver-inbox-test-b'];
const DAY = 24 * 60 * 60 * 1000;

let orgA: any;
let orgB: any;
const people: Record<string, { user: any; token: string }> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
const id = (who: string) => String(people[who].user._id);
const loads: Record<string, any> = {};

async function makeUser(key: string, role: string, org?: any) {
  const user = await User.create({
    email: `${key}${DOMAIN}`,
    name: `Inbox ${key}`,
    role,
    ...(org ? { organizationId: org._id, dispatcherOrganizationIds: [org._id] } : {}),
    emailVerified: true,
    onboardingCompleted: true,
    isActive: true,
    isApproved: true,
  });
  people[key] = { user, token: tokenService.generateAccessToken(user as any) };
}

function seedLoad(overrides: Record<string, unknown>) {
  return Load.create({
    organizationId: orgA._id,
    createdBy: people.creator.user._id,
    postType: 'load-board',
    status: 'Posted',
    pickupLocation: { address: '1 Pickup St', city: 'Salt Lake City', state: 'UT', zip: '84101' },
    deliveryLocation: { address: '2 Delivery Ave', city: 'Denver', state: 'CO', zip: '80202' },
    vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
    trailerType: 'open_2car',
    additionalInfo: { visibility: 'public' },
    pricing: { miles: 500, carrierPayAmount: 800, isPricingEnabled: true, isVisibleToDriver: true },
    ...overrides,
  });
}

async function cleanUp() {
  const users = await User.find({ email: { $regex: /@driver-dispatch-inbox-test\.com$/ } }).select('_id');
  const ids = users.map((u) => u._id);
  const orgs = await Organization.find({ slug: { $in: SLUGS } }).select('_id');
  const orgIds = orgs.map((o) => String(o._id));
  await Load.deleteMany({ organizationId: { $in: orgIds } });
  await DispatchChatMessage.deleteMany({ organizationId: { $in: orgIds } });
  await DispatchChatThread.deleteMany({ organizationId: { $in: orgIds } });
  await DispatchChannel.deleteMany({ createdBy: { $in: ids } });
  await DispatchChatPin.deleteMany({ userId: { $in: ids } });
  await Notification.deleteMany({ userId: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
  await Organization.deleteMany({ slug: { $in: SLUGS } });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  orgA = await Organization.create({ name: 'Inbox Test Org A', slug: SLUGS[0], status: 'active' });
  orgB = await Organization.create({ name: 'Inbox Test Org B', slug: SLUGS[1], status: 'active' });
  await makeUser('creator', 'admin', orgA);
  await makeUser('owner', 'employee', orgA);
  await makeUser('recentOwner', 'employee', orgA);
  await makeUser('oldOwner', 'employee', orgA);
  await makeUser('foreignStaff', 'employee', orgB);
  await makeUser('driver', 'driver');
  await makeUser('otherDriver', 'driver');

  // Current load: the responsible dispatcher is "owner".
  loads.current = await seedLoad({
    status: 'In-Transit',
    assignedDriverId: people.driver.user._id,
    dispatchOwnerId: people.owner.user._id,
    assignedAt: new Date(),
    acceptedAt: new Date(),
  });
  // Delivered 10 days ago; no responsible dispatcher, so the creator counts.
  loads.recent = await seedLoad({
    status: 'Delivered',
    assignedDriverId: people.driver.user._id,
    createdBy: people.recentOwner.user._id,
    deliveredAt: new Date(Date.now() - 10 * DAY),
  });
  // Delivered 40 days ago: too old for New message.
  loads.old = await seedLoad({
    status: 'Delivered',
    assignedDriverId: people.driver.user._id,
    dispatchOwnerId: people.oldOwner.user._id,
    deliveredAt: new Date(Date.now() - 40 * DAY),
  });
  // Another driver's load.
  loads.otherDrivers = await seedLoad({
    status: 'Accepted',
    assignedDriverId: people.otherDriver.user._id,
    dispatchOwnerId: people.oldOwner.user._id,
  });
  // A responsible dispatcher from another organization isn't a valid contact.
  loads.foreignOwner = await seedLoad({
    status: 'Assigned',
    assignedDriverId: people.driver.user._id,
    dispatchOwnerId: people.foreignStaff.user._id,
  });
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Driver Dispatch Chat: dispatchers of my loads', () => {
  it('lists the dispatchers of current and recent loads, current first, and only for drivers', async () => {
    await request(app).get('/api/driver-tracking/dispatch-chat/contacts').set(auth('owner')).expect(403);

    const res = await request(app).get('/api/driver-tracking/dispatch-chat/contacts').set(auth('driver')).expect(200);
    const contacts = res.body.data.contacts;
    expect(contacts.map((contact: any) => contact.dispatcher.id)).toEqual([id('owner'), id('recentOwner')]);
    expect(contacts[0]).toMatchObject({
      current: true,
      threadId: null,
      loadCount: 1,
      load: { id: String(loads.current._id), status: 'In-Transit', origin: 'Salt Lake City, UT', destination: 'Denver, CO' },
    });
    expect(contacts[1]).toMatchObject({ current: false, load: { id: String(loads.recent._id), status: 'Delivered' } });
    // Drivers never see staff email addresses here.
    expect(contacts[0].dispatcher.email).toBeUndefined();
  });

  it('starts (and reuses) the private conversation from one of my loads, never from someone else\'s', async () => {
    const open = (loadId: unknown, who = 'driver') =>
      request(app).post(`/api/driver-tracking/dispatch-chat/my-loads/${loadId}/open`).set(auth(who));

    const first = await open(loads.current._id).expect(200);
    const thread = first.body.data.thread;
    expect(thread.dispatcher).toMatchObject({ id: id('owner'), isActive: true });
    expect(thread.driver.id).toBe(id('driver'));
    expect(thread.lastMessageAt).toBeNull();

    const again = await open(loads.current._id).expect(200);
    expect(again.body.data.thread.id).toBe(thread.id);

    await open(loads.old._id).expect(404);
    await open(loads.otherDrivers._id).expect(404);
    await open(loads.foreignOwner._id).expect(409);
    await open(loads.current._id, 'owner').expect(403);
    await open('not-an-id').expect(400);

    const contacts = await request(app).get('/api/driver-tracking/dispatch-chat/contacts').set(auth('driver')).expect(200);
    expect(contacts.body.data.contacts[0].threadId).toBe(thread.id);

    // The dispatcher sees the conversation once the driver writes in it.
    await request(app)
      .post(`/api/driver-tracking/dispatch-chat/${id('driver')}/messages`)
      .set(auth('driver'))
      .send({ threadId: thread.id, content: 'Stuck at the gate, who do I call?' })
      .expect(201);
    const staffThreads = await request(app).get('/api/driver-tracking/dispatch-chat/threads').set(auth('owner')).expect(200);
    expect(staffThreads.body.data.threads.map((row: any) => row.id)).toContain(thread.id);
  });

  it('a reply from Dispatch notifies the driver with a link to the Dispatch Chat page', async () => {
    const thread = await DispatchChatThread.findOne({ driverId: people.driver.user._id, dispatcherId: people.owner.user._id });
    await request(app)
      .post(`/api/driver-tracking/dispatch-chat/${id('driver')}/messages`)
      .set(auth('owner'))
      .send({ content: 'Call the gate office.' })
      .expect(201);

    let notification: any = null;
    for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
      notification = await Notification.findOne({ userId: people.driver.user._id, type: 'driver_dispatch_message' }).lean();
      if (!notification) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(notification?.metadata?.route).toBe(`/driver/channels?threadId=${thread!._id}`);
  });
});

describe('Driver Dispatch Chat: pins', () => {
  const pin = (who: string, body: Record<string, unknown>) =>
    request(app).put('/api/driver-tracking/dispatch-chat/pins').set(auth(who)).send(body);

  it('pins and unpins my conversations and channels, and nothing else', async () => {
    const thread = await DispatchChatThread.findOne({ driverId: people.driver.user._id, dispatcherId: people.owner.user._id });
    const now = new Date();
    const channel = await DispatchChannel.create({
      name: 'Denver lane',
      organizationId: String(orgA._id),
      createdBy: people.creator.user._id,
      members: [
        { userId: people.creator.user._id, role: 'admin', joinedAt: now },
        { userId: people.driver.user._id, role: 'member', joinedAt: now },
      ],
    });
    const notMine = await DispatchChannel.create({
      name: 'Other lane',
      organizationId: String(orgA._id),
      createdBy: people.creator.user._id,
      members: [{ userId: people.creator.user._id, role: 'admin', joinedAt: now }],
    });

    await request(app).get('/api/driver-tracking/dispatch-chat/pins').set(auth('owner')).expect(403);
    await pin('driver', { kind: 'folder', id: String(channel._id), pinned: true }).expect(400);
    await pin('driver', { kind: 'channel', id: String(channel._id) }).expect(400);
    await pin('driver', { kind: 'channel', id: String(notMine._id), pinned: true }).expect(404);
    await pin('otherDriver', { kind: 'thread', id: String(thread!._id), pinned: true }).expect(404);

    await pin('driver', { kind: 'thread', id: String(thread!._id), pinned: true }).expect(200);
    const pinned = await pin('driver', { kind: 'channel', id: String(channel._id), pinned: true }).expect(200);
    expect(pinned.body.data.pins.map((row: any) => `${row.kind}:${row.id}`)).toEqual([
      `thread:${thread!._id}`,
      `channel:${channel._id}`,
    ]);
    // Pinning twice is harmless.
    await pin('driver', { kind: 'channel', id: String(channel._id), pinned: true }).expect(200);
    expect(await DispatchChatPin.countDocuments({ userId: people.driver.user._id })).toBe(2);

    // Pins are private.
    const others = await request(app).get('/api/driver-tracking/dispatch-chat/pins').set(auth('otherDriver')).expect(200);
    expect(others.body.data.pins).toEqual([]);

    const unpinned = await pin('driver', { kind: 'thread', id: String(thread!._id), pinned: false }).expect(200);
    expect(unpinned.body.data.pins.map((row: any) => row.id)).toEqual([String(channel._id)]);

    // Leaving the channel drops its pin.
    await DispatchChannel.updateOne({ _id: channel._id }, { $pull: { members: { userId: people.driver.user._id } } });
    const afterLeaving = await request(app).get('/api/driver-tracking/dispatch-chat/pins').set(auth('driver')).expect(200);
    expect(afterLeaving.body.data.pins).toEqual([]);
    expect(await DispatchChatPin.countDocuments({ userId: people.driver.user._id })).toBe(0);
  });

  it('allows up to 20 pins', async () => {
    const now = new Date();
    const channels = await DispatchChannel.insertMany(
      Array.from({ length: 21 }, (_, index) => ({
        name: `Pin limit ${index}`,
        organizationId: String(orgA._id),
        createdBy: people.creator.user._id,
        members: [
          { userId: people.creator.user._id, role: 'admin', joinedAt: now },
          { userId: people.otherDriver.user._id, role: 'member', joinedAt: now },
        ],
      })),
    );
    for (const channel of channels.slice(0, 20)) {
      await pin('otherDriver', { kind: 'channel', id: String(channel._id), pinned: true }).expect(200);
    }
    const refused = await pin('otherDriver', { kind: 'channel', id: String(channels[20]._id), pinned: true }).expect(400);
    expect(refused.body.message).toMatch(/up to 20/);
  });
});
