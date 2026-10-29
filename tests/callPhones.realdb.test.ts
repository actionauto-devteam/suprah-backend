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
  dialPhone: jest.fn(),
  gatherDigit: jest.fn(),
  speakFinal: jest.fn(),
  bridgeCalls: jest.fn(),
};
const mockRoomEmit = jest.fn();

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
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
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
import StaffCallPhone from '../src/models/StaffCallPhone.model';
import CallRoutingConfig, { IvrInboundClaim } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, TelephonyCredential } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import communicationRoutes from '../src/routes/communication.routes';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use('/api/crm/communications', communicationRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const MAIN = '+18015550900';
const SERVICE = '+18015550912';
const MENU = '+18015550915';
const LEHI = '+18015550910';
const OREM = '+18015550920';
const PHONES = { tech: '+13855550161', mate: '+13855550162', rep: '+13855550163', admin: '+13855550164', gone: '+13855550165' };
const ids = {
  adminUser: new mongoose.Types.ObjectId(), adminCrm: new mongoose.Types.ObjectId(),
  techUser: new mongoose.Types.ObjectId(), techCrm: new mongoose.Types.ObjectId(),
  mateUser: new mongoose.Types.ObjectId(), mateCrm: new mongoose.Types.ObjectId(),
  repUser: new mongoose.Types.ObjectId(), repCrm: new mongoose.Types.ObjectId(),
  goneCrm: new mongoose.Types.ObjectId(),
  serviceTeam: new mongoose.Types.ObjectId(),
  lehiTeam: new mongoose.Types.ObjectId(),
  lehiNumber: new mongoose.Types.ObjectId(),
  oremNumber: new mongoose.Types.ObjectId(),
  foreignNumber: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(7900 + (++serial)).slice(-4)}`;
const nextControlId = () => `v3:p12c3-${Date.now()}-${++serial}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ringTimers: Array<{ fn: () => Promise<void>; handle: { cleared: boolean }; ms: number }> = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };
const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64');
const ready = { status: 'ready', readyForCalls: true, readyForTexts: true, message: '', checkedAt: new Date() };

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p12c3-${Date.now()}-${++serial}`, event_type: eventType, payload } });
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
  return { call, controlId, sessionId: `session-${controlId}` };
}

const dialsFor = (callId: unknown) => mockTelnyx.dialPhone.mock.calls.map(([opts]) => opts).filter((opts: any) => opts.clientState.callLogId === String(callId));
const legsOf = async (callId: unknown) => ((await CallLog.findById(callId).lean() as any)?.phoneLegs || []) as any[];
const legFor = async (callId: unknown, phone: string) => (await until(() => legsOf(callId), (legs) => legs.some((leg) => leg.phone === phone))).find((leg) => leg.phone === phone);

async function answerLeg(callId: unknown, phone: string) {
  const leg = await legFor(callId, phone);
  const dial: any = dialsFor(callId).find((opts: any) => opts.to === phone);
  await webhook('call.answered', { call_control_id: leg.callControlId, call_session_id: `leg-${leg.callControlId}`, client_state: encode(dial.clientState) });
  const prompt = (await until(async () => mockTelnyx.gatherDigit.mock.calls.find(([id]) => id === leg.callControlId), Boolean)) as any[] | undefined;
  return { leg: leg.callControlId as string, prompt: prompt?.[1] as string, acceptState: prompt?.[2] as Record<string, unknown> };
}

const press = (leg: string, acceptState: Record<string, unknown>, digits = '1') =>
  webhook('call.gather.ended', { call_control_id: leg, client_state: encode(acceptState), digits, status: 'valid' });

describe('Real-DB: customer calls also ring employees\' confirmed phones; first to press 1 wins (local MongoDB, simulated Telnyx only)', () => {
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
        const handle = { p12c3Ring: true, cleared: false, ref() { return this; }, unref() { return this; }, hasRef: () => false };
        ringTimers.push({ fn, handle, ms });
        return handle as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as any);
    jest.spyOn(global, 'clearTimeout').mockImplementation(((handle: any) => {
      if (handle?.p12c3Ring) {
        handle.cleared = true;
        return;
      }
      realClearTimeout(handle);
    }) as any);
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), TelephonyCredential.init(), DealershipPhoneNumber.init(), StaffCallPhone.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Twelve C Phones', slug: `p12c3-${orgId}`, status: 'active', metadata: {} } as any);
    const userRow = (id: any, name: string, key: string, role = 'employee') => ({ _id: id, name, email: `p12c3-${key}-${orgId}@example.com`, password: 'x', role, organizationRole: role === 'admin' ? 'admin' : 'member', organizationId: orgId, isActive: true });
    const crmRow = (id: any, name: string, key: string, role = 'employee', extra: Record<string, unknown> = {}) => ({ _id: id, organizationId: orgId, fullName: name, username: `p12c3-${key}-${orgId}`, email: `p12c3-${key}-${orgId}@example.com`, role, isActive: true, password: 'x', ...extra });
    await User.collection.insertMany([
      userRow(ids.adminUser, 'Ada Admin', 'admin', 'admin'), userRow(ids.techUser, 'Toni Tech', 'tech'),
      userRow(ids.mateUser, 'Mo Mate', 'mate'), userRow(ids.repUser, 'Remy Rep', 'rep'),
    ] as any[]);
    await CrmUser.collection.insertMany([
      crmRow(ids.adminCrm, 'Ada Admin', 'admin', 'admin'), crmRow(ids.techCrm, 'Toni Tech', 'tech'), crmRow(ids.mateCrm, 'Mo Mate', 'mate'),
      crmRow(ids.repCrm, 'Remy Rep', 'rep'), crmRow(ids.goneCrm, 'Gwen Gone', 'gone', 'employee', { isActive: false }),
    ] as any[]);
    await TelephonyCredential.collection.insertMany([
      { userId: ids.techCrm, credentialId: 'cred-tech', sipUsername: 'p12c3tech' },
      { userId: ids.repCrm, credentialId: 'cred-rep', sipUsername: 'p12c3rep' },
    ] as any[]);
    await CrmLeadGroup.collection.insertMany([
      { _id: ids.serviceTeam, organizationId: orgId, name: 'Service Team', isActive: true, memberIds: [ids.techUser, ids.mateUser], createdBy: ids.adminCrm },
      { _id: ids.lehiTeam, organizationId: orgId, name: 'Lehi Team', isActive: true, memberIds: [ids.repUser], createdBy: ids.adminCrm },
    ] as any[]);
    await DealershipPhoneNumber.create([
      { organizationId: orgId, number: MAIN, label: 'Main', kind: 'main', telnyx: ready, createdBy: ids.adminCrm, updatedBy: ids.adminCrm },
      { organizationId: orgId, number: SERVICE, label: 'Service Department', kind: 'department', department: 'Service', ringGroupId: ids.serviceTeam, telnyx: ready, createdBy: ids.adminCrm, updatedBy: ids.adminCrm },
      { _id: ids.lehiNumber, organizationId: orgId, number: LEHI, label: 'Lehi Sales', kind: 'location', location: 'LEHI', ringGroupId: ids.lehiTeam, telnyx: ready, createdBy: ids.adminCrm, updatedBy: ids.adminCrm },
      { _id: ids.oremNumber, organizationId: orgId, number: OREM, label: 'Orem Sales', kind: 'location', location: 'OREM', ringGroupId: null, telnyx: ready, createdBy: ids.adminCrm, updatedBy: ids.adminCrm },
      { _id: ids.foreignNumber, organizationId: new mongoose.Types.ObjectId(), number: '+18015550999', label: 'Elsewhere', kind: 'main', telnyx: ready, createdBy: ids.adminCrm, updatedBy: ids.adminCrm },
    ]);
    await CallRoutingConfig.collection.insertOne({
      organizationId: orgId, enabled: true, name: 'Main menu', inboundNumber: MENU, mainNumber: MENU, greeting: 'Press 1 for service.',
      ringTimeoutSeconds: 30, retryCount: 0, receptionGroupId: String(ids.serviceTeam), allOrgFallback: false,
      options: [
        { digit: '1', label: 'Service', type: 'department', groupId: String(ids.serviceTeam), leadLocation: '', language: '', externalDestination: '', phoneNumberId: null },
        { digit: '2', label: 'Lehi', type: 'number', groupId: null, leadLocation: '', language: '', externalDestination: '', phoneNumberId: String(ids.lehiNumber) },
        { digit: '3', label: 'Orem', type: 'number', groupId: null, leadLocation: '', language: '', externalDestination: '', phoneNumberId: String(ids.oremNumber) },
      ],
      updatedBy: ids.adminCrm,
    } as any);
    const verifiedAt = new Date();
    await StaffCallPhone.collection.insertMany([
      { organizationId: orgId, userId: String(ids.techCrm), phone: PHONES.tech, enabled: true, verifiedAt },
      { organizationId: orgId, userId: String(ids.mateCrm), phone: PHONES.mate, enabled: true, verifiedAt },
      { organizationId: orgId, userId: String(ids.repCrm), phone: PHONES.rep, enabled: true, verifiedAt },
      { organizationId: orgId, userId: String(ids.adminCrm), phone: PHONES.admin, enabled: true, verifiedAt: null },
      { organizationId: orgId, userId: String(ids.goneCrm), phone: PHONES.gone, enabled: true, verifiedAt },
    ] as any[]);
    for (const who of ['adminCrm', 'techCrm', 'repCrm'] as const) tokens[who] = generateCrmToken(String(ids[who]));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.transferToAgent.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.playMissedAndHangup.mockResolvedValue(undefined);
    mockTelnyx.hangupCall.mockResolvedValue({});
    mockTelnyx.answerCall.mockResolvedValue({});
    mockTelnyx.gatherIvr.mockResolvedValue({});
    mockTelnyx.speakIvr.mockResolvedValue({});
    mockTelnyx.findAccountPhoneNumber.mockResolvedValue(null);
    mockTelnyx.dialPhone.mockImplementation(async (opts: any) => ({ callControlId: `v3:leg-${opts.to}-${++serial}` }));
    mockTelnyx.gatherDigit.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.speakFinal.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.bridgeCalls.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.sendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
    mockRoomEmit.mockReset();
    ringTimers.length = 0;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('a call to the Service number rings only the Service team\'s confirmed phones, from the Service number', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    await wait(150);
    const dials: any[] = dialsFor(call._id);
    expect(dials.map((opts) => opts.to).sort()).toEqual([PHONES.tech, PHONES.mate].sort());
    expect(dials.every((opts) => opts.from === SERVICE && opts.clientState.kind === 'phone-leg')).toBe(true);
    expect(dials[0].timeoutSecs).toBeGreaterThanOrEqual(30);
    const legs = await until(() => legsOf(call._id), (rows) => rows.length === 2);
    expect(legs.every((leg) => leg.state === 'dialing')).toBe(true);
  });

  test('the employee hears who is calling; pressing 1 connects them to the customer and stops every other phone and pop-up', async () => {
    const from = nextPhone();
    const { call, controlId } = await incoming(from, SERVICE);
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    const { leg, prompt, acceptState } = await answerLeg(call._id, PHONES.tech);
    expect(prompt).toMatch(/^Call for Service Department from .+\. Press 1 to take the call\.$/);
    expect(acceptState).toMatchObject({ kind: 'phone-accept', callLogId: String(call._id), userId: String(ids.techCrm) });
    mockRoomEmit.mockReset();
    await press(leg, acceptState);
    const live: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'in-progress');
    expect(live).toMatchObject({ status: 'in-progress', answeredVia: 'phone', agentLegCallControlId: leg });
    expect(live.answeredBy).toMatchObject({ userId: String(ids.techCrm), name: 'Toni Tech' });
    expect(mockTelnyx.answerCall).toHaveBeenCalledWith(controlId);
    expect(mockTelnyx.bridgeCalls).toHaveBeenCalledWith(controlId, leg);
    const mateLeg = await legFor(call._id, PHONES.mate);
    expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(mateLeg.callControlId);
    expect(mockTelnyx.hangupCall).not.toHaveBeenCalledWith(leg);
    const updates = mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:update');
    expect(updates.some(([, , data]: any) => data.call.status === 'answering' && data.call.answeredVia === 'phone')).toBe(true);
    expect(ringTimers[0].handle.cleared).toBe(true);
  });

  test('when two phones press 1, only the first gets the call; the second hears it was already answered', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    const first = await answerLeg(call._id, PHONES.tech);
    const second = await answerLeg(call._id, PHONES.mate);
    await Promise.all([press(first.leg, first.acceptState), press(second.leg, second.acceptState)]);
    const live: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'in-progress');
    const winner = live.agentLegCallControlId;
    const loser = winner === first.leg ? second.leg : first.leg;
    expect([first.leg, second.leg]).toContain(winner);
    expect(mockTelnyx.bridgeCalls).toHaveBeenCalledTimes(1);
    await until(async () => mockTelnyx.speakFinal.mock.calls.length, (count) => count === 1);
    expect(mockTelnyx.speakFinal).toHaveBeenCalledWith(loser, expect.stringMatching(/already answered/));
  });

  test('answering in the browser first stops the phones from ringing', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    await until(() => legsOf(call._id), (legs) => legs.length === 2);
    const res = await request(app).post(`/api/crm/communications/calls/${call._id}/claim`).set('Authorization', `Bearer ${tokens.techCrm}`);
    expect(res.status).toBe(200);
    const legs = await until(() => legsOf(call._id), (rows) => rows.every((leg) => leg.state === 'ended'));
    expect(legs.every((leg) => leg.state === 'ended')).toBe(true);
    for (const leg of legs) expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(leg.callControlId);
    const { leg, acceptState } = { leg: legs[0].callControlId, acceptState: { kind: 'phone-accept', callLogId: String(call._id), userId: String(ids.techCrm) } };
    await press(leg, acceptState);
    await wait(200);
    expect(mockTelnyx.bridgeCalls).not.toHaveBeenCalled();
    expect((await CallLog.findById(call._id).lean() as any).answeredVia).toBeUndefined();
  });

  test('a missed call or a caller who hangs up also stops the phones', async () => {
    const missed = await incoming(nextPhone(), SERVICE);
    await until(() => legsOf(missed.call._id), (legs) => legs.length === 2);
    await ringTimers[0].fn();
    const missedLegs = await until(() => legsOf(missed.call._id), (rows) => rows.every((leg) => leg.state === 'ended'));
    expect(missedLegs.every((leg) => leg.state === 'ended')).toBe(true);
    expect((await CallLog.findById(missed.call._id).lean() as any).status).toBe('missed');
    const gone = await incoming(nextPhone(), SERVICE);
    await until(() => legsOf(gone.call._id), (legs) => legs.length === 2);
    await webhook('call.hangup', { call_control_id: gone.controlId, call_session_id: gone.sessionId, hangup_cause: 'originator_cancel' });
    const canceledLegs = await until(() => legsOf(gone.call._id), (rows) => rows.every((leg) => leg.state === 'ended'));
    expect(canceledLegs.every((leg) => leg.state === 'ended')).toBe(true);
    expect((await CallLog.findById(gone.call._id).lean() as any).status).toBe('canceled');
  });

  test('a wrong key hangs up only that phone; the call keeps ringing for everyone else', async () => {
    const { call } = await incoming(nextPhone(), SERVICE);
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    const { leg, acceptState } = await answerLeg(call._id, PHONES.mate);
    await press(leg, acceptState, '2');
    await until(async () => mockTelnyx.hangupCall.mock.calls.length, (count) => count > 0);
    expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(leg);
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('ringing');
  });

  test('when the employee hangs up their phone, the customer\'s call ends too', async () => {
    const { call, controlId } = await incoming(nextPhone(), SERVICE);
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    const { leg, acceptState } = await answerLeg(call._id, PHONES.tech);
    await press(leg, acceptState);
    await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'in-progress');
    mockTelnyx.hangupCall.mockClear();
    await webhook('call.hangup', { call_control_id: leg, call_session_id: `leg-${leg}`, client_state: encode(acceptState), hangup_cause: 'normal_clearing' });
    await until(async () => mockTelnyx.hangupCall.mock.calls.length, (count) => count > 0);
    expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(controlId);
  });

  test('the main number rings every confirmed phone that is turned on; unconfirmed, inactive and the caller\'s own phone are skipped', async () => {
    const { call } = await incoming(PHONES.rep, MAIN);
    await until(async () => dialsFor(call._id).length, (count) => count >= 2);
    await wait(200);
    expect(dialsFor(call._id).map((opts: any) => opts.to).sort()).toEqual([PHONES.tech, PHONES.mate].sort());
  });

  test('after the phone menu, the chosen team\'s phones ring and pressing 1 connects without answering twice', async () => {
    const { call, controlId } = await incoming(nextPhone(), MENU);
    const menuCall: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.routing?.stage === 'menu');
    await webhook('call.gather.ended', { call_control_id: controlId, client_state: encode({ kind: 'ivr-menu', callLogId: String(call._id), revision: menuCall.routing.revision }), digits: '1', status: 'valid' });
    await until(async () => dialsFor(call._id).length, (count) => count === 2);
    mockTelnyx.answerCall.mockClear();
    const { leg, acceptState } = await answerLeg(call._id, PHONES.tech);
    expect(typeof acceptState.revision).toBe('number');
    await press(leg, acceptState);
    const live: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.status === 'in-progress');
    expect(live.answeredVia).toBe('phone');
    expect(mockTelnyx.answerCall).not.toHaveBeenCalled();
    expect(mockTelnyx.bridgeCalls).toHaveBeenCalledWith(controlId, leg);
  });

  async function pressMenu(digit: string) {
    const from = nextPhone();
    const { call, controlId } = await incoming(from, MENU);
    const menuCall: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.routing?.stage === 'menu');
    mockRoomEmit.mockReset();
    await webhook('call.gather.ended', { call_control_id: controlId, client_state: encode({ kind: 'ivr-menu', callLogId: String(call._id), revision: menuCall.routing.revision }), digits: digit, status: 'valid' });
    return { call, controlId, from };
  }

  test('12D: menu options can send callers to a dealership number; a missing or other dealership number is refused', async () => {
    const save = (options: unknown[]) => request(app).post('/api/crm/communications/ivr-configs').set('Authorization', `Bearer ${tokens.adminCrm}`).send({
      enabled: true, name: 'Second menu', inboundNumber: '+18015550916', mainNumber: '+18015550916', greeting: 'Press 1 for Lehi.',
      ringTimeoutSeconds: 35, retryCount: 1, receptionGroupId: String(ids.serviceTeam), allOrgFallback: false, options,
    });
    const base = { digit: '1', label: 'Lehi', type: 'number', groupId: null, leadLocation: '', language: '', externalDestination: '' };
    expect((await save([{ ...base, phoneNumberId: null }])).body.message).toMatch(/Choose the dealership number for option 1/);
    expect((await save([{ ...base, phoneNumberId: String(ids.foreignNumber) }])).body.message).toMatch(/this dealership's phone numbers/);
    const ok = await save([{ ...base, phoneNumberId: String(ids.lehiNumber) }]);
    expect(ok.status).toBe(200);
    expect(ok.body.data.options[0]).toMatchObject({ type: 'number', phoneNumberId: String(ids.lehiNumber), groupId: null });
  });

  test('12D: pressing 2 sends the caller to Lehi Sales: the Lehi team rings, the lead is tagged LEHI and the pop-up says Lehi Sales', async () => {
    const { call } = await pressMenu('2');
    const routed: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.routing?.stage === 'selected');
    expect(routed.lineLabel).toBe('Lehi Sales');
    expect(routed.routing.targetGroupId).toBe(String(ids.lehiTeam));
    expect(routed.routing.recipientIds).toEqual(expect.arrayContaining([String(ids.repUser), String(ids.repCrm)]));
    expect(routed.routing.recipientIds).not.toContain(String(ids.techCrm));
    const lead: any = await until(() => Lead.findById(call.leadId).lean(), (row: any) => row?.location === 'LEHI');
    expect(lead.location).toBe('LEHI');
    await until(async () => dialsFor(call._id).length, (count) => count === 1);
    expect(dialsFor(call._id).map((opts: any) => opts.to)).toEqual([PHONES.rep]);
    const incomingCalls = mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:incoming');
    expect(incomingCalls.some(([, , data]: any) => data.call.lineLabel === 'Lehi Sales')).toBe(true);
  });

  test('12D: a number without a team (Orem) rings everyone', async () => {
    const { call } = await pressMenu('3');
    const routed: any = await until(() => CallLog.findById(call._id).lean(), (row: any) => row?.routing?.stage === 'all-org');
    expect(routed.routing.allOrg).toBe(true);
    expect(routed.lineLabel).toBe('Orem Sales');
    await until(async () => dialsFor(call._id).length, (count) => count === 3);
    expect(dialsFor(call._id).map((opts: any) => opts.to).sort()).toEqual([PHONES.tech, PHONES.mate, PHONES.rep].sort());
  });
});
