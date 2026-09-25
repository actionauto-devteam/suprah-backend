const mockCrmFindById = jest.fn();
const mockUserFindById = jest.fn();
const mockResolveMode = jest.fn();

jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: mockCrmFindById } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/config/departmentMonitoring', () => ({ resolveMonitoringMode: mockResolveMode }));
jest.mock('../../src/utils/monitoringDeviceState.util', () => ({ isDesktopActiveForUserId: jest.fn().mockResolvedValue(false) }));

import { isLocationSilenceExcusedForRecord } from '../../src/utils/locationExcuse.util';

const savedEnv = { ...process.env };
const NOW = Date.now();
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const record = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  userModel: 'CrmUser',
  organizationId: 'org-1',
  department: 'Accounting',
  sharingState: 'sharing' as const,
  deviceType: 'desktop' as const,
  lastSeenAt: new Date(NOW - 20 * 60_000),
  desktopLastSeenAt: new Date(NOW - 30_000),
  desktopInputAgeSec: 5,
  ...overrides,
});

describe('silence excuse with the per-user desktop location switch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.LOC_DESKTOP_EXCUSE;
    delete process.env.LOC_DESKTOP_DISABLED;
    mockResolveMode.mockResolvedValue('off');
    mockCrmFindById.mockImplementation(() => lean({ department: 'Accounting', monitoringModeOverride: 'default', desktopLocationOverride: 'on' }));
    mockUserFindById.mockImplementation(() => lean({ personalInfo: { department: 'Accounting' } }));
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('excuses a hidden-tab user whose tray keeps reporting, with no environment setting, when an admin turned the switch on', async () => {
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(true);
    expect(mockCrmFindById).toHaveBeenCalledWith('user-1');
  });

  it('works for a regular Off-mode desktop employee, not only for Switching accounts', async () => {
    mockResolveMode.mockResolvedValue('off');
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(true);
    mockResolveMode.mockResolvedValue('switching');
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(true);
  });

  it('does not excuse an Always (phone-only) account', async () => {
    mockResolveMode.mockResolvedValue('always');
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });

  it('does not excuse when the tray has gone quiet too, which is a real outage', async () => {
    expect(await isLocationSilenceExcusedForRecord(record({ desktopLastSeenAt: new Date(NOW - 60 * 60_000) }), NOW)).toBe(false);
  });

  it('does not excuse a record that is not sharing', async () => {
    expect(await isLocationSilenceExcusedForRecord(record({ sharingState: 'off_duty' }), NOW)).toBe(false);
  });

  it('a user left on default is not excused while the environment flag is off', async () => {
    mockCrmFindById.mockImplementation(() => lean({ department: 'Accounting', desktopLocationOverride: 'default' }));
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });

  it('a user left on default still follows the environment list', async () => {
    mockCrmFindById.mockImplementation(() => lean({ department: 'Accounting', desktopLocationOverride: 'default' }));
    process.env.LOC_DESKTOP_EXCUSE = 'user-1';
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(true);
  });

  it('an admin off beats the environment list', async () => {
    mockCrmFindById.mockImplementation(() => lean({ department: 'Accounting', desktopLocationOverride: 'off' }));
    process.env.LOC_DESKTOP_EXCUSE = 'all';
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });

  it('the kill switch stops it even for a user set to on', async () => {
    process.env.LOC_DESKTOP_DISABLED = 'true';
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });

  it('a main-site record has no per-user switch and follows the environment only', async () => {
    expect(await isLocationSilenceExcusedForRecord(record({ userModel: 'User' }), NOW)).toBe(false);
    process.env.LOC_DESKTOP_EXCUSE = 'user-1';
    expect(await isLocationSilenceExcusedForRecord(record({ userModel: 'User' }), NOW)).toBe(true);
  });

  it('does no lookup at all for a record with no fresh tray data, so nothing costs anything while the feature is unused', async () => {
    expect(await isLocationSilenceExcusedForRecord(record({ desktopLastSeenAt: null }), NOW)).toBe(false);
    expect(mockCrmFindById).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('never throws when a lookup fails', async () => {
    mockCrmFindById.mockImplementation(() => { throw new Error('db down'); });
    expect(await isLocationSilenceExcusedForRecord(record(), NOW)).toBe(false);
  });
});
