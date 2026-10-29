const mockTelnyx = {
  dialPhone: jest.fn(),
  gatherDigit: jest.fn(),
  speakFinal: jest.fn(),
  hangupCall: jest.fn(),
  findAccountPhoneNumber: jest.fn(),
};

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
    dialPhone: forward('dialPhone'),
    gatherDigit: forward('gatherDigit'),
    speakFinal: forward('speakFinal'),
    hangupCall: forward('hangupCall'),
    findAccountPhoneNumber: forward('findAccountPhoneNumber'),
    recordingCommand: jest.fn(),
    recordingDisclosure: jest.fn(),
    findRecordings: jest.fn().mockResolvedValue([]),
    deleteProviderRecording: jest.fn(),
  };
});
jest.mock('../src/utils/socketEmitter', () => {
  const actual = jest.requireActual('../src/utils/socketEmitter');
  return { ...actual, getSocketIO: () => ({ to: () => ({ emit: jest.fn() }), emit: jest.fn() }), emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), streamLogToAdmins: jest.fn() };
});

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import StaffCallPhone from '../src/models/StaffCallPhone.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { CallLog } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import myCallPhoneRoutes from '../src/routes/crmMyCallPhone.routes';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';
import { LocalUiAcceptanceModeBlockedError } from '../src/services/telnyx.service';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use('/api/crm/my-call-phone', myCallPhoneRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const ids = { rep: new mongoose.Types.ObjectId(), other: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId() };
const tokens: Record<string, string> = {};
const MOBILE = '+13855550142';
const NEW_MOBILE = '+13855550143';
const LEHI = '+18015550910';
let serial = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64');

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p12c2-${Date.now()}-${++serial}`, event_type: eventType, payload } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${body}`), (globalThis as any).mockTelnyxPrivateKey).toString('base64');
  return request(app).post('/api/webhooks/telnyx').set('Content-Type', 'application/json')
    .set('telnyx-timestamp', timestamp).set('telnyx-signature-ed25519', signature).send(body);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await wait(40);
    value = await read();
  }
  return value;
}

const api = (who: 'rep' | 'other' = 'rep') => ({
  get: () => request(app).get('/api/crm/my-call-phone').set('Authorization', `Bearer ${tokens[who]}`),
  put: (body: Record<string, unknown>) => request(app).put('/api/crm/my-call-phone').set('Authorization', `Bearer ${tokens[who]}`).send(body),
  verify: () => request(app).post('/api/crm/my-call-phone/verify').set('Authorization', `Bearer ${tokens[who]}`),
});

