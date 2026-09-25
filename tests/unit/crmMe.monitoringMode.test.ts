const mockTimeLogFind = jest.fn();
const mockResolveMonitoringMode = jest.fn();
const mockIsMainMonitorOnly = jest.fn();
const mockIsLocationRequired = jest.fn();
const mockIsIdleExempt = jest.fn();
const mockIsMobileDept = jest.fn();
const mockIsIdleVideo = jest.fn();
const mockResolveScreenshotsRequired = jest.fn();
const mockGetDeviceSwitchView = jest.fn();

jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/TimeLog.model', () => ({ __esModule: true, default: { find: mockTimeLogFind } }));
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
jest.mock('../../src/services/department.service', () => ({ normalizeDepartmentValue: jest.fn(), getDefaultDepartmentKey: jest.fn() }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  isMainMonitorOnlyDept: mockIsMainMonitorOnly,
  isLocationRequiredForUser: mockIsLocationRequired,
  isIdleDetectionExemptDept: mockIsIdleExempt,
  isMobileMonitoringDept: mockIsMobileDept,
  isIdleVideoProofEnabled: mockIsIdleVideo,
  resolveMonitoringMode: mockResolveMonitoringMode,
}));
jest.mock('../../src/utils/monitoringMode.util', () => ({ resolveScreenshotsRequired: mockResolveScreenshotsRequired }));
jest.mock('../../src/services/trayDevice.service', () => ({ revokeUserTrayDevices: jest.fn(), revokeTrayDevicesForEmail: jest.fn() }));
jest.mock('../../src/services/monitoringDevice.service', () => ({
  getDeviceSwitchView: mockGetDeviceSwitchView,
  initShiftDevice: jest.fn(),
  recordDeviceSwitchOverrideChange: jest.fn(),
  recordDesktopLocationOverrideChange: jest.fn(),
  clearShiftDevice: jest.fn(),
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

const crmUser = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => '64a1b2c3d4e5f60718293a4b' },
  fullName: 'Pat Example',
  username: 'pat',
  role: 'agent',
  organizationId: { toString: () => 'org1' },
  department: 'Accounting',
  monitoringModeOverride: 'default',
  isActive: true,
  ...overrides,
});

const callMe = async (user: unknown, query: Record<string, unknown> = {}) => {
  const json = jest.fn();
  const next = jest.fn();
  crmController.getMe({ crmUser: user, query } as any, { json } as any, next);
  await new Promise((resolve) => setImmediate(resolve));
  if (next.mock.calls.length > 0) throw next.mock.calls[0][0];
  return json.mock.calls[0][0].data as Record<string, unknown>;
};

