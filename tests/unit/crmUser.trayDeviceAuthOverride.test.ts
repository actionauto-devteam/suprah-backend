const mockCrmFindOne = jest.fn();
const mockRecordOverrideChange = jest.fn();
const mockNormalizeDepartment = jest.fn();

jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: mockCrmFindOne } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/TimeLog.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Absence.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/AgentHeartbeat.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/middleware/crmAuth.middleware', () => ({ generateCrmToken: jest.fn(), CRM_TOKEN_COOKIE: 'crm_token' }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn(), emitToShiftBoard: jest.fn(), emitToUser: jest.fn() }));
jest.mock('../../src/services/storage.service', () => ({ storageService: {} }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: jest.fn() }));
jest.mock('../../src/services/crmPush.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/timeLogEngine', () => ({ buildSessions: jest.fn(), buildBreakSessions: jest.fn() }));
jest.mock('../../src/utils/departmentSync.util', () => ({ cascadeDepartmentToLinkedUser: jest.fn(), cascadeEmailToLinkedUser: jest.fn() }));
jest.mock('../../src/services/department.service', () => ({ normalizeDepartmentValue: mockNormalizeDepartment, getDefaultDepartmentKey: jest.fn() }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  isMainMonitorOnlyDept: jest.fn(),
  isLocationRequiredForUser: jest.fn(),
  isIdleDetectionExemptDept: jest.fn(),
  isMobileMonitoringDept: jest.fn(),
  isIdleVideoProofEnabled: jest.fn(),
  resolveMonitoringMode: jest.fn(),
}));
jest.mock('../../src/utils/monitoringMode.util', () => ({ resolveScreenshotsRequired: jest.fn() }));
jest.mock('../../src/services/trayDevice.service', () => ({
  revokeUserTrayDevices: jest.fn(),
  revokeTrayDevicesForEmail: jest.fn(),
  recordTrayDeviceAuthOverrideChange: mockRecordOverrideChange,
}));
jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: jest.fn() }));
jest.mock('../../src/utils/crossIdentityShift.util', () => ({ findOpenShiftOnOtherIdentity: jest.fn() }));
jest.mock('../../src/utils/employeeId.util', () => ({ resolveNextEmployeeId: jest.fn() }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/config/subscriptionTiers', () => ({
  isValidTier: jest.fn(),
  isPurchasableTier: jest.fn(),
  TIER_SEAT_LIMITS: {},
  TIER_LABELS: {},
}));

import crmController from '../../src/controllers/crm.controller';

const admin = { _id: 'admin1', role: 'admin', organizationId: 'org1' };

const makeTarget = (overrides: Record<string, unknown> = {}) => ({
  _id: 'target1',
  fullName: 'Pat Example',
  email: 'pat@example.com',
  role: 'employee',
  organizationId: 'org1',
  trayDeviceAuthOverride: 'default',
  markModified: jest.fn(),
  validate: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const callUpdate = async (actor: unknown, body: Record<string, unknown>) => {
  const json = jest.fn();
  const next = jest.fn();
  crmController.updateUser({ crmUser: actor, params: { id: 'target1' }, body } as any, { json } as any, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, next };
};

describe('PATCH /users/:id trayDeviceAuthOverride', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['default', 'on'],
    ['default', 'off'],
    ['on', 'off'],
    ['off', 'default'],
  ])('changes %s to %s, saves it and writes one audit entry naming the admin', async (from, to) => {
    const target = makeTarget({ trayDeviceAuthOverride: from });
    mockCrmFindOne.mockResolvedValue(target);
    const { json, next } = await callUpdate(admin, { trayDeviceAuthOverride: to });
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalled();
    expect(target.trayDeviceAuthOverride).toBe(to);
    expect(target.save).toHaveBeenCalled();
    expect(mockRecordOverrideChange).toHaveBeenCalledTimes(1);
    expect(mockRecordOverrideChange).toHaveBeenCalledWith(target, from, to, 'admin1');
  });

  it('does not audit anything when the value is unchanged', async () => {
    const target = makeTarget({ trayDeviceAuthOverride: 'on' });
    mockCrmFindOne.mockResolvedValue(target);
    await callUpdate(admin, { trayDeviceAuthOverride: 'on' });
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });

  it('treats a record that never had the field as default', async () => {
    const target = makeTarget();
    delete (target as any).trayDeviceAuthOverride;
    mockCrmFindOne.mockResolvedValue(target);
    await callUpdate(admin, { trayDeviceAuthOverride: 'on' });
    expect(mockRecordOverrideChange).toHaveBeenCalledWith(target, 'default', 'on', 'admin1');
  });

  it.each(['ON', 'true', '', null, 1, {}, 'always'])('ignores the invalid value %p and leaves the setting alone', async (bad) => {
    const target = makeTarget({ trayDeviceAuthOverride: 'off' });
    mockCrmFindOne.mockResolvedValue(target);
    await callUpdate(admin, { trayDeviceAuthOverride: bad });
    expect(target.trayDeviceAuthOverride).toBe('off');
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });

  it('leaves the setting alone when the request does not mention it', async () => {
    const target = makeTarget({ trayDeviceAuthOverride: 'on' });
    mockCrmFindOne.mockResolvedValue(target);
    await callUpdate(admin, { fullName: 'Pat Renamed' });
    expect(target.trayDeviceAuthOverride).toBe('on');
    expect(target.fullName).toBe('Pat Renamed');
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });

  it.each(['employee', 'manager'])('refuses a %s and never reads or changes the user', async (role) => {
    const { next, json } = await callUpdate({ ...admin, role }, { trayDeviceAuthOverride: 'on' });
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(json).not.toHaveBeenCalled();
    expect(mockCrmFindOne).not.toHaveBeenCalled();
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });

  it('only looks inside the admin organization', async () => {
    mockCrmFindOne.mockResolvedValue(null);
    const { next } = await callUpdate(admin, { trayDeviceAuthOverride: 'on' });
    expect(mockCrmFindOne).toHaveBeenCalledWith({ _id: 'target1', organizationId: 'org1' });
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });

  it('does not audit a change that failed to save', async () => {
    const target = makeTarget();
    target.save.mockRejectedValue(new Error('write failed'));
    mockCrmFindOne.mockResolvedValue(target);
    const { next } = await callUpdate(admin, { trayDeviceAuthOverride: 'on' });
    expect(next).toHaveBeenCalled();
    expect(mockRecordOverrideChange).not.toHaveBeenCalled();
  });
});
