import {
  SWITCH_COOLDOWN_MS,
  decideSwitch,
  deviceFromHint,
  isDeviceSwitchEnabledForUser,
  isMonitoringDevice,
  isStateForShift,
  normalizeDeviceSwitchOverride,
} from '../../src/utils/deviceSwitch.util';

const base = {
  to: 'mobile' as const,
  current: 'desktop' as const,
  isOnShift: true,
  mode: 'switching',
  actor: 'user' as const,
  mobileFresh: true,
  trayFresh: true,
  lastSwitchAt: null,
  nowMs: 1_000_000,
};

describe('device switch enablement', () => {
  it('normalizes anything unexpected to default', () => {
    expect(normalizeDeviceSwitchOverride('on')).toBe('on');
    expect(normalizeDeviceSwitchOverride('off')).toBe('off');
    for (const value of ['ON', 'true', '', null, undefined, 1, {}]) {
      expect(normalizeDeviceSwitchOverride(value)).toBe('default');
    }
  });

  it('is off by default and follows the environment list for a default user', () => {
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1' }, {})).toBe(false);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1' }, { MON_DEVICE_SWITCH: 'off' })).toBe(false);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1' }, { MON_DEVICE_SWITCH: 'u1,u2' })).toBe(true);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u3' }, { MON_DEVICE_SWITCH: 'u1,u2' })).toBe(false);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u3' }, { MON_DEVICE_SWITCH: 'all' })).toBe(true);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u3' }, { MON_DEVICE_SWITCH: 'true' })).toBe(false);
  });

  it('an admin on enables one user with no environment setting, and off beats the list and all', () => {
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'on' }, {})).toBe(true);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'off' }, { MON_DEVICE_SWITCH: 'all' })).toBe(false);
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'off' }, { MON_DEVICE_SWITCH: 'u1' })).toBe(false);
  });

  it('the kill switch beats everything and a missing user is never enabled', () => {
    const env = { MON_DEVICE_SWITCH: 'all', MON_DEVICE_SWITCH_DISABLED: 'true' };
    expect(isDeviceSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'on' }, env)).toBe(false);
    expect(isDeviceSwitchEnabledForUser(null, { MON_DEVICE_SWITCH: 'all' })).toBe(false);
  });
});

describe('device helpers', () => {
  it('reads the starting device from the hint the way startedVia does', () => {
    expect(deviceFromHint('desktop-web')).toBe('desktop');
    expect(deviceFromHint('desktop')).toBe('desktop');
    expect(deviceFromHint(undefined)).toBe('desktop');
    expect(deviceFromHint('')).toBe('desktop');
    expect(deviceFromHint('ios-pwa')).toBe('mobile');
    expect(deviceFromHint('android-pwa')).toBe('mobile');
  });

  it('accepts only the two device names', () => {
    expect(isMonitoringDevice('desktop')).toBe(true);
    expect(isMonitoringDevice('mobile')).toBe(true);
    for (const value of ['phone', 'Desktop', '', null, undefined, 1]) expect(isMonitoringDevice(value)).toBe(false);
  });

  it('a stored state belongs to a shift only when the start times are identical', () => {
    const start = new Date('2026-09-25T10:00:00.000Z');
    expect(isStateForShift(new Date(start), start)).toBe(true);
    expect(isStateForShift(start.toISOString(), start)).toBe(true);
    expect(isStateForShift(new Date(start.getTime() + 1), start)).toBe(false);
    expect(isStateForShift(null, start)).toBe(false);
    expect(isStateForShift(start, null)).toBe(false);
    expect(isStateForShift('garbage', start)).toBe(false);
  });
});

describe('decideSwitch', () => {
  it('lets a user move to a phone that is sharing fresh location', () => {
    expect(decideSwitch(base)).toEqual({ ok: true, unchanged: false });
  });

  it('lets a user move back to a computer whose app is online', () => {
    expect(decideSwitch({ ...base, to: 'desktop', current: 'mobile' })).toEqual({ ok: true, unchanged: false });
  });

  it('refuses a switch to a phone with no fresh location', () => {
    expect(decideSwitch({ ...base, mobileFresh: false })).toMatchObject({ ok: false, status: 409, code: 'MOBILE_NOT_READY' });
  });

  it('refuses a switch to a computer whose app is offline', () => {
    expect(decideSwitch({ ...base, to: 'desktop', current: 'mobile', trayFresh: false })).toMatchObject({
      ok: false,
      status: 409,
      code: 'DESKTOP_NOT_READY',
    });
  });

  it('does not check the other device while the target is the current one and answers unchanged', () => {
    expect(decideSwitch({ ...base, current: 'mobile', mobileFresh: false })).toEqual({ ok: true, unchanged: true });
  });

  it('requires an open shift and a Switching account', () => {
    expect(decideSwitch({ ...base, isOnShift: false })).toMatchObject({ ok: false, code: 'NOT_ON_SHIFT' });
    expect(decideSwitch({ ...base, mode: 'off' })).toMatchObject({ ok: false, code: 'NOT_SWITCHING' });
    expect(decideSwitch({ ...base, mode: 'always' })).toMatchObject({ ok: false, code: 'NOT_SWITCHING' });
  });

  it('applies a cooldown to users only', () => {
    const recent = base.nowMs - (SWITCH_COOLDOWN_MS - 1000);
    const old = base.nowMs - (SWITCH_COOLDOWN_MS + 1000);
    expect(decideSwitch({ ...base, lastSwitchAt: recent })).toMatchObject({ ok: false, code: 'TOO_SOON' });
    expect(decideSwitch({ ...base, lastSwitchAt: old })).toEqual({ ok: true, unchanged: false });
    expect(decideSwitch({ ...base, actor: 'admin', lastSwitchAt: recent })).toEqual({ ok: true, unchanged: false });
  });

  it('an admin override skips the liveness checks', () => {
    expect(decideSwitch({ ...base, actor: 'admin', mobileFresh: false })).toEqual({ ok: true, unchanged: false });
    expect(decideSwitch({ ...base, actor: 'admin', to: 'desktop', current: 'mobile', trayFresh: false })).toEqual({
      ok: true,
      unchanged: false,
    });
  });

  it('an admin still needs an open shift and a Switching account', () => {
    expect(decideSwitch({ ...base, actor: 'admin', isOnShift: false })).toMatchObject({ ok: false, code: 'NOT_ON_SHIFT' });
    expect(decideSwitch({ ...base, actor: 'admin', mode: 'off' })).toMatchObject({ ok: false, code: 'NOT_SWITCHING' });
  });

  it('allows a switch with no known current device, for example a shift that started before the feature was on', () => {
    expect(decideSwitch({ ...base, current: null })).toEqual({ ok: true, unchanged: false });
  });
});
