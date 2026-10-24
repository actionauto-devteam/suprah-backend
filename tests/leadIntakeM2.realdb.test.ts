const mockSendSms = jest.fn();
const mockAiEmail = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
  playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
  hangupCall: jest.fn().mockResolvedValue(undefined),
  speakIvr: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/services/aiEmailReply.service', () => ({
  triggerAiEmailReplyForNewInquiry: mockAiEmail,
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Vehicle from '../src/models/Vehicle.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import Notification from '../src/models/Notification.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import crmWebchatRoutes from '../src/routes/crmWebchat.routes';
import communicationRoutes from '../src/routes/communication.routes';
import * as webchat from '../src/controllers/webchat.controller';
import appointmentController from '../src/controllers/appointment.controller';
import { telnyxWebhook } from '../src/controllers/communication.controller';
import leadService from '../src/services/lead.service';
import { handleInboundSms, handleCallInitiated, handleCallHangup } from '../src/services/communication.service';
import { recoverLeadIntake } from '../src/services/leadIntake.service';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.post('/public/book', appointmentController.createPublicTestDriveBooking);
app.post('/public/chat', webchat.startSession);
app.post('/public/chat/:sessionId/messages', webchat.sendVisitorMessage);
app.post('/webhooks/telnyx', telnyxWebhook);
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use('/api/crm/webchat', crmWebchatRoutes);
app.use('/api/crm/communications', communicationRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const ids = {
  owner: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(),
  otherOwner: new mongoose.Types.ObjectId(),
  crmAdmin: new mongoose.Types.ObjectId(),
  crmEmployee: new mongoose.Types.ObjectId(),
  crmManager: new mongoose.Types.ObjectId(),
  crmTrustedManager: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
};
const vehicleIds = { truck: new mongoose.Types.ObjectId(), sedan: new mongoose.Types.ObjectId() };
const admin = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
const tokens: Record<string, string> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
let serial = 0;
const nextPhone = () => `+1801555${String(2000 + (++serial)).slice(-4)}`;
const nextEmail = () => `m2customer${++serial}@example.com`;
const smsId = () => `sms-${new mongoose.Types.ObjectId()}`;

async function setMode(mode: 'off' | 'active' | 'paused', org = ORG) {
  await setLeadIntakeMode({ organizationId: org, mode, reason: `test ${mode}`, actor: admin });
  clearLeadIntakeModeCache();
}

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Manual Entry', channel: 'sms', status: 'New', isRead: true, ...extra,
  });
}

const sms = (from: string, text: string, id = smsId()) => handleInboundSms({ from, to: '+18015550999', text, id }, ORG);

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

