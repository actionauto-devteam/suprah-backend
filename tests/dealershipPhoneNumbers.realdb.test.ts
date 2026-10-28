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
    MESSAGING_PROFILE_ID: 'mp-suprah',
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
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import CallRoutingConfig, { IvrInboundClaim } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';
import phoneNumberRoutes from '../src/routes/crmPhoneNumber.routes';
import { resetTelnyxReferenceCache } from '../src/services/dealershipPhoneNumber.service';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use('/api/crm/phone-numbers', phoneNumberRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const intakeOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const COMPANY = '+18015550900';
const LEHI = '+18015550910';
const SERVICE = '+18015550912';
const OTHER_ROUTED = '+18015550901';
const OTHER_LINE = '+18015550913';
const INTAKE_LINE = '+18015550914';
const ids = {
  admin: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const account = new Map<string, { status: string; connectionId: string; messagingProfileId: string } | null>();
let serial = 0;
const nextPhone = () => `+1801555${String(7400 + (++serial)).slice(-4)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p12a-${Date.now()}-${++serial}`, event_type: eventType, payload } });
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

const api = (who: keyof typeof ids = 'admin') => ({
  list: () => request(app).get('/api/crm/phone-numbers').set('Authorization', `Bearer ${tokens[who]}`),
  create: (body: Record<string, unknown>) => request(app).post('/api/crm/phone-numbers').set('Authorization', `Bearer ${tokens[who]}`).send(body),
  update: (id: string, body: Record<string, unknown>) => request(app).patch(`/api/crm/phone-numbers/${id}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  check: (id: string) => request(app).post(`/api/crm/phone-numbers/${id}/check`).set('Authorization', `Bearer ${tokens[who]}`),
  remove: (id: string) => request(app).delete(`/api/crm/phone-numbers/${id}`).set('Authorization', `Bearer ${tokens[who]}`),
});
const text = (from: string, to: string, body = 'Hi, is the truck still available?') =>
  webhook('message.received', { id: `p12a-sms-${++serial}`, from: { phone_number: from }, to: [{ phone_number: to }], text: body });
const call = (from: string, to: string) => {
  const controlId = `v3:p12a-${Date.now()}-${++serial}`;
  return webhook('call.initiated', { call_control_id: controlId, call_session_id: `s-${controlId}`, direction: 'incoming', from, to, state: 'parked' }).then(() => controlId);
};

describe('Real-DB: dealership phone numbers (local MongoDB, simulated Telnyx only)', () => {
  const created: Record<string, string> = {};

  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network is blocked in this test'));
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), DealershipPhoneNumber.init(), LeadIntakeControl.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Twelve A Motors', slug: `p12a-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer Motors', slug: `p12a-${otherOrgId}`, status: 'active', metadata: {} },
      { _id: intakeOrgId, name: 'Intake Motors', slug: `p12a-${intakeOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `p12a-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await User.collection.insertMany([
      { name: 'Other Owner', email: `p12a-other-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: otherOrgId, isActive: true },
      { name: 'Intake Owner', email: `p12a-intake-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: intakeOrgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.admin, organizationId: orgId, fullName: 'Ada Admin', username: `p12a-admin-${orgId}`, email: `p12a-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.employee, organizationId: orgId, fullName: 'Eli Employee', username: `p12a-emp-${orgId}`, email: `p12a-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await CallRoutingConfig.collection.insertOne({
      organizationId: otherOrgId, enabled: false, name: 'Other dealer line', inboundNumber: OTHER_ROUTED, mainNumber: OTHER_ROUTED,
      greeting: 'Thanks for calling', ringTimeoutSeconds: 30, retryCount: 0, allOrgFallback: true, options: [],
    } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrgId, mode: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    tokens.admin = generateCrmToken(String(ids.admin));
    tokens.employee = generateCrmToken(String(ids.employee));
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.sendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
    mockTelnyx.playMissedAndHangup.mockResolvedValue(undefined);
    mockTelnyx.findAccountPhoneNumber.mockImplementation(async (number: string) => account.get(number) ?? null);
    resetTelnyxReferenceCache();
    account.clear();
    account.set(COMPANY, { status: 'active', connectionId: 'conn-suprah', messagingProfileId: 'mp-suprah' });
    account.set(LEHI, { status: 'active', connectionId: 'conn-suprah', messagingProfileId: '' });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('only admins can see or change the phone numbers', async () => {
    expect((await api('employee').list()).status).toBe(403);
    expect((await api('employee').create({ number: LEHI, kind: 'location', label: 'Lehi Sales', location: 'LEHI' })).status).toBe(403);
  });

  test('suggests the current Suprah number until it is added, then adds it as the main number', async () => {
    const before = await api().list();
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ numbers: [], suggestion: { number: COMPANY } });
    const res = await api().create({ number: '(801) 555-0900', kind: 'main', label: '' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ number: COMPANY, label: 'Main', kind: 'main', organizationId: ORG });
    expect(res.body.data.telnyx).toMatchObject({ status: 'ready', readyForCalls: true, readyForTexts: true });
    created.main = res.body.data._id;
    expect((await api().list()).body.data.suggestion).toBeNull();
  });

  test('a location number shows what is still missing in Telnyx, and a number outside the account says so', async () => {
    const lehi = await api().create({ number: '801-555-0910', kind: 'location', label: 'Lehi Sales', location: 'LEHI' });
    expect(lehi.status).toBe(201);
    expect(lehi.body.data.telnyx).toMatchObject({ status: 'needs_setup', readyForCalls: true, readyForTexts: false });
    expect(lehi.body.data.telnyx.message).toMatch(/Texting is not turned on/);
    created.lehi = lehi.body.data._id;
    const service = await api().create({ number: SERVICE, kind: 'department', label: 'Service Dept', department: 'Service' });
    expect(service.status).toBe(201);
    expect(service.body.data.telnyx).toMatchObject({ status: 'not_in_account', readyForCalls: false, readyForTexts: false });
    created.service = service.body.data._id;
    account.set(LEHI, { status: 'active', connectionId: 'conn-suprah', messagingProfileId: 'mp-suprah' });
    const rechecked = await api().check(created.lehi);
    expect(rechecked.body.data.telnyx).toMatchObject({ status: 'ready', readyForCalls: true, readyForTexts: true, message: '' });
    account.set(LEHI, { status: 'active', connectionId: 'conn-someone-else', messagingProfileId: 'mp-suprah' });
    const wrong = await api().check(created.lehi);
    expect(wrong.body.data.telnyx.message).toMatch(/different calling setup/);
    mockTelnyx.findAccountPhoneNumber.mockRejectedValueOnce(new Error('timeout'));
    const failed = await api().check(created.service);
    expect(failed.body.data.telnyx).toMatchObject({ status: 'error' });
  });

  test('explains mistakes in plain words and never allows the same number twice', async () => {
    expect((await api().create({ number: '555-12', kind: 'location', label: 'X', location: 'LEHI' })).body.message).toMatch(/10-digit US phone number/);
    expect((await api().create({ number: '+18015550920', kind: 'location', label: 'Orem Sales' })).body.message).toMatch(/Choose the location/);
    expect((await api().create({ number: '+18015550920', kind: 'department', label: 'Licensing' })).body.message).toMatch(/Enter the department/);
    expect((await api().create({ number: '+18015550920', kind: 'other', label: 'X' })).status).toBe(400);
    const again = await api().create({ number: LEHI, kind: 'location', label: 'Lehi Again', location: 'LEHI' });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already in your list/);
    const secondMain = await api().create({ number: '+18015550921', kind: 'main', label: 'Second main' });
    expect(secondMain.status).toBe(409);
    expect(secondMain.body.message).toMatch(/already has a main number/);
    const routed = await api().create({ number: OTHER_ROUTED, kind: 'department', label: 'Stolen', department: 'Sales' });
    expect(routed.status).toBe(409);
    expect(routed.body.message).toMatch(/another dealership/);
    await DealershipPhoneNumber.create({ organizationId: otherOrgId, number: OTHER_LINE, label: 'Other dealer sales', kind: 'location', location: 'PROVO', createdBy: ids.owner, updatedBy: ids.owner });
    const taken = await api().create({ number: OTHER_LINE, kind: 'location', label: 'Mine', location: 'LEHI' });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toMatch(/another dealership/);
  });

  test('editing keeps the record and its check; another dealership cannot see it', async () => {
    const res = await api().update(created.service, { number: SERVICE, kind: 'department', label: 'Service Department', department: 'Service' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ label: 'Service Department', department: 'Service' });
    const list = await api().list();
    expect(list.body.data.numbers.map((row: any) => row.number)).toEqual([COMPANY, LEHI, SERVICE]);
  });

  test('a text to the Lehi number creates a lead for this dealership tagged with the Lehi location and line', async () => {
    const from = nextPhone();
    expect((await text(from, LEHI)).status).toBe(200);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    expect(lead).toMatchObject({ location: 'LEHI', dealershipLine: 'Lehi Sales', source: 'Inbound SMS' });
    expect(String(lead.organizationId)).toBe(ORG);
    const message: any = await CommunicationMessage.findOne({ from, direction: 'inbound' }).lean();
    expect(String(message.orgId)).toBe(ORG);
  });

  test('a call to the Service number records the line on the call and the new lead, without inventing a location', async () => {
    const from = nextPhone();
    const controlId = await call(from, SERVICE);
    const callLog: any = await until(() => CallLog.findOne({ providerCallControlId: controlId }).lean(), Boolean);
    expect(callLog).toMatchObject({ lineLabel: 'Service Department', status: 'ringing' });
    expect(String(callLog.orgId)).toBe(ORG);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    expect(lead.dealershipLine).toBe('Service Department');
    expect(lead.location).toBeUndefined();
  });

  test('a number saved by another dealership sends its texts and calls there, even though COMM_ORG_ID points here', async () => {
    const from = nextPhone();
    await text(from, OTHER_LINE);
    const message: any = await until(() => CommunicationMessage.findOne({ from, direction: 'inbound' }).lean(), Boolean);
    expect(String(message.orgId)).toBe(OTHER);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    expect(String(lead.organizationId)).toBe(OTHER);
    expect(lead).toMatchObject({ location: 'PROVO', dealershipLine: 'Other dealer sales' });
  });

  test('an existing lead keeps its location when it texts another line', async () => {
    const from = nextPhone();
    await Lead.create({ organizationId: orgId, createdBy: ids.owner, firstName: 'Old', lastName: 'Customer', phone: from, status: 'New', channel: 'sms', source: 'Inbound SMS', location: 'OREM' });
    await text(from, LEHI, 'Is the truck at Lehi?');
    await until(() => CommunicationMessage.findOne({ from, direction: 'inbound' }).lean(), Boolean);
    const leads: any[] = await Lead.find({ phone: from }).lean();
    expect(leads).toHaveLength(1);
    expect(leads[0].location).toBe('OREM');
  });

  test('numbers that belong to nobody are still refused, and the old COMM_ORG_ID setting still works for the company number', async () => {
    const stranger = nextPhone();
    await text(stranger, '+18015550977');
    await wait(300);
    expect(await CommunicationMessage.countDocuments({ from: stranger })).toBe(0);
    expect((await api().remove(created.main)).status).toBe(200);
    const from = nextPhone();
    await text(from, COMPANY);
    const message: any = await until(() => CommunicationMessage.findOne({ from, direction: 'inbound' }).lean(), Boolean);
    expect(String(message.orgId)).toBe(ORG);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    expect(lead.dealershipLine).toBeUndefined();
  });

  test('when lead intake is on, the new lead from a location number is also tagged', async () => {
    await DealershipPhoneNumber.create({ organizationId: intakeOrgId, number: INTAKE_LINE, label: 'Orem Sales', kind: 'location', location: 'OREM', createdBy: ids.owner, updatedBy: ids.owner });
    const from = nextPhone();
    await text(from, INTAKE_LINE, 'Do you have any trucks under 30k?');
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean, 10000);
    expect(lead).toBeTruthy();
    expect(String(lead.organizationId)).toBe(String(intakeOrgId));
    expect(lead).toMatchObject({ location: 'OREM', dealershipLine: 'Orem Sales' });
  });
});
