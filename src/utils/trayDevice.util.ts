import crypto from 'crypto';

type Env = Record<string, string | undefined>;

export const MAX_ACTIVE_DEVICES_PER_USER = 5;
export const BOOTSTRAP_CODE_TTL_SEC = 90;

const DEFAULT_IDLE_DAYS = 30;
const DEFAULT_TOKEN_TTL = '12h';
const TOKEN_TTL_PATTERN = /^\d{1,4}(s|m|h|d)$/;
const DEVICE_ID_PATTERN = /^td_[0-9a-f]{24}$/;
const MAX_LABEL_LENGTH = 80;
const MAX_PLATFORM_LENGTH = 32;
const MAX_VERSION_LENGTH = 32;

export type DeviceState = 'none' | 'valid' | 'unknown' | 'revoked' | 'expired';
export type CodeState = 'none' | 'valid' | 'invalid';
export type DeviceErrorCode = 'DEVICE_REVOKED' | 'DEVICE_EXPIRED' | 'DEVICE_UNKNOWN' | 'NEEDS_SETUP';

export type ConnectDecision =
  | { action: 'SESSION' }
  | { action: 'SESSION_CONSUME_CODE' }
  | { action: 'MISMATCH' }
  | { action: 'SHIFT_IN_PROGRESS' }
  | { action: 'REBIND' }
  | { action: 'REGISTER' }
  | { action: 'ERROR'; code: DeviceErrorCode };

export const generateDeviceId = (): string => `td_${crypto.randomBytes(12).toString('hex')}`;
export const generateDeviceSecret = (): string => crypto.randomBytes(32).toString('base64url');
export const generateBootstrapCode = (): string => crypto.randomBytes(24).toString('base64url');

export const hashSecret = (secret: string): string =>
  crypto.createHash('sha256').update(secret, 'utf8').digest('hex');

export const secretsMatch = (secret: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(typeof expectedHash === 'string' ? expectedHash : '', 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

export const isValidDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && DEVICE_ID_PATTERN.test(value);

export const isPlausibleSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);

export const isPlausibleCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 24 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);

const cleanText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';

export const sanitizeDeviceMeta = (input: unknown): { label: string; platform: string; appVersion: string } => {
  const raw = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    label: cleanText(raw.label, MAX_LABEL_LENGTH),
    platform: cleanText(raw.platform, MAX_PLATFORM_LENGTH).toLowerCase(),
    appVersion: cleanText(raw.appVersion, MAX_VERSION_LENGTH),
  };
};

export const getDeviceIdleMs = (env: Env = process.env): number => {
  const days = Number(env.TRAY_DEVICE_IDLE_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_IDLE_DAYS) * 24 * 60 * 60 * 1000;
};

export const computeDeviceExpiry = (nowMs: number, idleMs: number): Date => new Date(nowMs + idleMs);

export const isDeviceExpired = (expiresAt: Date | string | number | null | undefined, nowMs: number): boolean => {
  if (expiresAt === null || expiresAt === undefined) return true;
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
};

export const getTrayTokenTtl = (env: Env = process.env): string => {
  const raw = (env.TRAY_TOKEN_TTL ?? '').trim();
  return TOKEN_TTL_PATTERN.test(raw) ? raw : DEFAULT_TOKEN_TTL;
};

export const isTrayDeviceAuthKilled = (env: Env = process.env): boolean =>
  (env.TRAY_DEVICE_AUTH_DISABLED ?? '').trim().toLowerCase() === 'true';

const stripQuotes = (value: string): string => value.trim().replace(/^["']+|["']+$/g, '').trim();

const readDeviceAuthSetting = (env: Env): string => stripQuotes(env.TRAY_DEVICE_AUTH ?? '').toLowerCase();

const parseAllowlist = (raw: string): string[] => raw.split(',').map(stripQuotes).filter(Boolean);

export const isTrayDeviceAuthEnabled = (
  userId: string | { toString(): string } | null | undefined,
  env: Env = process.env,
): boolean => {
  if (isTrayDeviceAuthKilled(env)) return false;
  const raw = readDeviceAuthSetting(env);
  if (raw === '' || raw === 'off') return false;
  if (raw === 'all') return true;
  if (userId === null || userId === undefined) return false;
  const id = String(userId).trim().toLowerCase();
  return parseAllowlist(raw).includes(id);
};

export type TrayDeviceAuthMode = { mode: 'killed' | 'off' | 'all' | 'allowlist'; allowlistSize: number };

export const getTrayDeviceAuthMode = (env: Env = process.env): TrayDeviceAuthMode => {
  if (isTrayDeviceAuthKilled(env)) return { mode: 'killed', allowlistSize: 0 };
  const raw = readDeviceAuthSetting(env);
  if (raw === '' || raw === 'off') return { mode: 'off', allowlistSize: 0 };
  if (raw === 'all') return { mode: 'all', allowlistSize: 0 };
  const size = parseAllowlist(raw).length;
  return size > 0 ? { mode: 'allowlist', allowlistSize: size } : { mode: 'off', allowlistSize: 0 };
};

export const decideConnect = (params: {
  deviceState: DeviceState;
  codeState: CodeState;
  codeUserMatchesDevice: boolean;
  confirmSwitch: boolean;
  deviceUserHasOpenShift: boolean;
}): ConnectDecision => {
  if (params.deviceState === 'valid') {
    if (params.codeState !== 'valid') return { action: 'SESSION' };
    if (params.codeUserMatchesDevice) return { action: 'SESSION_CONSUME_CODE' };
    if (params.deviceUserHasOpenShift) return { action: 'SHIFT_IN_PROGRESS' };
    return params.confirmSwitch ? { action: 'REBIND' } : { action: 'MISMATCH' };
  }
  if (params.codeState === 'valid') return { action: 'REGISTER' };
  if (params.deviceState === 'revoked') return { action: 'ERROR', code: 'DEVICE_REVOKED' };
  if (params.deviceState === 'expired') return { action: 'ERROR', code: 'DEVICE_EXPIRED' };
  if (params.deviceState === 'unknown') return { action: 'ERROR', code: 'DEVICE_UNKNOWN' };
  return { action: 'ERROR', code: 'NEEDS_SETUP' };
};