describe('GET /me monitoringMode', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.TRAY_DEVICE_AUTH;
    delete process.env.TRAY_DEVICE_AUTH_DISABLED;
    mockTimeLogFind.mockReturnValue({ sort: () => Promise.resolve([]) });
    mockIsMainMonitorOnly.mockResolvedValue(false);
    mockIsLocationRequired.mockResolvedValue(true);
    mockIsIdleExempt.mockResolvedValue(false);
    mockIsMobileDept.mockResolvedValue(false);
    mockIsIdleVideo.mockResolvedValue(false);
    mockResolveScreenshotsRequired.mockResolvedValue(true);
    mockResolveMonitoringMode.mockResolvedValue('switching');
    mockGetDeviceSwitchView.mockResolvedValue({ enabled: false, activeDevice: null });
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('is returned for every user, including one whose device authentication is off', async () => {
    const data = await callMe(crmUser());
    expect(data.trayDeviceAuthEnabled).toBe(false);
    expect(data.monitoringMode).toBe('switching');
  });

  it.each(['off', 'always', 'switching'])('reports %s as configured, whether or not device authentication is enabled', async (mode) => {
    mockResolveMonitoringMode.mockResolvedValue(mode);
    const off = await callMe(crmUser());
    process.env.TRAY_DEVICE_AUTH = '64a1b2c3d4e5f60718293a4b';
    const on = await callMe(crmUser());
    expect(off.monitoringMode).toBe(mode);
    expect(on.monitoringMode).toBe(mode);
    expect(off.trayDeviceAuthEnabled).toBe(false);
    expect(on.trayDeviceAuthEnabled).toBe(true);
  });

  it('reflects the per-user override: on enables without the allowlist, off beats the allowlist and all, the kill switch beats on', async () => {
    expect((await callMe(crmUser({ trayDeviceAuthOverride: 'on' }))).trayDeviceAuthEnabled).toBe(true);
    process.env.TRAY_DEVICE_AUTH = 'all';
    expect((await callMe(crmUser({ trayDeviceAuthOverride: 'off' }))).trayDeviceAuthEnabled).toBe(false);
    expect((await callMe(crmUser({ trayDeviceAuthOverride: 'default' }))).trayDeviceAuthEnabled).toBe(true);
    process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
    expect((await callMe(crmUser({ trayDeviceAuthOverride: 'on' }))).trayDeviceAuthEnabled).toBe(false);
  });

  it('is resolved from the user\'s organization, department and override, exactly like the other monitoring fields', async () => {
    await callMe(crmUser({ department: 'Recon', monitoringModeOverride: 'always' }));
    expect(mockResolveMonitoringMode).toHaveBeenCalledWith('org1', 'Recon', 'always');
  });

  it('returns the device switch view so the website knows whether to show the switch button and who is active', async () => {
    mockGetDeviceSwitchView.mockResolvedValue({ enabled: true, activeDevice: 'mobile' });
    const data = await callMe(crmUser({ deviceSwitchOverride: 'on' }));
    expect(data.deviceSwitch).toEqual({ enabled: true, activeDevice: 'mobile' });
    expect(mockGetDeviceSwitchView).toHaveBeenCalledWith(expect.objectContaining({ deviceSwitchOverride: 'on' }));
  });

  it('reports the switch as off, and never breaks /me, when the view cannot be built', async () => {
    mockGetDeviceSwitchView.mockRejectedValue(new Error('db down'));
    const data = await callMe(crmUser());
    expect(data.deviceSwitch).toEqual({ enabled: false, activeDevice: null, autoSwitch: false });
    expect(data.fullName).toBe('Pat Example');
  });

  it('gives the per-user switch setting to the screenshots rule', async () => {
    await callMe(crmUser({ deviceSwitchOverride: 'on' }));
    expect(mockResolveScreenshotsRequired).toHaveBeenCalledWith(expect.objectContaining({ deviceSwitchOverride: 'on' }));
  });

  it('reports the tray location channel as on for a user an admin switched on, with no environment setting', async () => {
    delete process.env.LOC_DESKTOP_CHANNEL;
    mockIsLocationRequired.mockResolvedValue(true);
    const on = await callMe(crmUser({ desktopLocationOverride: 'on', locationConsent: { granted: true } }), { platform: 'win32' });
    expect(on.desktopLocationEnabled).toBe(true);
    const def = await callMe(crmUser({ locationConsent: { granted: true } }), { platform: 'win32' });
    expect(def.desktopLocationEnabled).toBe(false);
  });

  it('an admin off beats the environment and the kill switch beats an admin on', async () => {
    process.env.LOC_DESKTOP_CHANNEL = 'all';
    const off = await callMe(crmUser({ desktopLocationOverride: 'off', locationConsent: { granted: true } }), { platform: 'win32' });
    expect(off.desktopLocationEnabled).toBe(false);
    delete process.env.LOC_DESKTOP_CHANNEL;
    process.env.LOC_DESKTOP_DISABLED = 'true';
    const killed = await callMe(crmUser({ desktopLocationOverride: 'on', locationConsent: { granted: true } }), { platform: 'win32' });
    expect(killed.desktopLocationEnabled).toBe(false);
    delete process.env.LOC_DESKTOP_DISABLED;
  });

  it('is additive: every existing monitoring field is unchanged by the rollout flag', async () => {
    mockIsMainMonitorOnly.mockResolvedValue(true);
    mockIsIdleExempt.mockResolvedValue(true);
    mockIsMobileDept.mockResolvedValue(true);
    mockIsLocationRequired.mockResolvedValue(false);
    mockResolveScreenshotsRequired.mockResolvedValue(false);
    const before = await callMe(crmUser());
    process.env.TRAY_DEVICE_AUTH = 'all';
    const after = await callMe(crmUser());
    for (const key of ['mainMonitorOnly', 'idleDetectionExempt', 'isMobileMonitoringDept', 'locationRequiredForTimeproof', 'screenshotsRequired', 'desktopLocationEnabled', 'role', 'department']) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(before.mainMonitorOnly).toBe(true);
    expect(before.idleDetectionExempt).toBe(true);
    expect(before.isMobileMonitoringDept).toBe(true);
    expect(before.locationRequiredForTimeproof).toBe(false);
    expect(before.screenshotsRequired).toBe(false);
  });

  it('never breaks /me: if the mode cannot be resolved the field is simply omitted and everything else is returned', async () => {
    mockResolveMonitoringMode.mockRejectedValue(new Error('department lookup failed'));
    const data = await callMe(crmUser());
    expect('monitoringMode' in data).toBe(false);
    expect(data.fullName).toBe('Pat Example');
    expect(data.trayDeviceAuthEnabled).toBe(false);
    expect(data.screenshotsRequired).toBe(true);
  });
});
