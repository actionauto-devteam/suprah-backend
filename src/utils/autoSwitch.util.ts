import { distanceMeters } from './geofence';
import { isDeviceSwitchEnabledForUser } from './deviceSwitch.util';
import type { MonitoringDevice } from './deviceSwitch.util';

type Env = Record<string, string | undefined>;

export type AutoSwitchOverride = 'default' | 'on' | 'off';

export const AUTO_SWITCH_OVERRIDES: readonly AutoSwitchOverride[] = ['default', 'on', 'off'];
export const AUTO_SWITCH_ACCURACY_MAX_M = 100;
export const AUTO_SWITCH_EXIT_BUFFER_M = 20;
export const AUTO_SWITCH_AWAY_MS = 60_000;
export const AUTO_SWITCH_AWAY_GAP_MS = 5 * 60_000;
export const AUTO_SWITCH_PING_FRESH_MS = 120_000;

const MIN_AWAY_MS = 1_000;
const MAX_AWAY_MS = 30 * 60_000;

const stripQuotes = (value: string): string => value.trim().replace(/^["']+|["']+$/g, '').trim();

export const isAutoSwitchKilled = (env: Env = process.env): boolean =>
  (env.MON_AUTO_SWITCH_DISABLED ?? '').trim().toLowerCase() === 'true';

const isAutoSwitchFlagOn = (
  userId: string | { toString(): string } | null | undefined,
  env: Env,
): boolean => {
  const raw = stripQuotes(env.MON_AUTO_SWITCH ?? '').toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'all') return true;
  if (userId === null || userId === undefined) return false;
  const id = String(userId).trim().toLowerCase();
  return raw.split(',').map(stripQuotes).filter(Boolean).includes(id);
};

export const normalizeAutoSwitchOverride = (value: unknown): AutoSwitchOverride =>
  value === 'on' || value === 'off' ? value : 'default';

export const isAutoSwitchEnabledForUser = (
  user: {
    _id?: string | { toString(): string } | null;
    deviceSwitchOverride?: unknown;
    autoSwitchOverride?: unknown;
  } | null | undefined,
  env: Env = process.env,
): boolean => {
  if (!user) return false;
  if (isAutoSwitchKilled(env)) return false;
  if (!isDeviceSwitchEnabledForUser(user, env)) return false;
  const override = normalizeAutoSwitchOverride(user.autoSwitchOverride);
  if (override === 'off') return false;
  if (override === 'on') return true;
  return isAutoSwitchFlagOn(user._id, env);
};

export const getAutoSwitchAwayMs = (env: Env = process.env): number => {
  const raw = Number(env.MON_AUTO_SWITCH_AWAY_MS);
  if (!Number.isFinite(raw) || raw < MIN_AWAY_MS || raw > MAX_AWAY_MS) return AUTO_SWITCH_AWAY_MS;
  return Math.round(raw);
};

export interface WorkSiteRef {
  name: string;
  coords: { lat: number; lng: number };
  radiusM: number;
  warningRadiusM?: number | null;
}

export const workSiteExitThresholdM = (site: WorkSiteRef): number =>
  site.warningRadiusM && site.warningRadiusM > site.radiusM
    ? site.warningRadiusM
    : site.radiusM + AUTO_SWITCH_EXIT_BUFFER_M;

export interface WorkSiteReading {
  away: boolean;
  siteName: string | null;
  distanceM: number | null;
}

export const classifyAgainstWorkSites = (lat: number, lng: number, sites: WorkSiteRef[]): WorkSiteReading => {
  let nearest: { name: string; distanceM: number } | null = null;
  for (const site of sites) {
    const distanceM = distanceMeters(lat, lng, site.coords.lat, site.coords.lng);
    if (distanceM <= workSiteExitThresholdM(site)) return { away: false, siteName: site.name, distanceM };
    if (!nearest || distanceM < nearest.distanceM) nearest = { name: site.name, distanceM };
  }
  if (!nearest) return { away: false, siteName: null, distanceM: null };
  return { away: true, siteName: nearest.name, distanceM: nearest.distanceM };
};

export type AutoSwitchStep = 'none' | 'clear' | 'start' | 'refresh' | 'switch';

type MaybeDate = Date | string | number | null | undefined;

const toMsOrNull = (value: MaybeDate): number | null => {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const decideAutoSwitchStep = (params: {
  away: boolean;
  activeDevice: MonitoringDevice | null;
  awaySince: MaybeDate;
  awayLastPingAt: MaybeDate;
  paused?: boolean;
  nowMs: number;
  awayMs: number;
}): AutoSwitchStep => {
  const since = toMsOrNull(params.awaySince);
  const last = toMsOrNull(params.awayLastPingAt);
  if (!params.away) return since !== null || params.paused ? 'clear' : 'none';
  if (since === null || last === null || params.nowMs - last > AUTO_SWITCH_AWAY_GAP_MS) return 'start';
  if (!params.paused && params.activeDevice === 'desktop' && params.nowMs - since >= params.awayMs) return 'switch';
  return 'refresh';
};

export const isAwayBlockActive = (
  state: { awaySince?: MaybeDate; awayLastPingAt?: MaybeDate; awayPaused?: boolean } | null | undefined,
  nowMs: number,
  awayMs: number,
): boolean => {
  if (!state || state.awayPaused) return false;
  const since = toMsOrNull(state.awaySince);
  const last = toMsOrNull(state.awayLastPingAt);
  if (since === null || last === null) return false;
  if (nowMs - last > AUTO_SWITCH_PING_FRESH_MS) return false;
  return last - since >= awayMs;
};
