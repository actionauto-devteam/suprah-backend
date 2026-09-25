const mockCrmFindById = jest.fn();
const mockUserFindById = jest.fn();
const mockResolveMode = jest.fn();
const mockIsDesktopActive = jest.fn();

jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: mockCrmFindById } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/config/departmentMonitoring', () => ({ resolveMonitoringMode: mockResolveMode }));
jest.mock('../../src/utils/monitoringDeviceState.util', () => ({ isDesktopActiveForUserId: mockIsDesktopActive }));

import { isLocationSilenceExcusedForRecord } from '../../src/utils/locationExcuse.util';

const savedEnv = { ...process.env };
const NOW = Date.now();
const record = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  userModel: 'CrmUser',
  organizationId: 'org-1',
  department: 'Recon',
  sharingState: 'sharing' as const,
  deviceType: 'mobile' as const,
  lastSeenAt: new Date(NOW - 30 * 60_000),
  ...overrides,
});

describe('location silence excuse for an explicit desktop shift', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.LOC_DESKTOP_EXCUSE;
    mockIsDesktopActive.mockResolvedValue(false);
    mockResolveMode.mockResolvedValue('switching');
    mockCrmFindById.mockImplementation(() => ({ select: () => ({ lean: () => Promise.resolve({ department: 'Recon' }) }) }));
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('excuses silence while the user chose the computer, with every other flag off', async () => {
    mockIsDesktopActive.mockResolvedValue(true);
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(true);
    expect(mockIsDesktopActive).toHaveBeenCalledWith('user-1');
  });

  it('excuses even a stale row the last phone ping left as mobile, which is what raised the false alert', async () => {
    mockIsDesktopActive.mockResolvedValue(true);
    expect(await isLocationSilenceExcusedForRecord(record({ deviceType: 'mobile', sharingState: 'off_duty' }), NOW)).toBe(true);
  });

  it('does not excuse silence when the computer is not the chosen device', async () => {
    mockIsDesktopActive.mockResolvedValue(false);
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });

  it('only looks at CRM identities and never at a main-site record', async () => {
    mockIsDesktopActive.mockResolvedValue(true);
    expect(await isLocationSilenceExcusedForRecord(record({ userModel: 'User' }), NOW)).toBe(false);
    expect(mockIsDesktopActive).not.toHaveBeenCalled();
  });

  it('still returns false, never throws, when the device lookup fails', async () => {
    mockIsDesktopActive.mockRejectedValue(new Error('db down'));
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });
});
