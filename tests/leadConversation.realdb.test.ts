const mockThreadsGet = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: mockThreadsGet }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), generateAuthUrl: jest.fn(), getToken: jest.fn() })) },
    calendar: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/controllers/lead.controller', () => ({
  ...jest.requireActual('../src/controllers/lead.controller'),
  getCentralOAuth2Client: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: jest.fn().mockResolvedValue({ id: 'out-1' }),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import communicationRoutes from '../src/routes/communication.routes';
import { handleSmsStatus } from '../src/services/communication.service';
import { buildLeadTimeline } from '../src/controllers/communication.controller';
import { encrypt } from '../src/utils/crypto';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use('/api/crm/communications', communicationRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids = { owner: new mongoose.Types.ObjectId(), employee: new mongoose.Types.ObjectId(), otherEmployee: new mongoose.Types.ObjectId() };
const admin = { userId: String(ids.employee), name: 'Erin' };
const tokens: Record<string, string> = {};
let serial = 0;
const nextPhone = () => `+1801555${String(6000 + (++serial)).slice(-4)}`;
const nextEmail = () => `conversation${++serial}@example.com`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const savedAcceptance = process.env.LOCAL_UI_ACCEPTANCE_MODE;

const get = (path: string, who = 'employee') => request(app).get(path).set({ Authorization: `Bearer ${tokens[who]}` });
const post = (path: string, who = 'employee', body: Record<string, unknown> = {}) => request(app).post(path).set({ Authorization: `Bearer ${tokens[who]}` }).send(body);

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Website Inquiry', channel: 'web', status: 'New', comments: 'Is the Tacoma available?', ...extra,
  });
}

async function setMode(mode: 'off' | 'active' | 'paused') {
  await setLeadIntakeMode({ organizationId: ORG, mode, reason: `test ${mode}`, actor: admin });
  clearLeadIntakeModeCache();
}

async function text(lead: any, phone: string, direction: 'inbound' | 'outbound', body: string, minutes: number, status = direction === 'inbound' ? 'received' : 'delivered', leadId: unknown = lead?._id) {
  const conversation = await Conversation.findOneAndUpdate(
    { orgId: ORG, customerPhone: phone },
    { $setOnInsert: { orgId: ORG, customerPhone: phone } },
    { upsert: true, new: true },
  );
  const message = await CommunicationMessage.create({
    orgId: ORG, conversationId: conversation!._id, leadId: leadId ?? null, direction, body, from: phone, to: '+18015550999', status,
    ...(direction === 'outbound' ? { sentBy: { userId: String(ids.employee), name: 'Erin' } } : {}),
  });
  await CommunicationMessage.collection.updateOne({ _id: message._id }, { $set: { createdAt: minutesAgo(minutes) } });
  return message;
}

