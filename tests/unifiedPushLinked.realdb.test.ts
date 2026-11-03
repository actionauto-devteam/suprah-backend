import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const mockSend = jest.fn();
jest.mock('web-push', () => ({ __esModule: true, default: { setVapidDetails: jest.fn(), sendNotification: (...args: unknown[]) => mockSend(...args) } }));
jest.mock('../src/utils/socketEmitter', () => ({
  ...jest.requireActual('../src/utils/socketEmitter'),
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));

import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Organization from '../src/models/Organization.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import UnifiedPushService from '../src/services/unifiedPush.service';
import { notifyLeadMessage } from '../src/services/leadMessageNotice.service';
import crmTimeproofRoute from '../src/routes/crmTimeproof.route';

const app = express();
app.use(express.json());
app.use('/api/crm/timeproof', crmTimeproofRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const ids = {
  repUser: new mongoose.Types.ObjectId(),
  repCrm: new mongoose.Types.ObjectId(),
  lonelyCrm: new mongoose.Types.ObjectId(),
  otherOrgUser: new mongoose.Types.ObjectId(),
};
const tag = Date.now().toString(36);
const email = (name: string) => `${name}-${tag}@example.com`;
const sub = (name: string, extra: Record<string, unknown> = {}) => ({
  endpoint: `https://push.example.com/${name}-${tag}`,
  keys: { p256dh: `p256-${name}`, auth: `auth-${name}` },
  deviceHint: 'desktop',
  createdAt: new Date(),
  ...extra,
});
const endpointsSent = () => mockSend.mock.calls.map((call) => String(call[0].endpoint).replace(`-${tag}`, '').replace('https://push.example.com/', ''));
const payload = (title: string) => ({ title, body: 'Hello there', tag: `t-${title}` });

describe('Real-DB proof: push reaches the person on whichever account the device was saved (local MongoDB only)', () => {
  beforeAll(async () => {
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Push Org A', slug: `push-a-${orgA}`, status: 'active' },
      { _id: orgB, name: 'Push Org B', slug: `push-b-${orgB}`, status: 'active' },
    ] as any[]);
    const now = new Date();
    await User.collection.insertMany([
      { _id: ids.repUser, email: email('rep'), name: 'Rep Main', organizationId: orgA, role: 'member', pushSubscriptions: [sub('main-laptop'), sub('shared-browser')], createdAt: now, updatedAt: now },
      { _id: ids.otherOrgUser, email: email('lonely'), name: 'Other Org', organizationId: orgB, role: 'member', pushSubscriptions: [], createdAt: now, updatedAt: now },
    ] as any[]);
    await CrmUser.collection.insertMany([
      {
        _id: ids.repCrm, organizationId: orgA, fullName: 'Rep Crm', username: `rep-${tag}`, email: email('rep'), role: 'employee', isActive: true, password: 'x',
        pushSubscriptions: [sub('crm-desktop'), sub('shared-browser'), sub('space-app', { appSource: 'supraspace' })], createdAt: now, updatedAt: now,
      },
      {
        _id: ids.lonelyCrm, organizationId: orgA, fullName: 'Lonely Crm', username: `lonely-${tag}`, email: email('lonely'), role: 'employee', isActive: true, password: 'x',
        pushSubscriptions: [sub('lonely-desktop')], createdAt: now, updatedAt: now,
      },
    ] as any[]);
  });

  afterAll(async () => {
    await User.collection.deleteMany({ _id: { $in: [ids.repUser, ids.otherOrgUser] } });
    await CrmUser.collection.deleteMany({ _id: { $in: [ids.repCrm, ids.lonelyCrm] } });
    await Organization.collection.deleteMany({ _id: { $in: [orgA, orgB] } });
    await mongoose.connection.db!.collection('notifications').deleteMany({ organizationId: { $in: [orgA, String(orgA)] } });
  });

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ statusCode: 201 });
  });

  it('a push to the main account also reaches devices saved on the CRM account, once per device, never the SupraSpace app', async () => {
    const result = await UnifiedPushService.sendToUser(String(ids.repUser), payload('one'));
    expect(endpointsSent().sort()).toEqual(['crm-desktop', 'main-laptop', 'shared-browser']);
    expect(result).toMatchObject({ sent: 3, failed: 0, devices: 3 });
  });

  it('a push to the CRM account also reaches the main account, and the SupraSpace app only when asked', async () => {
    await UnifiedPushService.sendToUser(String(ids.repCrm), payload('two'));
    expect(endpointsSent().sort()).toEqual(['crm-desktop', 'main-laptop', 'shared-browser']);
    mockSend.mockClear();
    await UnifiedPushService.sendToUser(String(ids.repCrm), payload('three'), true);
    expect(endpointsSent().sort()).toEqual(['crm-desktop', 'main-laptop', 'shared-browser', 'space-app']);
  });

  it('the same notice sent to both accounts of one person reaches each device once, but a deliberate resend still goes out', async () => {
    await UnifiedPushService.sendToUser(String(ids.repUser), payload('four'));
    const second = await UnifiedPushService.sendToUser(String(ids.repCrm), payload('four'));
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(second.sent).toBe(0);
    await UnifiedPushService.sendToUser(String(ids.repUser), payload('four'));
    expect(mockSend).toHaveBeenCalledTimes(6);
  });

  it('never links accounts across organizations, and only links by the same email', async () => {
    const result = await UnifiedPushService.sendToUser(String(ids.otherOrgUser), payload('five'));
    expect(result).toMatchObject({ sent: 0, devices: 0 });
    await UnifiedPushService.sendToUser(String(ids.lonelyCrm), payload('six'));
    expect(endpointsSent()).toEqual(['lonely-desktop']);
  });

  it('an expired device is removed only from the account that holds it', async () => {
    mockSend.mockImplementation(async (target: { endpoint: string }) => {
      if (target.endpoint.includes('crm-desktop')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const result = await UnifiedPushService.sendToUser(String(ids.repUser), payload('seven'));
    expect(result).toMatchObject({ sent: 2, pruned: 1 });
    const crm: any = await CrmUser.collection.findOne({ _id: ids.repCrm });
    expect(crm.pushSubscriptions.map((s: any) => s.endpoint.replace(`-${tag}`, '').replace('https://push.example.com/', '')).sort()).toEqual(['shared-browser', 'space-app']);
    const user: any = await User.collection.findOne({ _id: ids.repUser });
    expect(user.pushSubscriptions).toHaveLength(2);
    await CrmUser.collection.updateOne({ _id: ids.repCrm }, { $push: { pushSubscriptions: sub('crm-desktop') } } as any);
  });

  it('a text on a lead assigned to the rep reaches the device the rep turned on from the CRM', async () => {
    await User.collection.updateOne({ _id: ids.repUser }, { $set: { pushSubscriptions: [] } });
    const lead = { _id: new mongoose.Types.ObjectId(), firstName: 'Pat', lastName: 'Lee', assignedTo: ids.repUser, createdAt: new Date(Date.now() - 3600_000) };
    expect(await notifyLeadMessage(String(orgA), lead, 'sms', 'Is the truck still there?')).toBe(true);
    for (let i = 0; i < 40 && mockSend.mock.calls.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(endpointsSent().sort()).toEqual(['crm-desktop', 'shared-browser']);
    const sentPayload = JSON.parse(mockSend.mock.calls[0][1]);
    expect(sentPayload.tag).toBe(`lead-message-${lead._id}`);
    await User.collection.updateOne({ _id: ids.repUser }, { $set: { pushSubscriptions: [sub('main-laptop'), sub('shared-browser')] } });
  });

  it('Send test reaches every device of the signed-in person and is limited to one every few seconds', async () => {
    const token = generateCrmToken(String(ids.repCrm));
    const first = await request(app).post('/api/crm/timeproof/push/test').set({ Authorization: `Bearer ${token}` }).send({});
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ devices: 3, sent: 3, failed: 0 });
    expect(JSON.parse(mockSend.mock.calls[0][1]).title).toBe('Test notification');
    const second = await request(app).post('/api/crm/timeproof/push/test').set({ Authorization: `Bearer ${token}` }).send({});
    expect(second.status).toBe(429);
    await request(app).post('/api/crm/timeproof/push/test').send({}).expect(401);
  });
});
