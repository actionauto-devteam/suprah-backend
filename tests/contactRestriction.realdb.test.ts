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
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import communicationRoutes from '../src/routes/communication.routes';
import leadRoutes from '../src/routes/lead.route';
import { handleInboundSms, sendSmsFromUser } from '../src/services/communication.service';
import { resolveContactRestriction, CONTACT_RESTRICTION_MESSAGES } from '../src/services/contactRestriction.service';
import emailService from '../src/services/email.service';
import appointmentService from '../src/services/appointment.service';
import { runAppointmentReminderSweep } from '../src/schedulers/appointmentReminder.scheduler';

const app = express();
app.use(express.json());
app.use('/api/crm/communications', communicationRoutes);
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors, code: error.code }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const employeeId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const tokens: Record<string, string> = {};
const auth = (who: 'employee' | 'admin') => ({ Authorization: `Bearer ${tokens[who]}` });

const PHONE = {
  dnc: '+18015550171',
  otherOrg: '+18015550172',
  emailOnlyDnc: '+18015550173',
  emailFresh: '+18015550174',
  incomplete: '+18015550175',
  allowed: '+18015550176',
  race: '+18015550177',
  remind: '+18015550178',
};
const DNC_EMAIL = 'dnc-email@example.com';
const ids = {
  dncLead: new mongoose.Types.ObjectId(),
  freshLead: new mongoose.Types.ObjectId(),
  otherOrgDnc: new mongoose.Types.ObjectId(),
  otherOrgPhoneLead: new mongoose.Types.ObjectId(),
  emailDnc: new mongoose.Types.ObjectId(),
  emailFresh: new mongoose.Types.ObjectId(),
  allowedLead: new mongoose.Types.ObjectId(),
  raceLead: new mongoose.Types.ObjectId(),
  remindDnc: new mongoose.Types.ObjectId(),
};

