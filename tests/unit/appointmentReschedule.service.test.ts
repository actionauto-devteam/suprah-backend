jest.mock('../../src/services/contactRestriction.service', () => ({
  ...jest.requireActual('../../src/services/contactRestriction.service'),
  resolveContactRestriction: jest.fn(async () => ({ status: 'allowed' })),
  checkContactForSend: jest.fn(async () => ({ status: 'allowed' })),
  assertContactAllowed: jest.fn(async () => undefined),
  authorizeWebchatReply: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  assertWebchatReplyAllowed: jest.fn(async () => ({ allowed: true, basis: 'not_restricted' })),
  recordWebchatExceptionReply: jest.fn(async () => undefined),
  recordContactRestrictionAudit: jest.fn(async () => true),
  describeWebchatContactPolicy: jest.fn(async () => ({ restricted: false, lookupUnavailable: false, restrictedSince: null, windowMinutes: 30 })),
  isOrganizationAdmin: jest.fn(async () => false),
  protectPreviousContact: jest.fn(async () => ({})),
  releaseProtectedContacts: jest.fn(async () => undefined),
}));
const findOne = jest.fn();
const syncAppointmentToGoogleCalendar = jest.fn().mockResolvedValue(undefined);
const createNotification = jest.fn().mockResolvedValue(undefined);
const sendAppointmentUpdate = jest.fn().mockResolvedValue(undefined);
const crmUserExists = jest.fn().mockResolvedValue(null);
const userFindById = jest.fn();
const emitToOrg = jest.fn();
const notifyCustomerOfReschedule = jest.fn().mockResolvedValue(true);
const isSmsOptedOut = jest.fn().mockResolvedValue(false);
const appointmentUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { findOne, updateOne: appointmentUpdateOne },
}));

jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true,
  default: { exists: crmUserExists, findById: jest.fn() },
}));

jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findById: userFindById },
}));

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/services/googleCalendar.service', () => ({
  __esModule: true,
  default: { syncAppointmentToGoogleCalendar },
}));

jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification },
}));

jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendAppointmentUpdate },
}));

jest.mock('../../src/services/customerbooking.service', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../src/utils/socketEmitter', () => ({
  getSocketIO: jest.fn(),
  emitToOrg,
}));

jest.mock('../../src/services/communication.service', () => ({
  notifyCustomerOfReschedule,
  isSmsOptedOut,
}));

import appointmentService, { withoutServerOwnedNoticeFields } from '../../src/services/appointment.service';

function buildAppointment(overrides: Record<string, any> = {}) {
  const appointment: any = {
    _id: 'appt-1',
    organizationId: 'org-1',
    status: 'scheduled',
    entryType: 'appointment',
    title: 'Test drive',
    startTime: new Date('2026-10-05T16:00:00.000Z'),
    endTime: new Date('2026-10-05T17:00:00.000Z'),
    createdBy: { _id: 'user-1' },
    participants: ['user-1'],
    guestEmails: [],
    customerBooking: undefined,
    statusHistory: [],
    reminderSent: true,
    reminderSentAt: new Date('2026-10-01T00:00:00.000Z'),
    reminderTime: new Date('2026-10-05T15:00:00.000Z'),
    rescheduleAwaitingReplyAt: new Date('2026-10-01T00:00:00.000Z'),
    rescheduleStatedPreference: 'next Tuesday afternoon',
    ...overrides,
  };
  appointment.save = jest.fn().mockResolvedValue(undefined);
  appointment.populate = jest.fn().mockResolvedValue(appointment);
  return appointment;
}

