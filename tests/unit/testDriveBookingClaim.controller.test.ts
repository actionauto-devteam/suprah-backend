const mockVehicleFindById = jest.fn();
const mockUserFindOne = jest.fn();
const mockLeadCreate = jest.fn();
const mockAppointmentCreate = jest.fn();
const mockIntakeClaimFindOneAndUpdate = jest.fn();
const mockIntakeClaimUpdateOne = jest.fn();
const mockEmitToOrg = jest.fn();

jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: { findById: mockVehicleFindById } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: mockUserFindOne } }));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { create: mockLeadCreate } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: { create: mockAppointmentCreate } }));
jest.mock('../../src/models/IntakeClaim.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: mockIntakeClaimFindOneAndUpdate, updateOne: mockIntakeClaimUpdateOne },
}));
jest.mock('../../src/models/ServiceSlot.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/appointment.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/customerbooking.service', () => ({
  __esModule: true,
  default: { checkDuplicateBooking: jest.fn() },
}));
jest.mock('../../src/services/googleCalendar.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/utils/safeNotification', () => ({
  __esModule: true,
  safeCreateNotification: jest.fn(),
  notifyOrgAdmins: jest.fn(),
}));
jest.mock('../../src/utils/notificationTemplates', () => ({ __esModule: true, notificationTemplates: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, emitToOrg: mockEmitToOrg }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/controllers/locator.controller', () => ({
  __esModule: true,
  startDrivingSessionForAppointment: jest.fn(),
  endDrivingSessionForAppointment: jest.fn(),
}));

import appointmentController from '../../src/controllers/appointment.controller';

async function invoke(fn: any, body: any) {
  const req: any = { body, params: {} };
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { status, json };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { res, next, json, status };
}

describe('Public test-drive booking double-submit fix (IntakeClaim dedup)', () => {
  const orgId = 'org-1';
  const leadId = 'lead-1';
  const appointmentId = 'appt-1';

  beforeEach(() => {
    jest.clearAllMocks();
    mockVehicleFindById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'veh-1',
        organizationId: orgId,
        year: 2024,
        make: 'Toyota',
        model: 'Camry',
        stockNumber: 'STK1',
        dealerCity: 'Lehi',
      }),
    });
    mockUserFindOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'staff-1' }) }) }),
    });
    mockLeadCreate.mockResolvedValue({
      _id: leadId,
      statusHistory: [],
      save: jest.fn().mockResolvedValue(undefined),
    });
    mockAppointmentCreate.mockResolvedValue({ _id: appointmentId, title: 't', startTime: new Date(), status: 'scheduled' });
  });

  function callBooking(body: any) {
    return invoke(appointmentController.createPublicTestDriveBooking, {
      vehicleId: 'veh-1',
      firstName: 'Jordan',
      lastName: 'Lee',
      email: 'jordan@example.com',
      phone: '8015550100',
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...body,
    });
  }

  it('proceeds normally (creates exactly one Lead) when no clientRequestId is sent', async () => {
    await callBooking({});
    expect(mockIntakeClaimFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
  });

  it('attaches vehicleId and a location snapshot from the already-fetched Vehicle', async () => {
    await callBooking({});
    const [createArgs] = mockLeadCreate.mock.calls[0];
    expect(createArgs.vehicleId).toBe('veh-1');
    expect(createArgs.location).toBe('Lehi');
  });

  it('creates the claim and the Lead/Appointment on a first submission with a clientRequestId', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: {} });
    mockIntakeClaimUpdateOne.mockResolvedValue({});

    await callBooking({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    expect(mockAppointmentCreate).toHaveBeenCalledTimes(1);
    expect(mockIntakeClaimUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ claimKey: 'req-abc' }),
      expect.objectContaining({ $set: { leadId, appointmentId } }),
    );
  });

  it('returns the original result instead of creating a second Lead/Appointment when the same clientRequestId is resubmitted after success', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { leadId, appointmentId },
    });

    const { status } = await callBooking({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(mockAppointmentCreate).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(201);
  });

  it('returns 409 when the same clientRequestId is resubmitted while the original request is still in flight', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { leadId: null, appointmentId: null },
    });

    const { status } = await callBooking({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(409);
  });
});