function rawLead(_id: mongoose.Types.ObjectId, status: string, phone: string, extra: Record<string, unknown> = {}, organizationId = orgId) {
  const now = new Date();
  return {
    _id,
    organizationId,
    createdBy: adminId,
    firstName: 'Pat',
    lastName: 'Lee',
    status,
    phone,
    normalizedPhone: phone,
    source: 'Manual Entry',
    channel: 'sms',
    statusHistory: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const sendText = (who: 'employee' | 'admin', toPhone: string, leadId: mongoose.Types.ObjectId) =>
  request(app).post('/api/crm/communications/messages').set(auth(who)).send({ toPhone, body: 'Hi Pat, checking in.', leadId: String(leadId) });

const messagesTo = (phone: string) => CommunicationMessage.countDocuments({ orgId: ORG, to: phone });

describe('Real-DB R1: Do Not Contact enforcement (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Organization.collection.insertMany([
      { _id: orgId, name: 'R1 Dealer', slug: `r1-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'R1 Other Dealer', slug: `r1-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    const crm = (_id: mongoose.Types.ObjectId, role: string, name: string) => ({
      _id, organizationId: orgId, fullName: name, username: `r1-${_id}`, email: `r1-${_id}@example.com`, role, isActive: true, password: 'x',
    });
    await CrmUser.collection.insertMany([crm(employeeId, 'employee', 'Erin Employee'), crm(adminId, 'admin', 'Ada Admin')] as any[]);
    tokens.employee = generateCrmToken(String(employeeId));
    tokens.admin = generateCrmToken(String(adminId));

    const incompleteLeads = Array.from({ length: 101 }, () =>
      rawLead(new mongoose.Types.ObjectId(), 'Do Not Contact', '801-555-0175 x1', { normalizedPhone: undefined }),
    ).map(({ normalizedPhone, ...doc }) => doc);

    await Lead.collection.insertMany([
      rawLead(ids.dncLead, 'Do Not Contact', PHONE.dnc),
      rawLead(ids.freshLead, 'New', PHONE.dnc, { createdAt: new Date(Date.now() + 1000) }),
      rawLead(ids.otherOrgDnc, 'Do Not Contact', PHONE.otherOrg, {}, otherOrgId),
      rawLead(ids.otherOrgPhoneLead, 'New', PHONE.otherOrg),
      rawLead(ids.emailDnc, 'Do Not Contact', PHONE.emailOnlyDnc, { email: DNC_EMAIL, normalizedEmail: DNC_EMAIL }),
      rawLead(ids.emailFresh, 'New', PHONE.emailFresh, { email: DNC_EMAIL, normalizedEmail: DNC_EMAIL }),
      rawLead(ids.allowedLead, 'New', PHONE.allowed, { email: 'allowed@example.com', normalizedEmail: 'allowed@example.com' }),
      rawLead(ids.raceLead, 'New', PHONE.race),
      rawLead(ids.remindDnc, 'Do Not Contact', PHONE.remind, { email: 'remind@example.com', normalizedEmail: 'remind@example.com' }),
      ...incompleteLeads,
    ] as any[]);
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

  it('blocks a manual text to a lead marked Do Not Contact with a plain reason and records nothing', async () => {
    const res = await sendText('employee', PHONE.dnc, ids.dncLead);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(CONTACT_RESTRICTION_MESSAGES.restricted);
    expect(res.body.errors[0]).toMatchObject({ code: 'CONTACT_RESTRICTED' });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await messagesTo(PHONE.dnc)).toBe(0);
    expect(await Conversation.countDocuments({ orgId: ORG, customerPhone: PHONE.dnc })).toBe(0);
  });

  it('keeps a fresh New lead restricted when the same customer has an earlier Do Not Contact lead', async () => {
    const res = await sendText('employee', PHONE.dnc, ids.freshLead);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(CONTACT_RESTRICTION_MESSAGES.restrictedElsewhere);
    expect(res.body.errors[0].leadIds).toEqual([String(ids.dncLead)]);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('matches the customer by email too, so a fresh lead with a different phone cannot be emailed or texted', async () => {
    const check = await resolveContactRestriction({ organizationId: ORG, leadId: ids.emailFresh });
    expect(check).toEqual({ status: 'restricted', leadIds: [String(ids.emailDnc)], onThisLead: false });

    const text = await sendText('employee', PHONE.emailFresh, ids.emailFresh);
    expect(text.status).toBe(403);

    await expect(emailService.sendCampaignEmail({
      to: DNC_EMAIL, subject: 'Hi', greetingText: 'Hi', bodyText: 'Body', organizationId: ORG, leadId: String(ids.emailFresh),
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does not let another dealership\'s Do Not Contact lead block this dealership\'s customer', async () => {
    const check = await resolveContactRestriction({ organizationId: ORG, phone: PHONE.otherOrg, leadId: ids.otherOrgPhoneLead });
    expect(check).toEqual({ status: 'allowed' });
    const res = await sendText('employee', PHONE.otherOrg, ids.otherOrgPhoneLead);
    expect(res.status).toBe(201);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toContain(String(ids.otherOrgDnc));
  });

  it('fails closed when the lookup is incomplete instead of treating the customer as contactable', async () => {
    expect(await resolveContactRestriction({ organizationId: ORG, phone: PHONE.incomplete })).toEqual({ status: 'unavailable' });
    const res = await request(app).post('/api/crm/communications/messages').set(auth('employee')).send({ toPhone: PHONE.incomplete, body: 'Hello' });
    expect(res.status).toBe(503);
    expect(res.body.errors[0]).toMatchObject({ code: 'CONTACT_RESTRICTION_UNAVAILABLE' });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await messagesTo(PHONE.incomplete)).toBe(0);
  });

  it('rechecks right before Telnyx and catches a lead marked Do Not Contact after the send was prepared', async () => {
    let marked = false;
    await expect(sendSmsFromUser({
      orgId: ORG,
      user: { userId: String(employeeId), name: 'Erin Employee' },
      toPhone: PHONE.race,
      body: 'Hello again',
      leadId: ids.raceLead,
      destinationPolicy: 'manual',
      beforeSend: async () => {
        if (marked) return;
        marked = true;
        await Lead.updateOne({ _id: ids.raceLead }, { $set: { status: 'Do Not Contact' } });
      },
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await messagesTo(PHONE.race)).toBe(0);
  });

  it('records the reminder text as not sent and sends no reminder email to a Do Not Contact customer', async () => {
    const start = new Date(Date.now() + 30 * 60 * 1000);
    start.setUTCSeconds(0, 0);
    const appointment = await Appointment.create({
      title: 'Test drive', startTime: start, endTime: new Date(start.getTime() + 3600000), status: 'scheduled', entryType: 'appointment',
      organizationId: ORG, createdBy: adminId, createdByModel: 'CrmUser', participants: [adminId], participantModel: 'CrmUser',
      leadId: ids.remindDnc,
      customerBooking: { firstName: 'Pat', lastName: 'Lee', email: 'remind@example.com', phone: PHONE.remind, isCustomerBooking: false },
    });

    await runAppointmentReminderSweep();

    const saved: any = await Appointment.findById(appointment._id).lean();
    expect(saved.reminderSent).toBe(true);
    expect(saved.reminderSms).toMatchObject({ status: 'not_sent', reason: CONTACT_RESTRICTION_MESSAGES.restricted });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();

    const next = new Date(start.getTime() + 24 * 3600000);
    await appointmentService.updateAppointment(String(appointment._id), ORG, String(adminId), {
      startTime: next.toISOString(), endTime: new Date(next.getTime() + 3600000).toISOString(),
    } as any);
    const moved: any = await Appointment.findById(appointment._id).lean();
    expect(moved.rescheduleNotice).toMatchObject({ status: 'not_sent', reason: CONTACT_RESTRICTION_MESSAGES.restricted });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('still sends a reminder email to a customer who is not restricted', async () => {
    const start = new Date(Date.now() + 40 * 60 * 1000);
    const appointment = await Appointment.create({
      title: 'Test drive', startTime: start, endTime: new Date(start.getTime() + 3600000), status: 'scheduled', entryType: 'appointment',
      organizationId: ORG, createdBy: adminId, createdByModel: 'CrmUser', participants: [adminId], participantModel: 'CrmUser',
      leadId: ids.allowedLead,
      customerBooking: { firstName: 'Pat', lastName: 'Lee', email: 'allowed@example.com', phone: PHONE.allowed, isCustomerBooking: false },
    });
    await emailService.sendAppointmentReminder(appointment as any, 'allowed@example.com', 'Pat', ORG);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0]).toMatchObject({ to: 'allowed@example.com' });
  });

  it('booking an appointment for a Do Not Contact lead keeps the restriction and sends no invitation', async () => {
    const start = new Date(Date.now() + 5 * 24 * 3600000);
    await appointmentService.createAppointment(String(adminId), ORG, {
      title: 'Walk-in visit', startTime: start, endTime: new Date(start.getTime() + 3600000), type: 'in-person', entryType: 'appointment',
      participants: [String(adminId)], leadId: String(ids.remindDnc),
      customerBooking: { isCustomerBooking: true, firstName: 'Pat', lastName: 'Lee', email: 'remind@example.com', phone: PHONE.remind },
    } as any);
    const lead: any = await Lead.findById(ids.remindDnc).lean();
    expect(lead.status).toBe('Do Not Contact');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('records inbound texts from a Do Not Contact customer, keeps STOP working, and sends nothing back', async () => {
    await handleInboundSms({ from: PHONE.dnc, to: '+18015550000', text: 'Is the truck still available?', id: `in-${new mongoose.Types.ObjectId()}` }, ORG);
    expect(await CommunicationMessage.countDocuments({ orgId: ORG, from: PHONE.dnc, direction: 'inbound' })).toBe(1);

    await handleInboundSms({ from: PHONE.dnc, to: '+18015550000', text: 'STOP', id: `in-${new mongoose.Types.ObjectId()}` }, ORG);
    const optOut: any = await SmsOptOut.findOne({ organizationId: ORG, phone: PHONE.dnc }).lean();
    expect(optOut?.optedOut).toBe(true);

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await CommunicationMessage.countDocuments({ orgId: ORG, to: PHONE.dnc, direction: 'outbound' })).toBe(0);
    await SmsOptOut.deleteOne({ organizationId: ORG, phone: PHONE.dnc });
  });

  it('only an admin, with a reason, can remove Do Not Contact; other status and contact changes cannot clear it', async () => {
    const employeeTry = await request(app).patch(`/api/leads/${ids.dncLead}`).set(auth('employee')).send({ status: 'Contacted', reason: 'Customer asked' });
    expect(employeeTry.status).toBe(403);
    expect(employeeTry.body.code).toBe('CONTACT_RESTRICTION_ADMIN_ONLY');

    const noReason = await request(app).patch(`/api/leads/${ids.dncLead}`).set(auth('admin')).send({ status: 'Contacted' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toBe(CONTACT_RESTRICTION_MESSAGES.reasonRequired);

    const pending = await request(app).patch(`/api/leads/${ids.dncLead}/pending`).set(auth('employee'));
    expect(pending.status).toBe(403);

    const contactEdit = await request(app).patch(`/api/leads/${ids.dncLead}/contact`).set(auth('employee')).send({ firstName: 'Pat', lastName: 'Lee', phone: '801-555-0199', email: '' });
    expect(contactEdit.status).toBe(403);

    const unchanged: any = await Lead.findById(ids.dncLead).lean();
    expect(unchanged.status).toBe('Do Not Contact');
    expect(unchanged.phone).toBe(PHONE.dnc);
    expect((await sendText('employee', PHONE.dnc, ids.freshLead)).status).toBe(403);

    const cleared = await request(app).patch(`/api/leads/${ids.dncLead}`).set(auth('admin')).send({ status: 'Contacted', reason: 'Customer called and asked us to text them again' });
    expect(cleared.status).toBe(200);
    const lead: any = await Lead.findById(ids.dncLead).lean();
    expect(lead.status).toBe('Contacted');
    expect(lead.statusHistory.at(-1)).toMatchObject({
      from: 'Do Not Contact',
      to: 'Contacted',
      reason: 'Customer called and asked us to text them again',
    });
    expect(String(lead.statusHistory.at(-1).changedBy)).toBe(String(adminId));

    const res = await sendText('employee', PHONE.dnc, ids.freshLead);
    expect(res.status).toBe(201);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });
});
