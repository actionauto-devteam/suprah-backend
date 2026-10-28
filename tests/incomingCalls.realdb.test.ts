const mockTelnyx = {
  transferToAgent: jest.fn(),
  playMissedAndHangup: jest.fn(),
  hangupCall: jest.fn(),
  answerCall: jest.fn(),
  speak: jest.fn(),
  speakIvr: jest.fn(),
  gatherIvr: jest.fn(),
  sendSms: jest.fn(),
  createTelephonyCredential: jest.fn(),
  createRtcLoginToken: jest.fn(),
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
    transferToAgent: forward('transferToAgent'),
    playMissedAndHangup: forward('playMissedAndHangup'),
    hangupCall: forward('hangupCall'),
    answerCall: forward('answerCall'),
    speak: forward('speak'),
    speakIvr: forward('speakIvr'),
    gatherIvr: forward('gatherIvr'),
    sendSms: forward('sendSms'),
    createTelephonyCredential: forward('createTelephonyCredential'),
    createRtcLoginToken: forward('createRtcLoginToken'),
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
    getSocketIO: () => ({ to: (room: string) => ({ emit: (event: string, data: unknown) => mockRoomEmit(room, event, data) }), emit: jest.fn() }),
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
import Lead from '../src/models/lead.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import CallRoutingConfig, { IvrInboundClaim } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, CommunicationMessage, TelephonyCredential } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import communicationRoutes from '../src/routes/communication.routes';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';
import { buildLeadConversation } from '../src/services/leadConversation.service';
import * as comm from '../src/services/communication.service';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use('/api/crm/communications', communicationRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const COMPANY = '+18015550900';
const OTHER_NUMBER = '+18015550901';
const ids = {
  owner: new mongoose.Types.ObjectId(),
  agent: new mongoose.Types.ObjectId(),
  teammate: new mongoose.Types.ObjectId(),
  offline: new mongoose.Types.ObjectId(),
  other: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(7000 + (++serial)).slice(-4)}`;
const nextControlId = () => `v3:p11-inbound-${Date.now()}-${++serial}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ringTimers: Array<{ fn: () => Promise<void>; handle: { cleared: boolean }; ms: number }> = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };

function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${body}`), (globalThis as any).mockTelnyxPrivateKey).toString('base64');
  return { timestamp: String(timestamp), signature };
}

function webhook(eventType: string, payload: Record<string, unknown>, options: { timestamp?: number; badSignature?: boolean; eventId?: string } = {}) {
  const body = JSON.stringify({ data: { id: options.eventId || `evt-${Date.now()}-${++serial}`, event_type: eventType, payload } });
  const { timestamp, signature } = signed(body, options.timestamp);
  return request(app)
    .post('/api/webhooks/telnyx')
    .set('Content-Type', 'application/json')
    .set('telnyx-timestamp', timestamp)
    .set('telnyx-signature-ed25519', options.badSignature ? Buffer.from('not-a-signature').toString('base64') : signature)
    .send(body);
}

const agentState = (callLogId: unknown, extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ kind: 'agent-leg', callLogId: String(callLogId), userId: String(ids.agent), ...extra })).toString('base64');

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await wait(40);
    value = await read();
  }
  return value;
}

async function incoming(from: string, to = COMPANY, controlId = nextControlId()) {
  const sessionId = `session-${controlId}`;
  const res = await webhook('call.initiated', { call_control_id: controlId, call_session_id: sessionId, direction: 'incoming', from, to, state: 'parked' });
  expect(res.status).toBe(200);
  const call: any = await until(() => CallLog.findOne({ providerCallControlId: controlId }).lean(), Boolean);
  expect(call).toBeTruthy();
  return { call, controlId, sessionId };
}

async function settle() {
  await wait(150);
}

async function fireRing(index = 0) {
  const timer = ringTimers[index];
  if (!timer || timer.handle.cleared) return false;
  await timer.fn();
  return true;
}

const claim = (callId: unknown, who: keyof typeof ids = 'agent') =>
  request(app).post(`/api/crm/communications/calls/${callId}/claim`).set('Authorization', `Bearer ${tokens[who]}`);
const ringing = (who: keyof typeof ids = 'agent') =>
  request(app).get('/api/crm/communications/calls/ringing').set('Authorization', `Bearer ${tokens[who]}`);

const backdate = (callId: unknown, seconds: number) =>
  CallLog.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(callId)) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
const refusalsFor = (controlId: string) => mockTelnyx.playMissedAndHangup.mock.calls.filter(([id, message]) => id === controlId && /unable to take your call/.test(String(message))).length;
const textBacksTo = (phone: string) => mockTelnyx.sendSms.mock.calls.filter(([to]) => to === phone).length;
const missedReleasesFor = (controlId: string) => mockTelnyx.playMissedAndHangup.mock.calls.filter(([id]) => id === controlId).length;

async function answeredCall(from = nextPhone()) {
  const started = await incoming(from);
  const claimed = await claim(started.call._id);
  expect(claimed.status).toBe(200);
  const agentControlId = `v3:p11-agent-${++serial}`;
  const state = agentState(started.call._id);
  await webhook('call.initiated', { call_control_id: agentControlId, call_session_id: started.sessionId, direction: 'outgoing', client_state: state, from: COMPANY, to: 'sip:p11agent@sip.telnyx.com' });
  await webhook('call.answered', { call_control_id: agentControlId, call_session_id: started.sessionId, client_state: state });
  const live: any = await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'in-progress');
  expect(live.status).toBe('in-progress');
  return { ...started, agentControlId, state };
}

describe('Real-DB: incoming calls (local MongoDB, simulated Telnyx only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
      if (typeof ms === 'number' && ms >= 5_000 && ms <= 35_000) {
        const handle = { p11Ring: true, cleared: false, ref() { return this; }, unref() { return this; }, hasRef: () => false };
        ringTimers.push({ fn, handle, ms });
        return handle as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as any);
    jest.spyOn(global, 'clearTimeout').mockImplementation(((handle: any) => {
      if (handle?.p11Ring) {
        handle.cleared = true;
        return;
      }
      realClearTimeout(handle);
    }) as any);
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), SmsOptOut.init(), TelephonyCredential.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Phase Eleven Motors', slug: `p11-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer Motors', slug: `p11-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `p11-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertMany([
      { _id: ids.agent, organizationId: orgId, fullName: 'Avery Agent', username: `p11-agent-${orgId}`, email: `p11-agent-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.teammate, organizationId: orgId, fullName: 'Taylor Teammate', username: `p11-team-${orgId}`, email: `p11-team-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.offline, organizationId: orgId, fullName: 'Owen Offline', username: `p11-off-${orgId}`, email: `p11-off-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.other, organizationId: otherOrgId, fullName: 'Other Dealer Agent', username: `p11-other-${orgId}`, email: `p11-other-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await TelephonyCredential.collection.insertMany([
      { userId: ids.agent, credentialId: 'cred-agent', sipUsername: 'p11agent' },
      { userId: ids.teammate, credentialId: 'cred-team', sipUsername: 'p11team' },
      { userId: ids.other, credentialId: 'cred-other', sipUsername: 'p11other' },
    ] as any[]);
    await CallRoutingConfig.collection.insertOne({
      organizationId: otherOrgId, enabled: false, name: 'Other dealer main line', inboundNumber: OTHER_NUMBER, mainNumber: OTHER_NUMBER,
      greeting: 'Thanks for calling', ringTimeoutSeconds: 30, retryCount: 0, allOrgFallback: true, options: [],
    } as any);
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) tokens[key] = generateCrmToken(String(ids[key]));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.transferToAgent.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.playMissedAndHangup.mockResolvedValue(undefined);
    mockTelnyx.hangupCall.mockResolvedValue({});
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

  test('1 + 10. a valid incoming call creates one ringing call and rings only its dealership', async () => {
    const from = nextPhone();
    const { call } = await incoming(from);
    expect(call).toMatchObject({ orgId: expect.anything(), direction: 'inbound', status: 'ringing', from, to: COMPANY });
    expect(String(call.orgId)).toBe(ORG);
    const rings = mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:incoming');
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toBe(`org:${ORG}:crm-staff`);
    expect(rings[0][2].call.from).toBe(from);
    expect(ringTimers).toHaveLength(1);
    const listed = await ringing('agent');
    expect(listed.body.data.items.map((item: any) => String(item._id))).toContain(String(call._id));
  });

  test('2. a wrong or expired webhook signature is refused and changes nothing', async () => {
    const before = await CallLog.countDocuments({});
    const bad = await webhook('call.initiated', { call_control_id: nextControlId(), call_session_id: 's-bad', direction: 'incoming', from: nextPhone(), to: COMPANY }, { badSignature: true });
    expect(bad.status).toBe(401);
    const stale = await webhook('call.initiated', { call_control_id: nextControlId(), call_session_id: 's-stale', direction: 'incoming', from: nextPhone(), to: COMPANY }, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
    const unsigned = await request(app).post('/api/webhooks/telnyx').set('Content-Type', 'application/json').send(JSON.stringify({ data: { event_type: 'call.initiated', payload: {} } }));
    expect(unsigned.status).toBe(401);
    await settle();
    expect(await CallLog.countDocuments({})).toBe(before);
    expect(mockRoomEmit).not.toHaveBeenCalled();
  });

  test('3 + 20. repeated and simultaneous copies of the same call create one call record and one ring', async () => {
    const from = nextPhone();
    const controlId = nextControlId();
    const payload = { call_control_id: controlId, call_session_id: `session-${controlId}`, direction: 'incoming', from, to: COMPANY };
    const [first, second] = await Promise.all([webhook('call.initiated', payload), webhook('call.initiated', payload)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await until(() => CallLog.countDocuments({ providerCallControlId: controlId }), (count) => count >= 1);
    await settle();
    const third = await webhook('call.initiated', payload);
    expect(third.status).toBe(200);
    await settle();
    expect(await CallLog.countDocuments({ providerCallControlId: controlId })).toBe(1);
    expect(mockRoomEmit.mock.calls.filter(([, event, data]: any[]) => event === 'comm:call:incoming' && data.call.from === from)).toHaveLength(1);
    expect(ringTimers).toHaveLength(1);
  });

  test('4. late and out-of-order events cannot change a finished call', async () => {
    const live = await answeredCall();
    await webhook('call.hangup', { call_control_id: live.controlId, call_session_id: live.sessionId, hangup_cause: 'normal_clearing' });
    const done: any = await until(() => CallLog.findById(live.call._id).lean(), (c: any) => c?.status === 'completed');
    expect(done.status).toBe('completed');
    await webhook('call.answered', { call_control_id: live.agentControlId, call_session_id: live.sessionId, client_state: live.state });
    await webhook('call.hangup', { call_control_id: live.agentControlId, call_session_id: live.sessionId, client_state: live.state, hangup_cause: 'timeout' });
    await settle();
    const after: any = await CallLog.findById(live.call._id).lean();
    expect(after.status).toBe('completed');
    expect(after.endedAt?.toISOString()).toBe(done.endedAt?.toISOString());
    expect(textBacksTo(live.call.from)).toBe(0);

    const newer = await incoming(live.call.from);
    await webhook('call.hangup', { call_control_id: live.agentControlId, call_session_id: live.sessionId, client_state: live.state, hangup_cause: 'normal_clearing' });
    await settle();
    expect((await CallLog.findById(newer.call._id).lean() as any).status).toBe('ringing');
  });

  test('4b. a hangup that loses a race to another update is re-checked against the newer status', async () => {
    const { call, controlId, sessionId } = await incoming(nextPhone());
    const realFindOne = CallLog.findOne.bind(CallLog);
    const spy = jest.spyOn(CallLog, 'findOne').mockImplementationOnce(((filter: any) =>
      realFindOne(filter).then(async (doc: any) => {
        await CallLog.updateOne({ _id: call._id }, { $set: { status: 'in-progress', answeredAt: new Date() } });
        return doc;
      })) as any);
    try {
      await comm.handleCallHangup({ call_control_id: controlId, call_session_id: sessionId, hangup_cause: 'normal_clearing' });
      expect(spy).toHaveBeenCalled();
      const final: any = await CallLog.findById(call._id).lean();
      expect(final.status).toBe('completed');
    } finally {
      spy.mockRestore();
    }
  });

  test('5. an unknown caller is shown as unknown and gets the existing automatic lead', async () => {
    const from = nextPhone();
    const { call } = await incoming(from);
    expect(call.customerName).toBeUndefined();
    const lead: any = await Lead.findById(call.leadId).lean();
    expect(lead).toMatchObject({ phone: from, source: 'Inbound Call', channel: 'phone' });
    expect(String(lead.organizationId)).toBe(ORG);
  });

  test('6. a known lead is matched by phone inside the same dealership', async () => {
    const from = nextPhone();
    const lead = await Lead.create({ organizationId: orgId, createdBy: ids.owner, firstName: 'Jordan', lastName: 'Rivera', phone: from.replace('+1', ''), source: 'Website Inquiry', channel: 'web', status: 'New' });
    const { call } = await incoming(from);
    expect(String(call.leadId)).toBe(String(lead._id));
    expect(call.customerName).toBe('Jordan Rivera');
    expect(await Lead.countDocuments({ organizationId: orgId, phone: { $in: [from, from.replace('+1', '')] } })).toBe(1);
  });

  test('7. a number shared by leads of different customers is never auto-picked for one of them', async () => {
    const from = nextPhone();
    const customerA = new mongoose.Types.ObjectId();
    const customerB = new mongoose.Types.ObjectId();
    const first = await Lead.create({ organizationId: orgId, createdBy: ids.owner, firstName: 'Casey', lastName: 'One', phone: from, customerId: customerA, source: 'Website Inquiry', channel: 'web', status: 'New' });
    const second = await Lead.create({ organizationId: orgId, createdBy: ids.owner, firstName: 'Casey', lastName: 'Two', phone: from, customerId: customerB, source: 'Website Inquiry', channel: 'web', status: 'New' });
    const { call } = await incoming(from);
    expect([String(first._id), String(second._id)]).not.toContain(String(call.leadId));
    expect(call.customerName).toBeUndefined();
  });

  test('8. a call to another dealership number stays with that dealership only', async () => {
    const from = nextPhone();
    const { call } = await incoming(from, OTHER_NUMBER);
    expect(String(call.orgId)).toBe(OTHER);
    expect(mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:incoming').map(([room]) => room)).toEqual([`org:${OTHER}:crm-staff`]);
    const mine = await ringing('agent');
    expect(mine.body.data.items.map((item: any) => String(item._id))).not.toContain(String(call._id));
    const wrongDealer = await claim(call._id, 'agent');
    expect(wrongDealer.status).toBe(409);
    expect(mockTelnyx.transferToAgent).not.toHaveBeenCalled();
    const ownDealer = await claim(call._id, 'other');
    expect(ownDealer.status).toBe(200);
    expect(mockTelnyx.transferToAgent.mock.calls[0][1]).toBe('p11other');
  });

  test('9. an employee whose phone line never connected cannot take the call; it keeps ringing and can still be missed', async () => {
    const from = nextPhone();
    const { call, controlId } = await incoming(from);
    const res = await claim(call._id, 'offline');
    expect(res.status).toBe(428);
    expect(mockTelnyx.transferToAgent).not.toHaveBeenCalled();
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('ringing');
    expect(await fireRing(0)).toBe(true);
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('missed');
    expect(missedReleasesFor(controlId)).toBe(1);
    expect(textBacksTo(from)).toBe(1);

    const next = await incoming(nextPhone());
    expect((await claim(next.call._id, 'offline')).status).toBe(428);
    expect((await claim(next.call._id, 'teammate')).status).toBe(200);
    expect(ringTimers[1].handle.cleared).toBe(true);
  });

  test('11 + 19. an answered call is bridged to the employee, completed with a duration and shown as answered', async () => {
    const from = nextPhone();
    const live = await answeredCall(from);
    const [, sipUser, clientState] = mockTelnyx.transferToAgent.mock.calls[0];
    expect(mockTelnyx.transferToAgent.mock.calls[0][0]).toBe(live.controlId);
    expect(sipUser).toBe('p11agent');
    expect(clientState).toMatchObject({ kind: 'agent-leg', callLogId: String(live.call._id), userId: String(ids.agent) });
    expect(await CallLog.countDocuments({ providerCallSessionId: live.sessionId })).toBe(1);
    const second = await claim(live.call._id, 'teammate');
    expect(second.status).toBe(409);
    await wait(1100);
    await webhook('call.hangup', { call_control_id: live.agentControlId, call_session_id: live.sessionId, client_state: live.state, hangup_cause: 'normal_clearing' });
    const done: any = await until(() => CallLog.findById(live.call._id).lean(), (c: any) => c?.status === 'completed');
    expect(done.status).toBe('completed');
    expect(done.answeredBy?.name).toBe('Avery Agent');
    expect(done.durationSec).toBeGreaterThanOrEqual(1);
    expect(textBacksTo(from)).toBe(0);
    expect(missedReleasesFor(live.controlId)).toBe(0);
    const conversation = await buildLeadConversation(ORG, String(done.leadId));
    const item: any = conversation.items.find((entry: any) => entry.id === `call:${live.call._id}`);
    expect(item?.call).toMatchObject({ status: 'completed', label: 'Answered', answeredBy: 'Avery Agent' });
  });

  test('12. when one employee browser cannot take the call, it rings for the team again and no text is sent', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    expect((await claim(started.call._id)).status).toBe(200);
    mockRoomEmit.mockClear();
    const state = agentState(started.call._id);
    await webhook('call.hangup', { call_control_id: 'v3:p11-agent-rejected', call_session_id: started.sessionId, client_state: state, hangup_cause: 'call_rejected' });
    const reopened: any = await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'ringing');
    expect(reopened).toMatchObject({ status: 'ringing', answeredBy: null, hangupCause: 'call_rejected' });
    await settle();
    expect(textBacksTo(from)).toBe(0);
    expect(missedReleasesFor(started.controlId)).toBe(0);
    const rings = mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:call:incoming');
    expect(rings.map(([room]) => room)).toEqual([`org:${ORG}:crm-staff`]);
    const timer = ringTimers[ringTimers.length - 1];
    expect(timer.ms).toBeLessThan(35_000);
    expect(timer.ms).toBeGreaterThanOrEqual(5_000);

    const teammate = await claim(started.call._id, 'teammate');
    expect(teammate.status).toBe(200);
    expect(mockTelnyx.transferToAgent.mock.calls[1][1]).toBe('p11team');
    const agentControlId = `v3:p11-team-${++serial}`;
    await webhook('call.answered', { call_control_id: agentControlId, call_session_id: started.sessionId, client_state: agentState(started.call._id, { userId: String(ids.teammate) }) });
    await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'in-progress');
    await webhook('call.hangup', { call_control_id: started.controlId, call_session_id: started.sessionId, hangup_cause: 'normal_clearing' });
    const done: any = await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'completed');
    expect(done.answeredBy?.name).toBe('Taylor Teammate');
    expect(await timer.fn().then(() => CallLog.findById(started.call._id).lean()) as any).toMatchObject({ status: 'completed' });
    expect(textBacksTo(from)).toBe(0);
    expect(missedReleasesFor(started.controlId)).toBe(0);
  });

  test('12b. if nobody else answers before the ring time ends, the call becomes missed once, with one message and one text', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    expect((await claim(started.call._id)).status).toBe(200);
    await webhook('call.hangup', { call_control_id: 'v3:p11-agent-gone', call_session_id: started.sessionId, client_state: agentState(started.call._id), hangup_cause: 'user_busy' });
    await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'ringing');
    expect(textBacksTo(from)).toBe(0);
    expect(await fireRing(ringTimers.length - 1)).toBe(true);
    const missed: any = await CallLog.findById(started.call._id).lean();
    expect(missed.status).toBe('missed');
    expect(missedReleasesFor(started.controlId)).toBe(1);
    expect(textBacksTo(from)).toBe(1);
    await webhook('call.hangup', { call_control_id: started.controlId, call_session_id: started.sessionId, hangup_cause: 'normal_clearing' });
    await settle();
    expect(textBacksTo(from)).toBe(1);
  });

  test('12c. if the browser fails after the ring time is already over, the call is missed right away, with one message and one text', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    expect((await claim(started.call._id)).status).toBe(200);
    await backdate(started.call._id, 40);
    await webhook('call.hangup', { call_control_id: 'v3:p11-agent-timeout', call_session_id: started.sessionId, client_state: agentState(started.call._id), hangup_cause: 'timeout' });
    const missed: any = await until(() => CallLog.findById(started.call._id).lean(), (c: any) => c?.status === 'missed');
    expect(missed).toMatchObject({ status: 'missed', hangupCause: 'timeout' });
    await until(async () => textBacksTo(from), (count) => count >= 1);
    expect(missedReleasesFor(started.controlId)).toBe(1);
    expect(textBacksTo(from)).toBe(1);
  });

  test('13 + 21. an unanswered call becomes missed once, with one announcement and one text-back', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    expect(ringTimers).toHaveLength(1);
    expect(await fireRing(0)).toBe(true);
    const missed: any = await CallLog.findById(started.call._id).lean();
    expect(missed.status).toBe('missed');
    expect(missedReleasesFor(started.controlId)).toBe(1);
    expect(textBacksTo(from)).toBe(1);
    await ringTimers[0].fn();
    await webhook('call.hangup', { call_control_id: started.controlId, call_session_id: started.sessionId, hangup_cause: 'normal_clearing' });
    await settle();
    expect(textBacksTo(from)).toBe(1);
    expect(missedReleasesFor(started.controlId)).toBe(1);
    const messages = await CommunicationMessage.countDocuments({ to: from, direction: 'outbound' });
    expect(messages).toBe(1);
  });

  test('14. the caller hanging up is recorded correctly: while live, while ringing, and while connecting', async () => {
    const live = await answeredCall();
    await webhook('call.hangup', { call_control_id: live.controlId, call_session_id: live.sessionId, hangup_cause: 'normal_clearing' });
    expect((await until(() => CallLog.findById(live.call._id).lean(), (c: any) => c?.status !== 'in-progress') as any).status).toBe('completed');

    const ringingCall = await incoming(nextPhone());
    await webhook('call.hangup', { call_control_id: ringingCall.controlId, call_session_id: ringingCall.sessionId, hangup_cause: 'originator_cancel' });
    expect((await until(() => CallLog.findById(ringingCall.call._id).lean(), (c: any) => c?.status !== 'ringing') as any).status).toBe('canceled');

    const connecting = await incoming(nextPhone());
    expect((await claim(connecting.call._id)).status).toBe(200);
    await webhook('call.hangup', { call_control_id: connecting.controlId, call_session_id: connecting.sessionId, hangup_cause: 'normal_clearing' });
    const ended: any = await until(() => CallLog.findById(connecting.call._id).lean(), (c: any) => c?.status !== 'answering');
    expect(ended.status).toBe('canceled');
    expect(ended.answeredAt).toBeFalsy();
    const conversation = await buildLeadConversation(ORG, String(ended.leadId));
    const item: any = conversation.items.find((entry: any) => entry.id === `call:${connecting.call._id}`);
    expect(item?.call?.label).toBe('Ended before answer');
    expect(textBacksTo(ringingCall.call.from) + textBacksTo(connecting.call.from)).toBe(0);
  });

  test('15. a provider error for one employee returns the call to the team; no text and the caller is not cut off', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    mockTelnyx.transferToAgent.mockRejectedValueOnce(new Error('Telnyx API error 422: simulated'));
    const res = await claim(started.call._id);
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/ringing for your teammates again/);
    const reopened: any = await CallLog.findById(started.call._id).lean();
    expect(reopened.status).toBe('ringing');
    expect(missedReleasesFor(started.controlId)).toBe(0);
    expect((await claim(started.call._id, 'teammate')).status).toBe(200);
    await settle();
    expect(textBacksTo(from)).toBe(0);
  });

  test('15b. a provider error after the ring time is over is recorded as failed, releases the caller and sends no text', async () => {
    const from = nextPhone();
    const started = await incoming(from);
    await backdate(started.call._id, 40);
    mockTelnyx.transferToAgent.mockRejectedValueOnce(new Error('Telnyx API error 422: simulated'));
    const res = await claim(started.call._id);
    expect(res.status).toBe(502);
    const failed: any = await CallLog.findById(started.call._id).lean();
    expect(failed.status).toBe('failed');
    expect(missedReleasesFor(started.controlId)).toBe(1);
    await settle();
    expect(textBacksTo(from)).toBe(0);
  });

  test('C1. a call to a number that is not linked to any dealership is never filed under a dealership', async () => {
    const controlId = nextControlId();
    const before = await CallLog.countDocuments({});
    const payload = { call_control_id: controlId, call_session_id: `session-${controlId}`, direction: 'incoming', from: nextPhone(), to: '+18015550977' };
    await Promise.all([webhook('call.initiated', payload), webhook('call.initiated', payload)]);
    await until(async () => refusalsFor(controlId), (count) => count >= 1);
    await settle();
    expect(await CallLog.countDocuments({})).toBe(before);
    expect(await IvrInboundClaim.countDocuments({ callControlId: controlId })).toBe(0);
    expect(refusalsFor(controlId)).toBe(1);
    expect(mockRoomEmit.mock.calls.filter(([, event]) => String(event).startsWith('comm:call'))).toHaveLength(0);
    expect(textBacksTo(payload.from)).toBe(0);
  });

  test('C2. without COMM_ORG_ID the call is refused instead of guessing a dealership from old conversations', async () => {
    await Conversation.create({ orgId: OTHER, customerPhone: '+18015550978', lastMessageAt: new Date('2020-01-01') } as any);
    await Conversation.collection.updateOne({ customerPhone: '+18015550978', orgId: OTHER }, { $set: { createdAt: new Date('2000-01-01') } });
    const saved = process.env.COMM_ORG_ID;
    delete process.env.COMM_ORG_ID;
    try {
      const controlId = nextControlId();
      const before = await CallLog.countDocuments({});
      await webhook('call.initiated', { call_control_id: controlId, call_session_id: `session-${controlId}`, direction: 'incoming', from: nextPhone(), to: COMPANY });
      await until(async () => refusalsFor(controlId), (count) => count >= 1);
      await settle();
      expect(await CallLog.countDocuments({})).toBe(before);
      expect(mockRoomEmit.mock.calls.filter(([room]) => String(room).includes(OTHER))).toHaveLength(0);
    } finally {
      process.env.COMM_ORG_ID = saved;
    }
  });

  test('C3. a call event without a called number is refused, and the configured company number still works', async () => {
    const controlId = nextControlId();
    const before = await CallLog.countDocuments({});
    await webhook('call.initiated', { call_control_id: controlId, call_session_id: `session-${controlId}`, direction: 'incoming', from: nextPhone() });
    await until(async () => refusalsFor(controlId), (count) => count >= 1);
    await settle();
    expect(await CallLog.countDocuments({})).toBe(before);
    const { call } = await incoming(nextPhone(), COMPANY);
    expect(String(call.orgId)).toBe(ORG);
  });

  test('21b. a missed call to a number that opted out of texts gets no text-back', async () => {
    const from = nextPhone();
    await SmsOptOut.create({ organizationId: orgId, phone: from, optedOut: true } as any);
    const started = await incoming(from);
    expect(await fireRing(0)).toBe(true);
    expect((await CallLog.findById(started.call._id).lean() as any).status).toBe('missed');
    expect(textBacksTo(from)).toBe(0);
  });

  test('S1. an incoming text to the company number is filed under the COMM_ORG_ID dealership as before', async () => {
    const from = nextPhone();
    const res = await webhook('message.received', { id: `p11-sms-${++serial}`, from: { phone_number: from }, to: [{ phone_number: COMPANY }], text: 'Is the Tacoma still available?' });
    expect(res.status).toBe(200);
    const message: any = await until(() => CommunicationMessage.findOne({ from, direction: 'inbound' }).lean(), Boolean);
    expect(String(message?.orgId)).toBe(ORG);
    expect(message?.body).toBe('Is the Tacoma still available?');
  });

  test('S2. without COMM_ORG_ID an incoming text is not filed under a dealership guessed from old conversations', async () => {
    await Conversation.create({ orgId: OTHER, customerPhone: '+18015550979', lastMessageAt: new Date('2020-01-01') } as any);
    await Conversation.collection.updateOne({ customerPhone: '+18015550979', orgId: OTHER }, { $set: { createdAt: new Date('1999-01-01') } });
    const saved = process.env.COMM_ORG_ID;
    delete process.env.COMM_ORG_ID;
    try {
      const from = nextPhone();
      const before = { messages: await CommunicationMessage.countDocuments({}), conversations: await Conversation.countDocuments({}), leads: await Lead.countDocuments({}) };
      const res = await webhook('message.received', { id: `p11-sms-${++serial}`, from: { phone_number: from }, to: [{ phone_number: COMPANY }], text: 'Can someone call me?' });
      expect(res.status).toBe(200);
      await settle();
      expect(await CommunicationMessage.countDocuments({})).toBe(before.messages);
      expect(await Conversation.countDocuments({})).toBe(before.conversations);
      expect(await Lead.countDocuments({})).toBe(before.leads);
      expect(mockRoomEmit.mock.calls.filter(([room]) => String(room).includes(OTHER))).toHaveLength(0);
    } finally {
      process.env.COMM_ORG_ID = saved;
    }
  });

  test('S3. an incoming text to an unconfigured number or without a number is refused, even with COMM_ORG_ID set', async () => {
    const before = await CommunicationMessage.countDocuments({});
    await webhook('message.received', { id: `p11-sms-${++serial}`, from: { phone_number: nextPhone() }, to: [{ phone_number: '+18015550977' }], text: 'Hello?' });
    await webhook('message.received', { id: `p11-sms-${++serial}`, from: { phone_number: nextPhone() }, text: 'Hello again?' });
    await settle();
    expect(await CommunicationMessage.countDocuments({})).toBe(before);
    expect(mockTelnyx.sendSms).not.toHaveBeenCalled();
  });

  test('S4. an incoming text to a number with a call routing setting is filed under that setting\'s dealership', async () => {
    const from = nextPhone();
    await webhook('message.received', { id: `p11-sms-${++serial}`, from: { phone_number: from }, to: [{ phone_number: OTHER_NUMBER }], text: 'Do you have service openings?' });
    const message: any = await until(() => CommunicationMessage.findOne({ from, direction: 'inbound' }).lean(), Boolean);
    expect(String(message?.orgId)).toBe(OTHER);
    const live = mockRoomEmit.mock.calls.filter(([, event]) => event === 'comm:message:new').map(([room]) => room);
    expect(live).toContain(`org:${OTHER}:crm-staff`);
    expect(live).not.toContain(`org:${OTHER}`);
  });

  test('22. outbound browser calls are still logged from start to finish', async () => {
    const to = nextPhone();
    const user = { userId: String(ids.agent), name: 'Avery Agent' };
    const clientCallId = `cc_p11_${++serial}`;
    const started: any = await comm.logClientCall({ orgId, user, clientCallId, event: 'start', toPhone: to });
    expect(started).toMatchObject({ direction: 'outbound', status: 'ringing', to, from: COMPANY });
    await comm.logClientCall({ orgId, user, clientCallId, event: 'answered' });
    await wait(1100);
    const ended: any = await comm.logClientCall({ orgId, user, clientCallId, event: 'end', hangupCause: 'normal_clearing' });
    expect(ended.status).toBe('completed');
    expect(ended.durationSec).toBeGreaterThanOrEqual(1);
    expect(await CallLog.countDocuments({ clientCallId })).toBe(1);
    expect(mockTelnyx.transferToAgent).not.toHaveBeenCalled();
  });

  test('recovery list only returns calls that can still be ringing', async () => {
    await CallLog.updateMany({ orgId: ORG, status: 'ringing' }, { $set: { status: 'canceled' } });
    const stale = await CallLog.create({ orgId: ORG, direction: 'inbound', from: nextPhone(), to: COMPANY, status: 'ringing', providerCallControlId: nextControlId(), startedAt: new Date(Date.now() - 10 * 60 * 1000) });
    await CallLog.collection.updateOne({ _id: stale._id }, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
    const fresh = await incoming(nextPhone());
    const listed = await ringing('agent');
    const listedIds = listed.body.data.items.map((item: any) => String(item._id));
    expect(listedIds).toContain(String(fresh.call._id));
    expect(listedIds).not.toContain(String(stale._id));
  });

  test('security: answering a call needs a CRM sign-in', async () => {
    const { call } = await incoming(nextPhone());
    const anonymous = await request(app).post(`/api/crm/communications/calls/${call._id}/claim`);
    expect(anonymous.status).toBe(401);
    expect((await CallLog.findById(call._id).lean() as any).status).toBe('ringing');
  });
});
