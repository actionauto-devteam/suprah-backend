const mockTelnyx = {
  transferToAgent: jest.fn(),
  playMissedAndHangup: jest.fn(),
  hangupCall: jest.fn(),
  answerCall: jest.fn(),
  speak: jest.fn(),
  speakIvr: jest.fn(),
  gatherIvr: jest.fn(),
  sendSms: jest.fn(),
  findAccountPhoneNumber: jest.fn(),
};
const mockRoomEmit = jest.fn();
const mockNotifyUsers = jest.fn();
const mockNotifyOrgAdmins = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const nodeCrypto = require('crypto');
  const keys = nodeCrypto.generateKeyPairSync('ed25519');
  const der: Buffer = keys.publicKey.export({ format: 'der', type: 'spki' });
  process.env.TELNYX_PUBLIC_KEY = der.subarray(der.length - 32).toString('base64');
  (globalThis as any).mockTelnyxPrivateKey = keys.privateKey;
  const actual = jest.requireActual('../src/services/telnyx.service');
  const forward = (name: keyof typeof mockTelnyx) => (...args: unknown[]) => (mockTelnyx[name] as jest.Mock)(...args);
  return {
    ...actual,
    COMPANY_NUMBER: '+18015550900',
    transferToAgent: forward('transferToAgent'),
    playMissedAndHangup: forward('playMissedAndHangup'),
    hangupCall: forward('hangupCall'),
    answerCall: forward('answerCall'),
    speak: forward('speak'),
    speakIvr: forward('speakIvr'),
    gatherIvr: forward('gatherIvr'),
    sendSms: forward('sendSms'),
    findAccountPhoneNumber: forward('findAccountPhoneNumber'),
    createTelephonyCredential: jest.fn(),
    createRtcLoginToken: jest.fn(),
    recordingCommand: jest.fn(),
    recordingDisclosure: jest.fn(),
    findRecordings: jest.fn().mockResolvedValue([]),
    deleteProviderRecording: jest.fn(),
  };
});
jest.mock('../src/utils/socketEmitter', () => {
  const actual = jest.requireActual('../src/utils/socketEmitter');
  return {
    ...actual,
    getSocketIO: () => ({ to: (room: unknown) => ({ emit: (event: string, data: unknown) => mockRoomEmit(room, event, data) }), emit: jest.fn() }),
    emitToOrg: (orgId: string, event: string, data: unknown) => mockRoomEmit(`org:${orgId}`, event, data),
    emitToUser: jest.fn(),
    emitToCrmUser: jest.fn(),
    streamLogToAdmins: jest.fn(),
  };
});
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import Lead from '../src/models/lead.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { IvrInboundClaim } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, TelephonyCredential } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import communicationRoutes from '../src/routes/communication.routes';
import phoneNumberRoutes from '../src/routes/crmPhoneNumber.routes';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use('/api/crm/communications', communicationRoutes);
app.use('/api/crm/phone-numbers', phoneNumberRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const MAIN = '+18015550900';
const SERVICE = '+18015550912';
const EMPTY_TEAM_LINE = '+18015550913';
const ids = {
  adminUser: new mongoose.Types.ObjectId(),
  adminCrm: new mongoose.Types.ObjectId(),
  techUser: new mongoose.Types.ObjectId(),
  techCrm: new mongoose.Types.ObjectId(),
  repUser: new mongoose.Types.ObjectId(),
  repCrm: new mongoose.Types.ObjectId(),
  serviceTeam: new mongoose.Types.ObjectId(),
  emptyTeam: new mongoose.Types.ObjectId(),
  oldTeam: new mongoose.Types.ObjectId(),
  foreignTeam: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
let serial = 0;
const numberIds: Record<string, string> = {};
const nextPhone = () => `+1801555${String(7800 + (++serial)).slice(-4)}`;
const nextControlId = () => `v3:p12c-${Date.now()}-${++serial}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ringTimers: Array<{ fn: () => Promise<void>; handle: { cleared: boolean }; ms: number }> = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p12c-${Date.now()}-${++serial}`, event_type: eventType, payload } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${body}`), (globalThis as any).mockTelnyxPrivateKey).toString('base64');
  return request(app).post('/api/webhooks/telnyx').set('Content-Type', 'application/json')
    .set('telnyx-timestamp', timestamp).set('telnyx-signature-ed25519', signature).send(body);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await wait(40);
    value = await read();
  }
  return value;
}

async function incoming(from: string, to: string) {
  const controlId = nextControlId();
  const res = await webhook('call.initiated', { call_control_id: controlId, call_session_id: `session-${controlId}`, direction: 'incoming', from, to, state: 'parked' });
  expect(res.status).toBe(200);
  const call: any = await until(() => CallLog.findOne({ providerCallControlId: controlId }).lean(), Boolean);
  return { call, controlId };
}

const claim = (callId: unknown, who: string) =>
  request(app).post(`/api/crm/communications/calls/${callId}/claim`).set('Authorization', `Bearer ${tokens[who]}`);
const ringingFor = async (who: string) =>
  ((await request(app).get('/api/crm/communications/calls/ringing').set('Authorization', `Bearer ${tokens[who]}`)).body.data.items as any[]).map((item) => String(item._id));
const incomingEmits = () => mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:incoming');
const roomsOf = (room: unknown) => (Array.isArray(room) ? room : [room]).map(String);

describe('Real-DB: calls ring the number\'s team, and missed calls notify people (local MongoDB, simulated Telnyx only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network is blocked in this test'));
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
      if (typeof ms === 'number' && ms >= 5_000 && ms <= 35_000) {
        const handle = { p12cRing: true, cleared: false, ref() { return this; }, unref() { return this; }, hasRef: () => false };
        ringTimers.push({ fn, handle, ms });
        return handle as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as any);
    jest.spyOn(global, 'clearTimeout').mockImplementation(((handle: any) => {
      if (handle?.p12cRing) {
        handle.cleared = true;
        return;
      }
      realClearTimeout(handle);
    }) as any);
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), TelephonyCredential.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Twelve C Motors', slug: `p12c-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Motors', slug: `p12c-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.adminUser, name: 'Ada Admin', email: `p12c-admin-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.techUser, name: 'Toni Tech', email: `p12c-tech-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true },
      { _id: ids.repUser, name: 'Remy Rep', email: `p12c-rep-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.adminCrm, organizationId: orgId, fullName: 'Ada Admin', username: `p12c-admin-${orgId}`, email: `p12c-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.techCrm, organizationId: orgId, fullName: 'Toni Tech', username: `p12c-tech-${orgId}`, email: `p12c-tech-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.repCrm, organizationId: orgId, fullName: 'Remy Rep', username: `p12c-rep-${orgId}`, email: `p12c-rep-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await TelephonyCredential.collection.insertMany([
      { userId: ids.techCrm, credentialId: 'cred-tech', sipUsername: 'p12ctech' },
      { userId: ids.repCrm, credentialId: 'cred-rep', sipUsername: 'p12crep' },
    ] as any[]);
    await CrmLeadGroup.collection.insertMany([
      { _id: ids.serviceTeam, organizationId: orgId, name: 'Service Team', isActive: true, memberIds: [ids.techUser, ids.adminUser], createdBy: ids.adminCrm },
      { _id: ids.emptyTeam, organizationId: orgId, name: 'Empty Team', isActive: true, memberIds: [], createdBy: ids.adminCrm },
      { _id: ids.oldTeam, organizationId: orgId, name: 'Old Team', isActive: false, memberIds: [ids.repUser], createdBy: ids.adminCrm },
      { _id: ids.foreignTeam, organizationId: otherOrgId, name: 'Foreign Team', isActive: true, memberIds: [], createdBy: ids.adminCrm },
    ] as any[]);
    for (const who of ['adminCrm', 'techCrm', 'repCrm'] as const) tokens[who] = generateCrmToken(String(ids[who]));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.transferToAgent.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.playMissedAndHangup.mockResolvedValue(undefined);
    mockTelnyx.hangupCall.mockResolvedValue({});
    mockTelnyx.findAccountPhoneNumber.mockResolvedValue(null);
    mockTelnyx.sendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
    mockRoomEmit.mockReset();
    mockNotifyUsers.mockReset().mockResolvedValue(undefined);
    mockNotifyOrgAdmins.mockReset().mockResolvedValue(undefined);
    ringTimers.length = 0;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('an admin can choose which team answers each number; inactive or other dealers\' teams are refused', async () => {
    const admin = (method: 'post' | 'patch', path: string, body: Record<string, unknown>) =>
      request(app)[method](`/api/crm/phone-numbers${path}`).set('Authorization', `Bearer ${tokens.adminCrm}`).send(body);
    const main = await admin('post', '', { number: MAIN, kind: 'main', label: 'Main' });
    expect(main.status).toBe(201);
    expect(main.body.data.ringGroupId).toBeNull();
    numberIds.main = main.body.data._id;
    const service = await admin('post', '', { number: SERVICE, kind: 'department', label: 'Service Department', department: 'Service', ringGroupId: String(ids.serviceTeam) });
    expect(service.status).toBe(201);
    numberIds.service = service.body.data._id;
    expect((await admin('post', '', { number: EMPTY_TEAM_LINE, kind: 'department', label: 'Licensing', department: 'Licensing', ringGroupId: String(ids.oldTeam) })).body.message).toMatch(/active Lead Group/);
    expect((await admin('post', '', { number: EMPTY_TEAM_LINE, kind: 'department', label: 'Licensing', department: 'Licensing', ringGroupId: String(ids.foreignTeam) })).status).toBe(400);
    expect((await admin('post', '', { number: EMPTY_TEAM_LINE, kind: 'department', label: 'Licensing', department: 'Licensing', ringGroupId: 'nope' })).body.message).toMatch(/Choose a team/);
    const licensing = await admin('post', '', { number: EMPTY_TEAM_LINE, kind: 'department', label: 'Licensing', department: 'Licensing', ringGroupId: String(ids.emptyTeam) });
    expect(licensing.status).toBe(201);
    const list = await request(app).get('/api/crm/phone-numbers').set('Authorization', `Bearer ${tokens.adminCrm}`);
    const byLabel = Object.fromEntries(list.body.data.numbers.map((row: any) => [row.label, row]));
    expect(byLabel['Service Department'].ringGroupName).toBe('Service Team');
    expect(byLabel.Main.ringGroupName).toBe('');
    await DealershipPhoneNumber.updateMany({ organizationId: orgId }, { $set: { telnyx: { status: 'ready', readyForCalls: true, readyForTexts: true, message: '', checkedAt: new Date() } } });
  });

  test('a call to the Service number rings only the Service team, in the browser and in the ringing list', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    expect(call.lineLabel).toBe('Service Department');
    expect(call.ringGroupId).toBe(String(ids.serviceTeam));
    expect(call.ringRecipientIds).toEqual(expect.arrayContaining([String(ids.techUser), String(ids.techCrm), String(ids.adminUser), String(ids.adminCrm)]));
    expect(call.ringRecipientIds).not.toContain(String(ids.repCrm));
    const rings = incomingEmits();
    expect(rings).toHaveLength(1);
    const rooms = roomsOf(rings[0][0]);
    expect(rooms).toEqual(expect.arrayContaining([`crm-user:${ids.techCrm}`, `user:${ids.techUser}`]));
    expect(rooms.some((room) => room.includes(String(ids.repCrm)) || room.startsWith('org:'))).toBe(false);
    expect(await ringingFor('techCrm')).toContain(String(call._id));
    expect(await ringingFor('repCrm')).not.toContain(String(call._id));
  });

  test('someone outside the team cannot take the call; a team member can', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    const outsider = await claim(call._id, 'repCrm');
    expect(outsider.status).toBe(403);
    expect(outsider.body.message).toMatch(/another team/);
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('ringing');
    const member = await claim(call._id, 'techCrm');
    expect(member.status).toBe(200);
    expect(mockTelnyx.transferToAgent).toHaveBeenCalledWith(call.providerCallControlId, 'p12ctech', expect.objectContaining({ kind: 'agent-leg' }));
  });

  test('the main number without a team still rings everyone, exactly as before', async () => {
    const { call } = await incoming(nextPhone(), MAIN);
    expect(call.ringRecipientIds).toBeUndefined();
    const rings = incomingEmits();
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toBe(`org:${ORG}:crm-staff`);
    expect(await ringingFor('repCrm')).toContain(String(call._id));
  });

  test('a team with no active members falls back to ringing everyone so the call is never lost', async () => {
    const { call } = await incoming(nextPhone(), EMPTY_TEAM_LINE);
    expect(call.ringRecipientIds).toBeUndefined();
    expect(incomingEmits()[0][0]).toBe(`org:${ORG}:crm-staff`);
  });

  test('when nobody on the team answers: missed call, missed-call message, text back, and the team, the lead\'s rep and admins are notified', async () => {
    const from = nextPhone();
    const { call, controlId } = await incoming(from, SERVICE);
    await Lead.updateOne({ _id: call.leadId }, { $set: { assignedTo: ids.repUser } });
    expect(ringTimers).toHaveLength(1);
    await ringTimers[0].fn();
    const missed: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'missed');
    expect(missed.status).toBe('missed');
    expect(mockTelnyx.playMissedAndHangup.mock.calls.filter(([id]) => id === controlId)).toHaveLength(1);
    await until(async () => mockTelnyx.sendSms.mock.calls.length, (count) => count > 0);
    expect(mockTelnyx.sendSms.mock.calls[0][0]).toBe(from);
    expect(mockTelnyx.sendSms.mock.calls[0][2]).toBe(SERVICE);
    await until(async () => mockNotifyOrgAdmins.mock.calls.length, (count) => count > 0);
    const [userIds, notifyOrg, type, title, message, metadata] = mockNotifyUsers.mock.calls[0];
    expect(new Set(userIds)).toEqual(new Set([String(ids.techUser), String(ids.techCrm), String(ids.repUser), String(ids.repCrm)]));
    expect(notifyOrg).toBe(ORG);
    expect(type).toBe('missed_call');
    expect(title).toBe('Missed call');
    expect(message).toMatch(/^Missed call from \(801\) 555-\d{4} to Service Department\./);
    expect(metadata).toMatchObject({ callId: String(call._id), leadId: String(call.leadId), route: `/crm/leads?leadId=${call.leadId}` });
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith(ORG, 'missed_call', 'Missed call', message, expect.objectContaining({ callId: String(call._id) }));
  });

  test('a missed call to the main number notifies the admins', async () => {
    const { call } = await incoming(nextPhone(), MAIN);
    await ringTimers[0].fn();
    await until(async () => mockNotifyOrgAdmins.mock.calls.length, (count) => count > 0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins.mock.calls[0][3]).toMatch(/to Main\./);
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('missed');
  });
});