describe('Real-DB: a rep\'s own phone for customer calls, confirmed by a test call (local MongoDB, simulated Telnyx only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network is blocked in this test'));
    await Promise.all([StaffCallPhone.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Phone Motors', slug: `p12c2-${orgId}`, status: 'active', metadata: {} } as any);
    await CrmUser.collection.insertMany([
      { _id: ids.rep, organizationId: orgId, fullName: 'Remy Rep', username: `p12c2-rep-${orgId}`, email: `p12c2-rep-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.other, organizationId: orgId, fullName: 'Olly Other', username: `p12c2-other-${orgId}`, email: `p12c2-other-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await DealershipPhoneNumber.create({ organizationId: orgId, number: LEHI, label: 'Lehi Sales', kind: 'location', location: 'LEHI', createdBy: ids.owner, updatedBy: ids.owner, telnyx: { status: 'ready', readyForCalls: true, readyForTexts: true, message: '', checkedAt: new Date() } });
    tokens.rep = generateCrmToken(String(ids.rep));
    tokens.other = generateCrmToken(String(ids.other));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.dialPhone.mockImplementation(async () => ({ callControlId: `v3:verify-${++serial}` }));
    mockTelnyx.gatherDigit.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.speakFinal.mockResolvedValue({ data: { result: 'ok' } });
    mockTelnyx.hangupCall.mockResolvedValue({});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('starts empty, refuses wrong or dealership numbers in plain words, and saves a mobile as not confirmed', async () => {
    expect((await api().get()).body.data).toEqual({ phone: '', enabled: false, verified: false, verifying: false });
    expect((await api().put({ phone: '555-12', enabled: true })).body.message).toMatch(/10-digit US mobile number/);
    expect((await api().put({ phone: '(801) 555-0900', enabled: true })).body.message).toMatch(/dealership number/);
    expect((await api().put({ phone: LEHI, enabled: true })).body.message).toMatch(/dealership number/);
    const saved = await api().put({ phone: '(385) 555-0142', enabled: true });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ phone: MOBILE, enabled: true, verified: false, verifying: false });
    expect((await api('other').get()).body.data.phone).toBe('');
  });

  test('a test call is placed from the dealership main number; pressing 1 confirms the phone and the call ends politely', async () => {
    const started = await api().verify();
    expect(started.status).toBe(200);
    expect(started.body.data.verifying).toBe(true);
    expect(mockTelnyx.dialPhone).toHaveBeenCalledTimes(1);
    const [{ to, from, timeoutSecs, clientState }] = mockTelnyx.dialPhone.mock.calls[0];
    expect(to).toBe(MOBILE);
    expect(from).toBe('+18015550900');
    expect(timeoutSecs).toBe(30);
    expect(clientState.kind).toBe('phone-verify');
    const leg = (await StaffCallPhone.findOne({ userId: String(ids.rep) }).lean() as any).verifyCallControlId;
    const again = await api().verify();
    expect(again.status).toBe(429);
    expect(again.body.message).toMatch(/Wait a minute/);
    const before = await CallLog.countDocuments({});
    await webhook('call.answered', { call_control_id: leg, call_session_id: `s-${leg}`, client_state: state(clientState) });
    await until(async () => mockTelnyx.gatherDigit.mock.calls.length, (count) => count > 0);
    expect(mockTelnyx.gatherDigit).toHaveBeenCalledWith(leg, expect.stringMatching(/Press 1 to confirm this phone/), expect.objectContaining({ kind: 'phone-verify-gather' }));
    const gatherState = mockTelnyx.gatherDigit.mock.calls[0][2];
    await webhook('call.gather.ended', { call_control_id: leg, client_state: state(gatherState), digits: '1', status: 'valid' });
    const confirmed = await until(() => api().get(), (res) => res.body.data.verified === true);
    expect(confirmed.body.data).toEqual({ phone: MOBILE, enabled: true, verified: true, verifying: false });
    expect(mockTelnyx.speakFinal).toHaveBeenCalledWith(leg, expect.stringMatching(/confirmed/));
    await webhook('call.speak.ended', { call_control_id: leg, client_state: state({ kind: 'phone-bye' }) });
    await until(async () => mockTelnyx.hangupCall.mock.calls.length, (count) => count > 0);
    expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(leg);
    await webhook('call.hangup', { call_control_id: leg, call_session_id: `s-${leg}`, client_state: state({ kind: 'phone-bye' }), hangup_cause: 'normal_clearing' });
    await wait(200);
    expect(await CallLog.countDocuments({})).toBe(before);
  });

  test('changing the number resets the confirmation; a wrong key or someone else\'s call cannot confirm it', async () => {
    const changed = await api().put({ phone: NEW_MOBILE, enabled: true });
    expect(changed.body.data).toMatchObject({ phone: NEW_MOBILE, verified: false });
    await StaffCallPhone.updateOne({ userId: String(ids.rep) }, { $set: { verifyRequestedAt: null } });
    await api().verify();
    const row: any = await StaffCallPhone.findOne({ userId: String(ids.rep) }).lean();
    const leg = row.verifyCallControlId;
    await webhook('call.gather.ended', { call_control_id: leg, client_state: state({ kind: 'phone-verify-gather', settingId: String(row._id) }), digits: '2', status: 'valid' });
    await webhook('call.gather.ended', { call_control_id: 'v3:someone-else', client_state: state({ kind: 'phone-verify-gather', settingId: String(row._id) }), digits: '1', status: 'valid' });
    await wait(300);
    expect((await api().get()).body.data.verified).toBe(false);
    expect(mockTelnyx.speakFinal).not.toHaveBeenCalled();
    expect(mockTelnyx.hangupCall).toHaveBeenCalledWith(leg);
  });

  test('turning it off keeps the confirmation; clearing the number removes the setting', async () => {
    await StaffCallPhone.updateOne({ userId: String(ids.rep) }, { $set: { verifiedAt: new Date() } });
    expect((await api().put({ phone: NEW_MOBILE, enabled: false })).body.data).toEqual({ phone: NEW_MOBILE, enabled: false, verified: true, verifying: false });
    expect((await api().put({ phone: '', enabled: true })).body.data).toEqual({ phone: '', enabled: false, verified: false, verifying: false });
    expect(await StaffCallPhone.countDocuments({ userId: String(ids.rep) })).toBe(0);
  });

  test('on the local test system the test call is refused with a plain message', async () => {
    await api('other').put({ phone: '(385) 555-0150', enabled: true });
    mockTelnyx.dialPhone.mockRejectedValueOnce(new LocalUiAcceptanceModeBlockedError('POST', '/calls'));
    const res = await api('other').verify();
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Test calls are not available on this test system.');
  });

  test('a signed-out request is refused', async () => {
    expect((await request(app).get('/api/crm/my-call-phone')).status).toBe(401);
  });
});
