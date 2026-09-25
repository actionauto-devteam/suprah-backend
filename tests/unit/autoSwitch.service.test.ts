const mockPlaceFind = jest.fn();
const mockStateFindById = jest.fn();
const mockStateUpdateOne = jest.fn();
const mockGetOpenShiftStart = jest.fn();
const mockSwitchMonitoringDevice = jest.fn();

jest.mock('../../src/models/Place.model', () => ({
  __esModule: true,
  default: { find: mockPlaceFind },
}));
jest.mock('../../src/models/MonitoringDeviceState.model', () => ({
  __esModule: true,
  default: { findById: mockStateFindById, updateOne: mockStateUpdateOne },
}));
jest.mock('../../src/utils/monitoringDeviceState.util', () => ({
  getOpenShiftStart: mockGetOpenShiftStart,
}));
jest.mock('../../src/services/monitoringDevice.service', () => ({
  switchMonitoringDevice: mockSwitchMonitoringDevice,
}));

import { invalidateWorkSiteCache, processMobilePingForAutoSwitch } from '../../src/services/autoSwitch.service';

const savedEnv = { ...process.env };
const NOW = 50_000_000;
const SHIFT_START = new Date('2026-09-25T10:00:00.000Z');
const LEHI = { name: 'Action Auto Lehi', coords: { lat: 40.3916, lng: -111.8507 }, radiusM: 100 };
const AT_SITE = { lat: 40.3916, lng: -111.8507 };
const AWAY = { lat: 40.3916 + 3000 / 111_320, lng: -111.8507 };

const user = (overrides: Record<string, unknown> = {}) => ({
  _id: 'user1',
  organizationId: 'org1',
  deviceSwitchOverride: 'on',
  autoSwitchOverride: 'on',
  ...overrides,
});
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const state = (overrides: Record<string, unknown> = {}) => ({
  shiftStartedAt: SHIFT_START,
  activeDevice: 'desktop',
  awaySince: null,
  awayLastPingAt: null,
  ...overrides,
});
const ping = (position: { lat: number; lng: number }, extra: Record<string, unknown> = {}) =>
  processMobilePingForAutoSwitch({ user: user() as any, ...position, nowMs: NOW, ...extra });

