const mockSendSms = jest.fn();
const mockSendMail = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550000',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
  createTransport: () => ({ sendMail: mockSendMail }),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/googleCalendar.service', () => ({
  __esModule: true,
  default: {
    syncAppointmentToGoogleCalendar: jest.fn().mockResolvedValue(undefined),
    deleteFromGoogleCalendar: jest.fn().mockResolvedValue(undefined),
    isCrmUserCalendarConnected: jest.fn().mockResolvedValue(true),
  },
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import EmailOptOut from '../src/models/EmailOptOut.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import ContactRestrictionAudit from '../src/models/ContactRestrictionAudit.model';
import ContactRestrictionIdentifier from '../src/models/ContactRestrictionIdentifier.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import tokenService from '../src/services/token.service';
import leadRoutes from '../src/routes/lead.route';
import crmWebchatRoutes from '../src/routes/crmWebchat.routes';
import crmCalendarRoutes from '../src/routes/crmCalendar.routes';
import { sendSmsFromUser } from '../src/services/communication.service';
import { sendWebchatUnavailableAck } from '../src/controllers/webchat.controller';
import { CONTACT_RESTRICTION_MESSAGES, resolveContactRestriction } from '../src/services/contactRestriction.service';
import appointmentService from '../src/services/appointment.service';
import { sendReminderFor } from '../src/schedulers/appointmentReminder.scheduler';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use('/api/crm/webchat', crmWebchatRoutes);
app.use('/api/crm/calendar', crmCalendarRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors, code: error.code }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const people = {
  admin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  otherAdmin: new mongoose.Types.ObjectId(),
  superAdmin: new mongoose.Types.ObjectId(),
  mainOrgAdmin: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const auth = (who: keyof typeof people) => ({ Authorization: `Bearer ${tokens[who]}` });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

const PHONE = {
  removal: '+18015550181',
  mainAdmin: '+18015550182',
  race: '+18015550183',
  contact: '+18015550184',
  contactNew: '+18015550185',
  appointment: '+18015550186',
  chat: '+18015550187',
  chatLate: '+18015550188',
  open: '+18015550189',
  otherOrg: '+18015550190',
};
const ids = {
  removal: new mongoose.Types.ObjectId(),
  mainAdmin: new mongoose.Types.ObjectId(),
  race: new mongoose.Types.ObjectId(),
  contact: new mongoose.Types.ObjectId(),
  appointment: new mongoose.Types.ObjectId(),
  chatDnc: new mongoose.Types.ObjectId(),
  chatLead: new mongoose.Types.ObjectId(),
  chatLateDnc: new mongoose.Types.ObjectId(),
  chatLateLead: new mongoose.Types.ObjectId(),
  openLead: new mongoose.Types.ObjectId(),
  otherOrgDnc: new mongoose.Types.ObjectId(),
  otherOrgChatLead: new mongoose.Types.ObjectId(),
};

function rawLead(_id: mongoose.Types.ObjectId, status: string, phone: string, extra: Record<string, unknown> = {}, organizationId = orgId) {
  const now = new Date();
  return {
    _id,
    organizationId,
    createdBy: people.admin,
    firstName: 'Pat',
    lastName: 'Lee',
    status,
    phone,
    normalizedPhone: phone,
    source: 'Manual Entry',
    channel: 'sms',
    statusHistory: status === 'Do Not Contact' ? [{ from: 'New', to: 'Do Not Contact', changedAt: minutesAgo(120), changedBy: people.admin }] : [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

async function chatSession(leadId: mongoose.Types.ObjectId, phone: string, organizationId = ORG) {
  const session = await WebChatSession.create({
    organizationId,
    leadId,
    tokenHash: `hash-${new mongoose.Types.ObjectId()}`,
    visitorName: 'Pat Lee',
    visitorPhone: phone,
  });
  return session;
}

async function inbound(session: any, createdAt: Date, body = 'Is it still available?') {
  const [message] = await WebChatMessage.collection.insertMany([
    { organizationId: String(session.organizationId), sessionId: session._id, leadId: session.leadId, direction: 'inbound', body, aiDispatchPending: false, createdAt, updatedAt: createdAt },
  ] as any[]).then((result) => Object.values(result.insertedIds));
  return message;
}

const staffReply = (leadId: mongoose.Types.ObjectId, who: keyof typeof people = 'employee') =>
  request(app).post(`/api/crm/webchat/leads/${leadId}/messages`).set(auth(who)).send({ body: 'Thanks for asking, it is on the lot today.' });

describe('Real-DB R1.1: Do Not Contact hardening (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Organization.collection.insertMany([
      { _id: orgId, name: 'R1.1 Dealer', slug: `r11-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'R1.1 Other Dealer', slug: `r11-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    const crm = (_id: mongoose.Types.ObjectId, role: string, name: string, organizationId = orgId) => ({
      _id, organizationId, fullName: name, username: `r11-${_id}`, email: `r11-${_id}@example.com`, role, isActive: true, password: 'x',
    });
    await CrmUser.collection.insertMany([
      crm(people.admin, 'admin', 'Ada Admin'),
      crm(people.manager, 'manager', 'Max Manager'),
      crm(people.employee, 'employee', 'Erin Employee'),
      crm(people.otherAdmin, 'admin', 'Olive Other', otherOrgId),
    ] as any[]);
    await User.collection.insertMany([
      { _id: people.superAdmin, name: 'Sky Platform', email: `r11-super-${orgId}@example.com`, password: 'x', role: 'super_admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: people.mainOrgAdmin, name: 'Mona Owner', email: `r11-owner-${orgId}@example.com`, password: 'x', role: 'employee', organizationRole: 'admin', organizationId: orgId, isActive: true },
    ] as any[]);
    for (const who of ['admin', 'manager', 'employee', 'otherAdmin'] as const) tokens[who] = generateCrmToken(String(people[who]));
    tokens.superAdmin = tokenService.generateAccessToken({ _id: people.superAdmin, email: `r11-super-${orgId}@example.com`, role: 'super_admin', organizationId: orgId });
    tokens.mainOrgAdmin = tokenService.generateAccessToken({ _id: people.mainOrgAdmin, email: `r11-owner-${orgId}@example.com`, role: 'employee', organizationId: orgId });

    await Lead.collection.insertMany([
      rawLead(ids.removal, 'Do Not Contact', PHONE.removal, { email: 'removal@example.com', normalizedEmail: 'removal@example.com' }),
      rawLead(ids.mainAdmin, 'Do Not Contact', PHONE.mainAdmin),
      rawLead(ids.race, 'New', PHONE.race, { email: 'race@example.com', normalizedEmail: 'race@example.com' }),
      rawLead(ids.contact, 'Do Not Contact', PHONE.contact, { email: 'old-contact@example.com', normalizedEmail: 'old-contact@example.com' }),
      rawLead(ids.appointment, 'Do Not Contact', PHONE.appointment, { email: 'dnc-appointment@example.com', normalizedEmail: 'dnc-appointment@example.com' }),
      rawLead(ids.chatDnc, 'Do Not Contact', PHONE.chat),
      rawLead(ids.chatLead, 'New', PHONE.chat, { channel: 'webchat' }),
      rawLead(ids.chatLateDnc, 'Do Not Contact', PHONE.chatLate, { statusHistory: [{ from: 'New', to: 'Do Not Contact', changedAt: minutesAgo(5), changedBy: people.admin }] }),
      rawLead(ids.chatLateLead, 'New', PHONE.chatLate, { channel: 'webchat' }),
      rawLead(ids.openLead, 'New', PHONE.open, { channel: 'webchat' }),
      rawLead(ids.otherOrgDnc, 'Do Not Contact', PHONE.otherOrg, {}, otherOrgId),
      rawLead(ids.otherOrgChatLead, 'New', PHONE.otherOrg, { channel: 'webchat' }),
    ] as any[]);
    await SmsOptOut.create({ organizationId: ORG, phone: PHONE.removal, optedOut: true, keyword: 'STOP', changedAt: new Date() });
    await EmailOptOut.create({ organizationId: ORG, email: 'removal@example.com', optedOut: true } as any);
  });

  beforeEach(() => {
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `tx-${new mongoose.Types.ObjectId()}` }));
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'smtp-1' });
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  describe('removing Do Not Contact', () => {
    it('refuses managers, employees, platform super_admins, and admins of another organization', async () => {
      const body = { status: 'Contacted', reason: 'Customer asked us to call' };
      for (const who of ['manager', 'employee', 'superAdmin'] as const) {
        const res = await request(app).patch(`/api/leads/${ids.removal}`).set(auth(who)).send(body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('CONTACT_RESTRICTION_ADMIN_ONLY');
      }
      const other = await request(app).patch(`/api/leads/${ids.removal}`).set(auth('otherAdmin')).send(body);
      expect(other.status).toBe(404);
      expect((await Lead.findById(ids.removal).lean())?.status).toBe('Do Not Contact');
      expect(await ContactRestrictionAudit.countDocuments({ leadId: ids.removal, event: 'dnc_removed' })).toBe(0);
    });

    it('requires a reason, then records a permanent audit entry and leaves STOP and unsubscribe in place', async () => {
      const noReason = await request(app).patch(`/api/leads/${ids.removal}`).set(auth('admin')).send({ status: 'Contacted' });
      expect(noReason.status).toBe(400);

      const res = await request(app).patch(`/api/leads/${ids.removal}`).set(auth('admin')).send({ status: 'Contacted', reason: 'Customer called and asked to be contacted again' });
      expect(res.status).toBe(200);
      const audit: any = await ContactRestrictionAudit.findOne({ leadId: ids.removal, event: 'dnc_removed' }).lean();
      expect(audit).toMatchObject({
        fromStatus: 'Do Not Contact',
        toStatus: 'Contacted',
        reason: 'Customer called and asked to be contacted again',
        actor: { kind: 'staff', userId: String(people.admin), name: 'Ada Admin' },
      });
      expect(String(audit.organizationId)).toBe(ORG);
      expect(audit.createdAt).toBeInstanceOf(Date);
      expect((await SmsOptOut.findOne({ organizationId: ORG, phone: PHONE.removal }).lean())?.optedOut).toBe(true);
      expect((await EmailOptOut.findOne({ organizationId: ORG, email: 'removal@example.com' }).lean())?.optedOut).toBe(true);
    });

    it('lets a main-app organization admin remove it in their own organization', async () => {
      const res = await request(app).patch(`/api/leads/${ids.mainAdmin}`).set(auth('mainOrgAdmin')).send({ status: 'Contacted', reason: 'Owner confirmed with the customer' });
      expect(res.status).toBe(200);
      expect(await ContactRestrictionAudit.countDocuments({ leadId: ids.mainAdmin, event: 'dnc_removed' })).toBe(1);
    });

    it('keeps audit records permanent: no expiry index and no edits or deletes', async () => {
      const indexes = await ContactRestrictionAudit.collection.indexes();
      expect(indexes.some((index: any) => index.expireAfterSeconds !== undefined)).toBe(false);
      await expect(ContactRestrictionAudit.updateOne({ leadId: ids.removal }, { $set: { reason: 'changed' } })).rejects.toThrow();
      await expect(ContactRestrictionAudit.deleteOne({ leadId: ids.removal })).rejects.toThrow();
    });

    it('records applying Do Not Contact too', async () => {
      const res = await request(app).patch(`/api/leads/${ids.race}`).set(auth('employee')).send({ status: 'Do Not Contact', reason: 'Customer asked us to stop' });
      expect(res.status).toBe(200);
      expect(await ContactRestrictionAudit.countDocuments({ leadId: ids.race, event: 'dnc_applied' })).toBe(1);
    });
  });

  describe('concurrent updates never overwrite a newly applied Do Not Contact', () => {
    const staleRead = async (leadId: mongoose.Types.ObjectId, staleStatus: string) => {
      const current = await Lead.findById(leadId).lean();
      return jest.spyOn(Lead, 'findOne').mockImplementationOnce((() => Promise.resolve(Lead.hydrate({ ...current, status: staleStatus }))) as any);
    };

    it('a status change based on an older read is refused', async () => {
      const spy = await staleRead(ids.race, 'New');
      const res = await request(app).patch(`/api/leads/${ids.race}`).set(auth('employee')).send({ status: 'Working' });
      spy.mockRestore();
      expect(res.status).toBe(409);
      expect((await Lead.findById(ids.race).lean())?.status).toBe('Do Not Contact');
    });

    it('mark as pending based on an older read is refused', async () => {
      const spy = await staleRead(ids.race, 'New');
      const res = await request(app).patch(`/api/leads/${ids.race}/pending`).set(auth('employee'));
      spy.mockRestore();
      expect(res.status).toBe(409);
      expect((await Lead.findById(ids.race).lean())?.status).toBe('Do Not Contact');
    });

    it('booking an appointment based on an older read keeps Do Not Contact and still saves the appointment details', async () => {
      const spy = await staleRead(ids.race, 'New');
      const date = new Date(Date.now() + 7 * 24 * 3600000).toISOString().slice(0, 10);
      const res = await request(app).post(`/api/leads/${ids.race}/appointment`).set(auth('admin')).send({ date, time: '14:00', notes: 'Walk-in' });
      spy.mockRestore();
      expect({ status: res.status, body: res.body }).toMatchObject({ status: 200 });
      const lead: any = await Lead.findById(ids.race).lean();
      expect(lead.status).toBe('Do Not Contact');
      expect(lead.appointment?.time).toBe('14:00');
    });
  });

  describe('changing the phone or email of a Do Not Contact lead', () => {
    it('is refused for employees and requires a reason from an admin', async () => {
      const body = { firstName: 'Pat', lastName: 'Lee', phone: PHONE.contactNew, email: 'new-contact@example.com' };
      const employee = await request(app).patch(`/api/leads/${ids.contact}/contact`).set(auth('employee')).send(body);
      expect(employee.status).toBe(403);
      const noReason = await request(app).patch(`/api/leads/${ids.contact}/contact`).set(auth('admin')).send(body);
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('CONTACT_RESTRICTION_REASON_REQUIRED');
      expect((await Lead.findById(ids.contact).lean())?.phone).toBe(PHONE.contact);
    });

    it('records the change permanently and keeps the old phone and email blocked', async () => {
      const res = await request(app).patch(`/api/leads/${ids.contact}/contact`).set(auth('admin')).send({
        firstName: 'Pat', lastName: 'Lee', phone: PHONE.contactNew, email: 'new-contact@example.com', restrictionReason: 'Customer gave a new number',
      });
      expect(res.status).toBe(200);
      const audit: any = await ContactRestrictionAudit.findOne({ leadId: ids.contact, event: 'dnc_contact_changed' }).lean();
      expect(audit).toMatchObject({
        reason: 'Customer gave a new number',
        previousContact: { phone: PHONE.contact, email: 'old-contact@example.com' },
        newContact: { phone: PHONE.contactNew, email: 'new-contact@example.com' },
      });
      expect(await resolveContactRestriction({ organizationId: ORG, phone: PHONE.contact })).toMatchObject({ status: 'restricted', leadIds: [String(ids.contact)] });
      expect(await resolveContactRestriction({ organizationId: ORG, email: 'old-contact@example.com' })).toMatchObject({ status: 'restricted' });
      expect(await resolveContactRestriction({ organizationId: ORG, phone: PHONE.contactNew })).toMatchObject({ status: 'restricted' });
    });

    it('releases the protected old details only when an admin removes Do Not Contact', async () => {
      const res = await request(app).patch(`/api/leads/${ids.contact}`).set(auth('admin')).send({ status: 'Contacted', reason: 'Customer asked to hear from us again' });
      expect(res.status).toBe(200);
      expect(await ContactRestrictionIdentifier.countDocuments({ leadId: ids.contact, active: true })).toBe(0);
      expect(await resolveContactRestriction({ organizationId: ORG, phone: PHONE.contact })).toEqual({ status: 'allowed' });
    });
  });

  describe('appointment emails skipped for Do Not Contact', () => {
    const future = (days: number) => new Date(Date.now() + days * 24 * 3600000);
    const booking = { isCustomerBooking: true, firstName: 'Pat', lastName: 'Lee', email: 'dnc-appointment@example.com', phone: PHONE.appointment };

    it('shows a warning on the appointment when the invitation and cancellation emails are blocked', async () => {
      const start = future(3);
      const created: any = await appointmentService.createAppointment(String(people.admin), ORG, {
        title: 'Test drive', startTime: start, endTime: new Date(start.getTime() + 3600000), type: 'in-person', entryType: 'appointment',
        participants: [String(people.admin)], leadId: String(ids.appointment), customerBooking: booking,
      } as any);
      expect(created.customerEmailNotice).toMatchObject({ status: 'not_sent', emailType: 'invitation', reason: CONTACT_RESTRICTION_MESSAGES.restricted });
      expect((await Appointment.findById(created._id).lean() as any).customerEmailNotice).toMatchObject({ emailType: 'invitation' });
      expect(mockSendMail).not.toHaveBeenCalled();

      await appointmentService.cancelAppointment(String(created._id), ORG, String(people.admin));
      expect((await Appointment.findById(created._id).lean() as any).customerEmailNotice).toMatchObject({ emailType: 'cancellation' });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('returns the warning when a deleted appointment\'s cancellation email is blocked', async () => {
      const start = future(4);
      const created: any = await appointmentService.createAppointment(String(people.admin), ORG, {
        title: 'Second visit', startTime: start, endTime: new Date(start.getTime() + 3600000), type: 'in-person', entryType: 'appointment',
        participants: [String(people.admin)], leadId: String(ids.appointment), customerBooking: booking,
      } as any);
      const res = await request(app).delete(`/api/crm/calendar/appointments/${created._id}`).set(auth('admin'));
      expect(res.status).toBe(200);
      expect(res.body.data.customerEmailNotice).toMatchObject({ emailType: 'cancellation', reason: CONTACT_RESTRICTION_MESSAGES.restricted });
    });

    it('records a reminder email warning', async () => {
      const start = future(1);
      const appointment = await Appointment.create({
        title: 'Reminder visit', startTime: start, endTime: new Date(start.getTime() + 3600000), status: 'scheduled', entryType: 'appointment',
        organizationId: ORG, createdBy: people.admin, createdByModel: 'CrmUser', participants: [people.admin], participantModel: 'CrmUser',
        leadId: ids.appointment, customerBooking: { firstName: 'Pat', lastName: 'Lee', email: 'dnc-appointment@example.com', phone: '+18015550300', isCustomerBooking: false },
      });
      await sendReminderFor(appointment.toObject());
      const saved: any = await Appointment.findById(appointment._id).lean();
      expect(saved.customerEmailNotice).toMatchObject({ emailType: 'reminder', reason: CONTACT_RESTRICTION_MESSAGES.restricted });
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(mockSendSms).not.toHaveBeenCalled();
    });
  });

  describe('Web Chat replies to a Do Not Contact customer', () => {
    it('allows a staff reply within 30 minutes of the customer\'s message, audits it, and pauses Alex until resumed', async () => {
      const session = await chatSession(ids.chatLead, PHONE.chat);
      const message = await inbound(session, minutesAgo(10));
      const res = await staffReply(ids.chatLead);
      expect(res.status).toBe(201);
      const audit: any = await ContactRestrictionAudit.findOne({ sessionId: session._id, event: 'webchat_exception_reply' }).lean();
      expect(audit).toMatchObject({ channel: 'webchat', purpose: 'staff_webchat_reply' });
      expect(String(audit.respondingToMessageId)).toBe(String(message));
      expect(audit.restrictingLeadIds.map(String)).toEqual([String(ids.chatDnc)]);

      const paused: any = await WebChatSession.findById(session._id).lean();
      expect(paused.aiPausedAt).toBeInstanceOf(Date);
      expect(paused.aiPausedBy).toMatchObject({ userId: String(people.employee), name: 'Erin Employee' });
      expect(paused.aiAutoPausedUntil).toBeUndefined();

      await inbound(session, new Date(), 'One more question');
      expect((await WebChatSession.findById(session._id).lean() as any).aiPausedAt).toBeInstanceOf(Date);

      const resume = await request(app).post(`/api/crm/webchat/leads/${ids.chatLead}/ai-resume`).set(auth('employee'));
      expect(resume.status).toBe(200);
      expect((await WebChatSession.findById(session._id).lean() as any).aiPausedAt).toBeUndefined();
      expect((await Lead.findById(ids.chatDnc).lean())?.status).toBe('Do Not Contact');
    });

    it('does not let staff or Alex messages extend the window, and a new customer message opens a new one', async () => {
      await WebChatMessage.collection.updateMany({ leadId: ids.chatLead, direction: 'inbound' }, { $set: { createdAt: minutesAgo(31) } });
      await WebChatMessage.collection.insertOne({ organizationId: ORG, sessionId: (await WebChatSession.findOne({ leadId: ids.chatLead }))!._id, leadId: ids.chatLead, direction: 'outbound', body: 'Alex here', sentBy: { userId: 'ai-agent', name: 'Alex' }, createdAt: new Date(), updatedAt: new Date() } as any);
      const blocked = await staffReply(ids.chatLead);
      expect(blocked.status).toBe(403);
      expect(blocked.body.message).toBe(CONTACT_RESTRICTION_MESSAGES.webchatWindowClosed);
      expect(await ContactRestrictionAudit.countDocuments({ leadId: ids.chatLead, event: 'outbound_blocked', channel: 'webchat' })).toBe(1);

      const session = await WebChatSession.findOne({ leadId: ids.chatLead });
      await inbound(session, new Date(), 'Are you still there?');
      expect((await staffReply(ids.chatLead)).status).toBe(201);
    });

    it('requires a new customer message when Do Not Contact was applied after the last one', async () => {
      const session = await chatSession(ids.chatLateLead, PHONE.chatLate);
      await inbound(session, minutesAgo(10));
      const blocked = await staffReply(ids.chatLateLead);
      expect(blocked.status).toBe(403);
      await inbound(session, new Date(), 'Hello again');
      expect((await staffReply(ids.chatLateLead)).status).toBe(201);
    });

    it('sends at most one automatic acknowledgement, and only within the window', async () => {
      const lateLead = new mongoose.Types.ObjectId();
      await Lead.collection.insertOne(rawLead(lateLead, 'New', PHONE.chat, { channel: 'webchat' }) as any);
      const lateSession = await chatSession(lateLead, PHONE.chat);
      await inbound(lateSession, minutesAgo(40));
      await expect(sendWebchatUnavailableAck(lateSession)).resolves.toBe(false);
      expect(await WebChatMessage.countDocuments({ sessionId: lateSession._id, direction: 'outbound' })).toBe(0);

      const ackLead = new mongoose.Types.ObjectId();
      await Lead.collection.insertOne(rawLead(ackLead, 'New', PHONE.chat, { channel: 'webchat' }) as any);
      const session = await chatSession(ackLead, PHONE.chat);
      await inbound(session, minutesAgo(2));
      await expect(sendWebchatUnavailableAck(session)).resolves.toBe(true);
      await expect(sendWebchatUnavailableAck(session)).resolves.toBe(false);
      expect(await WebChatMessage.countDocuments({ sessionId: session._id, direction: 'outbound' })).toBe(1);
      expect(await ContactRestrictionAudit.countDocuments({ sessionId: session._id, event: 'webchat_exception_reply', purpose: 'webchat_ack' })).toBe(1);
      expect(mockSendSms).not.toHaveBeenCalled();
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('is not consent for texts: the same customer still cannot be texted', async () => {
      await expect(sendSmsFromUser({
        orgId: ORG, user: { userId: String(people.employee), name: 'Erin Employee' }, toPhone: PHONE.chat, body: 'Following up by text', leadId: ids.chatLead, destinationPolicy: 'manual',
      })).rejects.toMatchObject({ statusCode: 403 });
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('leaves customers who are not restricted unaffected, and never borrows another organization\'s restriction', async () => {
      const open = await chatSession(ids.openLead, PHONE.open);
      await inbound(open, minutesAgo(60 * 24 * 2));
      expect((await staffReply(ids.openLead)).status).toBe(201);
      expect(await ContactRestrictionAudit.countDocuments({ sessionId: open._id })).toBe(0);

      const other = await chatSession(ids.otherOrgChatLead, PHONE.otherOrg);
      await inbound(other, minutesAgo(60 * 24 * 2));
      expect((await staffReply(ids.otherOrgChatLead)).status).toBe(201);
    });

    it('a fresh chat for a new lead starts with Alex unpaused', async () => {
      const freshLead = new mongoose.Types.ObjectId();
      await Lead.collection.insertOne(rawLead(freshLead, 'New', PHONE.open, { channel: 'webchat' }) as any);
      const fresh = await chatSession(freshLead, PHONE.open);
      expect((await WebChatSession.findById(fresh._id).lean() as any).aiPausedAt).toBeUndefined();
    });
  });
});
