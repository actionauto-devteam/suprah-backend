import type { MonitoringMode } from '../config/departmentMonitoring';

export type DesktopPingRejection =
  | 'flag_off'
  | 'platform_not_allowed'
  | 'no_org'
  | 'no_consent'
  | 'opted_out'
  | 'not_required'
  | 'not_applicable'
  | 'not_on_shift'
  | 'on_break'
  | 'no_active_record';

export const DESKTOP_PING_RETRY_LONG_SEC = 300;
export const DESKTOP_PING_RETRY_RECORD_SEC = 120;
export const DESKTOP_PING_RETRY_SHORT_SEC = 60;

const MAX_ACCURACY_M = 1_000_000;
const MAX_INPUT_AGE_SEC = 7 * 24 * 3600;
const MAX_PLATFORM_LENGTH = 32;

export interface SanitizedDesktopPing {
  lat: number;
  lng: number;
  accuracyM: number | null;
  inputAgeSec: number | null;
  platform: string | null;
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const sanitizeDesktopPingBody = (body: unknown): SanitizedDesktopPing | null => {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const { lat, lng } = raw;
  if (!finiteNumber(lat) || !finiteNumber(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const accuracyM = finiteNumber(raw.accuracyM) && raw.accuracyM >= 0 && raw.accuracyM <= MAX_ACCURACY_M
    ? raw.accuracyM
    : null;
  const inputAgeSec = finiteNumber(raw.inputAgeSec) && raw.inputAgeSec >= 0 && raw.inputAgeSec <= MAX_INPUT_AGE_SEC
    ? Math.round(raw.inputAgeSec)
    : null;
  const platform = typeof raw.platform === 'string' && raw.platform.trim() !== '' && raw.platform.trim().length <= MAX_PLATFORM_LENGTH
    ? raw.platform.trim().toLowerCase()
    : null;

  return { lat, lng, accuracyM, inputAgeSec, platform };
};

export interface DesktopLocationEligibilityInput {
  flagOn: boolean;
  platformAllowed: boolean | null;
  hasOrganization?: boolean;
  hasConsent: boolean;
  optedOut: boolean;
  locationRequired: boolean;
  mode: MonitoringMode;
}

export type DesktopEligibility =
  | { eligible: true }
  | { eligible: false; reason: DesktopPingRejection; retryAfterSec: number };

const deny = (reason: DesktopPingRejection, retryAfterSec: number): DesktopEligibility => ({
  eligible: false,
  reason,
  retryAfterSec,
});

export const evaluateDesktopLocationEligibility = (input: DesktopLocationEligibilityInput): DesktopEligibility => {
  if (!input.flagOn) return deny('flag_off', DESKTOP_PING_RETRY_LONG_SEC);
  if (input.platformAllowed === false) return deny('platform_not_allowed', DESKTOP_PING_RETRY_LONG_SEC);
  if (input.hasOrganization === false) return deny('no_org', DESKTOP_PING_RETRY_LONG_SEC);
  if (!input.hasConsent) return deny('no_consent', DESKTOP_PING_RETRY_LONG_SEC);
  if (input.optedOut) return deny('opted_out', DESKTOP_PING_RETRY_LONG_SEC);
  if (!input.locationRequired) return deny('not_required', DESKTOP_PING_RETRY_LONG_SEC);
  if (input.mode === 'always') return deny('not_applicable', DESKTOP_PING_RETRY_LONG_SEC);
  return { eligible: true };
};

export interface DesktopPingDecisionInput extends DesktopLocationEligibilityInput {
  isOnShift: boolean;
  isOnBreak: boolean;
}

export const evaluateDesktopPing = (input: DesktopPingDecisionInput): DesktopEligibility => {
  const eligibility = evaluateDesktopLocationEligibility(input);
  if (!eligibility.eligible) return eligibility;
  if (!input.isOnShift) return deny('not_on_shift', DESKTOP_PING_RETRY_SHORT_SEC);
  if (input.isOnBreak) return deny('on_break', DESKTOP_PING_RETRY_SHORT_SEC);
  return { eligible: true };
};
