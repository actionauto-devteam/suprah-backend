import type { MonitoringMode } from '../config/departmentMonitoring';
import type { SharingState } from '../models/EmployeeLocation.model';

export type LocationDeviceType = 'mobile' | 'desktop';
type TimeValue = Date | string | number | null | undefined;
type Env = Record<string, string | undefined>;

export interface MainChannelSnapshot {
  deviceType?: LocationDeviceType | null;
  sharingState?: SharingState | null;
  lastSeenAt?: TimeValue;
}

export interface DesktopChannelSnapshot {
  desktopLastSeenAt?: TimeValue;
  desktopInputAgeSec?: number | null;
}

export interface LocationTuning {
  mobileStickyMs: number;
  desktopFreshMs: number;
  inputConfirmSec: number;
}

export const DEFAULT_LOCATION_TUNING: LocationTuning = {
  mobileStickyMs: 180_000,
  desktopFreshMs: 150_000,
  inputConfirmSec: 300,
};

const readPositive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getLocationTuning = (env: Env = process.env): LocationTuning => ({
  mobileStickyMs: readPositive(env.LOC_MOBILE_STICKY_MS, DEFAULT_LOCATION_TUNING.mobileStickyMs),
  desktopFreshMs: readPositive(env.LOC_DESKTOP_FRESH_MS, DEFAULT_LOCATION_TUNING.desktopFreshMs),
  inputConfirmSec: readPositive(env.LOC_INPUT_CONFIRM_SEC, DEFAULT_LOCATION_TUNING.inputConfirmSec),
});

const toMs = (value: TimeValue): number | null => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const isMobileFresh = (
  main: MainChannelSnapshot | null | undefined,
  nowMs: number,
  windowMs: number,
): boolean => {
  if (!main || main.deviceType !== 'mobile' || main.sharingState !== 'sharing') return false;
  const lastSeenMs = toMs(main.lastSeenAt);
  return lastSeenMs !== null && lastSeenMs >= nowMs - windowMs;
};

export const isDesktopChannelFresh = (
  desktop: DesktopChannelSnapshot | null | undefined,
  nowMs: number,
  freshMs: number,
): boolean => {
  const seenMs = toMs(desktop?.desktopLastSeenAt);
  return seenMs !== null && seenMs >= nowMs - freshMs && seenMs <= nowMs + 60_000;
};

export const effectiveDesktopInputAgeSec = (
  desktop: DesktopChannelSnapshot | null | undefined,
  nowMs: number,
): number | null => {
  const reported = desktop?.desktopInputAgeSec;
  const seenMs = toMs(desktop?.desktopLastSeenAt);
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0 || seenMs === null) return null;
  return reported + Math.max(0, nowMs - seenMs) / 1000;
};

export const isInputConfirmingPresence = (
  desktop: DesktopChannelSnapshot | null | undefined,
  nowMs: number,
  inputConfirmSec: number,
): boolean => {
  const age = effectiveDesktopInputAgeSec(desktop, nowMs);
  return age !== null && age <= inputConfirmSec;
};

export const shouldIgnoreDesktopPing = (params: {
  mode: MonitoringMode;
  incomingDeviceType: LocationDeviceType | null | undefined;
  previous: MainChannelSnapshot | null | undefined;
  nowMs: number;
  tuning?: LocationTuning;
}): boolean => {
  const tuning = params.tuning ?? DEFAULT_LOCATION_TUNING;
  if (params.mode !== 'switching' || params.incomingDeviceType !== 'desktop') return false;
  return isMobileFresh(params.previous, params.nowMs, tuning.mobileStickyMs);
};

export const isSilenceExcused = (params: {
  mode: MonitoringMode;
  main: MainChannelSnapshot | null | undefined;
  desktop: DesktopChannelSnapshot | null | undefined;
  nowMs: number;
  tuning?: LocationTuning;
}): boolean => {
  const tuning = params.tuning ?? DEFAULT_LOCATION_TUNING;
  if (params.mode === 'always') return false;
  if (!params.main || params.main.sharingState !== 'sharing') return false;
  if (!isDesktopChannelFresh(params.desktop, params.nowMs, tuning.desktopFreshMs)) return false;
  if (params.main.deviceType === 'mobile') {
    return isInputConfirmingPresence(params.desktop, params.nowMs, tuning.inputConfirmSec);
  }
  return true;
};

export const pickDisplayChannel = (params: {
  main: MainChannelSnapshot | null | undefined;
  desktop: DesktopChannelSnapshot | null | undefined;
  nowMs: number;
  tuning?: LocationTuning;
}): 'main' | 'desktop' => {
  const tuning = params.tuning ?? DEFAULT_LOCATION_TUNING;
  if (!params.main || params.main.sharingState !== 'sharing') return 'main';
  if (!isDesktopChannelFresh(params.desktop, params.nowMs, tuning.desktopFreshMs)) return 'main';
  if (isMobileFresh(params.main, params.nowMs, tuning.mobileStickyMs)) return 'main';
  const desktopSeenMs = toMs(params.desktop?.desktopLastSeenAt);
  const mainSeenMs = toMs(params.main.lastSeenAt);
  if (desktopSeenMs === null) return 'main';
  return mainSeenMs === null || desktopSeenMs > mainSeenMs ? 'desktop' : 'main';
};

export const isDesktopActiveOverPhone = (params: {
  mode: MonitoringMode;
  main: MainChannelSnapshot | null | undefined;
  desktop: DesktopChannelSnapshot | null | undefined;
  nowMs: number;
  tuning?: LocationTuning;
}): boolean => {
  const tuning = params.tuning ?? DEFAULT_LOCATION_TUNING;
  if (params.mode !== 'switching' || !params.main || params.main.deviceType !== 'mobile') return false;
  if (!isDesktopChannelFresh(params.desktop, params.nowMs, tuning.desktopFreshMs)) return false;
  if (!isInputConfirmingPresence(params.desktop, params.nowMs, tuning.inputConfirmSec)) return false;
  const desktopSeenMs = toMs(params.desktop?.desktopLastSeenAt);
  const mobileSeenMs = toMs(params.main.lastSeenAt);
  if (desktopSeenMs === null) return false;
  return mobileSeenMs === null || desktopSeenMs > mobileSeenMs;
};
