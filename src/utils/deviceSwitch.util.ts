type Env = Record<string, string | undefined>;

export type MonitoringDevice = 'desktop' | 'mobile';
export type DeviceSwitchOverride = 'default' | 'on' | 'off';
export type SwitchActor = 'user' | 'admin' | 'geofence';

export const DEVICE_SWITCH_OVERRIDES: readonly DeviceSwitchOverride[] = ['default', 'on', 'off'];
export const SWITCH_COOLDOWN_MS = 20_000;
export const MOBILE_PING_FRESH_MS = 120_000;
export const TRAY_HEARTBEAT_FRESH_MS = 150_000;
export const MOBILE_SHIFT_GUARD_MS = 20 * 60_000;

const stripQuotes = (value: string): string => value.trim().replace(/^["']+|["']+$/g, '').trim();

export const isDeviceSwitchKilled = (env: Env = process.env): boolean =>
  (env.MON_DEVICE_SWITCH_DISABLED ?? '').trim().toLowerCase() === 'true';

const isDeviceSwitchFlagOn = (
  userId: string | { toString(): string } | null | undefined,
  env: Env,
): boolean => {
  const raw = stripQuotes(env.MON_DEVICE_SWITCH ?? '').toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'all') return true;
  if (userId === null || userId === undefined) return false;
  const id = String(userId).trim().toLowerCase();
  return raw.split(',').map(stripQuotes).filter(Boolean).includes(id);
};

export const normalizeDeviceSwitchOverride = (value: unknown): DeviceSwitchOverride =>
  value === 'on' || value === 'off' ? value : 'default';

export const isDeviceSwitchEnabledForUser = (
  user: { _id?: string | { toString(): string } | null; deviceSwitchOverride?: unknown } | null | undefined,
  env: Env = process.env,
): boolean => {
  if (!user) return false;
  if (isDeviceSwitchKilled(env)) return false;
  const override = normalizeDeviceSwitchOverride(user.deviceSwitchOverride);
  if (override === 'off') return false;
  if (override === 'on') return true;
  return isDeviceSwitchFlagOn(user._id, env);
};

export const isMonitoringDevice = (value: unknown): value is MonitoringDevice =>
  value === 'desktop' || value === 'mobile';

export const deviceFromHint = (hint: unknown): MonitoringDevice => {
  const value = typeof hint === 'string' ? hint.trim().toLowerCase() : '';
  return value !== '' && value !== 'desktop-web' && value !== 'desktop' ? 'mobile' : 'desktop';
};

export const isStateForShift = (
  stateShiftStartedAt: Date | string | number | null | undefined,
  shiftStartedAt: Date | string | number | null | undefined,
): boolean => {
  if (stateShiftStartedAt === null || stateShiftStartedAt === undefined) return false;
  if (shiftStartedAt === null || shiftStartedAt === undefined) return false;
  const a = new Date(stateShiftStartedAt).getTime();
  const b = new Date(shiftStartedAt).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
};

export type SwitchDecision =
  | { ok: true; unchanged: boolean }
  | { ok: false; status: number; code: string; message: string };

export const decideSwitch = (params: {
  to: MonitoringDevice;
  current: MonitoringDevice | null;
  isOnShift: boolean;
  mode: string;
  actor: SwitchActor;
  mobileFresh: boolean;
  trayFresh: boolean;
  lastSwitchAt: Date | string | number | null | undefined;
  nowMs: number;
  awayFromWorkSite?: boolean;
  awaySiteName?: string | null;
}): SwitchDecision => {
  if (params.mode !== 'switching') {
    return { ok: false, status: 409, code: 'NOT_SWITCHING', message: 'This account is not set up to switch monitoring between devices.' };
  }
  if (!params.isOnShift) {
    return { ok: false, status: 409, code: 'NOT_ON_SHIFT', message: 'Start a shift before switching monitoring.' };
  }
  if (params.current === params.to) return { ok: true, unchanged: true };
  if (params.actor === 'admin' || params.actor === 'geofence') return { ok: true, unchanged: false };

  if (params.to === 'desktop' && params.awayFromWorkSite) {
    const site = params.awaySiteName ? params.awaySiteName : 'your work site';
    return {
      ok: false,
      status: 409,
      code: 'AWAY_FROM_WORK_SITE',
      message: `You're away from ${site}. Monitoring stays on your phone until you're back at a work site.`,
    };
  }

  if (params.lastSwitchAt !== null && params.lastSwitchAt !== undefined) {
    const last = new Date(params.lastSwitchAt).getTime();
    if (Number.isFinite(last) && params.nowMs - last < SWITCH_COOLDOWN_MS) {
      return { ok: false, status: 409, code: 'TOO_SOON', message: 'Please wait a few seconds before switching again.' };
    }
  }
  if (params.to === 'mobile' && !params.mobileFresh) {
    return {
      ok: false,
      status: 409,
      code: 'MOBILE_NOT_READY',
      message: "Your phone hasn't shared its location yet. Keep this page open with location on and try again in a few seconds.",
    };
  }
  if (params.to === 'desktop' && !params.trayFresh) {
    return {
      ok: false,
      status: 409,
      code: 'DESKTOP_NOT_READY',
      message: "The TimeProof app on your computer isn't online. Open it, then switch again.",
    };
  }
  return { ok: true, unchanged: false };
};