describe('Real-DB: lifecycle intake Milestone 2 (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = ORG;
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Lifecycle Dealer', slug: `m2-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `m2-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `m2-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.rep, name: 'Ryan Rep', email: `m2-rep-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true },
      { _id: ids.otherOwner, name: 'Other Owner', email: `m2-other-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: otherOrgId, isActive: true },
      { _id: ids.customer, name: 'Casey Customer', email: `m2-casey-${orgId}@example.com`, password: 'x', role: 'customer', isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.crmAdmin, organizationId: orgId, fullName: 'Ada Admin', username: `m2-${ids.crmAdmin}`, email: `m2-crm-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.crmEmployee, organizationId: orgId, fullName: 'Erin Employee', username: `m2-${ids.crmEmployee}`, email: `m2-crm-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.crmManager, organizationId: orgId, fullName: 'Max Manager', username: `m2-${ids.crmManager}`, email: `m2-crm-mgr-${orgId}@example.com`, role: 'manager', isActive: true, password: 'x' },
      { _id: ids.crmTrustedManager, organizationId: orgId, fullName: 'Tara Trusted', username: `m2-${ids.crmTrustedManager}`, email: `m2-crm-tmgr-${orgId}@example.com`, role: 'manager', isActive: true, password: 'x', leadReviewAccess: true },
    ] as any[]);
    await Vehicle.collection.insertMany([
      { _id: vehicleIds.truck, organizationId: orgId, year: 2021, make: 'Toyota', modelName: 'Tacoma', vin: '1HGBH41JXMN109186', stockNumber: 'T100', status: 'Ready for Sale', dealerCity: 'Lehi', price: 30000 },
      { _id: vehicleIds.sedan, organizationId: orgId, year: 2020, make: 'Honda', modelName: 'Civic', vin: '2HGFC2F59LH000001', stockNumber: 'C200', status: 'Ready for Sale', dealerCity: 'Orem', price: 20000 },
    ] as any[]);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'sales@dealer.example.com', accessToken: 'x', refreshToken: 'x',
      expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true, leadSourceEmail: 'leads@dealerscloud.com',
    } as any);
    tokens.admin = generateCrmToken(String(ids.crmAdmin));
    tokens.employee = generateCrmToken(String(ids.crmEmployee));
    tokens.manager = generateCrmToken(String(ids.crmManager));
    tokens.trusted = generateCrmToken(String(ids.crmTrustedManager));
    await setMode('active');
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockSendSms.mockResolvedValue({ id: `out-${new mongoose.Types.ObjectId()}` });
    mockAiEmail.mockReset();
    mockAiEmail.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    delete process.env.COMM_ORG_ID;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  describe('website inquiries', () => {
    it('creates a lead through intake without the old bounce email, then adds a second vehicle to the same open lead', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const base = { organizationId: ORG, customerId: String(ids.customer), customerName: { first: 'Casey', last: 'Cruz' }, customerEmail: email, customerPhone: phone };
      await leadService.processInquiry({ ...base, vehicleId: String(vehicleIds.truck), comments: 'Is the Tacoma available?' });
      const first: any = await Lead.findOne({ organizationId: orgId, email }).lean();
      expect(first).toMatchObject({ source: 'Website Inquiry', channel: 'web', inquiryCount: 1, location: 'Lehi' });
      expect(first.sourceInquiryId).toBeTruthy();
      expect(String(first.vehicleId)).toBe(String(vehicleIds.truck));
      expect(mockAiEmail).not.toHaveBeenCalled();

      await leadService.processInquiry({ ...base, vehicleId: String(vehicleIds.sedan), comments: 'Or the Civic?' });
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
      const updated: any = await Lead.findById(first._id).lean();
      expect(updated.inquiryCount).toBe(2);
      const second: any = await LeadInquiry.findOne({ organizationId: orgId, 'contact.normalizedEmail': email, 'vehicle.model': 'Civic' }).lean();
      expect(second).toMatchObject({ kind: 'website_inquiry', association: { state: 'associated', outcome: 'appended' } });
    });

    it('starts a fresh lead when the earlier lead for this customer is closed', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const closed = await makeLead({ phone, email }, { status: 'Sold' });
      await leadService.processInquiry({
        organizationId: ORG, customerId: String(new mongoose.Types.ObjectId()), vehicleId: String(vehicleIds.truck),
        customerName: { first: 'Pat', last: 'Lee' }, customerEmail: email, customerPhone: phone, comments: 'Back for another truck',
      });
      const leads: any[] = await Lead.find({ organizationId: orgId, email }).sort({ createdAt: 1 }).lean();
      expect(leads).toHaveLength(2);
      expect(String(leads[0]._id)).toBe(String(closed._id));
      expect(leads[0]).toMatchObject({ status: 'Sold', isRead: true });
      expect(leads[1]).toMatchObject({ status: 'New', source: 'Website Inquiry' });
    });
  });

  describe('public test-drive booking', () => {
    const book = (body: Record<string, unknown>) => request(app).post('/public/book').send({
      vehicleId: String(vehicleIds.truck), firstName: 'Bea', lastName: 'Booker', startTime: new Date(Date.now() + 86400000).toISOString(), ...body,
    });

    it('creates the lead and appointment together and replays the same request safely', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const clientRequestId = `req-${new mongoose.Types.ObjectId()}`;
      const first = await book({ phone, email, clientRequestId });
      expect(first.status).toBe(201);
      const { leadId, appointmentId } = first.body.data;
      const lead: any = await Lead.findById(leadId).lean();
      expect(lead).toMatchObject({ status: 'Appointment Set', source: 'Website Booking', location: 'Lehi' });
      const appointment: any = await waitFor(() => Appointment.findById(appointmentId).lean(), (doc: any) => Boolean(doc?.leadId));
      expect(String(appointment.leadId)).toBe(String(leadId));

      const replay = await book({ phone, email, clientRequestId });
      expect(replay.status).toBe(201);
      expect(String(replay.body.data.appointmentId)).toBe(String(appointmentId));
      expect(await Appointment.countDocuments({ organizationId: orgId, 'customerBooking.email': email })).toBe(1);
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
    });

    it('books against the open lead instead of opening a duplicate', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const open = await makeLead({ phone, email }, { status: 'Contacted', assignedTo: ids.rep });
      const res = await book({ phone, email });
      expect(res.status).toBe(201);
      expect(String(res.body.data.leadId)).toBe(String(open._id));
      const appointment: any = await waitFor(() => Appointment.findById(res.body.data.appointmentId).lean(), (doc: any) => Boolean(doc?.leadId));
      expect(String(appointment.leadId)).toBe(String(open._id));
      expect(await Lead.countDocuments({ organizationId: orgId, email })).toBe(1);
      expect((await Lead.findById(open._id).lean() as any).status).toBe('Contacted');
    });
  });

  describe('inbound text messages', () => {
    it('keeps a reply on the customer’s open lead without notifying on every message', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone }, { assignedTo: ids.rep });
      const message: any = await sms(phone, 'What time do you close today?');
      expect(String(message.leadId)).toBe(String(lead._id));
      const conversation: any = await Conversation.findOne({ orgId: ORG, customerPhone: phone }).lean();
      expect(String(conversation.leadId)).toBe(String(lead._id));
      expect((await Lead.findById(lead._id).lean() as any).isRead).toBe(false);
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(1);
      const event: any = await LeadInquiry.findOne({ organizationId: orgId, 'sourceIds.communicationMessageId': message._id }).lean();
      expect(event).toMatchObject({ kind: 'sms', association: { state: 'associated', outcome: 'appended' }, sideEffects: { notification: { state: 'skipped' } } });
      expect(await Notification.countDocuments({ 'metadata.inquiryId': String(event._id) })).toBe(0);
    });

    it('never attaches a new text to a closed lead and opens a fresh lead instead', async () => {
      const phone = nextPhone();
      const closed = await makeLead({ phone }, { status: 'Closed' });
      await Conversation.create({ orgId: ORG, customerPhone: phone, leadId: closed._id });
      const sent: any = await sms(phone, 'Hi, do you have any trucks?');
      const message: any = await CommunicationMessage.findById(sent._id).lean();
      expect(message.leadId).toBeTruthy();
      expect(String(message.leadId)).not.toBe(String(closed._id));
      const fresh: any = await Lead.findById(message.leadId).lean();
      expect(fresh).toMatchObject({ status: 'New', source: 'Inbound SMS', phone });
      expect((await Lead.findById(closed._id).lean() as any)).toMatchObject({ status: 'Closed', isRead: true });
      const conversation: any = await Conversation.findOne({ orgId: ORG, customerPhone: phone }).lean();
      expect(String(conversation.leadId)).toBe(String(fresh._id));
      expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.leadId': String(fresh._id) })).toBeGreaterThanOrEqual(1);
    });

    it('does not create leads from STOP or HELP and still records the opt-out', async () => {
      const phone = nextPhone();
      await sms(phone, 'STOP');
      await sms(phone, 'HELP');
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(0);
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone }).lean() as any)?.optedOut).toBe(true);
      const events: any[] = await LeadInquiry.find({ organizationId: orgId, 'contact.normalizedPhone': phone }).lean();
      expect(events).toHaveLength(2);
      for (const event of events) expect(event.association).toMatchObject({ state: 'resolved', outcome: 'dismissed', reason: 'sms_keyword' });
      await SmsOptOut.deleteOne({ organizationId: ORG, phone });
    });

    it('treats repeated and simultaneous deliveries of the same text as one message', async () => {
      const phone = nextPhone();
      const id = smsId();
      await Promise.all([sms(phone, 'Is the Tacoma still there?', id), sms(phone, 'Is the Tacoma still there?', id)]);
      await sms(phone, 'Is the Tacoma still there?', id);
      expect(await CommunicationMessage.countDocuments({ orgId: ORG, providerMessageId: id })).toBe(1);
      expect(await LeadInquiry.countDocuments({ organizationId: orgId, 'sourceIds.smsProviderMessageId': id })).toBe(1);
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(1);
    });

    it('only treats YES as a confirmation when a reminder actually asked for it', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      const appointment = await Appointment.create({
        organizationId: orgId, createdBy: ids.owner, createdByModel: 'User', participants: [ids.owner], participantModel: 'User',
        title: 'Test drive', startTime: new Date(Date.now() + 2 * 86400000), endTime: new Date(Date.now() + 2 * 86400000 + 3600000),
        type: 'test-drive', entryType: 'appointment', status: 'scheduled', leadId: lead._id,
        customerBooking: { firstName: 'Pat', lastName: 'Lee', email: nextEmail(), phone, isCustomerBooking: false },
      });
      await sms(phone, 'YES');
      expect((await Appointment.findById(appointment._id).lean() as any).status).toBe('scheduled');
      await Appointment.updateOne({ _id: appointment._id }, { $set: { reminderSent: true, reminderSentAt: new Date() } });
      await sms(phone, 'YES');
      expect((await Appointment.findById(appointment._id).lean() as any).status).toBe('confirmed');
    });

    it('sends a text to review when the phone belongs to two open leads and never guesses', async () => {
      const phone = nextPhone();
      await makeLead({ phone }, { email: nextEmail() });
      await makeLead({ phone }, { email: nextEmail(), firstName: 'Sam' });
      const message: any = await sms(phone, 'Hello?');
      const stored: any = await CommunicationMessage.findById(message._id).lean();
      expect(stored.leadId ?? null).toBeNull();
      const event: any = await LeadInquiry.findOne({ 'sourceIds.communicationMessageId': message._id }).lean();
      expect(event).toMatchObject({ association: { state: 'pending_review' }, review: { state: 'pending', kind: 'unassigned' } });
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(2);
    });

    it('stores texts while intake is paused and files them when it resumes', async () => {
      const phone = nextPhone();
      await setMode('paused');
      const message: any = await sms(phone, 'Any SUVs in stock?');
      expect((await CommunicationMessage.findById(message._id).lean() as any).leadId ?? null).toBeNull();
      expect(await Lead.countDocuments({ organizationId: orgId, phone })).toBe(0);
      const event: any = await LeadInquiry.findOne({ 'sourceIds.communicationMessageId': message._id }).lean();
      expect(event.association.state).toBe('received');
      await setMode('active');
      await recoverLeadIntake({ organizationId: ORG });
      const linked: any = await waitFor(() => CommunicationMessage.findById(message._id).lean(), (doc: any) => Boolean(doc?.leadId));
      const lead: any = await Lead.findById(linked.leadId).lean();
      expect(lead).toMatchObject({ phone, status: 'New' });
    });

    it('saves the text before answering Telnyx and asks for a retry when it cannot', async () => {
      const phone = nextPhone();
      const ok = await request(app).post('/webhooks/telnyx').send({
        data: { event_type: 'message.received', payload: { id: smsId(), from: { phone_number: phone }, to: [{ phone_number: '+18015550999' }], text: 'Hi there' } },
      });
      expect(ok.status).toBe(200);
      expect(await LeadInquiry.countDocuments({ organizationId: orgId, 'contact.normalizedPhone': phone })).toBe(1);
      clearLeadIntakeModeCache();
      const outage = jest.spyOn(LeadIntakeControl, 'findOne').mockImplementationOnce(() => { throw new Error('database unavailable'); });
      const failedPhone = nextPhone();
      const failed = await request(app).post('/webhooks/telnyx').send({
        data: { event_type: 'message.received', payload: { id: smsId(), from: { phone_number: failedPhone }, to: [{ phone_number: '+18015550999' }], text: 'Hi there' } },
      });
      outage.mockRestore();
      expect(failed.status).toBe(503);
      expect(await CommunicationMessage.countDocuments({ orgId: ORG, from: failedPhone })).toBe(0);
    });
  });

  describe('inbound calls', () => {
    it('gives a call from a closed-lead customer a fresh lead and leaves the closed lead alone', async () => {
      const phone = nextPhone();
      const closed = await makeLead({ phone }, { status: 'Bought Elsewhere' });
      const callControlId = `cc-${new mongoose.Types.ObjectId()}`;
      const callSessionId = `cs-${new mongoose.Types.ObjectId()}`;
      const payload = { direction: 'incoming', call_control_id: callControlId, call_session_id: callSessionId, from: phone, to: '+18015550999' };
      await Promise.all([handleCallInitiated(payload), handleCallInitiated(payload)]);
      expect(await CallLog.countDocuments({ providerCallControlId: callControlId })).toBe(1);
      const call: any = await waitFor(() => CallLog.findOne({ providerCallControlId: callControlId }).lean(), (doc: any) => Boolean(doc?.leadId));
      expect(String(call.leadId)).not.toBe(String(closed._id));
      expect((await Lead.findById(call.leadId).lean() as any)).toMatchObject({ source: 'Inbound Call', status: 'New' });
      await handleCallHangup({ call_control_id: callControlId, call_session_id: callSessionId, hangup_cause: 'normal_clearing' });
    });
  });

  describe('web chat', () => {
    const startChat = (body: Record<string, unknown>) => request(app).post('/public/chat').send({ orgKey: `m2-${orgId}`, name: 'Vera Visitor', message: 'Hi, is the truck available?', ...body });

    it('keeps a chat from an unverified visitor separate from the matching open lead and flags it for review', async () => {
      const phone = nextPhone();
      const open = await makeLead({ phone }, { status: 'Contacted' });
      const res = await startChat({ phone });
      expect(res.status).toBe(201);
      const session: any = await WebChatSession.findById(res.body.data.sessionId).lean();
      expect(String(session.leadId)).not.toBe(String(open._id));
      const chatLead: any = await Lead.findById(session.leadId).lean();
      expect(chatLead).toMatchObject({ intakeIdentity: 'unverified', source: 'Website Chat' });
      expect(chatLead.customerLink?.status).not.toBe('linked');
      expect((await Lead.findById(open._id).lean() as any).isRead).toBe(true);
      const event: any = await LeadInquiry.findById(chatLead.sourceInquiryId).lean();
      expect(event.review).toMatchObject({ state: 'pending', kind: 'possible_match' });
      expect(event.review.candidateLeadIds.map(String)).toContain(String(open._id));
    });

    it('moves a returning visitor whose chat lead is closed into a fresh conversation and keeps a staff takeover', async () => {
      const email = nextEmail();
      const started = await startChat({ email });
      const { sessionId, token } = started.body.data;
      const session: any = await WebChatSession.findById(sessionId).lean();
      await Lead.updateOne({ _id: session.leadId }, { $set: { status: 'Closed' } });
      await WebChatSession.updateOne({ _id: sessionId }, { $set: { aiPausedAt: new Date(), aiPausedBy: { userId: String(ids.rep), name: 'Ryan Rep' } } });

      const sent = await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'I am back, any updates?' });
      expect(sent.status).toBe(201);
      const next = sent.body.data.session;
      expect(next.sessionId).not.toBe(sessionId);
      const nextSession: any = await WebChatSession.findById(next.sessionId).lean();
      expect(String(nextSession.leadId)).not.toBe(String(session.leadId));
      expect(nextSession.aiPausedAt).toBeTruthy();
      expect(await WebChatMessage.countDocuments({ leadId: session.leadId, body: 'I am back, any updates?' })).toBe(0);
      expect(await WebChatMessage.countDocuments({ leadId: nextSession.leadId, body: 'I am back, any updates?' })).toBe(1);

      const again = await request(app).post(`/public/chat/${sessionId}/messages`).send({ token, message: 'Hello again' });
      expect(again.status).toBe(201);
      expect(again.body.data.session.sessionId).toBe(next.sessionId);
      expect(await WebChatSession.countDocuments({ visitorEmail: email })).toBe(2);
    });

    it('blocks staff replies from a closed chat lead', async () => {
      const started = await startChat({ email: nextEmail() });
      const session: any = await WebChatSession.findById(started.body.data.sessionId).lean();
      await Lead.updateOne({ _id: session.leadId }, { $set: { status: 'Sold' } });
      const res = await request(app).post(`/api/crm/webchat/leads/${session.leadId}/messages`).set(auth('employee')).send({ body: 'Thanks!' });
      expect(res.status).toBe(409);
      expect(res.body.errors?.[0]?.code).toBe('lead_closed');
    });
  });

  describe('needs review', () => {
    async function pendingTextReview() {
      const phone = nextPhone();
      const first = await makeLead({ phone }, { email: nextEmail(), assignedTo: ids.rep });
      const second = await makeLead({ phone }, { email: nextEmail(), firstName: 'Sam' });
      const message: any = await sms(phone, 'Can someone call me?');
      const event: any = await LeadInquiry.findOne({ 'sourceIds.communicationMessageId': message._id }).lean();
      return { phone, first, second, message, event };
    }
    const resolve = (who: string, inquiryId: string, body: Record<string, unknown>) =>
      request(app).post(`/api/crm/lead-intake/reviews/${inquiryId}/resolve`).set(auth(who)).send(body);

    it('lets everyone see the queue but only admins and authorized managers resolve it', async () => {
      const { event } = await pendingTextReview();
      const list = await request(app).get('/api/crm/lead-intake/reviews').set(auth('employee'));
      expect(list.status).toBe(200);
      expect(list.body.data.canResolve).toBe(false);
      expect(list.body.data.items.some((item: any) => item.inquiryId === String(event._id))).toBe(true);
      expect((await resolve('employee', String(event._id), { resolution: 'not_customer_inquiry' })).status).toBe(403);
      expect((await resolve('manager', String(event._id), { resolution: 'not_customer_inquiry' })).status).toBe(403);
      const trustedList = await request(app).get('/api/crm/lead-intake/reviews').set(auth('trusted'));
      expect(trustedList.body.data.canResolve).toBe(true);
    });

    it('adds the text to the chosen lead, files it, tells the rep, and keeps a permanent record', async () => {
      const { first, message, event } = await pendingTextReview();
      const res = await resolve('trusted', String(event._id), { resolution: 'associate', leadId: String(first._id), note: 'Called the customer' });
      expect(res.status).toBe(200);
      expect((await CommunicationMessage.findById(message._id).lean() as any).leadId?.toString()).toBe(String(first._id));
      const saved: any = await LeadInquiry.findById(event._id).lean();
      expect(saved).toMatchObject({ association: { state: 'associated', outcome: 'appended' }, review: { state: 'resolved', resolution: 'associated', note: 'Called the customer' } });
      const audit: any = await LeadIntakeAudit.findOne({ inquiryId: event._id, event: 'review_resolved' }).lean();
      expect(audit).toMatchObject({ resolution: 'associated', actor: { kind: 'staff', userId: String(ids.crmTrustedManager) } });
      expect(await Notification.countDocuments({ type: 'lead_new_inquiry', userId: ids.rep, 'metadata.inquiryId': String(event._id) })).toBe(1);
      expect((await resolve('admin', String(event._id), { resolution: 'not_customer_inquiry' })).status).toBe(409);
    });

    it('can create a fresh lead or dismiss the inquiry, and refuses closed leads as targets', async () => {
      const one = await pendingTextReview();
      const closed = await makeLead({ phone: one.phone }, { status: 'Closed', email: nextEmail() });
      expect((await resolve('admin', String(one.event._id), { resolution: 'associate', leadId: String(closed._id) })).status).toBe(409);
      const created = await resolve('admin', String(one.event._id), { resolution: 'create_lead' });
      expect(created.status).toBe(200);
      expect((await Lead.findById(created.body.data.leadId).lean() as any)).toMatchObject({ status: 'New', phone: one.phone });
      const two = await pendingTextReview();
      const dismissed = await resolve('admin', String(two.event._id), { resolution: 'not_customer_inquiry' });
      expect(dismissed.status).toBe(200);
      expect((await LeadInquiry.findById(two.event._id).lean() as any).association).toMatchObject({ state: 'resolved', outcome: 'dismissed' });
    });

    it('links a verified chat to the existing open lead and moves the conversation there', async () => {
      const phone = nextPhone();
      const open = await makeLead({ phone }, { status: 'Contacted' });
      const started = await request(app).post('/public/chat').send({ orgKey: `m2-${orgId}`, name: 'Pat Lee', phone, message: 'It is Pat again' });
      const session: any = await WebChatSession.findById(started.body.data.sessionId).lean();
      const chatLead: any = await Lead.findById(session.leadId).lean();
      const res = await resolve('admin', String(chatLead.sourceInquiryId), { resolution: 'associate', leadId: String(open._id), note: 'Confirmed by phone' });
      expect(res.status).toBe(200);
      expect(String((await WebChatSession.findById(session._id).lean() as any).leadId)).toBe(String(open._id));
      expect(await WebChatMessage.countDocuments({ leadId: open._id })).toBeGreaterThanOrEqual(1);
      expect((await Lead.findById(chatLead._id).lean() as any).status).toBe('Closed');
    });

    it('keeps each organization’s review items private', async () => {
      const { event } = await pendingTextReview();
      await CrmUser.collection.insertOne({ _id: new mongoose.Types.ObjectId(), organizationId: otherOrgId, fullName: 'Other Admin', username: `m2-other-admin-${orgId}`, email: `m2-other-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' } as any);
      const otherAdmin: any = await CrmUser.findOne({ organizationId: otherOrgId }).lean();
      const otherToken = generateCrmToken(String(otherAdmin._id));
      const res = await request(app).post(`/api/crm/lead-intake/reviews/${event._id}/resolve`).set({ Authorization: `Bearer ${otherToken}` }).send({ resolution: 'not_customer_inquiry' });
      expect(res.status).toBe(404);
      const list = await request(app).get('/api/crm/lead-intake/reviews').set({ Authorization: `Bearer ${otherToken}` });
      expect(list.body.data.items).toHaveLength(0);
      expect(OTHER).not.toBe(ORG);
    });
  });

  describe('closed-lead composer', () => {
    it('points a closed lead to the customer’s active lead, never guesses between two, and can start a fresh one', async () => {
      const phone = nextPhone();
      const email = nextEmail();
      const closed = await makeLead({ phone, email }, { status: 'Closed' });
      const none = await request(app).get(`/api/crm/lead-intake/leads/${closed._id}/active-lead`).set(auth('employee'));
      expect(none.body.data).toMatchObject({ leadClosed: true, status: 'none' });

      const fresh = await request(app).post(`/api/crm/lead-intake/leads/${closed._id}/fresh-lead`).set(auth('employee')).send({});
      expect(fresh.status).toBe(201);
      const single = await request(app).get(`/api/crm/lead-intake/leads/${closed._id}/active-lead`).set(auth('employee'));
      expect(single.body.data).toMatchObject({ leadClosed: true, status: 'single', lead: { _id: fresh.body.data.leadId } });

      await makeLead({ phone, email }, { status: 'Contacted' });
      const multiple = await request(app).get(`/api/crm/lead-intake/leads/${closed._id}/active-lead`).set(auth('employee'));
      expect(multiple.body.data.status).toBe('multiple');
      expect(multiple.body.data.candidates).toHaveLength(2);
    });

    it('blocks a manual text from a closed lead while intake is on, and allows it when intake is off', async () => {
      const phone = nextPhone();
      const closed = await makeLead({ phone }, { status: 'Closed' });
      const blocked = await request(app).post('/api/crm/communications/messages').set(auth('employee')).send({ toPhone: phone, body: 'Hello', leadId: String(closed._id) });
      expect(blocked.status).toBe(409);
      expect(mockSendSms).not.toHaveBeenCalled();
      await setMode('off');
      const allowed = await request(app).post('/api/crm/communications/messages').set(auth('employee')).send({ toPhone: phone, body: 'Hello', leadId: String(closed._id) });
      expect(allowed.status).not.toBe(409);
      await setMode('active');
    });
  });
});
