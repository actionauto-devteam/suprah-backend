const mockStateFindById = jest.fn();
const mockStateUpdateOne = jest.fn();
const mockStateDeleteOne = jest.fn();
const mockLocFindOne = jest.fn();
const mockLocUpdateOne = jest.fn();
const mockBeatFindOne = jest.fn();
const mockAuditCreate = jest.fn();
const mockResolveMode = jest.fn();
const mockEmitToUser = jest.fn();
const mockEmitToShiftBoard = jest.fn();
const mockGetOpenShiftStart = jest.fn();
const mockGetActiveDevice = jest.fn();

jest.mock('../../src/models/MonitoringDeviceState.model', () => ({
  __esModule: true,
  default: { findById: mockStateFindById, updateOne: mockStateUpdateOne, deleteOne: mockStateDeleteOne },
}));
jest.mock('../../src/models/EmployeeLocation.model', () => ({
  __esModule: true,
  default: { findOne: mockLocFindOne, updateOne: mockLocUpdateOne },
}));
jest.mock('../../src/models/AgentHeartbeat.model', () => ({ __esModule: true, default: { findOne: mockBeatFindOne } }));
jest.mock('../../src/models/AuditLog.model', () => ({ __esModule: true, default: { create: mockAuditCreate } }));
jest.mock('../../src/config/departmentMonitoring', () => ({ resolveMonitoringMode: mockResolveMode }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser: mockEmitToUser, emitToShiftBoard: mockEmitToShiftBoard }));
jest.mock('../../src/utils/monitoringDeviceState.util', () => ({
  getOpenShiftStart: mockGetOpenShiftStart,
  getActiveDevice: mockGetActiveDevice,
}));

import {
  clearShiftDevice,
  getDeviceSwitchView,
  initShiftDevice,
  recordDeviceSwitchOverrideChange,
  switchMonitoringDevice,
} from '../../src/services/monitoringDevice.service';

const savedEnv = { ...process.env };
const SHIFT_START = new Date('2026-09-25T10:00:00.000Z');
const user = (overrides: Record<string, unknown> = {}) => ({
  _id: 'user1',
  organizationId: 'org1',
  department: 'Recon',
  monitoringModeOverride: 'default',
  deviceSwitchOverride: 'on',
  ...overrides,
});
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const state = (overrides: Record<string, unknown> = {}) => ({
  activeDevice: 'desktop',
  shiftStartedAt: SHIFT_START,
  switchedAt: new Date(Date.now() - 10 * 60_000),
  history: [{ from: null, to: 'desktop', at: SHIFT_START, by: 'shift-start' }],
  ...overrides,
});

