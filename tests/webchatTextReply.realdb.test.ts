const mockSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return {
    ...actual,
    COMPANY_NUMBER: '+18015550900',
    sendSms: (...args: unknown[]) => mockSms(...args),
    hangupCall: jest.fn().mockResolvedValue(undefined),
    transferToAgent: jest.fn().mockResolvedValue(undefined),
    speakIvr: jest.fn().mockResolvedValue(undefined),
    playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
  safeBroadcastNotification: jest.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import webchatRoutes from '../src/routes/webchat.route';
import { handleInboundSms, handleCallInitiated, handleCallHangup } from '../src/services/communication.service';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';

const app = express();
app.use(express.json());
app.use('/api/webchat', webchatRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const SLUG = `textreply-${orgId}`;
const COMPANY = '+18015550900';
let phoneSeq = 0;
const nextPhone = () => `+1801555${String(4800 + phoneSeq++).padStart(4, '0')}`;
const savedOrg = process.env.COMM_ORG_ID;

const textUs = (phone: string, body: Record<string, unknown> = {}) =>
  request(app).post('/api/webchat/public/sessions').send({
    orgKey: SLUG,
    name: 'ignored',
    firstName: 'Erik',
    lastName: 'Tester',
    phone,
    message: 'Testing Vehicle interest: 2021 Toyota tacoma',
    continueByText: true,
    ...body,
  });

const text = (from: string, body: string) =>
  handleInboundSms({ from, to: COMPANY, text: body, id: `sms-${new mongoose.Types.ObjectId()}` }, ORG);

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

const chatLeadFor = async (phone: string) => {
  const res = await textUs(phone);
  expect(res.status).toBe(201);
  const lead: any = await Lead.findOne({ organizationId: orgId, normalizedPhone: phone, source: 'Website Chat' }).lean();
  expect(lead).toBeTruthy();
  expect(lead.intakeIdentity).toBe('unverified');
  return lead;
};

describe('Real-DB: a text or call from a website chat number joins that chat card (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    process.env.COMM_ORG_ID = ORG;
    await Promise.all([Lead.createIndexes(), Customer.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(), IntakeClaim.init()]);
    for (const index of CUSTOMER_IDENTITY_INDEXES) {
      await mongoose.connection.db!.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    }
    await Organization.collection.insertOne({
      _id: orgId, name: 'Text Reply Motors', slug: SLUG, status: 'active',
      metadata: { webchatTextMode: true, aiAgentName: 'Anna', aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
    } as any);
    await User.collection.insertOne({ organizationId: orgId, name: 'Avery Admin', email: `textreply-${orgId}@example.com`, role: 'admin', organizationRole: 'admin', isActive: true } as any);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    clearLeadIntakeModeCache(ORG);
  });

  beforeEach(() => {
    mockSms.mockReset().mockResolvedValue({ id: `out-${new mongoose.Types.ObjectId()}` });
  });

  afterAll(async () => {
    if (savedOrg === undefined) delete process.env.COMM_ORG_ID;
    else process.env.COMM_ORG_ID = savedOrg;
    if (/_test$/.test(mongoose.connection.name) && mongoose.connection.host === '127.0.0.1') await mongoose.connection.db!.dropDatabase();
  });

  it('keeps the customer in one card when they text back after the website chat, and confirms the card', async () => {
    const phone = nextPhone();
    const chat = await chatLeadFor(phone);

    await text(phone, 'Testing');
    await text(phone, 'Testing with a new message');

    expect(await Lead.countDocuments({ organizationId: orgId, normalizedPhone: phone })).toBe(1);
    const lead: any = await waitFor(() => Lead.findById(chat._id).lean(), (doc: any) => doc?.customerLink?.status === 'linked');
    expect(lead.intakeIdentity).toBeUndefined();
    expect(lead).toMatchObject({ firstName: 'Erik', lastName: 'Tester' });
    expect(lead.customerLink.status).toBe('linked');
    expect(await Customer.countDocuments({ organizationId: orgId, _id: lead.customerId })).toBe(1);

    const inbound = await CommunicationMessage.find({ orgId: { $in: [orgId, ORG] }, from: phone, direction: 'inbound' }).lean();
    expect(inbound.map((message: any) => message.body).sort()).toEqual(['Testing', 'Testing Vehicle interest: 2021 Toyota tacoma', 'Testing with a new message']);
    expect(inbound.every((message: any) => String(message.leadId) === String(chat._id))).toBe(true);
    const conversation: any = await Conversation.findOne({ orgId: { $in: [orgId, ORG] }, customerPhone: phone }).lean();
    expect(String(conversation.leadId)).toBe(String(chat._id));

    const events: any[] = await LeadInquiry.find({ organizationId: { $in: [orgId, ORG] }, kind: 'sms', 'contact.normalizedPhone': phone }).lean();
    expect(events.length).toBe(2);
    expect(events.every((event) => String(event.association.leadId) === String(chat._id))).toBe(true);
    expect(events.map((event) => event.association.reason)).toContain('phone_confirmed_chat');
  });

  it('still sends the text to the confirmed open card the customer already has', async () => {
    const phone = nextPhone();
    const owner: any = await User.findOne({ organizationId: orgId }).lean();
    const real = await Lead.create({ organizationId: orgId, createdBy: owner._id, firstName: 'Pat', lastName: 'Lee', phone, source: 'Manual Entry', channel: 'sms', status: 'Contacted', isRead: true });
    const chat = await chatLeadFor(phone);

    await text(phone, 'Is the Tacoma still there?');

    const message: any = await CommunicationMessage.findOne({ orgId: { $in: [orgId, ORG] }, from: phone, body: 'Is the Tacoma still there?' }).lean();
    expect(String(message.leadId)).toBe(String(real._id));
    expect((await Lead.findById(chat._id).lean() as any).intakeIdentity).toBe('unverified');
    expect(await Lead.countDocuments({ organizationId: orgId, normalizedPhone: phone })).toBe(2);
  });

  it('does not reopen a closed chat card; a later text starts a fresh card', async () => {
    const phone = nextPhone();
    const chat = await chatLeadFor(phone);
    await Lead.updateOne({ _id: chat._id }, { $set: { status: 'Closed' } });

    await text(phone, 'Hello again');

    const leads: any[] = await Lead.find({ organizationId: orgId, normalizedPhone: phone }).lean();
    expect(leads.length).toBe(2);
    const fresh = leads.find((lead) => String(lead._id) !== String(chat._id));
    expect(fresh.intakeIdentity).toBeUndefined();
    expect((await Lead.findById(chat._id).lean() as any)).toMatchObject({ status: 'Closed', intakeIdentity: 'unverified' });
  });

  it('puts a phone call from the chat number in the same card and confirms it', async () => {
    const phone = nextPhone();
    const chat = await chatLeadFor(phone);
    const callControlId = `cc-${new mongoose.Types.ObjectId()}`;
    const callSessionId = `cs-${new mongoose.Types.ObjectId()}`;

    await handleCallInitiated({ direction: 'incoming', call_control_id: callControlId, call_session_id: callSessionId, from: phone, to: COMPANY });

    const call: any = await waitFor(() => CallLog.findOne({ providerCallControlId: callControlId }).lean(), (doc: any) => Boolean(doc?.leadId));
    expect(String(call.leadId)).toBe(String(chat._id));
    expect(await Lead.countDocuments({ organizationId: orgId, normalizedPhone: phone })).toBe(1);
    const lead: any = await waitFor(() => Lead.findById(chat._id).lean(), (doc: any) => doc?.intakeIdentity === undefined);
    expect(lead.intakeIdentity).toBeUndefined();
    await handleCallHangup({ call_control_id: callControlId, call_session_id: callSessionId, hangup_cause: 'originator_cancel' });
  });
});
