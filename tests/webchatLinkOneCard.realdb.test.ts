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
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import webchatRoutes from '../src/routes/webchat.route';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import leadRoutes from '../src/routes/lead.route';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.use('/api/webchat', webchatRoutes);
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const SLUG = `wclink-${orgId}`;
const ownerId = new mongoose.Types.ObjectId();
const crmAdminId = new mongoose.Types.ObjectId();
let token = '';
let phoneSeq = 0;
const nextPhone = () => `+1801555${String(6100 + phoneSeq++).padStart(4, '0')}`;
const auth = () => ({ Authorization: `Bearer ${token}` });
const MESSAGE = 'SupTest Orem - AAU 11.19';

const start = (body: Record<string, unknown>) =>
  request(app).post('/api/webchat/public/sessions').send({ orgKey: SLUG, name: 'SupTest Orem', message: MESSAGE, continueByText: true, ...body });

async function makeLead(phone: string, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ownerId, firstName: 'Test', lastName: 'Email Orem Lead', phone,
    source: 'Third-Party Lead', channel: 'email', status: 'New', isRead: true, ...extra,
  });
}

async function chatLeadOf(sessionId: string) {
  const session: any = await WebChatSession.findById(sessionId).lean();
  return Lead.findById(session.leadId).lean() as any;
}

