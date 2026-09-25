const mockFindOne = jest.fn();
const mockResolveMode = jest.fn();

jest.mock('../../src/models/EmployeeLocation.model', () => ({
  __esModule: true,
  default: { findOne: mockFindOne },
}));
jest.mock('../../src/config/departmentMonitoring', () => ({
  resolveMonitoringMode: mockResolveMode,
}));

import { resolveScreenshotsRequired } from '../../src/utils/monitoringMode.util';

const originalFlag = process.env.LOC_HANDOFF_SCREENSHOTS;
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

const params = { userId: 'user-1', organizationId: 'org-1', department: 'Recon', monitoringModeOverride: 'default' as const };

const setLocation = (options: { phoneFresh: boolean; record?: Record<string, unknown> | null; recordThrows?: boolean }) => {
  mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
    if (filter.deviceType === 'mobile') {
      return { select: () => ({ lean: () => Promise.resolve(options.phoneFresh ? { _id: 'loc-1' } : null) }) };
    }
    return {
      select: () => ({
        lean: () => (options.recordThrows ? Promise.reject(new Error('db down')) : Promise.resolve(options.record ?? null)),
      }),
    };
  });
};

const phoneThenComputerRecord = (overrides: Record<string, unknown> = {}) => ({
  deviceType: 'mobile',
  sharingState: 'sharing',
  lastSeenAt: secondsAgo(200),
  desktopLastSeenAt: secondsAgo(20),
  desktopInputAgeSec: 10,
  ...overrides,
});

const detailQueries = () => mockFindOne.mock.calls.filter(([filter]) => filter.deviceType !== 'mobile');

describe('resolveScreenshotsRequired handoff from phone to computer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOC_HANDOFF_SCREENSHOTS = 'user-1';
    mockResolveMode.mockResolvedValue('switching');
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.LOC_HANDOFF_SCREENSHOTS;
    else process.env.LOC_HANDOFF_SCREENSHOTS = originalFlag;
  });

  it('keeps today behavior while the flag is off, even with recent computer input', async () => {
    delete process.env.LOC_HANDOFF_SCREENSHOTS;
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord() });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
    expect(detailQueries()).toHaveLength(0);
  });

  it('keeps today behavior for a user outside the pilot list', async () => {
    process.env.LOC_HANDOFF_SCREENSHOTS = 'someone-else';
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord() });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
    expect(detailQueries()).toHaveLength(0);
  });

  it('requires screenshots once the computer shows recent input newer than the last phone ping', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord() });
    expect(await resolveScreenshotsRequired(params)).toBe(true);
  });

  it('keeps the phone active when it pinged after the computer report', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord({ lastSeenAt: secondsAgo(5) }) });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
  });

  it('keeps the phone active when the computer has had no input for hours', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord({ desktopInputAgeSec: 7200 }) });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
  });

  it('keeps the phone active when the computer report is stale or missing', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord({ desktopLastSeenAt: secondsAgo(600) }) });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord({ desktopLastSeenAt: undefined, desktopInputAgeSec: undefined }) });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
    setLocation({ phoneFresh: true, record: null });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
  });

  it('falls back to today behavior when the detail lookup fails', async () => {
    setLocation({ phoneFresh: true, recordThrows: true });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
  });

  it('requires screenshots when the phone is not fresh, without any extra lookup', async () => {
    setLocation({ phoneFresh: false, record: phoneThenComputerRecord() });
    expect(await resolveScreenshotsRequired(params)).toBe(true);
    expect(detailQueries()).toHaveLength(0);
  });

  it('leaves the other modes and exemptions untouched', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord() });
    mockResolveMode.mockResolvedValue('off');
    expect(await resolveScreenshotsRequired(params)).toBe(true);
    mockResolveMode.mockResolvedValue('always');
    expect(await resolveScreenshotsRequired(params)).toBe(false);
    mockResolveMode.mockResolvedValue('switching');
    expect(await resolveScreenshotsRequired({ ...params, screenshotExempt: true })).toBe(false);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('passes the user override to the mode resolver', async () => {
    setLocation({ phoneFresh: false });
    await resolveScreenshotsRequired({ ...params, monitoringModeOverride: 'switching' });
    expect(mockResolveMode).toHaveBeenCalledWith('org-1', 'Recon', 'switching');
  });

  it('flips back to the phone as soon as it pings again', async () => {
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord() });
    expect(await resolveScreenshotsRequired(params)).toBe(true);
    setLocation({ phoneFresh: true, record: phoneThenComputerRecord({ lastSeenAt: secondsAgo(2) }) });
    expect(await resolveScreenshotsRequired(params)).toBe(false);
  });
});