describe('monitoringDevice.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.MON_DEVICE_SWITCH;
    delete process.env.MON_DEVICE_SWITCH_DISABLED;
    mockResolveMode.mockResolvedValue('switching');
    mockGetOpenShiftStart.mockResolvedValue(SHIFT_START);
    mockGetActiveDevice.mockResolvedValue('desktop');
    mockStateFindById.mockImplementation(() => lean(state()));
    mockStateUpdateOne.mockResolvedValue({});
    mockStateDeleteOne.mockResolvedValue({});
    mockLocFindOne.mockImplementation(() => lean({ _id: 'loc1' }));
    mockLocUpdateOne.mockResolvedValue({});
    mockBeatFindOne.mockImplementation(() => lean({ _id: 'beat1' }));
    mockAuditCreate.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('initShiftDevice', () => {
    it('records the device the shift started on and tells the other devices', async () => {
      await initShiftDevice(user(), SHIFT_START, 'ios-pwa');
      const [filter, update, options] = mockStateUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'user1' });
      expect(options).toEqual({ upsert: true });
      expect(update.$set).toMatchObject({ organizationId: 'org1', shiftStartedAt: SHIFT_START, activeDevice: 'mobile' });
      expect(update.$set.history).toEqual([expect.objectContaining({ from: null, to: 'mobile', by: 'shift-start' })]);
      expect(mockEmitToUser).toHaveBeenCalledWith('user1', 'monitoring-device', expect.objectContaining({ activeDevice: 'mobile' }));
    });

    it('defaults to the computer for a desktop browser and for the tray, which sends no hint', async () => {
      await initShiftDevice(user(), SHIFT_START, 'desktop-web');
      await initShiftDevice(user(), SHIFT_START, undefined);
      expect(mockStateUpdateOne.mock.calls[0][1].$set.activeDevice).toBe('desktop');
      expect(mockStateUpdateOne.mock.calls[1][1].$set.activeDevice).toBe('desktop');
    });

    it('does nothing when the feature is off for the user, when the mode is not switching, or without an organization', async () => {
      await initShiftDevice(user({ deviceSwitchOverride: 'default' }), SHIFT_START, 'ios-pwa');
      await initShiftDevice(user({ deviceSwitchOverride: 'off' }), SHIFT_START, 'ios-pwa');
      mockResolveMode.mockResolvedValue('off');
      await initShiftDevice(user(), SHIFT_START, 'ios-pwa');
      mockResolveMode.mockResolvedValue('switching');
      await initShiftDevice(user({ organizationId: null }), SHIFT_START, 'ios-pwa');
      expect(mockStateUpdateOne).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceSwitchView', () => {
    it('is disabled without touching the database when the feature is off', async () => {
      const view = await getDeviceSwitchView(user({ deviceSwitchOverride: 'default' }));
      expect(view).toEqual({ enabled: false, activeDevice: null });
      expect(mockResolveMode).not.toHaveBeenCalled();
      expect(mockGetActiveDevice).not.toHaveBeenCalled();
    });

    it('is disabled for an account that is not in Switching mode', async () => {
      mockResolveMode.mockResolvedValue('always');
      expect(await getDeviceSwitchView(user())).toEqual({ enabled: false, activeDevice: null });
    });

    it('reports the active device for an enabled Switching account', async () => {
      mockGetActiveDevice.mockResolvedValue('mobile');
      expect(await getDeviceSwitchView(user())).toEqual({ enabled: true, activeDevice: 'mobile' });
    });
  });

  describe('switchMonitoringDevice', () => {
    it('rejects an unknown device name', async () => {
      expect(await switchMonitoringDevice({ user: user(), to: 'tablet', actor: 'user' })).toMatchObject({ ok: false, status: 400, code: 'BAD_DEVICE' });
    });

    it('refuses when the feature is off and never touches state', async () => {
      const result = await switchMonitoringDevice({ user: user({ deviceSwitchOverride: 'off' }), to: 'mobile', actor: 'user' });
      expect(result).toMatchObject({ ok: false, status: 403, code: 'DEVICE_SWITCH_OFF' });
      expect(mockStateUpdateOne).not.toHaveBeenCalled();
    });

    it('refuses without an open shift', async () => {
      mockGetOpenShiftStart.mockResolvedValue(null);
      expect(await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' })).toMatchObject({ ok: false, code: 'NOT_ON_SHIFT' });
    });

    it('moves monitoring to the phone, records history, clears the location episode, audits and announces', async () => {
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user', actorId: 'user1' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'mobile', unchanged: false });
      const [filter, update, options] = mockStateUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'user1' });
      expect(options).toBeUndefined();
      expect(update.$set).toMatchObject({ activeDevice: 'mobile', shiftStartedAt: SHIFT_START });
      expect(update.$push.history.$slice).toBe(-20);
      expect(update.$push.history.$each[0]).toMatchObject({ from: 'desktop', to: 'mobile', by: 'user', actorId: 'user1' });
      expect(mockLocUpdateOne).toHaveBeenCalledWith(
        { userId: 'user1' },
        { locationIssueDetectedAt: null, locationWarningStage: 0, connectionLostNotifiedAt: null },
      );
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'monitoring_device_switched', changes: { activeDevice: { from: 'desktop', to: 'mobile' } }, performedBy: 'user1' }),
      );
      expect(mockEmitToUser).toHaveBeenCalledWith('user1', 'monitoring-device', expect.objectContaining({ activeDevice: 'mobile', by: 'user' }));
      expect(mockEmitToShiftBoard).toHaveBeenCalledWith('monitoring-device', expect.objectContaining({ userId: 'user1' }));
    });

    it('checks that the phone is sharing fresh location before moving to it', async () => {
      await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' });
      const filter = mockLocFindOne.mock.calls[0][0];
      expect(filter).toMatchObject({ userId: 'user1', deviceType: 'mobile', sharingState: 'sharing' });
      expect(filter.lastSeenAt.$gte.getTime()).toBeGreaterThan(Date.now() - 125_000);
      expect(mockBeatFindOne).not.toHaveBeenCalled();
    });

    it('refuses to move to a phone that has not shared location and writes nothing', async () => {
      mockLocFindOne.mockImplementation(() => lean(null));
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' });
      expect(result).toMatchObject({ ok: false, status: 409, code: 'MOBILE_NOT_READY' });
      expect(mockStateUpdateOne).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('checks the tray heartbeat before moving back to the computer', async () => {
      mockStateFindById.mockImplementation(() => lean(state({ activeDevice: 'mobile' })));
      const result = await switchMonitoringDevice({ user: user(), to: 'desktop', actor: 'user' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'desktop' });
      expect(mockBeatFindOne).toHaveBeenCalled();
      expect(mockLocFindOne).not.toHaveBeenCalled();
    });

    it('refuses to move to a computer whose app is offline', async () => {
      mockStateFindById.mockImplementation(() => lean(state({ activeDevice: 'mobile' })));
      mockBeatFindOne.mockImplementation(() => lean(null));
      expect(await switchMonitoringDevice({ user: user(), to: 'desktop', actor: 'user' })).toMatchObject({ ok: false, code: 'DESKTOP_NOT_READY' });
      expect(mockStateUpdateOne).not.toHaveBeenCalled();
    });

    it('answers unchanged without writing when the device is already the active one', async () => {
      const result = await switchMonitoringDevice({ user: user(), to: 'desktop', actor: 'user' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'desktop', unchanged: true });
      expect(mockStateUpdateOne).not.toHaveBeenCalled();
      expect(mockEmitToUser).not.toHaveBeenCalled();
    });

    it('applies a cooldown after a real switch but not right after the shift started', async () => {
      const justSwitched = state({
        activeDevice: 'mobile',
        switchedAt: new Date(Date.now() - 3000),
        history: [{ from: 'desktop', to: 'mobile', at: new Date(), by: 'user' }],
      });
      mockStateFindById.mockImplementation(() => lean(justSwitched));
      expect(await switchMonitoringDevice({ user: user(), to: 'desktop', actor: 'user' })).toMatchObject({ ok: false, code: 'TOO_SOON' });

      const justStarted = state({ activeDevice: 'mobile', switchedAt: new Date(Date.now() - 3000) });
      mockStateFindById.mockImplementation(() => lean(justStarted));
      expect(await switchMonitoringDevice({ user: user(), to: 'desktop', actor: 'user' })).toMatchObject({ ok: true, activeDevice: 'desktop' });
    });

    it('starts a fresh history when the stored state belongs to an earlier shift', async () => {
      mockStateFindById.mockImplementation(() => lean(state({ shiftStartedAt: new Date('2026-09-24T10:00:00.000Z') })));
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'mobile' });
      const [, update, options] = mockStateUpdateOne.mock.calls[0];
      expect(options).toEqual({ upsert: true });
      expect(update.$push).toBeUndefined();
      expect(update.$set.history).toHaveLength(1);
      expect(update.$set.history[0]).toMatchObject({ from: null, to: 'mobile', by: 'user' });
    });

    it('accepts a switch when no state exists yet, for a shift that started before the feature was on', async () => {
      mockStateFindById.mockImplementation(() => lean(null));
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'mobile' });
      expect(mockStateUpdateOne.mock.calls[0][2]).toEqual({ upsert: true });
    });

    it('lets an admin override without any liveness check or cooldown and records who did it', async () => {
      mockLocFindOne.mockImplementation(() => lean(null));
      mockStateFindById.mockImplementation(() => lean(state({ switchedAt: new Date(Date.now() - 1000), history: [{ from: 'desktop', to: 'desktop', at: new Date(), by: 'user' }] })));
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'admin', actorId: 'admin1' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'mobile' });
      expect(mockLocFindOne).not.toHaveBeenCalled();
      expect(mockBeatFindOne).not.toHaveBeenCalled();
      expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'monitoring_device_switched_by_admin', performedBy: 'admin1' }));
      expect(mockEmitToUser).toHaveBeenCalledWith('user1', 'monitoring-device', expect.objectContaining({ by: 'admin' }));
    });

    it('never fails because the audit or the announcement failed', async () => {
      mockAuditCreate.mockImplementation(() => { throw new Error('db down'); });
      mockEmitToUser.mockImplementation(() => { throw new Error('socket down'); });
      const result = await switchMonitoringDevice({ user: user(), to: 'mobile', actor: 'user' });
      expect(result).toMatchObject({ ok: true, activeDevice: 'mobile' });
    });
  });

  describe('bookkeeping helpers', () => {
    it('records who changed the per-user override without ever throwing', () => {
      recordDeviceSwitchOverrideChange({ _id: 'u2', organizationId: 'org1' }, 'default', 'on', 'admin1');
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'User',
          entityId: 'u2',
          changes: { deviceSwitchOverride: { from: 'default', to: 'on' } },
          reason: 'device_switch_override_changed',
          performedBy: 'admin1',
        }),
      );
      mockAuditCreate.mockImplementation(() => { throw new Error('db down'); });
      expect(() => recordDeviceSwitchOverrideChange({ _id: 'u2' }, 'on', 'off', undefined)).not.toThrow();
    });

    it('clears a user shift state and never throws', () => {
      clearShiftDevice('user1');
      expect(mockStateDeleteOne).toHaveBeenCalledWith({ _id: 'user1' });
      mockStateDeleteOne.mockImplementation(() => { throw new Error('db down'); });
      expect(() => clearShiftDevice('user1')).not.toThrow();
    });
  });
});