describe('Real-DB: a website chat linked to the customer\'s lead stays one card (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertOne({
      _id: orgId, name: 'Link Motors', slug: SLUG, status: 'active',
      metadata: { webchatTextMode: true, aiAgentName: 'Anna', aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
    } as any);
    await User.collection.insertOne({ _id: ownerId, organizationId: orgId, name: 'Olivia Owner', email: `wclink-owner-${orgId}@example.com`, role: 'admin', organizationRole: 'admin', isActive: true, password: 'x' } as any);
    await CrmUser.collection.insertOne({ _id: crmAdminId, organizationId: orgId, fullName: 'Ada Admin', username: `wclink-${crmAdminId}`, email: `wclink-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' } as any);
    token = generateCrmToken(String(crmAdminId));
    await setLeadIntakeMode({ organizationId: ORG, mode: 'active', reason: 'test', actor: { userId: String(crmAdminId), name: 'Ada Admin' } });
    clearLeadIntakeModeCache();
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSms.mockReset().mockResolvedValue({ id: `sms-${new mongoose.Types.ObjectId()}` });
  });

  afterAll(async () => {
    if (/_test$/.test(mongoose.connection.name) && mongoose.connection.host === '127.0.0.1') await mongoose.connection.db!.dropDatabase();
  });

  const phone = nextPhone();
  let open: any;
  let closed: any;
  let chat: any;
  let sessionId = '';

  it('a Text Us chat from a phone with an open lead starts one unverified chat card and a Needs Review item, and leaves the open lead alone', async () => {
    open = await makeLead(phone);
    closed = await makeLead(phone, { firstName: 'Test', lastName: 'CarFax Email Lead', status: 'Closed' });
    const res = await start({ phone });
    expect(res.status).toBe(201);
    expect(res.body.data.continuedByText).toBe(true);
    sessionId = res.body.data.sessionId;
    chat = await chatLeadOf(sessionId);
    expect(String(chat._id)).not.toBe(String(open._id));
    expect(chat).toMatchObject({ intakeIdentity: 'unverified', source: 'Website Chat' });
    const inquiry: any = await LeadInquiry.findById(chat.sourceInquiryId).lean();
    expect(inquiry.review).toMatchObject({ state: 'pending', kind: 'possible_match' });
    expect(inquiry.review.candidateLeadIds.map(String)).toEqual([String(open._id)]);
    expect((await Lead.findById(open._id).lean() as any).inquiryCount ?? 1).toBe(1);
    const conversation: any = await Conversation.findOne({ orgId: { $in: [orgId, ORG] }, customerPhone: phone }).lean();
    expect(String(conversation.leadId)).toBe(String(chat._id));
  });

  it('choosing "Same person" leaves one card: the chat card is hidden, points to the customer\'s lead, and everything it had moves there', async () => {
    const task = await AiAgentTask.create({ organizationId: ORG, leadId: chat._id, channel: 'sms', question: 'Safety check service error', status: 'pending', waitingSince: new Date() });
    const staffNote = { _id: new mongoose.Types.ObjectId(), text: 'Called him, trading in a 2015 Civic', createdAt: new Date(Date.now() - 60 * 60 * 1000), authorType: 'user', authorName: 'Ada Admin' };
    const laterNote = { _id: new mongoose.Types.ObjectId(), text: 'Left a voicemail', createdAt: new Date(Date.now() - 5 * 60 * 1000), authorType: 'user', authorName: 'Ada Admin' };
    await Lead.updateOne({ _id: chat._id }, { $push: { notes: staffNote } });
    await Lead.updateOne({ _id: open._id }, { $push: { notes: laterNote } });
    const res = await request(app).post(`/api/crm/lead-intake/reviews/${chat.sourceInquiryId}/resolve`).set(auth()).send({ resolution: 'associate', leadId: String(open._id) });
    expect(res.status).toBe(200);

    const linked: any = await Lead.findById(chat._id).lean();
    expect(linked.status).toBe('Closed');
    expect(linked.intakeIdentity).toBeUndefined();
    expect(String(linked.combinedInto.leadId)).toBe(String(open._id));
    expect(linked.combinedInto).toMatchObject({ via: 'link', previousStatus: 'New' });

    const list = await request(app).get('/api/leads').query({ limit: 100 }).set(auth());
    expect(list.status).toBe(200);
    const listed = list.body.data.leads.map((lead: any) => String(lead._id));
    expect(listed).toContain(String(open._id));
    expect(listed).not.toContain(String(chat._id));

    const conversation: any = await Conversation.findOne({ orgId: { $in: [orgId, ORG] }, customerPhone: phone }).lean();
    expect(String(conversation.leadId)).toBe(String(open._id));
    expect(String((await AiAgentTask.findById(task._id).lean() as any).leadId)).toBe(String(open._id));
    expect(String((await WebChatSession.findById(sessionId).lean() as any).leadId)).toBe(String(open._id));
    const openAfter: any = await Lead.findById(open._id).lean();
    expect(openAfter.inquiryCount).toBe(2);
    expect(openAfter.notes.filter((note: any) => String(note._id) === String(staffNote._id)).map((note: any) => note.text)).toEqual([staffNote.text]);
    const order = openAfter.notes.map((note: any) => String(note._id));
    expect(order.indexOf(String(staffNote._id))).toBeLessThan(order.indexOf(String(laterNote._id)));
    const times = openAfter.notes.map((note: any) => new Date(note.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect((await Lead.findById(closed._id).lean() as any).status).toBe('Closed');

    const active = await request(app).get(`/api/crm/lead-intake/leads/${chat._id}/active-lead`).set(auth());
    expect(active.body.data).toMatchObject({ leadClosed: true, status: 'single' });
    expect(String(active.body.data.lead._id)).toBe(String(open._id));

    const chatView = await request(app).get(`/api/leads/${chat._id}/conversation`).set(auth());
    expect(chatView.status).toBe(200);
    expect(chatView.body.data.combine.combinedInto).toMatchObject({ leadId: String(open._id), via: 'link' });
    expect(chatView.body.data.combine.canUndo).toBe(false);
  });

  it('the customer\'s lead shows the website message once; the text copy is kept but not shown twice', async () => {
    const view = await request(app).get(`/api/leads/${open._id}/conversation`).set(auth());
    expect(view.status).toBe(200);
    const items: any[] = view.body.data.items || [];
    const copies = items.filter((item) => item.body === MESSAGE);
    expect(copies.map((item) => `${item.kind}:${item.channel}`)).toEqual(['message:webchat']);
    const cards = items.filter((item) => item.kind === 'inquiry' && item.inquiry?.kind === 'webchat_session');
    expect(cards).toHaveLength(1);
    expect(cards[0].body).toBe('');
    expect(items.some((item) => item.channel === 'sms' && item.direction === 'outbound' && /Thanks for your message on our website/.test(item.body))).toBe(true);
    expect(await CommunicationMessage.countDocuments({ leadId: open._id, origin: 'inquiry', body: MESSAGE })).toBe(1);
    expect(await WebChatMessage.countDocuments({ leadId: open._id, body: MESSAGE })).toBe(1);
    const earlier = (view.body.data.earlier?.leads || []).map((entry: any) => String(entry._id));
    expect(earlier).toContain(String(closed._id));
    expect(earlier).not.toContain(String(chat._id));
  });

  it('the chat card that was added to the customer\'s lead cannot be reopened; other closed leads still can', async () => {
    const reopen = await request(app).patch(`/api/leads/${chat._id}`).set(auth()).send({ status: 'Pending', reason: 'Customer called back' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.message).toMatch(/added to the customer's lead/);
    const pending = await request(app).patch(`/api/leads/${chat._id}/pending`).set(auth()).send({});
    expect(pending.status).toBe(409);
    expect((await Lead.findById(chat._id).lean() as any).status).toBe('Closed');
    const other = await makeLead(nextPhone(), { firstName: 'Old', lastName: 'Closed Lead', status: 'Closed' });
    const ok = await request(app).patch(`/api/leads/${other._id}`).set(auth()).send({ status: 'Pending', reason: 'Customer called back' });
    expect(ok.status).toBe(200);
    expect((await Lead.findById(other._id).lean() as any).status).toBe('Pending');
  });

  it('"Link to a lead" on a chat card without a review item also leaves one card', async () => {
    const other = nextPhone();
    const started = await start({ phone: other });
    expect(started.status).toBe(201);
    const lone = await chatLeadOf(started.body.data.sessionId);
    expect(lone.intakeIdentity).toBe('unverified');
    const target = await makeLead(other, { firstName: 'Real', lastName: 'Customer' });
    const res = await request(app).post(`/api/crm/lead-intake/leads/${lone._id}/link`).set(auth()).send({ targetLeadId: String(target._id) });
    expect(res.status).toBe(200);
    const linked: any = await Lead.findById(lone._id).lean();
    expect(linked).toMatchObject({ status: 'Closed' });
    expect(linked.intakeIdentity).toBeUndefined();
    expect(String(linked.combinedInto.leadId)).toBe(String(target._id));
    expect(linked.combinedInto.via).toBe('link');
    const conversation: any = await Conversation.findOne({ orgId: { $in: [orgId, ORG] }, customerPhone: other }).lean();
    expect(String(conversation.leadId)).toBe(String(target._id));
    const list = await request(app).get('/api/leads').query({ limit: 100 }).set(auth());
    expect(list.body.data.leads.map((lead: any) => String(lead._id))).not.toContain(String(lone._id));
  });

  it('a website chat with no other lead for that phone is still one normal unverified card', async () => {
    const res = await start({ phone: nextPhone() });
    expect(res.status).toBe(201);
    const lone = await chatLeadOf(res.body.data.sessionId);
    expect(lone).toMatchObject({ intakeIdentity: 'unverified', status: 'New' });
    expect(lone.combinedInto).toBeUndefined();
    const inquiry: any = await LeadInquiry.findById(lone.sourceInquiryId).lean();
    expect(inquiry.review?.state === 'pending').toBe(false);
  });

  it('a start that never finished (for example a restart mid-send) stops blocking the visitor after 2 minutes; a recent one still waits', async () => {
    const insertClaim = (claimKey: string, ageMs: number) => IntakeClaim.collection.insertOne({
      organizationId: orgId, kind: 'webchat_session', claimKey, leadId: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), createdAt: new Date(Date.now() - ageMs),
    } as any);

    const stuckKey = `stuck-${new mongoose.Types.ObjectId()}`;
    await insertClaim(stuckKey, 3 * 60 * 1000);
    const res = await start({ phone: nextPhone(), clientRequestId: stuckKey });
    expect(res.status).toBe(201);
    const lead = await chatLeadOf(res.body.data.sessionId);
    const claims: any[] = await IntakeClaim.find({ organizationId: orgId, kind: 'webchat_session', claimKey: stuckKey }).lean();
    expect(claims.map((claim) => String(claim.leadId))).toEqual([String(lead._id)]);

    const busyKey = `busy-${new mongoose.Types.ObjectId()}`;
    await insertClaim(busyKey, 20 * 1000);
    const busy = await start({ phone: nextPhone(), clientRequestId: busyKey });
    expect(busy.status).toBe(409);
    expect(busy.body.message).toBe('This request is already being processed.');
    expect(await IntakeClaim.countDocuments({ organizationId: orgId, kind: 'webchat_session', claimKey: busyKey, leadId: null })).toBe(1);
  });
});