describe('processMobilePingForAutoSwitch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.MON_AUTO_SWITCH;
    delete process.env.MON_AUTO_SWITCH_DISABLED;
    delete process.env.MON_AUTO_SWITCH_AWAY_MS;
    invalidateWorkSiteCache();
    mockPlaceFind.mockImplementation(() => lean([LEHI]));
    mockStateFindById.mockImplementation(() => lean(state()));
    mockStateUpdateOne.mockResolvedValue({});
    mockGetOpenShiftStart.mockResolvedValue(SHIFT_START);
    mockSwitchMonitoringDevice.mockResolvedValue({ ok: true, activeDevice: 'mobile', switchedAt: new Date(), unchanged: false });
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('does nothing and touches nothing when auto-switch is not on for the user', async () => {
    const result = await processMobilePingForAutoSwitch({ user: user({ autoSwitchOverride: 'default' }) as any, ...AWAY, nowMs: NOW });
    expect(result).toBe('none');
    expect(mockPlaceFind).not.toHaveBeenCalled();
    expect(mockStateFindById).not.toHaveBeenCalled();
  });

  it('does nothing without an organization', async () => {
    expect(await processMobilePingForAutoSwitch({ user: user({ organizationId: null }) as any, ...AWAY, nowMs: NOW })).toBe('none');
    expect(mockPlaceFind).not.toHaveBeenCalled();
  });

  it('ignores a coarse fix without any database work', async () => {
    expect(await ping(AWAY, { accuracyM: 150 })).toBe('none');
    expect(mockPlaceFind).not.toHaveBeenCalled();
  });

  it('accepts a fix at exactly the accuracy limit and a fix with no accuracy', async () => {
    expect(await ping(AWAY, { accuracyM: 100 })).toBe('start');
    mockStateUpdateOne.mockClear();
    expect(await ping(AWAY)).toBe('start');
  });

  it('only loads active work sites of the organization', async () => {
    await ping(AWAY);
    expect(mockPlaceFind).toHaveBeenCalledWith({ organizationId: 'org1', isActive: true, isWorkSite: true });
  });

  it('does nothing when the organization has no work sites, and does not read state', async () => {
    mockPlaceFind.mockImplementation(() => lean([]));
    expect(await ping(AWAY)).toBe('none');
    expect(mockStateFindById).not.toHaveBeenCalled();
  });

  it('remembers the work sites between pings and reloads them after an invalidation', async () => {
    await ping(AT_SITE);
    await ping(AT_SITE);
    expect(mockPlaceFind).toHaveBeenCalledTimes(1);
    invalidateWorkSiteCache('org1');
    await ping(AT_SITE);
    expect(mockPlaceFind).toHaveBeenCalledTimes(2);
  });

  it('reloads the work sites after the cache lifetime', async () => {
    await ping(AT_SITE);
    await processMobilePingForAutoSwitch({ user: user() as any, ...AT_SITE, nowMs: NOW + 31_000 });
    expect(mockPlaceFind).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a shift state, and does not look up the shift', async () => {
    mockStateFindById.mockImplementation(() => lean(null));
    expect(await ping(AWAY)).toBe('none');
    expect(mockGetOpenShiftStart).not.toHaveBeenCalled();
  });

  it('does nothing when there is no open shift or the state belongs to an earlier shift', async () => {
    mockGetOpenShiftStart.mockResolvedValue(null);
    expect(await ping(AWAY)).toBe('none');
    mockGetOpenShiftStart.mockResolvedValue(SHIFT_START);
    mockStateFindById.mockImplementation(() => lean(state({ shiftStartedAt: new Date('2026-09-24T10:00:00.000Z') })));
    expect(await ping(AWAY)).toBe('none');
    expect(mockStateUpdateOne).not.toHaveBeenCalled();
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
  });

  it('writes nothing while at the site with no away record', async () => {
    expect(await ping(AT_SITE)).toBe('none');
    expect(mockStateUpdateOne).not.toHaveBeenCalled();
  });

  it('clears the away record when the phone is back at the site', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 600_000), awayLastPingAt: new Date(NOW - 30_000) })));
    expect(await ping(AT_SITE)).toBe('clear');
    const [filter, update] = mockStateUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'user1', shiftStartedAt: SHIFT_START });
    expect(update).toEqual({ $unset: { awaySince: '', awayLastPingAt: '', awaySiteName: '', awayPaused: '' } });
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
  });

  it('never moves monitoring back to the phone while an admin override is in force, and re-arms after the phone returns', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 900_000), awayLastPingAt: new Date(NOW - 30_000), awayPaused: true })));
    expect(await ping(AWAY)).toBe('refresh');
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
    mockStateUpdateOne.mockClear();
    expect(await ping(AT_SITE)).toBe('clear');
    expect(mockStateUpdateOne.mock.calls[0][1].$unset).toHaveProperty('awayPaused');
  });

  it('a new departure after a long silence re-arms the automatic move even if it had been paused', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 3_600_000), awayLastPingAt: new Date(NOW - 1_200_000), awayPaused: true })));
    expect(await ping(AWAY)).toBe('start');
    expect(mockStateUpdateOne.mock.calls[0][1].$set.awayPaused).toBe(false);
  });

  it('starts the away clock on the first ping outside and does not switch yet', async () => {
    expect(await ping(AWAY)).toBe('start');
    const [filter, update] = mockStateUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'user1', shiftStartedAt: SHIFT_START });
    expect(update.$set.awaySince).toEqual(new Date(NOW));
    expect(update.$set.awayLastPingAt).toEqual(new Date(NOW));
    expect(update.$set.awaySiteName).toBe('Action Auto Lehi');
    expect(update.$set.awayPaused).toBe(false);
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
  });

  it('keeps refreshing while away for less than the required time', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 30_000), awayLastPingAt: new Date(NOW - 30_000) })));
    expect(await ping(AWAY)).toBe('refresh');
    expect(mockStateUpdateOne.mock.calls[0][1].$set.awayLastPingAt).toEqual(new Date(NOW));
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
  });

  it('moves monitoring to the phone once it has been away long enough, naming the site', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 70_000), awayLastPingAt: new Date(NOW - 30_000) })));
    expect(await ping(AWAY)).toBe('switch');
    expect(mockSwitchMonitoringDevice).toHaveBeenCalledTimes(1);
    expect(mockSwitchMonitoringDevice).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'mobile', actor: 'geofence', placeName: 'Action Auto Lehi' }),
    );
  });

  it('honours a shorter confirmation time from the environment', async () => {
    process.env.MON_AUTO_SWITCH_AWAY_MS = '2000';
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 3000), awayLastPingAt: new Date(NOW - 1000) })));
    expect(await ping(AWAY)).toBe('switch');
  });

  it('keeps the away record fresh but never switches when the phone is already the monitored device', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ activeDevice: 'mobile', awaySince: new Date(NOW - 900_000), awayLastPingAt: new Date(NOW - 30_000) })));
    expect(await ping(AWAY)).toBe('refresh');
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
    expect(mockStateUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('treats a long silence as a new departure instead of trusting the old away time', async () => {
    mockStateFindById.mockImplementation(() => lean(state({ awaySince: new Date(NOW - 3_600_000), awayLastPingAt: new Date(NOW - 1_200_000) })));
    expect(await ping(AWAY)).toBe('start');
    expect(mockSwitchMonitoringDevice).not.toHaveBeenCalled();
  });

  it('stays quiet in the buffer just outside the radius', async () => {
    const buffer = { lat: LEHI.coords.lat + 110 / 111_320, lng: LEHI.coords.lng };
    expect(await ping(buffer)).toBe('none');
  });
});
