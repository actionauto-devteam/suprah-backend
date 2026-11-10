const mockSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550900', sendSms: (...args: unknown[]) => mockSms(...args) };
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
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import webchatRoutes from '../src/routes/webchat.route';

const app = express();
app.use(express.json());
app.use('/api/webchat', webchatRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const offOrgId = new mongoose.Types.ObjectId();
const SLUG = `wctext-${orgId}`;
const OFF_SLUG = `wctext-off-${offOrgId}`;
const adminId = new mongoose.Types.ObjectId();
const offAdminId = new mongoose.Types.ObjectId();
let phoneSeq = 0;
const nextPhone = () => `+1801555${String(4300 + phoneSeq++).padStart(4, '0')}`;

const start = (body: Record<string, unknown>, slug = SLUG) =>
  request(app).post('/api/webchat/public/sessions').send({ orgKey: slug, name: 'Rosa Diaz', message: 'Do you have any SUVs under $25k?', ...body });

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: [orgId, offOrgId] } }),
    User.collection.deleteMany({ organizationId: { $in: [orgId, offOrgId] } }),
    Lead.collection.deleteMany({ organizationId: { $in: [orgId, offOrgId] } }),
    SmsOptOut.collection.deleteMany({ organizationId: { $in: [String(orgId), String(offOrgId)] } }),
    WebChatSession.collection.deleteMany({ organizationId: { $in: [String(orgId), String(offOrgId)] } }),
    WebChatMessage.collection.deleteMany({ organizationId: { $in: [String(orgId), String(offOrgId)] } }),
    LeadInquiry.collection.deleteMany({ organizationId: { $in: [String(orgId), String(offOrgId), orgId, offOrgId] } }),
    IntakeClaim.collection.deleteMany({ organizationId: { $in: [orgId, offOrgId] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [orgId, offOrgId, String(orgId), String(offOrgId)] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [orgId, offOrgId, String(orgId), String(offOrgId)] } }),
  ]);
}

