const mockSendSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550000',
  sendSms: mockSendSms,
}));
jest.mock('../src/services/googleCalendar.service', () => ({
  __esModule: true,
  default: { syncAppointmentToGoogleCalendar: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendAppointmentUpdate: jest.fn().mockResolvedValue(undefined),
    sendAppointmentReminder: jest.fn().mockResolvedValue(undefined),
  },
}));

import mongoose from 'mongoose';
import Appointment from '../src/models/Appointment.model';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import appointmentService from '../src/services/appointment.service';
import { handleSmsStatus } from '../src/services/communication.service';
import { runAppointmentReminderSweep, sendReminderFor } from '../src/schedulers/appointmentReminder.scheduler';
import { finishAppointmentSmsNotice, startAppointmentSmsNotice } from '../src/utils/appointmentSmsNotice';

const settled = async (id: unknown, field: 'rescheduleNotice' | 'reminderSms') => {
  const deadline = Date.now() + 8000;
  let doc: any = null;
  while (Date.now() < deadline) {
    doc = await Appointment.findById(id).lean();
    if (!doc?.[field] || doc[field].status !== 'sending') return doc;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return doc;
};

describe('Real-DB S1: appointment text status stays accurate', () => {
  let org: any;
  let user: any;
  const created: mongoose.Types.ObjectId[] = [];

  async function makeAppointment(phone: string, startOffsetMs = 2 * 24 * 60 * 60 * 1000) {
    const start = new Date(Date.now() + startOffsetMs);
    start.setUTCSeconds(0, 0);
    const appointment = await Appointment.create({
      title: 'Test drive',
      startTime: start,
      endTime: new Date(start.getTime() + 60 * 60 * 1000),
      status: 'scheduled',
      entryType: 'appointment',
      organizationId: String(org._id),
      createdBy: user._id,
      createdByModel: 'User',
      participants: [user._id],
      participantModel: 'User',
      customerBooking: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone, isCustomerBooking: false },
    });
    created.push(appointment._id as mongoose.Types.ObjectId);
    return appointment;
  }

  const reschedule = async (appointment: any, body: Record<string, unknown> = {}) => {
    const next = new Date(new Date(appointment.startTime).getTime() + 24 * 60 * 60 * 1000);
    await appointmentService.updateAppointment(String(appointment._id), String(org._id), String(user._id), {
      startTime: next.toISOString(),
      endTime: new Date(next.getTime() + 60 * 60 * 1000).toISOString(),
      ...body,
    } as any);
    await settled(appointment._id, 'rescheduleNotice');
    return next;
  };

  const reload = async (id: unknown) => (await Appointment.findById(id).lean()) as any;

  beforeAll(async () => {
    jest.setTimeout(60000);
    await Appointment.createIndexes();
    org = await Organization.create({ name: 'S1 Notice Org', slug: `s1-notice-${Date.now()}`, status: 'active' });
    user = await User.create({
      email: `s1-notice-${Date.now()}@example.com`,
      password: 'Password123!',
      name: 'S1 Notice Tester',
      role: 'admin',
      organizationId: org._id,
      organizationRole: 'admin',
      emailVerified: true,
      onboardingCompleted: true,
      isActive: true,
    });
  });

  beforeEach(() => {
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `tx-${new mongoose.Types.ObjectId()}` }));
  });

  afterAll(async () => {
    await Appointment.deleteMany({ _id: { $in: created } });
    await CommunicationMessage.deleteMany({ orgId: String(org._id) });
    await Conversation.deleteMany({ orgId: String(org._id) });
    await SmsOptOut.deleteMany({ organizationId: String(org._id) });
    await User.deleteOne({ _id: user._id });
    await Organization.deleteOne({ _id: org._id });
  });

  it('marks a reschedule text accepted with its ids, then delivered only when the carrier confirms', async () => {
    const appointment = await makeAppointment('+18015550142');
    const next = await reschedule(appointment);

    const saved = await reload(appointment._id);
    expect(saved.rescheduleNotice).toMatchObject({ status: 'accepted', forStartTime: next, reason: null });
    expect(saved.rescheduleNotice.providerMessageId).toMatch(/^tx-/);
    const message: any = await CommunicationMessage.findById(saved.rescheduleNotice.messageId).lean();
    expect(message).toMatchObject({ status: 'sent', providerMessageId: saved.rescheduleNotice.providerMessageId });

    await handleSmsStatus({ id: saved.rescheduleNotice.providerMessageId, to: [{ status: 'delivered' }] });
    expect((await reload(appointment._id)).rescheduleNotice.status).toBe('delivered');
    await handleSmsStatus({ id: saved.rescheduleNotice.providerMessageId, to: [{ status: 'delivery_failed' }] });
    expect((await reload(appointment._id)).rescheduleNotice.status).toBe('delivered');
  });

  it('records a carrier failure after acceptance instead of keeping a success indicator', async () => {
    const appointment = await makeAppointment('+18015550144');
    await reschedule(appointment);
    const providerMessageId = (await reload(appointment._id)).rescheduleNotice.providerMessageId;
    await handleSmsStatus({ id: providerMessageId, to: [{ status: 'delivery_failed' }] });
    expect((await reload(appointment._id)).rescheduleNotice).toMatchObject({
      status: 'failed',
      reason: 'The carrier reported that this text was not delivered.',
    });
  });

  it('warns about STOP and writes no text record', async () => {
    await SmsOptOut.create({ organizationId: String(org._id), phone: '+18015550143', optedOut: true, changedAt: new Date(), keyword: 'STOP' });
    const appointment = await makeAppointment('+18015550143');
    const next = await reschedule(appointment);

    expect((await reload(appointment._id)).rescheduleNotice).toMatchObject({
      status: 'not_sent',
      reason: 'This customer replied STOP, so texting is turned off.',
      forStartTime: next,
    });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(await CommunicationMessage.countDocuments({ orgId: String(org._id), to: '+18015550143' })).toBe(0);
  });

  it('warns about an untextable number and writes no text record', async () => {
    const appointment = await makeAppointment('+639171234567');
    await reschedule(appointment);

    expect((await reload(appointment._id)).rescheduleNotice).toMatchObject({
      status: 'not_sent',
      reason: 'Automatic texts only go to numbers in the US, US territories, and Canada.',
    });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('records a provider rejection as failed, not sent', async () => {
    mockSendSms.mockRejectedValueOnce(new Error('Telnyx rejected the message'));
    const appointment = await makeAppointment('+18015550145');
    await reschedule(appointment);

    expect((await reload(appointment._id)).rescheduleNotice).toMatchObject({
      status: 'failed',
      reason: 'The text service rejected this message.',
    });
  });

  it('never lets a delayed result from an earlier time overwrite the newer appointment state', async () => {
    const appointment = await makeAppointment('+18015550146');
    const oldStart = new Date(appointment.startTime);
    const newStart = new Date(oldStart.getTime() + 3 * 60 * 60 * 1000);
    await Appointment.collection.updateOne({ _id: appointment._id }, { $set: { startTime: newStart } });

    expect(await startAppointmentSmsNotice(appointment._id, 'reminderSms', oldStart, 'not_sent', 'stale')).toBe(false);
    expect((await reload(appointment._id)).reminderSms).toBeUndefined();

    expect(await startAppointmentSmsNotice(appointment._id, 'rescheduleNotice', newStart, 'sending')).toBe(true);
    expect(await finishAppointmentSmsNotice(appointment._id, 'rescheduleNotice', oldStart, { status: 'accepted' })).toBe(false);
    expect((await reload(appointment._id)).rescheduleNotice).toMatchObject({ status: 'sending', forStartTime: newStart });
    expect(await finishAppointmentSmsNotice(appointment._id, 'rescheduleNotice', newStart, { status: 'accepted', providerMessageId: 'tx-current' })).toBe(true);
    expect(await finishAppointmentSmsNotice(appointment._id, 'rescheduleNotice', newStart, { status: 'failed' })).toBe(false);
  });

  it('ignores notification fields a client tries to set', async () => {
    const appointment = await makeAppointment('+18015550147');
    await appointmentService.updateAppointment(String(appointment._id), String(org._id), String(user._id), {
      notes: 'client edit',
      rescheduleNotice: { status: 'delivered', forStartTime: appointment.startTime, updatedAt: new Date() },
      reminderSms: { status: 'delivered', forStartTime: appointment.startTime, updatedAt: new Date() },
      reminderSent: true,
    } as any);
    const saved = await reload(appointment._id);
    expect(saved.notes).toBe('client edit');
    expect(saved.rescheduleNotice).toBeUndefined();
    expect(saved.reminderSms).toBeUndefined();
    expect(saved.reminderSent).toBe(false);
  });

  it('sends a due reminder through the sweep, then a reschedule clears that reminder status', async () => {
    const appointment = await makeAppointment('+18015550148', 30 * 60 * 1000);
    const stats = await runAppointmentReminderSweep();
    expect(stats.sent).toBeGreaterThanOrEqual(1);
    const reminded = await reload(appointment._id);
    expect(reminded.reminderSent).toBe(true);
    expect(reminded.reminderSms).toMatchObject({ status: 'accepted', forStartTime: new Date(appointment.startTime) });

    await reschedule(appointment);
    const moved = await reload(appointment._id);
    expect(moved.reminderSent).toBe(false);
    expect(moved.reminderSms).toBeUndefined();
    expect(moved.rescheduleNotice.status).toBe('accepted');
  });

  it('does not send a reminder for an appointment time that changed after the job read it', async () => {
    const appointment = await makeAppointment('+18015550149', 30 * 60 * 1000);
    const staleCopy = appointment.toObject();
    await Appointment.collection.updateOne(
      { _id: appointment._id },
      { $set: { startTime: new Date(new Date(appointment.startTime).getTime() + 60 * 60 * 1000) } },
    );
    await sendReminderFor(staleCopy);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect((await reload(appointment._id)).reminderSms).toBeUndefined();
  });
});