describe('Real-DB: unified lead conversation (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Timeline Dealer', slug: `timeline-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `timeline-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: ids.owner, name: 'Olivia Owner', email: `timeline-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertMany([
      { _id: ids.employee, organizationId: orgId, fullName: 'Erin Employee', username: `timeline-${ids.employee}`, email: `timeline-emp-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.otherEmployee, organizationId: otherOrgId, fullName: 'Other Employee', username: `timeline-${ids.otherEmployee}`, email: `timeline-other-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'Sales@Timeline.example.com', accessToken: encrypt('local-test-access'), refreshToken: encrypt('local-test-refresh'),
      expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true,
    } as any);
    tokens.employee = generateCrmToken(String(ids.employee));
    tokens.other = generateCrmToken(String(ids.otherEmployee));
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockThreadsGet.mockReset();
    mockThreadsGet.mockResolvedValue({ data: { messages: [] } });
  });

  afterAll(async () => {
    if (savedAcceptance === undefined) delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    else process.env.LOCAL_UI_ACCEPTANCE_MODE = savedAcceptance;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('puts texts, email, Web Chat, calls, notes and the inquiry into one ordered timeline with clear statuses', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const threadId = `thread-${serial}`;
    const lead = await makeLead({ phone, email }, {
      threadId,
      notes: [{ text: 'Called, left voicemail', createdAt: minutesAgo(40), authorName: 'Erin', authorType: 'user' }],
    });
    await Lead.collection.updateOne({ _id: lead._id }, { $set: { createdAt: minutesAgo(120) } });
    await text(lead, phone, 'inbound', 'Hi, still available?', 100);
    await text(lead, phone, 'outbound', 'Yes it is!', 90, 'delivered');
    await text(lead, phone, 'outbound', 'Can you come today?', 80, 'pending_reconciliation');
    await text(lead, phone, 'outbound', 'Hello?', 70, 'failed');
    await text(lead, phone, 'outbound', 'Sending now', 1, 'queued');
    const call = await CallLog.create({ orgId: ORG, leadId: lead._id, direction: 'inbound', from: phone, to: '+18015550999', status: 'missed', providerCallControlId: `cc-${serial}` });
    await CallLog.collection.updateOne({ _id: call._id }, { $set: { createdAt: minutesAgo(60), startedAt: minutesAgo(60) } });
    const session = await WebChatSession.create({ organizationId: ORG, leadId: lead._id, tokenHash: 'x', visitorName: 'Pat' });
    const chat = await WebChatMessage.create({ organizationId: ORG, sessionId: session._id, leadId: lead._id, direction: 'inbound', body: 'From the website chat' });
    await WebChatMessage.collection.updateOne({ _id: chat._id }, { $set: { createdAt: minutesAgo(50) } });
    mockThreadsGet.mockResolvedValue({ data: { messages: [
      { id: 'g-in', threadId, internalDate: String(minutesAgo(30).getTime()), payload: { headers: [{ name: 'From', value: `Pat Lee <${email}>` }, { name: 'Subject', value: 'Re: Tacoma' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: b64('<p>I can come at 5</p>') } }] }] } },
      { id: 'g-out', threadId, internalDate: String(minutesAgo(20).getTime()), payload: { headers: [{ name: 'From', value: 'Sales <sales@timeline.example.com>' }], mimeType: 'text/plain', body: { data: b64('See you then\n\nOn Mon, Pat wrote:\n> I can come at 5') } } },
    ] } });

    const res = await get(`/api/leads/${lead._id}/conversation`);
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    const times = items.map((item: any) => item.occurredAt);
    expect([...times].sort()).toEqual(times);
    expect(items.map((item: any) => item.channel)).toEqual(['inquiry', 'sms', 'sms', 'sms', 'sms', 'call', 'webchat', 'note', 'email', 'email', 'sms']);
    expect(items[0].inquiry).toMatchObject({ isOriginal: true });
    expect(items.filter((item: any) => item.channel === 'sms').map((item: any) => item.status.label))
      .toEqual(['Received', 'Delivered', "Couldn't confirm delivery", 'Failed', 'Sending']);
    expect(items.find((item: any) => item.channel === 'call').call).toMatchObject({ status: 'missed', label: 'Missed' });
    const emails = items.filter((item: any) => item.channel === 'email');
    expect(emails.map((item: any) => [item.direction, item.status.label, item.body])).toEqual([
      ['inbound', 'Received', 'I can come at 5'],
      ['outbound', 'Sent', 'See you then'],
    ]);
    expect(new Set(items.map((item: any) => item.id)).size).toBe(items.length);

    const again = await get(`/api/leads/${lead._id}/conversation`);
    expect(again.body.data.items.map((item: any) => item.id)).toEqual(items.map((item: any) => item.id));

    const firstPage = await get(`/api/leads/${lead._id}/conversation?limit=4`);
    expect(firstPage.body.data.items).toHaveLength(4);
    expect(firstPage.body.data.nextCursor).toBeTruthy();
    const older = await get(`/api/leads/${lead._id}/conversation?limit=20&before=${firstPage.body.data.nextCursor}`);
    const combined = [...older.body.data.items, ...firstPage.body.data.items].map((item: any) => item.id);
    expect(combined).toEqual(items.map((item: any) => item.id));
  });

  it('keeps each lead’s messages on its own lead and links the same customer’s leads as earlier conversations', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const closed = await makeLead({ phone, email }, { status: 'Sold' });
    const fresh = await makeLead({ phone, email }, { status: 'New' });
    await text(closed, phone, 'inbound', 'Old question', 500);
    await text(fresh, phone, 'inbound', 'New question', 5);
    await text(null, phone, 'inbound', 'Before any lead existed', 900, 'received', null);

    const closedView = await get(`/api/leads/${closed._id}/conversation`);
    const closedBodies = closedView.body.data.items.map((item: any) => item.body);
    expect(closedBodies).toContain('Old question');
    expect(closedBodies).not.toContain('New question');
    expect(closedBodies).not.toContain('Before any lead existed');
    expect(closedView.body.data.earlier.leads.map((entry: any) => entry._id)).toEqual([String(fresh._id)]);

    const freshView = await get(`/api/leads/${fresh._id}/conversation`);
    expect(freshView.body.data.items.map((item: any) => item.body)).not.toContain('Old question');
    expect(freshView.body.data.earlier).toMatchObject({ available: true, unlinkedCount: 1 });
    expect(freshView.body.data.earlier.leads[0]).toMatchObject({ _id: String(closed._id), closed: true });

    const earlier = await get(`/api/leads/${fresh._id}/conversation/earlier/${closed._id}`);
    expect(earlier.status).toBe(200);
    expect(earlier.body.data.items.map((item: any) => item.body)).toContain('Old question');
    const unlinked = await get(`/api/leads/${fresh._id}/conversation/earlier/unlinked`);
    expect(unlinked.body.data.items.map((item: any) => item.body)).toEqual(['Before any lead existed']);

    const stranger = await makeLead({ phone: nextPhone(), email: nextEmail() });
    expect((await get(`/api/leads/${fresh._id}/conversation/earlier/${stranger._id}`)).status).toBe(404);
  });

  it('never shows another customer’s history because they share a phone number', async () => {
    const phone = nextPhone();
    const first = await makeLead({ phone, email: nextEmail() });
    const second = await makeLead({ phone, email: nextEmail() });
    await text(first, phone, 'inbound', 'First customer message', 30);
    await text(null, phone, 'inbound', 'Unlinked message', 60, 'received', null);
    const view = await get(`/api/leads/${second._id}/conversation`);
    expect(view.body.data.items.map((item: any) => item.body)).not.toContain('First customer message');
    expect(view.body.data.earlier).toMatchObject({ available: true, leads: [], unlinkedCount: 0 });
    expect((await get(`/api/leads/${second._id}/conversation/earlier/${first._id}`)).status).toBe(404);
    expect((await get(`/api/leads/${second._id}/conversation/earlier/unlinked`)).status).toBe(404);
  });

  it('shows no earlier history for an unverified chat lead', async () => {
    const phone = nextPhone();
    await makeLead({ phone }, { status: 'Closed' });
    const chatLead = await makeLead({ phone }, { intakeIdentity: 'unverified', channel: 'webchat', source: 'Website Chat' });
    const view = await get(`/api/leads/${chatLead._id}/conversation`);
    expect(view.body.data.lead.unverified).toBe(true);
    expect(view.body.data.earlier).toMatchObject({ available: false, reason: 'unverified', leads: [] });
  });

  it('moves a reply that belongs to a newer lead off the closed lead’s email thread', async () => {
    const email = nextEmail();
    const threadId = `thread-${serial}`;
    const closed = await makeLead({ email }, { status: 'Closed', threadId });
    const fresh = await makeLead({ email });
    await LeadInquiry.create({
      organizationId: orgId, kind: 'email_reply', receivedAt: new Date(), channel: 'email', contact: { email, normalizedEmail: email },
      comments: 'I want another car', sourceIds: { gmailMessageId: 'g-new', gmailThreadId: threadId },
      association: { state: 'associated', leadId: fresh._id, outcome: 'appended' },
    });
    mockThreadsGet.mockResolvedValue({ data: { messages: [
      { id: 'g-old', threadId, internalDate: String(minutesAgo(600).getTime()), payload: { headers: [{ name: 'From', value: email }], mimeType: 'text/plain', body: { data: b64('Old reply') } } },
      { id: 'g-new', threadId, internalDate: String(minutesAgo(5).getTime()), payload: { headers: [{ name: 'From', value: email }], mimeType: 'text/plain', body: { data: b64('I want another car') } } },
    ] } });
    const closedView = await get(`/api/leads/${closed._id}/conversation`);
    const closedEmails = closedView.body.data.items.filter((item: any) => item.channel === 'email').map((item: any) => item.body);
    expect(closedEmails).toEqual(['Old reply']);
    const freshView = await get(`/api/leads/${fresh._id}/conversation`);
    expect(freshView.body.data.items.filter((item: any) => item.channel === 'email').map((item: any) => item.body)).toEqual(['I want another car']);
  });

  it('keeps email trouble from hiding the rest of the conversation', async () => {
    const phone = nextPhone();
    const lead = await makeLead({ phone }, { threadId: `thread-${serial}` });
    await text(lead, phone, 'inbound', 'Text still shows', 10);
    mockThreadsGet.mockRejectedValue(new Error('Gmail unavailable'));
    const view = await get(`/api/leads/${lead._id}/conversation`);
    expect(view.status).toBe(200);
    expect(view.body.data.unavailableSources).toEqual(['email']);
    expect(view.body.data.items.map((item: any) => item.body)).toContain('Text still shows');
  });

  it('blocks the composer on closed leads only while lifecycle intake is on, and leaves Do Not Contact to its own rules', async () => {
    const closed = await makeLead({ phone: nextPhone() }, { status: 'Closed' });
    const dnc = await makeLead({ phone: nextPhone() }, { status: 'Do Not Contact' });
    await setMode('off');
    expect((await get(`/api/leads/${closed._id}/conversation`)).body.data.composer).toMatchObject({ closed: true, blocked: false, intakeMode: 'off' });
    await setMode('active');
    expect((await get(`/api/leads/${closed._id}/conversation`)).body.data.composer).toMatchObject({ closed: true, blocked: true, intakeMode: 'active' });
    expect((await get(`/api/leads/${dnc._id}/conversation`)).body.data.composer).toMatchObject({ blocked: false });
    await setMode('off');
  });

  it('shows an inquiry that also arrived as a text only once', async () => {
    const phone = nextPhone();
    const lead = await makeLead({ phone }, { comments: 'Is the RAV4 available?' });
    await text(lead, phone, 'inbound', 'Is the RAV4 available?', 0);
    await CommunicationMessage.collection.updateOne({ leadId: lead._id }, { $set: { createdAt: new Date(new Date(lead.createdAt).getTime() + 1000) } });
    const items = (await get(`/api/leads/${lead._id}/conversation`)).body.data.items;
    expect(items.filter((item: any) => item.body === 'Is the RAV4 available?')).toHaveLength(1);
  });

  it('keeps every organization’s conversations private', async () => {
    const lead = await makeLead({ phone: nextPhone() });
    expect((await get(`/api/leads/${lead._id}/conversation`, 'other')).status).toBe(404);
  });

  it.each(['off', 'active', 'paused'] as const)('keeps ownership and earlier history correct with lifecycle intake %s', async (mode) => {
    await setMode(mode);
    const phone = nextPhone();
    const email = nextEmail();
    const closed = await makeLead({ phone, email }, { status: 'Closed' });
    const fresh = await makeLead({ phone, email });
    const stranger = await makeLead({ phone, email: nextEmail() });
    await text(closed, phone, 'inbound', `${mode} old`, 300);
    await text(fresh, phone, 'inbound', `${mode} new`, 10);
    await text(stranger, phone, 'inbound', `${mode} stranger`, 20);
    const closedBodies = (await get(`/api/leads/${closed._id}/conversation`)).body.data.items.map((item: any) => item.body);
    expect(closedBodies).toContain(`${mode} old`);
    expect(closedBodies).not.toContain(`${mode} new`);
    expect(closedBodies).not.toContain(`${mode} stranger`);
    const freshView = (await get(`/api/leads/${fresh._id}/conversation`)).body.data;
    expect(freshView.earlier.leads.map((entry: any) => entry._id)).toEqual([String(closed._id)]);
    const strangerView = (await get(`/api/leads/${stranger._id}/conversation`)).body.data;
    expect(strangerView.earlier.leads).toEqual([]);
    expect(strangerView.items.map((item: any) => item.body)).toEqual(expect.not.arrayContaining([`${mode} old`, `${mode} new`]));
    await setMode('off');
  });

  it('keeps the old phone and Gmail thread endpoints lead-only once lifecycle intake is on', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const threadId = `thread-${serial}`;
    const closed = await makeLead({ phone, email }, { status: 'Closed', threadId });
    const fresh = await makeLead({ phone, email });
    await text(closed, phone, 'inbound', 'Closed lead text', 300);
    await text(fresh, phone, 'inbound', 'Fresh lead text', 10);
    await LeadInquiry.create({
      organizationId: orgId, kind: 'email_reply', receivedAt: new Date(), channel: 'email', contact: { email, normalizedEmail: email },
      comments: 'Reply that belongs to the fresh lead', sourceIds: { gmailMessageId: 'g-fresh', gmailThreadId: threadId },
      association: { state: 'associated', leadId: fresh._id, outcome: 'appended' },
    });
    mockThreadsGet.mockResolvedValue({ data: { messages: [
      { id: 'g-closed', threadId, internalDate: String(minutesAgo(600).getTime()), payload: { headers: [{ name: 'From', value: email }], mimeType: 'text/plain', body: { data: b64('Closed lead email') } } },
      { id: 'g-fresh', threadId, internalDate: String(minutesAgo(5).getTime()), payload: { headers: [{ name: 'From', value: email }], mimeType: 'text/plain', body: { data: b64('Reply that belongs to the fresh lead') } } },
    ] } });
    const byPhone = (lead: any) => get(`/api/crm/communications/threads/by-phone?phone=${encodeURIComponent(phone)}&leadId=${lead._id}`);
    await setMode('off');
    expect((await byPhone(closed)).body.data.messages.map((m: any) => m.body)).toEqual(expect.arrayContaining(['Closed lead text', 'Fresh lead text']));
    await setMode('active');
    expect((await byPhone(closed)).body.data.messages.map((m: any) => m.body)).toEqual(['Closed lead text']);
    const legacyEmail = await get(`/api/leads/${closed._id}/thread`);
    expect(legacyEmail.body.data.messages.map((m: any) => m.id)).toEqual(['g-closed']);
    await setMode('off');
  });

  it('never moves a text delivery status backwards, even when receipts arrive out of order', async () => {
    const phone = nextPhone();
    const lead = await makeLead({ phone });
    const message = await text(lead, phone, 'outbound', 'Status check', 5, 'queued');
    await CommunicationMessage.updateOne({ _id: message._id }, { $set: { providerMessageId: `pm-${serial}` } });
    await handleSmsStatus({ id: `pm-${serial}`, to: [{ status: 'delivered' }] });
    await handleSmsStatus({ id: `pm-${serial}`, to: [{ status: 'sent' }] });
    await handleSmsStatus({ id: `pm-${serial}`, to: [{ status: 'sending_failed' }] });
    const item = (await get(`/api/leads/${lead._id}/conversation`)).body.data.items.find((entry: any) => entry.body === 'Status check');
    expect(item.status).toMatchObject({ code: 'delivered', label: 'Delivered' });
  });

  it('only lets staff of the same dealership use the closed-lead actions, and refuses unsafe ones', async () => {
    await setMode('active');
    const phone = nextPhone();
    const closed = await makeLead({ phone }, { status: 'Closed' });
    const open = await makeLead({ phone: nextPhone() });
    const dnc = await makeLead({ phone: nextPhone() }, { status: 'Do Not Contact' });
    const unverified = await makeLead({ phone: nextPhone() }, { status: 'Closed', intakeIdentity: 'unverified' });
    expect((await get(`/api/crm/lead-intake/leads/${closed._id}/active-lead`, 'other')).status).toBe(404);
    expect((await post(`/api/crm/lead-intake/leads/${closed._id}/fresh-lead`, 'other')).status).toBe(404);
    expect((await get(`/api/leads/${closed._id}/conversation/earlier/unlinked`, 'other')).status).toBe(404);
    expect((await post(`/api/crm/lead-intake/leads/${open._id}/fresh-lead`)).status).toBe(409);
    expect((await post(`/api/crm/lead-intake/leads/${dnc._id}/fresh-lead`)).status).toBe(409);
    expect((await post(`/api/crm/lead-intake/leads/${unverified._id}/fresh-lead`)).status).toBe(409);
    expect((await request(app).post(`/api/crm/lead-intake/leads/${closed._id}/fresh-lead`).send({})).status).toBe(401);
    const created = await post(`/api/crm/lead-intake/leads/${closed._id}/fresh-lead`);
    expect(created.status).toBe(201);
    expect((await Lead.findById(closed._id).lean() as any).status).toBe('Closed');
    await setMode('off');
    expect((await post(`/api/crm/lead-intake/leads/${closed._id}/fresh-lead`)).status).toBe(409);
  });

  it('separates the Activity tab by lead only once lifecycle intake is on', async () => {
    const phone = nextPhone();
    const older = await makeLead({ phone, email: nextEmail() }, { status: 'Closed' });
    const newer = await makeLead({ phone, email: nextEmail() });
    await text(older, phone, 'inbound', 'Older lead text', 30);
    await text(newer, phone, 'inbound', 'Newer lead text', 10);
    await setMode('off');
    const legacy = await buildLeadTimeline(ORG, String(newer._id));
    expect(legacy.items.map((item: any) => item.body)).toEqual(expect.arrayContaining(['Older lead text', 'Newer lead text']));
    await setMode('active');
    const separated = await buildLeadTimeline(ORG, String(newer._id));
    const bodies = separated.items.map((item: any) => item.body);
    expect(bodies).toContain('Newer lead text');
    expect(bodies).not.toContain('Older lead text');
    await setMode('off');
  });
});
