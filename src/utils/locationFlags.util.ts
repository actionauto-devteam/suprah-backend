export type LocationFlagName =
  | 'LOC_DESKTOP_CHANNEL'
  | 'LOC_DESKTOP_EXCUSE'
  | 'LOC_DESKTOP_DISPLAY'
  | 'LOC_STICKY_MOBILE'
  | 'LOC_HANDOFF_SCREENSHOTS';

type Env = Record<string, string | undefined>;

const DEFAULT_PLATFORMS = ['win32', 'darwin'];

const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

export const isLocationFeatureOn = (
  flag: LocationFlagName,
  userId: string | { toString(): string } | null | undefined,
  env: Env = process.env,
): boolean => {
  const raw = (env[flag] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'all') return true;
  if (userId === null || userId === undefined) return false;
  return splitList(raw).includes(String(userId).trim().toLowerCase());
};

export const isDesktopPlatformAllowed = (
  platform: string | null | undefined,
  env: Env = process.env,
): boolean => {
  if (!platform) return false;
  const raw = (env.LOC_DESKTOP_PLATFORMS ?? '').trim();
  const allowed = raw === '' ? DEFAULT_PLATFORMS : splitList(raw);
  return allowed.includes(platform.trim().toLowerCase());
};

export type DesktopLocationOverride = 'default' | 'on' | 'off';

export const DESKTOP_LOCATION_OVERRIDES: readonly DesktopLocationOverride[] = ['default', 'on', 'off'];

export const normalizeDesktopLocationOverride = (value: unknown): DesktopLocationOverride =>
  value === 'on' || value === 'off' ? value : 'default';

const OVERRIDE_FLAGS: readonly LocationFlagName[] = ['LOC_DESKTOP_CHANNEL', 'LOC_DESKTOP_EXCUSE', 'LOC_DESKTOP_DISPLAY'];

export const isDesktopLocationKilled = (env: Env = process.env): boolean =>
  (env.LOC_DESKTOP_DISABLED ?? '').trim().toLowerCase() === 'true';

export const isLocationFeatureOnForUser = (
  flag: LocationFlagName,
  user: { _id?: string | { toString(): string } | null; desktopLocationOverride?: unknown } | null | undefined,
  env: Env = process.env,
): boolean => {
  if (!user) return false;
  if (OVERRIDE_FLAGS.includes(flag)) {
    if (isDesktopLocationKilled(env)) return false;
    const override = normalizeDesktopLocationOverride(user.desktopLocationOverride);
    if (override === 'off') return false;
    if (override === 'on') return true;
  }
  return isLocationFeatureOn(flag, user._id, env);
};
