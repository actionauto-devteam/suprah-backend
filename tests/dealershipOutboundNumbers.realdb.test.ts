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
    getSocketIO: () => ({ to: () => ({ emit: jest.fn() }), emit: jest.fn() }),
    emitToOrg: jest.fn(),
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
import Lead from '../src/models/lead.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { IvrInboundClaim } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, CommunicationMessage } from '../src/models/communication.model';
import { errorHandler } from '../src/middleware/error.middleware';
import telnyxWebhookRoute from '../src/routes/telnyxWebhook.route';
import { logClientCall, sendAutomatedSms, sendSmsFromUser } from '../src/services/communication.service';
import { getLeadReplyOptions } from '../src/services/leadComposer.service';
import { resolveOutboundNumber } from '../src/services/dealershipPhoneNumber.service';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/telnyx', telnyxWebhookRoute);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const plainOrgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const COMPANY = '+18015550900';
const MAIN = '+18015550905';
const LEHI = '+18015550910';
const SERVICE = '+18015550912';
const OREM = '+18015550920';
const PROVO = '+18015550930';
const OTHER_LINE = '+18015550940';
const owner = new mongoose.Types.ObjectId();
const staff = { userId: String(new mongoose.Types.ObjectId()), name: 'Rita Rep' };
let serial = 0;
const nextPhone = () => `+1801555${String(7600 + (++serial)).slice(-4)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };
const ready = { status: 'ready', readyForCalls: true, readyForTexts: true, message: '', checkedAt: new Date() };

function webhook(eventType: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { id: `evt-p12b-${Date.now()}-${++serial}`, event_type: eventType, payload } });
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

const text = (from: string, to: string, body = 'Is the truck still there?') =>
  webhook('message.received', { id: `p12b-sms-${++serial}`, from: { phone_number: from }, to: [{ phone_number: to }], text: body });
const call = (from: string, to: string) => {
  const controlId = `v3:p12b-${Date.now()}-${++serial}`;
  return webhook('call.initiated', { call_control_id: controlId, call_session_id: `s-${controlId}`, direction: 'incoming', from, to, state: 'parked' }).then(() => controlId);
};
const lastSentFrom = () => mockTelnyx.sendSms.mock.calls.at(-1)?.[2];
const reply = (to: string, extra: Record<string, unknown> = {}) =>
  sendSmsFromUser({ orgId: ORG, user: staff, toPhone: to, body: 'Thanks for reaching out!', destinationPolicy: 'manual', ...extra });
const startCall = (to: string, extra: Record<string, unknown> = {}) =>
  logClientCall({ orgId: ORG, user: staff, clientCallId: `cc_p12b_${++serial}`, event: 'start', toPhone: to, ...extra });

async function newLead(fields: Record<string, unknown>) {
  const phone = nextPhone();
  const lead = await Lead.create({ organizationId: orgId, createdBy: owner, firstName: 'Casey', lastName: 'Buyer', phone, status: 'New', channel: 'sms', source: 'Inbound SMS', ...fields });
  return { phone, lead };
}

describe('Real-DB: texts and calls go out from the right dealership number (local MongoDB, simulated Telnyx only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network is blocked in this test'));
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), IvrInboundClaim.init(), CallLog.init(), Conversation.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Twelve B Motors', slug: `p12b-${orgId}`, status: 'active', metadata: {} },
      { _id: plainOrgId, name: 'Plain Motors', slug: `p12b-${plainOrgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Motors', slug: `p12b-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: owner, name: 'Olivia Owner', email: `p12b-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    const row = (number: string, label: string, kind: string, extra: Record<string, unknown>, telnyx: Record<string, unknown>, org = orgId) =>
      ({ organizationId: org, number, label, kind, location: '', department: '', ...extra, telnyx, createdBy: owner, updatedBy: owner });
    await DealershipPhoneNumber.create([
      row(MAIN, 'Main', 'main', {}, ready),
      row(LEHI, 'Lehi Sales', 'location', { location: 'LEHI' }, ready),
      row(SERVICE, 'Service Department', 'department', { department: 'Service' }, ready),
      row(OREM, 'Orem Sales', 'location', { location: 'OREM' }, { ...ready, status: 'needs_setup', readyForCalls: false }),
      row(PROVO, 'Provo Sales', 'location', { location: 'PROVO' }, { status: 'needs_setup', readyForCalls: false, readyForTexts: false, message: 'Texting is not turned on', checkedAt: new Date() }),
      row(OTHER_LINE, 'Other Dealer Sales', 'location', { location: 'LEHI' }, ready, otherOrgId),
    ]);
  });

  beforeEach(() => {
    Object.values(mockTelnyx).forEach((mock) => mock.mockReset());
    mockTelnyx.sendSms.mockImplementation(async (to: string) => ({ id: `sim-${++serial}`, to: [{ phone_number: to }] }));
    mockTelnyx.playMissedAndHangup.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('a reply goes out from the number the customer texted, and the text record shows it', async () => {
    const from = nextPhone();
    await text(from, LEHI);
    const conversation: any = await until(() => Conversation.findOne({ customerPhone: from }).lean(), Boolean);
    expect(conversation.lastInboundNumber).toBe(LEHI);
    const { message } = await reply(from);
    expect(lastSentFrom()).toBe(LEHI);
    expect(message.from).toBe(LEHI);
    expect(message.status).toBe('sent');
  });

  test('a customer who called the Service number gets texts and calls back from the Service number', async () => {
    const from = nextPhone();
    await call(from, SERVICE);
    await until(() => Conversation.findOne({ customerPhone: from, lastInboundNumber: SERVICE }).lean(), Boolean);
    await reply(from);
    expect(lastSentFrom()).toBe(SERVICE);
    const outbound: any = await startCall(from);
    expect(outbound.from).toBe(SERVICE);
  });

  test('the latest number the customer used wins when they contact a second line', async () => {
    const from = nextPhone();
    await text(from, LEHI);
    await until(() => Conversation.findOne({ customerPhone: from, lastInboundNumber: LEHI }).lean(), Boolean);
    await text(from, SERVICE, 'Also, can I book an oil change?');
    await until(() => Conversation.findOne({ customerPhone: from, lastInboundNumber: SERVICE }).lean(), Boolean);
    await reply(from);
    expect(lastSentFrom()).toBe(SERVICE);
  });

  test('a first text to a lead who never contacted us goes out from their location number, matched without caring about capital letters', async () => {
    const { phone, lead } = await newLead({ location: 'Lehi' });
    await reply(phone, { leadId: lead._id });
    expect(lastSentFrom()).toBe(LEHI);
  });

  test('texts and calls are checked separately: Orem is ready for texts but not calls, so the call uses the main number', async () => {
    const { phone, lead } = await newLead({ location: 'OREM' });
    await reply(phone, { leadId: lead._id });
    expect(lastSentFrom()).toBe(OREM);
    const outbound: any = await startCall(phone, { leadId: lead._id });
    expect(outbound.from).toBe(MAIN);
  });

  test('a lead with no location, or a location whose number is not ready, gets the main number', async () => {
    const plain = await newLead({});
    await reply(plain.phone, { leadId: plain.lead._id });
    expect(lastSentFrom()).toBe(MAIN);
    const provo = await newLead({ location: 'PROVO' });
    await reply(provo.phone, { leadId: provo.lead._id });
    expect(lastSentFrom()).toBe(MAIN);
  });

  test('a number that is not ready is never used, even when the customer texted it', async () => {
    const from = nextPhone();
    await text(from, PROVO);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    expect(lead.location).toBe('PROVO');
    await reply(from, { leadId: lead._id });
    expect(lastSentFrom()).toBe(MAIN);
  });

  test('a customer who texted the current Suprah number gets the reply from that same number', async () => {
    const { phone, lead } = await newLead({ location: 'LEHI' });
    await text(phone, COMPANY);
    await until(() => Conversation.findOne({ customerPhone: phone, lastInboundNumber: COMPANY }).lean(), Boolean);
    await reply(phone, { leadId: lead._id });
    expect(lastSentFrom()).toBe(COMPANY);
  });

  test("another dealership's number is never used, even if it somehow ends up on this conversation", async () => {
    const { phone, lead } = await newLead({ location: 'LEHI' });
    await Conversation.create({ orgId, customerPhone: phone, leadId: lead._id, lastInboundNumber: OTHER_LINE });
    await reply(phone, { leadId: lead._id });
    expect(lastSentFrom()).toBe(LEHI);
  });

  test('a dealership with no ready numbers keeps using the current Suprah number, exactly as before', async () => {
    expect(await resolveOutboundNumber({ organizationId: plainOrgId, channel: 'texts' })).toEqual({ number: COMPANY, label: '', source: 'company' });
    expect(await resolveOutboundNumber({ organizationId: plainOrgId, channel: 'calls', contactedNumber: LEHI })).toEqual({ number: COMPANY, label: '', source: 'company' });
    const phone = nextPhone();
    const { message } = await sendSmsFromUser({ orgId: plainOrgId, user: staff, toPhone: phone, body: 'Hello', destinationPolicy: 'manual' });
    expect(lastSentFrom()).toBe(COMPANY);
    expect(message.from).toBe(COMPANY);
  });

  test('automated texts follow the same rule, even when the sender passes the dealership id in a different form', async () => {
    const from = nextPhone();
    await call(from, SERVICE);
    await until(() => Conversation.findOne({ customerPhone: from, lastInboundNumber: SERVICE }).lean(), Boolean);
    expect(await sendAutomatedSms({ orgId, toPhone: from, body: 'Your appointment is tomorrow at 10 AM. Reply STOP to opt out.' })).toBe(true);
    expect(lastSentFrom()).toBe(SERVICE);
    const outbound: any = await logClientCall({ orgId, user: staff, clientCallId: `cc_p12b_${++serial}`, event: 'start', toPhone: from });
    expect(outbound.from).toBe(SERVICE);
  });

  test('the reply box tells the rep which number the text will come from', async () => {
    const from = nextPhone();
    await text(from, LEHI);
    const lead: any = await until(() => Lead.findOne({ phone: from }).lean(), Boolean);
    await until(() => Conversation.findOne({ customerPhone: from, lastInboundNumber: LEHI }).lean(), Boolean);
    const options = await getLeadReplyOptions(orgId, lead._id);
    expect(options.sms).toMatchObject({ available: true, sender: { number: LEHI, label: 'Lehi Sales' } });
    const plain = await newLead({});
    const plainOptions = await getLeadReplyOptions(orgId, plain.lead._id);
    expect(plainOptions.sms.sender).toEqual({ number: MAIN, label: 'Main' });
  });
});
