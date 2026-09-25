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
