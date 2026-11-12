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
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import CrmLocation from '../src/models/CrmLocation.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import webchatRoutes from '../src/routes/webchat.route';

const app = express();
app.use(express.json());
app.use('/api/webchat', webchatRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const plainOrgId = new mongoose.Types.ObjectId();
const SLUG = `textus-${orgId}`;
const PLAIN_SLUG = `textus-plain-${plainOrgId}`;
let phoneSeq = 0;
const nextPhone = () => `+1801555${String(4700 + phoneSeq++).padStart(4, '0')}`;

const textUs = (body: Record<string, unknown>, slug = SLUG) =>
  request(app).post('/api/webchat/public/sessions').send({
    orgKey: slug,
    name: 'ignored',
    firstName: 'Mary Ann',
    lastName: 'De La Cruz',
    phone: nextPhone(),
    message: 'Is this still available?',
    location: 'Lehi',
    ...body,
  });

async function cleanup() {
  const ids = [orgId, plainOrgId];
  const strIds = ids.map(String);
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: ids } }),
    User.collection.deleteMany({ organizationId: { $in: ids } }),
    Lead.collection.deleteMany({ organizationId: { $in: ids } }),
    WebChatSession.collection.deleteMany({ organizationId: { $in: strIds } }),
    WebChatMessage.collection.deleteMany({ organizationId: { $in: strIds } }),
    LeadInquiry.collection.deleteMany({ organizationId: { $in: [...strIds, ...ids] } }),
    IntakeClaim.collection.deleteMany({ organizationId: { $in: ids } }),
    CrmLocation.collection.deleteMany({ organizationId: { $in: strIds } }),
    LeadIntakeControl.collection.deleteMany({ organizationId: { $in: ids } }),
    Conversation.collection.deleteMany({ orgId: { $in: [...ids, ...strIds] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [...ids, ...strIds] } }),
  ]);
}

