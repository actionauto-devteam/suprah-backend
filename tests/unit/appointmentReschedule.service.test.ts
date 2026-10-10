const findOne = jest.fn();
const syncAppointmentToGoogleCalendar = jest.fn().mockResolvedValue(undefined);
const createNotification = jest.fn().mockResolvedValue(undefined);
const sendAppointmentUpdate = jest.fn().mockResolvedValue(undefined);
const crmUserExists = jest.fn().mockResolvedValue(null);
const userFindById = jest.fn();
const emitToOrg = jest.fn();
const notifyCustomerOfReschedule = jest.fn().mockResolvedValue(true);

jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { findOne },
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
}));

import appointmentService from '../../src/services/appointment.service';

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
    const appointment = buildAppointment({ customerBooking: { phone: '+15551234567', firstName: 'Alex' } });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      startTime: new Date('2026-10-06T18:00:00.000Z') as any,
    });

    expect(notifyCustomerOfReschedule).toHaveBeenCalledWith(appointment);
  });

  it('does not notify the customer when startTime is unchanged', async () => {
    const appointment = buildAppointment({ customerBooking: { phone: '+15551234567', firstName: 'Alex' } });
    findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(appointment) });

    await appointmentService.updateAppointment('appt-1', 'org-1', 'user-1', {
      notes: 'updated notes',
    } as any);

    expect(notifyCustomerOfReschedule).not.toHaveBeenCalled();
  });

  it('does not let a failed customer notification break the reschedule itself', async () => {
    notifyCustomerOfReschedule.mockRejectedValueOnce(new Error('telnyx down'));
    const appointment = buildAppointment({ customerBooking: { phone: '+15551234567', firstName: 'Alex' } });
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
});
