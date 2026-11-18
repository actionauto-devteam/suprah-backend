const mockTelnyx = {
  transferToAgent: jest.fn(),
  playMissedAndHangup: jest.fn(),
  hangupCall: jest.fn(),
  answerCall: jest.fn(),
  speak: jest.fn(),
  speakIvr: jest.fn(),
  gatherIvr: jest.fn(),
  playHoldMusic: jest.fn(),
  stopPlayback: jest.fn(),
  sendSms: jest.fn(),
  findAccountPhoneNumber: jest.fn(),
  dialPhone: jest.fn(),
  gatherDigit: jest.fn(),
  speakFinal: jest.fn(),
  bridgeCalls: jest.fn(),
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
    ...Object.fromEntries((Object.keys(mockTelnyx) as Array<keyof typeof mockTelnyx>).map((name) => [name, forward(name)])),
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
import UnifiedPushService from '../src/services/unifiedPush.service';
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
const MENU = '+18015550900';
const LEHI = '+18015550931';
const OREM = '+18015550932';
const SERVICE = '+18015550933';
const SANDY = '+18015550934';
const people = ['admin', 'lehi', 'orem', 'tech', 'mary', 'beth'] as const;
const ids: Record<string, mongoose.Types.ObjectId> = {
  lehiTeam: new mongoose.Types.ObjectId(),
  oremTeam: new mongoose.Types.ObjectId(),
  serviceTeam: new mongoose.Types.ObjectId(),
  prospects: new mongoose.Types.ObjectId(),
  reception: new mongoose.Types.ObjectId(),
  oldTeam: new mongoose.Types.ObjectId(),
  foreignTeam: new mongoose.Types.ObjectId(),
};
for (const who of people) {
  ids[`${who}User`] = new mongoose.Types.ObjectId();
  ids[`${who}Crm`] = new mongoose.Types.ObjectId();
}
const id = (key: string) => String(ids[key]);
const both = (who: string) => [id(`${who}User`), id(`${who}Crm`)];
const tokens: Record<string, string> = {};
const numberIds: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(6700 + (++serial)).slice(-4)}`;
const nextControlId = () => `v3:p67-${Date.now()}-${++serial}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ringTimers: Array<{ fn: () => Promise<void>; handle: { cleared: boolean }; ms: number }> = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };
const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64');

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p67-${Date.now()}-${++serial}`, event_type: eventType, payload } });
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

async function pressMenu(digit: string) {
  const { call, controlId } = await incoming(nextPhone(), MENU);
  await webhook('call.answered', { call_control_id: controlId, client_state: encode({ kind: 'ivr-customer', callLogId: String(call._id) }) });
  const menuCall: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.routing?.stage === 'menu');
  mockRoomEmit.mockReset();
  await webhook('call.gather.ended', { call_control_id: controlId, client_state: encode({ kind: 'ivr-menu', callLogId: String(call._id), revision: menuCall.routing.revision }), digits: digit, status: 'valid' });
  return { call, controlId };
}

const stageOf = (callId: unknown, stage: string) => until(() => CallLog.findById(callId).lean(), (row: any) => row?.routing?.stage === stage) as Promise<any>;
const runRingTimer = async () => {
  const timer = ringTimers.filter((item) => !item.handle.cleared).pop();
  expect(timer).toBeDefined();
  timer!.handle.cleared = true;
  await timer!.fn();
};
const admin = (method: 'get' | 'post' | 'put', path: string, body?: Record<string, unknown>, who = 'adminCrm') => {
  const call = request(app)[method](`/api/crm/phone-numbers${path}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? call.send(body) : call;
};
const claim = (callId: unknown, who: string) =>
  request(app).post(`/api/crm/communications/calls/${callId}/claim`).set('Authorization', `Bearer ${tokens[who]}`);
const ringingFor = async (who: string) =>
  ((await request(app).get('/api/crm/communications/calls/ringing').set('Authorization', `Bearer ${tokens[who]}`)).body.data.items as any[]).map((item) => String(item._id));