describe('Real-DB: website chat that continues by text (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Text Mode Motors', slug: SLUG, status: 'active', metadata: { webchatTextMode: true, aiAgentName: 'Anna', aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: offOrgId, name: 'Chat Only Motors', slug: OFF_SLUG, status: 'active', metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
    ] as any[]);
    await User.collection.insertMany([
      { _id: adminId, organizationId: orgId, name: 'Avery Admin', email: `wctext-${adminId}@example.com`, role: 'admin', isActive: true },
      { _id: offAdminId, organizationId: offOrgId, name: 'Olly Admin', email: `wctext-${offAdminId}@example.com`, role: 'admin', isActive: true },
    ] as any[]);
  });

  beforeEach(() => {
    mockSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
  });

  afterAll(cleanup);

  it('1. the public config tells the widget to ask for a mobile number and names the dealership', async () => {
    const on = await request(app).get('/api/webchat/public/config').query({ orgKey: SLUG });
    expect(on.body.data).toMatchObject({ enabled: true, textMode: true, dealershipName: 'Text Mode Motors' });
    const off = await request(app).get('/api/webchat/public/config').query({ orgKey: OFF_SLUG });
    expect(off.body.data.textMode).toBe(false);
  });

  it('2. a visitor with a mobile number gets a text right away and the conversation moves to the text thread', async () => {
    const phone = nextPhone();
    const res = await start({ phone, continueByText: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ continuedByText: true, textedTo: `(***) ***-${phone.slice(-4)}`, textNotice: null });
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockSms.mock.calls[0])).toContain('Thanks for your message on our website');

    const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
    expect(session.continuedBySmsAt).toBeTruthy();
    expect(session.smsFallbackSentAt).toBeTruthy();
    const lead: any = await Lead.findById(session.leadId).lean();
    expect(lead.channel).toBe('sms');
    expect(lead.source).toBe('Website Chat');

    const thread = await CommunicationMessage.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean() as any[];
    expect(thread.map((message) => [message.direction, message.origin || null])).toEqual([['inbound', 'inquiry'], ['outbound', null]]);
    expect(thread[0].body).toBe('Do you have any SUVs under $25k?');
    expect(await WebChatMessage.countDocuments({ sessionId: session._id, direction: 'outbound' })).toBe(0);

    const blocked = await request(app).post(`/api/webchat/public/sessions/${session._id}/messages`).send({ token: res.body.data.token, message: 'hello again' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain(`***-${phone.slice(-4)}`);
    const synced = await request(app).post(`/api/webchat/public/sessions/${session._id}/sync`).send({ token: res.body.data.token });
    expect(synced.body.data).toMatchObject({ continuedByText: true, textedTo: `(***) ***-${phone.slice(-4)}` });
  });

  it('3. without the setting, or without the widget asking for it, the chat stays on the website as before', async () => {
    const portal = await start({ phone: nextPhone() });
    expect(portal.body.data).toMatchObject({ continuedByText: false, textedTo: null, textNotice: null });
    const offOrg = await start({ phone: nextPhone(), continueByText: true }, OFF_SLUG);
    expect(offOrg.body.data).toMatchObject({ continuedByText: false, textNotice: null });
    const emailOnly = await start({ email: 'rosa@example.com', continueByText: true });
    expect(emailOnly.body.data.continuedByText).toBe(false);
    expect(mockSms).not.toHaveBeenCalled();
    const session: any = await WebChatSession.findById(portal.body.data.sessionId).lean();
    expect(session.continuedBySmsAt ?? null).toBeNull();
    expect(((await Lead.findById(session.leadId).lean()) as any).channel).toBe('webchat');
  });

  it('4. numbers that cannot be texted keep the chat on the website with a clear note', async () => {
    const dncPhone = nextPhone();
    await Lead.collection.insertOne({ organizationId: orgId, firstName: 'Dee', lastName: 'Dnc', phone: dncPhone, normalizedPhone: dncPhone, status: 'Do Not Contact', source: 'Manual Entry', channel: 'sms', statusHistory: [{ from: 'New', to: 'Do Not Contact', changedAt: new Date(Date.now() - 86400000) }], createdAt: new Date(), updatedAt: new Date() } as any);
    const optedOut = nextPhone();
    await SmsOptOut.collection.insertOne({ organizationId: String(orgId), phone: optedOut, optedOut: true, createdAt: new Date(), updatedAt: new Date() } as any);
    for (const phone of [dncPhone, optedOut, '+639171234567']) {
      const res = await start({ phone, continueByText: true });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ continuedByText: false, textNotice: "We couldn't text that number, so let's keep chatting here." });
      const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
      expect(session.continuedBySmsAt ?? null).toBeNull();
    }
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('5. when the text fails to send, the chat stays on the website and can still get the later text reminder', async () => {
    mockSms.mockReset().mockRejectedValue(new Error('carrier down'));
    const res = await start({ phone: nextPhone(), continueByText: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ continuedByText: false, textNotice: "We couldn't text that number, so let's keep chatting here." });
    const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
    expect(session.continuedBySmsAt ?? null).toBeNull();
    expect(session.smsFallbackSentAt ?? null).toBeNull();
    expect(((await Lead.findById(session.leadId).lean()) as any).channel).toBe('webchat');
    const more = await request(app).post(`/api/webchat/public/sessions/${session._id}/messages`).send({ token: res.body.data.token, message: 'still there?' });
    expect(more.status).toBe(201);
  });

  it('6. sending the same start twice returns the same texted conversation without a second text', async () => {
    const phone = nextPhone();
    const clientRequestId = `wctext-${Date.now()}`;
    const first = await start({ phone, continueByText: true, clientRequestId });
    const again = await start({ phone, continueByText: true, clientRequestId });
    expect(again.body.data).toMatchObject({ sessionId: first.body.data.sessionId, continuedByText: true, textedTo: `(***) ***-${phone.slice(-4)}` });
    expect(mockSms).toHaveBeenCalledTimes(1);
  });
});
