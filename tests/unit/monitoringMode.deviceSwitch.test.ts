const mockLocFindOne = jest.fn();
const mockResolveMode = jest.fn();
const mockGetActiveDevice = jest.fn();

jest.mock('../../src/models/EmployeeLocation.model', () => ({ __esModule: true, default: { findOne: mockLocFindOne } }));
jest.mock('../../src/config/departmentMonitoring', () => ({ resolveMonitoringMode: mockResolveMode }));
jest.mock('../../src/utils/monitoringDeviceState.util', () => ({ getActiveDevice: mockGetActiveDevice }));

import { resolveScreenshotsRequired } from '../../src/utils/monitoringMode.util';

const savedEnv = { ...process.env };
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const params = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  organizationId: 'org-1',
  department: 'Recon',
  monitoringModeOverride: 'default' as const,
  deviceSwitchOverride: 'on',
  ...overrides,
});

describe('resolveScreenshotsRequired with an explicit active device', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.MON_DEVICE_SWITCH;
    delete process.env.MON_DEVICE_SWITCH_DISABLED;
    delete process.env.LOC_HANDOFF_SCREENSHOTS;
    mockResolveMode.mockResolvedValue('switching');
    mockGetActiveDevice.mockResolvedValue(null);
    mockLocFindOne.mockImplementation(() => lean(null));
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('requires screenshots while the computer is the active device, even if a phone pinged a minute ago', async () => {
    mockGetActiveDevice.mockResolvedValue('desktop');
    mockLocFindOne.mockImplementation(() => lean({ _id: 'loc1' }));
    expect(await resolveScreenshotsRequired(params())).toBe(true);
  });

  it('does not require screenshots while the phone is the active device, even with no phone ping at all', async () => {
    mockGetActiveDevice.mockResolvedValue('mobile');
    expect(await resolveScreenshotsRequired(params())).toBe(false);
  });

  it('falls back to the old phone-ping rule when there is no state for the shift', async () => {
    mockGetActiveDevice.mockResolvedValue(null);
    expect(await resolveScreenshotsRequired(params())).toBe(true);
    mockLocFindOne.mockImplementation(() => lean({ _id: 'loc1' }));
    expect(await resolveScreenshotsRequired(params())).toBe(false);
  });

  it('ignores the active device completely while the feature is off for the user', async () => {
    mockGetActiveDevice.mockResolvedValue('mobile');
    expect(await resolveScreenshotsRequired(params({ deviceSwitchOverride: 'default' }))).toBe(true);
    expect(mockGetActiveDevice).not.toHaveBeenCalled();
  });

  it('never lets the feature change the answer for Off or Always accounts', async () => {
    mockGetActiveDevice.mockResolvedValue('mobile');
    mockResolveMode.mockResolvedValue('off');
    expect(await resolveScreenshotsRequired(params())).toBe(true);
    mockGetActiveDevice.mockResolvedValue('desktop');
    mockResolveMode.mockResolvedValue('always');
    expect(await resolveScreenshotsRequired(params())).toBe(false);
    expect(mockGetActiveDevice).not.toHaveBeenCalled();
  });

  it('a screenshot exemption still wins', async () => {
    mockGetActiveDevice.mockResolvedValue('desktop');
    expect(await resolveScreenshotsRequired(params({ screenshotExempt: true }))).toBe(false);
  });

  it('a failed state lookup falls back to the old rule instead of breaking the caller', async () => {
    mockGetActiveDevice.mockRejectedValue(new Error('db down'));
    expect(await resolveScreenshotsRequired(params())).toBe(true);
  });

  it('follows the environment list for a user left on default', async () => {
    process.env.MON_DEVICE_SWITCH = 'user-1';
    mockGetActiveDevice.mockResolvedValue('mobile');
    expect(await resolveScreenshotsRequired(params({ deviceSwitchOverride: 'default' }))).toBe(false);
  });
});