describe('appointmentService.updateAppointment reschedule side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    crmUserExists.mockResolvedValue(null);
  });

  it('resets reminder and reschedule-preference fields when startTime changes', async () => {
    const appointment = buildAppointment();
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      startTime: new Date('2026-10-06T18:00:00.000Z') as any,
    });

    expect(appointment.reminderSent).toBe(false);
    expect(appointment.reminderSentAt).toBeUndefined();
    expect(appointment.reminderTime).toBeUndefined();
    expect(appointment.rescheduleAwaitingReplyAt).toBeUndefined();
    expect(appointment.rescheduleStatedPreference).toBeUndefined();
  });

  it('notifies the customer when startTime actually changes', async () => {
    const appointment = buildAppointment({ customerBooking: { phone: '+18015550142', firstName: 'Alex' } });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      startTime: new Date('2026-10-06T18:00:00.000Z') as any,
    });

    expect(notifyCustomerOfReschedule).toHaveBeenCalledWith(appointment);
  });

  it('does not notify the customer when startTime is unchanged', async () => {
    const appointment = buildAppointment({ customerBooking: { phone: '+18015550142', firstName: 'Alex' } });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      notes: 'updated notes',
    } as any);

    expect(notifyCustomerOfReschedule).not.toHaveBeenCalled();
  });

  it('does not let a failed customer notification break the reschedule itself', async () => {
    notifyCustomerOfReschedule.mockRejectedValueOnce(new Error('telnyx down'));
    const appointment = buildAppointment({ customerBooking: { phone: '+18015550142', firstName: 'Alex' } });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await expect(
      appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
        startTime: new Date('2026-10-06T18:00:00.000Z') as any,
      }),
    ).resolves.toBeDefined();
  });

  it('emits a live update event with the lead id so open views can refresh without a manual reload', async () => {
    const appointment = buildAppointment({ leadId: 'lead-1' });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      startTime: new Date('2026-10-06T18:00:00.000Z') as any,
    });

    expect(emitToOrg).toHaveBeenCalledWith(
      'org-1',
      'appointment:status_updated',
      expect.objectContaining({ _id: 'appt-1', leadId: 'lead-1' }),
    );
  });

  it('leaves reminder and reschedule-preference fields untouched when startTime is unchanged', async () => {
    const appointment = buildAppointment();
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      notes: 'updated notes',
    } as any);

    expect(appointment.reminderSent).toBe(true);
    expect(appointment.reminderSentAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(appointment.reminderTime).toEqual(new Date('2026-10-05T15:00:00.000Z'));
    expect(appointment.rescheduleAwaitingReplyAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(appointment.rescheduleStatedPreference).toBe('next Tuesday afternoon');
  });

  it('leaves reminder fields untouched when startTime is resent unchanged', async () => {
    const appointment = buildAppointment();
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      startTime: new Date('2026-10-05T16:00:00.000Z') as any,
    });

    expect(appointment.reminderSent).toBe(true);
    expect(appointment.rescheduleStatedPreference).toBe('next Tuesday afternoon');
  });

  it('still pushes statusHistory on a status change, independent of the reschedule fix', async () => {
    const appointment = buildAppointment();
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      status: 'completed',
    } as any);

    expect(appointment.statusHistory).toHaveLength(1);
    expect(appointment.statusHistory[0]).toEqual(
      expect.objectContaining({ from: 'scheduled', to: 'completed', changedBy: 'user-1' }),
    );
    expect(appointment.reminderSent).toBe(true);
  });

  it('rejects an update from someone who is neither the creator nor a participant', async () => {
    const appointment = buildAppointment({ createdBy: { _id: 'user-1' }, participants: ['user-1'] });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await expect(
      appointmentService.updateAppointment('appt-1', 'org-1', 'user-2', {
        startTime: new Date('2026-10-06T18:00:00.000Z') as any,
      }),
    ).rejects.toThrow('Not authorized to update this appointment');
  });

  const newStart = new Date('2026-10-06T18:00:00.000Z');
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const reschedule = async (appointment: any, extra: Record<string, unknown> = {}) => {
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });
    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', { startTime: newStart as any, ...extra } as any);
    await flush();
    await flush();
  };

  it.each([
    ['385-503-5869 x12', 'The phone number includes an extension, so it cannot be texted.'],
    ['+639171234567', 'Automatic texts only go to numbers in the US, US territories, and Canada.'],
    ['+385503586912', 'The phone number is not a valid number.'],
  ])('does not text %p about the new time and records why for staff', async (phone, reason) => {
    const appointment = buildAppointment({ customerBooking: { phone, firstName: 'Alex' } });
    await reschedule(appointment);

    expect(notifyCustomerOfReschedule).not.toHaveBeenCalled();
    expect(appointment.rescheduleNotice).toMatchObject({ status: 'not_sent', reason, forStartTime: newStart });
    expect(appointment.save).toHaveBeenCalled();
  });

  it('warns staff instead of texting a customer who replied STOP', async () => {
    isSmsOptedOut.mockResolvedValueOnce(true);
    const appointment = buildAppointment({ customerBooking: { phone: '+18015550142', firstName: 'Alex' } });
    await reschedule(appointment);

    expect(isSmsOptedOut).toHaveBeenCalledWith('org-1', '+18015550142');
    expect(notifyCustomerOfReschedule).not.toHaveBeenCalled();
    expect(appointment.rescheduleNotice).toMatchObject({
      status: 'not_sent',
      reason: 'This customer replied STOP, so texting is turned off.',
    });
  });

  it('records the text as accepted by the carrier only after the send succeeds, for this exact appointment time', async () => {
    notifyCustomerOfReschedule.mockResolvedValueOnce({ messageId: '64b7f0c2a1b2c3d4e5f60718', providerMessageId: 'tx-1' });
    const appointment = buildAppointment({
      customerBooking: { phone: '(385) 503-5869', firstName: 'Alex' },
      reminderSms: { status: 'not_sent', reason: 'old', forStartTime: new Date('2026-10-05T16:00:00.000Z'), updatedAt: new Date() },
    });
    await reschedule(appointment);

    expect(appointment.reminderSms).toBeUndefined();
    expect(appointment.rescheduleNotice).toMatchObject({ status: 'sending', forStartTime: newStart });
    expect(notifyCustomerOfReschedule).toHaveBeenCalledWith(appointment);
    expect(appointmentUpdateOne).toHaveBeenCalledWith(
      { _id: 'appt-1', startTime: newStart, 'rescheduleNotice.forStartTime': newStart, 'rescheduleNotice.status': 'sending' },
      {
        $set: expect.objectContaining({
          'rescheduleNotice.status': 'accepted',
          'rescheduleNotice.providerMessageId': 'tx-1',
          'rescheduleNotice.reason': null,
        }),
      },
      { timestamps: false },
    );
  });

  it.each([
    [Object.assign(new Error('SMS provider rejected the message'), { statusCode: 502 }), 'failed', 'The text service rejected this message.'],
    [Object.assign(new Error('accepted but not recorded'), { name: 'SmsDeliveryUncertainError', providerMessageId: 'tx-9' }), 'unknown', "We couldn't confirm whether this text went out."],
  ])('records a real send problem instead of a false success (%#)', async (error, status, reason) => {
    notifyCustomerOfReschedule.mockRejectedValueOnce(error);
    const appointment = buildAppointment({ customerBooking: { phone: '(385) 503-5869', firstName: 'Alex' } });
    await reschedule(appointment);

    expect(appointmentUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'rescheduleNotice.status': 'sending' }),
      { $set: expect.objectContaining({ 'rescheduleNotice.status': status, 'rescheduleNotice.reason': reason }) },
      { timestamps: false },
    );
  });

  it('records a not-sent warning when the customer opted out between saving and sending', async () => {
    notifyCustomerOfReschedule.mockResolvedValueOnce(false);
    const appointment = buildAppointment({ customerBooking: { phone: '(385) 503-5869', firstName: 'Alex' } });
    await reschedule(appointment);

    expect(appointmentUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ 'rescheduleNotice.status': 'not_sent', 'rescheduleNotice.reason': 'This customer replied STOP, so texting is turned off.' }) },
      { timestamps: false },
    );
  });

  it('replaces an older reschedule warning once the next reschedule can be texted', async () => {
    const appointment = buildAppointment({
      customerBooking: { phone: '(385) 503-5869', firstName: 'Alex' },
      rescheduleNotice: { status: 'not_sent', reason: 'old warning', forStartTime: new Date('2026-10-05T16:00:00.000Z'), updatedAt: new Date() },
    });
    await reschedule(appointment);

    expect(appointment.rescheduleNotice).toMatchObject({ status: 'sending', reason: null, forStartTime: newStart });
  });

  it('ignores notification status fields sent by a client', async () => {
    const existingNotice = { status: 'not_sent', reason: 'kept', forStartTime: new Date('2026-10-05T16:00:00.000Z'), updatedAt: new Date() };
    const appointment = buildAppointment({ rescheduleNotice: existingNotice });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      notes: 'updated notes',
      rescheduleNotice: { status: 'delivered' },
      reminderSms: { status: 'delivered' },
      reminderSent: false,
      reminderSentAt: null,
    } as any);

    expect(appointment.rescheduleNotice).toBe(existingNotice);
    expect(appointment.reminderSms).toBeUndefined();
    expect(appointment.reminderSent).toBe(true);
    expect(appointment.notes).toBe('updated notes');
  });

  it('strips server-owned notification fields from client data', () => {
    expect(
      withoutServerOwnedNoticeFields({ title: 'Test', reminderSent: true, reminderSentAt: 'x', reminderSms: {}, rescheduleNotice: {} }),
    ).toEqual({ title: 'Test' });
  });

  it('does not touch the reschedule warning when the time is unchanged', async () => {
    const existingNotice = { status: 'not_sent', reason: 'kept', forStartTime: new Date('2026-10-05T16:00:00.000Z'), updatedAt: new Date() };
    const appointment = buildAppointment({ customerBooking: { phone: '+639171234567', firstName: 'Alex' }, rescheduleNotice: existingNotice });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', { notes: 'updated notes' } as any);

    expect(appointment.rescheduleNotice).toBe(existingNotice);
    expect(notifyCustomerOfReschedule).not.toHaveBeenCalled();
  });
});