describe('Real-DB: Text Us website widget (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Text Us Motors', slug: SLUG, status: 'active', metadata: { webchatTextMode: true, aiAgentName: 'Anna', aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: plainOrgId, name: 'Plain Motors', slug: PLAIN_SLUG, status: 'active', metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
    ] as any[]);
    await User.collection.insertMany([
      { organizationId: orgId, name: 'Avery Admin', email: `textus-${orgId}@example.com`, role: 'admin', isActive: true },
      { organizationId: plainOrgId, name: 'Pat Admin', email: `textus-${plainOrgId}@example.com`, role: 'admin', isActive: true },
    ] as any[]);
    const now = new Date();
    await CrmLocation.collection.insertMany([
      { organizationId: String(orgId), code: 'orem', name: 'Orem', aliases: [], aliasKeys: ['orem'], status: 'active', revision: 1, createdAt: now, updatedAt: now },
      { organizationId: String(orgId), code: 'lehi', name: 'Lehi', aliases: ['Lehi Sales'], aliasKeys: ['lehi', 'lehi sales'], status: 'active', revision: 1, createdAt: now, updatedAt: now },
      { organizationId: String(orgId), code: 'provo', name: 'Provo', aliases: [], aliasKeys: ['provo'], status: 'archived', revision: 2, createdAt: now, updatedAt: now },
    ] as any[]);
    await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', createdAt: now, updatedAt: now } as any);
  });

  beforeEach(() => {
    mockSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
  });

  afterAll(cleanup);

  it('1. the public config lists only active dealerships, in order', async () => {
    const res = await request(app).get('/api/webchat/public/config').query({ orgKey: SLUG });
    expect(res.body.data.locations).toEqual(['Lehi', 'Orem']);
    const plain = await request(app).get('/api/webchat/public/config').query({ orgKey: PLAIN_SLUG });
    expect(plain.body.data.locations).toEqual([]);
    const missing = await request(app).get('/api/webchat/public/config').query({ orgKey: 'no-such-dealer' });
    expect(missing.body.data).toMatchObject({ enabled: false, locations: [] });
  });

  it('2. a Text Us message becomes a lead with the right names, dealership, email and vehicle', async () => {
    const res = await textUs({ location: 'lehi sales', email: 'Mary@Example.com', vehicleInterest: '  2021   Toyota Tacoma ', continueByText: true });
    expect(res.status).toBe(201);
    expect(res.body.data.continuedByText).toBe(true);

    const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
    expect(session.location).toBe('Lehi');
    expect(session.visitorName).toBe('Mary Ann De La Cruz');
    const lead: any = await Lead.findById(session.leadId).lean();
    expect(lead).toMatchObject({
      firstName: 'Mary Ann',
      lastName: 'De La Cruz',
      email: 'mary@example.com',
      location: 'Lehi',
      source: 'Website Chat',
      channel: 'sms',
    });
    expect(lead.comments).toBe('Is this still available?\n\nVehicle interest: 2021 Toyota Tacoma');
    const inquiry: any = await LeadInquiry.findOne({ organizationId: String(orgId), 'sourceIds.webchatSessionId': session._id }).lean();
    expect(inquiry?.contact).toMatchObject({ firstName: 'Mary Ann', lastName: 'De La Cruz' });

    const thread = await CommunicationMessage.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean() as any[];
    expect(thread[0].body).toContain('Vehicle interest: 2021 Toyota Tacoma');
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockSms.mock.calls[0])).toContain('Mary Ann');
  });

  it('3. first name, last name, a full mobile number and a dealership are required', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ firstName: '  ' }, 'Please add your first name'],
      [{ lastName: '' }, 'Please add your last name'],
      [{ phone: '' }, 'Please enter your mobile number with the area code'],
      [{ phone: '555-1234' }, 'Please enter your mobile number with the area code'],
      [{ location: '' }, 'Please choose a dealership'],
      [{ location: 'Provo' }, 'Please choose a dealership'],
      [{ location: 'Salt Lake' }, 'Please choose a dealership'],
      [{ email: 'not-an-email' }, 'Please enter a valid email address'],
      [{ message: '' }, 'Please type a message'],
      [{ message: 'x'.repeat(990), vehicleInterest: '2021 Toyota Tacoma' }, 'Messages are limited to 1000 characters'],
    ];
    for (const [body, message] of cases) {
      const res = await textUs(body);
      expect([res.status, res.body.message]).toEqual([400, message]);
    }
    expect(await WebChatSession.countDocuments({ organizationId: String(orgId), visitorName: 'Mary Ann De La Cruz' })).toBe(1);
  });

  it('4. with no dealerships set up, the choice is skipped and the chat stays on the website without the text setting', async () => {
    const res = await textUs({ location: undefined, vehicleInterest: 'Ford F-150', continueByText: true }, PLAIN_SLUG);
    expect(res.status).toBe(201);
    expect(res.body.data.continuedByText).toBe(false);
    const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
    const lead: any = await Lead.findById(session.leadId).lean();
    expect(lead).toMatchObject({ firstName: 'Mary Ann', lastName: 'De La Cruz', channel: 'webchat' });
    expect(lead.location ?? null).toBeNull();
    const first: any = await WebChatMessage.findOne({ sessionId: session._id }).lean();
    expect(first.body).toBe('Is this still available?\n\nVehicle interest: Ford F-150');
    expect(mockSms).not.toHaveBeenCalled();
  });

  it('5. the signed-in customer chat (name + email, no dealership) still works as before', async () => {
    const res = await request(app).post('/api/webchat/public/sessions').send({
      orgKey: SLUG,
      name: 'Rosa Diaz Lopez',
      email: 'rosa@example.com',
      message: 'Hi there',
      vehicleInterest: 'should be ignored',
      location: 'Nowhere',
    });
    expect(res.status).toBe(201);
    const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
    const lead: any = await Lead.findById(session.leadId).lean();
    expect(lead).toMatchObject({ firstName: 'Rosa', lastName: 'Diaz Lopez', email: 'rosa@example.com', comments: 'Hi there' });
    expect(lead.location ?? null).toBeNull();
    expect(session.location ?? null).toBeNull();
  });
});