const incomingRooms = () => mockRoomEmit.mock.calls
  .filter(([, event]) => event === 'comm:call:incoming')
  .flatMap(([room]) => (Array.isArray(room) ? room : [room]).map(String));
const pushesFor = (callId: unknown) => until(async () => (UnifiedPushService.sendToUser as jest.Mock).mock.calls
  .filter(([, payload]: any[]) => payload?.tag === `incoming-call-${callId}`), (rows: any[]) => rows.length >= 2);
const missedNotice = () => until<any[] | undefined>(async () => mockNotifyUsers.mock.calls.find((args: any[]) => args[2] === 'missed_call'), Boolean);

describe('Real-DB: sales calls for all locations also ring one chosen department (local MongoDB, simulated Telnyx only)', () => {
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
        const handle = { p67Ring: true, cleared: false, ref() { return this; }, unref() { return this; }, hasRef: () => false };
        ringTimers.push({ fn, handle, ms });
        return handle as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as any);
    jest.spyOn(global, 'clearTimeout').mockImplementation(((handle: any) => {
      if (handle?.p67Ring) {
        handle.cleared = true;
        return;
      }
      realClearTimeout(handle);
    }) as any);
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), TelephonyCredential.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Sixty Seven Motors', slug: `p67-${orgId}`, status: 'active', metadata: { reviewLink: 'keep-me' } },
      { _id: otherOrgId, name: 'Other Motors', slug: `p67-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    const names: Record<string, string> = { admin: 'Ada Admin', lehi: 'Leo Lehi', orem: 'Opal Orem', tech: 'Toni Tech', mary: 'Mary Prospect', beth: 'Beth Prospect' };
    await User.collection.insertMany(people.map((who) => ({
      _id: ids[`${who}User`], name: names[who], email: `p67-${who}-${orgId}@example.com`, password: 'x',
      role: who === 'admin' ? 'admin' : 'employee', organizationId: orgId, isActive: true,
    })) as any[]);
    await CrmUser.collection.insertMany(people.map((who) => ({
      _id: ids[`${who}Crm`], organizationId: orgId, fullName: names[who], username: `p67-${who}-${orgId}`,
      email: `p67-${who}-${orgId}@example.com`, role: who === 'admin' ? 'admin' : 'employee', isActive: true, password: 'x',
    })) as any[]);
    await TelephonyCredential.collection.insertMany(['lehi', 'orem', 'mary'].map((who) => ({
      userId: ids[`${who}Crm`], credentialId: `cred-${who}`, sipUsername: `p67${who}`,
    })) as any[]);
    const team = (key: string, name: string, memberIds: mongoose.Types.ObjectId[], extra: Record<string, unknown> = {}) =>
      ({ _id: ids[key], organizationId: orgId, name, isActive: true, memberIds, createdBy: ids.adminCrm, ...extra });
    await CrmLeadGroup.collection.insertMany([
      team('lehiTeam', 'Lehi Sales Team', [ids.lehiUser]),
      team('oremTeam', 'Orem Sales Team', [ids.oremUser]),
      team('serviceTeam', 'Service', [ids.techUser]),
      team('prospects', 'Prospects Team', [ids.maryUser, ids.bethUser]),
      team('reception', 'Reception', [ids.adminUser]),
      team('oldTeam', 'Old Team', [ids.maryUser], { isActive: false }),
      team('foreignTeam', 'Foreign Team', [], { organizationId: otherOrgId }),
    ] as any[]);
    for (const who of people) tokens[`${who}Crm`] = generateCrmToken(id(`${who}Crm`));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset().mockResolvedValue({}));
    mockTelnyx.transferToAgent.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.findAccountPhoneNumber.mockResolvedValue(null);
    mockTelnyx.sendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
    (UnifiedPushService.sendToUser as jest.Mock).mockClear();
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

  test('an admin picks the department for every location\'s sales calls; bad choices and non-admins are refused', async () => {
    const create = async (key: string, body: Record<string, unknown>) => {
      const res = await admin('post', '', body);
      expect(res.status).toBe(201);
      numberIds[key] = res.body.data._id;
    };
    await create('menu', { number: MENU, kind: 'main', label: 'Main' });
    await create('lehi', { number: LEHI, kind: 'location', label: 'Lehi Sales', location: 'Lehi', ringGroupId: id('lehiTeam') });
    await create('orem', { number: OREM, kind: 'location', label: 'Orem Sales', location: 'Orem', ringGroupId: id('oremTeam') });
    await create('service', { number: SERVICE, kind: 'department', label: 'Service', department: 'Service', ringGroupId: id('serviceTeam') });
    await create('sandy', { number: SANDY, kind: 'location', label: 'Sandy Sales', location: 'Sandy' });

    const before = (await admin('get', '')).body.data.allLocations;
    expect(before).toMatchObject({ groupId: null, groupName: '', groupActive: false });
    expect(before.appliesTo.map((line: any) => `${line.type}:${line.label}`)).toEqual(['number:Lehi Sales', 'number:Orem Sales']);

    expect((await admin('put', '/all-locations', { groupId: id('oldTeam') })).body.message).toMatch(/active Lead Group/);
    expect((await admin('put', '/all-locations', { groupId: id('foreignTeam') })).status).toBe(400);
    expect((await admin('put', '/all-locations', { groupId: 'nope' })).body.message).toMatch(/Choose a department/);
    expect((await admin('put', '/all-locations', { groupId: id('prospects') }, 'lehiCrm')).status).toBe(403);
    expect(((await Organization.findById(orgId).lean()) as any).metadata.allLocationsRingGroupId).toBeUndefined();

    const savedSetting = await admin('put', '/all-locations', { groupId: id('prospects') });
    expect(savedSetting.status).toBe(200);
    expect(savedSetting.body.data).toMatchObject({ groupId: id('prospects'), groupName: 'Prospects Team', groupActive: true });
    const org: any = await Organization.findById(orgId).lean();
    expect(org.metadata).toMatchObject({ reviewLink: 'keep-me', allLocationsRingGroupId: id('prospects') });
    expect(((await Organization.findById(otherOrgId).lean()) as any).metadata.allLocationsRingGroupId).toBeUndefined();
  });

  test('a call to the Lehi number rings the Lehi team and the all-locations department together', async () => {
    const { call } = await incoming(nextPhone(), LEHI);
    expect(call.ringGroupId).toBe(id('lehiTeam'));
    expect(call.extraRingGroupId).toBe(id('prospects'));
    expect(new Set(call.ringRecipientIds)).toEqual(new Set([...both('lehi'), ...both('mary'), ...both('beth')]));
    const rooms = incomingRooms();
    expect(rooms).toEqual(expect.arrayContaining([`crm-user:${id('lehiCrm')}`, `crm-user:${id('maryCrm')}`, `user:${id('bethUser')}`]));
    expect(rooms.some((room) => room.includes(id('oremCrm')) || room.includes(id('techCrm')) || room.startsWith('org:'))).toBe(false);
    expect(await ringingFor('maryCrm')).toContain(String(call._id));
    expect(await ringingFor('oremCrm')).not.toContain(String(call._id));
    const pushed = await pushesFor(call._id);
    expect(pushed.map(([userId]: any[]) => String(userId))).toEqual(expect.arrayContaining([id('maryCrm'), id('lehiCrm')]));
    expect(pushed[0][1].body).toContain('Calling Lehi Sales');
  });

  test('the same people ring for the Orem number, and the Lehi team does not', async () => {
    const { call } = await incoming(nextPhone(), OREM);
    expect(new Set(call.ringRecipientIds)).toEqual(new Set([...both('orem'), ...both('mary'), ...both('beth')]));
    expect(await ringingFor('bethCrm')).toContain(String(call._id));
    expect(await ringingFor('lehiCrm')).not.toContain(String(call._id));
  });

  test('a department number and a location that rings everyone are unchanged', async () => {
    const service = (await incoming(nextPhone(), SERVICE)).call;
    expect(new Set(service.ringRecipientIds)).toEqual(new Set(both('tech')));
    expect(service.extraRingGroupId).toBeNull();
    expect(await ringingFor('maryCrm')).not.toContain(String(service._id));
    mockRoomEmit.mockReset();
    const sandy = (await incoming(nextPhone(), SANDY)).call;
    expect(sandy.ringRecipientIds).toBeUndefined();
    expect(sandy.extraRingGroupId).toBeNull();
    expect(incomingRooms()).toEqual([`org:${ORG}:crm-staff`]);
  });

  test('someone from the all-locations department can take a Lehi call; someone from the Orem team cannot', async () => {
    const { call } = await incoming(nextPhone(), LEHI);
    const outsider = await claim(call._id, 'oremCrm');
    expect(outsider.status).toBe(403);
    expect(((await CallLog.findById(call._id).lean()) as any).status).toBe('ringing');
    const mary = await claim(call._id, 'maryCrm');
    expect(mary.status).toBe(200);
    expect(mockTelnyx.transferToAgent).toHaveBeenCalledWith(call.providerCallControlId, 'p67mary', expect.objectContaining({ kind: 'agent-leg' }));
  });

  test('a missed Lehi call tells the Lehi team and the all-locations department when the lead has no rep', async () => {
    const { call } = await incoming(nextPhone(), LEHI);
    await runRingTimer();
    const notice = await missedNotice();
    expect(new Set(notice![0])).toEqual(new Set([id('lehiCrm'), id('maryCrm'), id('bethCrm')]));
    expect(notice![4]).toMatch(/ to Lehi Sales\./);
    expect(notice![5]).toMatchObject({ callId: String(call._id) });
    expect(mockNotifyOrgAdmins.mock.calls.some((args: any[]) => args[1] === 'missed_call')).toBe(false);
  });

  test('a missed Lehi call on a lead that has a rep tells only the rep', async () => {
    const { call } = await incoming(nextPhone(), LEHI);
    await Lead.updateOne({ _id: call.leadId }, { $set: { assignedTo: ids.oremUser } });
    await runRingTimer();
    const notice = await missedNotice();
    expect(notice![0]).toEqual([id('oremCrm')]);
  });

  test('someone in both departments rings once, and a removed department never stops the location\'s own team', async () => {
    await CrmLeadGroup.updateOne({ _id: ids.lehiTeam }, { $addToSet: { memberIds: ids.maryUser } });
    const doubled = (await incoming(nextPhone(), LEHI)).call;
    expect(doubled.ringRecipientIds).toHaveLength(new Set(doubled.ringRecipientIds).size);
    expect(new Set(doubled.ringRecipientIds)).toEqual(new Set([...both('lehi'), ...both('mary'), ...both('beth')]));
    await CrmLeadGroup.updateOne({ _id: ids.lehiTeam }, { $pull: { memberIds: ids.maryUser } });

    await CrmLeadGroup.updateOne({ _id: ids.prospects }, { $set: { isActive: false } });
    const alone = (await incoming(nextPhone(), LEHI)).call;
    expect(new Set(alone.ringRecipientIds)).toEqual(new Set(both('lehi')));
    expect(alone.extraRingGroupId).toBeNull();
    const listed = (await admin('get', '')).body.data.allLocations;
    expect(listed).toMatchObject({ groupId: id('prospects'), groupName: '', groupActive: false });
    await CrmLeadGroup.updateOne({ _id: ids.prospects }, { $set: { isActive: true } });

    await CrmLeadGroup.updateOne({ _id: ids.prospects }, { $set: { memberIds: [] } });
    const empty = (await incoming(nextPhone(), LEHI)).call;
    expect(new Set(empty.ringRecipientIds)).toEqual(new Set(both('lehi')));
    await CrmLeadGroup.updateOne({ _id: ids.prospects }, { $set: { memberIds: [ids.maryUser, ids.bethUser] } });
  });

  test('through the Phone Menu, a store key also rings them; a department key does not', async () => {
    const option = { groupId: null, leadLocation: '', language: '', externalDestination: '' };
    const menu = await request(app).post('/api/crm/communications/ivr-configs').set('Authorization', `Bearer ${tokens.adminCrm}`).send({
      enabled: true, name: 'Main Menu', inboundNumber: MENU, mainNumber: MENU, greeting: 'Press 1 for Lehi. Press 2 for Orem. Press 3 for Service.',
      ringTimeoutSeconds: 30, retryCount: 0, receptionGroupId: id('reception'), allOrgFallback: false,
      options: [
        { ...option, digit: '1', label: 'Lehi', type: 'location', groupId: id('lehiTeam'), leadLocation: 'Lehi' },
        { ...option, digit: '2', label: 'Orem', type: 'number', phoneNumberId: numberIds.orem },
        { ...option, digit: '3', label: 'Service', type: 'department', groupId: id('serviceTeam') },
      ],
    });
    expect(menu.status).toBe(200);
    const listed = (await admin('get', '')).body.data.allLocations;
    expect(listed.appliesTo.map((line: any) => `${line.type}:${line.label}${line.digit ? `:${line.digit}` : ''}`))
      .toEqual(['number:Lehi Sales', 'number:Orem Sales', 'menu:Lehi:1', 'menu:Orem:2']);
    expect(listed.appliesTo[2]).toMatchObject({ menu: 'Main Menu' });

    const lehi = await pressMenu('1');
    const lehiRouted = await stageOf(lehi.call._id, 'selected');
    expect(lehiRouted.extraRingGroupId).toBe(id('prospects'));
    expect(lehiRouted.routing.targetGroupId).toBe(id('lehiTeam'));
    expect(new Set(lehiRouted.routing.recipientIds)).toEqual(new Set([...both('lehi'), ...both('mary'), ...both('beth')]));
    expect(await ringingFor('maryCrm')).toContain(String(lehi.call._id));
    const pushed = await pushesFor(lehi.call._id);
    expect(pushed[0][1].body).toContain('Calling Main, Lehi');
    expect((await claim(lehi.call._id, 'maryCrm')).status).toBe(200);

    const orem = await pressMenu('2');
    const oremRouted = await stageOf(orem.call._id, 'selected');
    expect(new Set(oremRouted.routing.recipientIds)).toEqual(new Set([...both('orem'), ...both('mary'), ...both('beth')]));
    expect(oremRouted.lineLabel).toBe('Orem Sales');

    const service = await pressMenu('3');
    const serviceRouted = await stageOf(service.call._id, 'selected');
    expect(new Set(serviceRouted.routing.recipientIds)).toEqual(new Set(both('tech')));
    expect(serviceRouted.extraRingGroupId).toBeNull();
    expect(await ringingFor('maryCrm')).not.toContain(String(service.call._id));
    expect((await claim(service.call._id, 'maryCrm')).status).toBe(403);
  });

  test('when the store team and the all-locations department do not answer, Reception rings alone and the missed-call notice still includes them', async () => {
    const { call } = await pressMenu('1');
    await stageOf(call._id, 'selected');
    await runRingTimer();
    const reception = await stageOf(call._id, 'reception');
    expect(new Set(reception.routing.recipientIds)).toEqual(new Set(both('admin')));
    expect(await ringingFor('maryCrm')).not.toContain(String(call._id));
    expect((await claim(call._id, 'maryCrm')).status).toBe(403);
    await runRingTimer();
    const missed: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'missed');
    expect(missed.status).toBe('missed');
    const notice = await missedNotice();
    expect(new Set(notice![0])).toEqual(new Set([id('adminCrm'), id('maryCrm'), id('bethCrm')]));
    expect(notice![4]).toMatch(/ to Main, Lehi\./);
  });
});
