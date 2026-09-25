import {
  DESKTOP_PING_RETRY_LONG_SEC,
  DESKTOP_PING_RETRY_SHORT_SEC,
  evaluateDesktopLocationEligibility,
  evaluateDesktopPing,
  sanitizeDesktopPingBody,
} from '../../src/utils/desktopPing.util';

const baseEligibility = {
  flagOn: true,
  platformAllowed: true as boolean | null,
  hasConsent: true,
  optedOut: false,
  locationRequired: true,
  mode: 'switching' as const,
};

describe('sanitizeDesktopPingBody', () => {
  it('accepts a complete valid body', () => {
    expect(sanitizeDesktopPingBody({ lat: 14.4, lng: 120.9, accuracyM: 183.4, inputAgeSec: 12.6, platform: ' WIN32 ' }))
      .toEqual({ lat: 14.4, lng: 120.9, accuracyM: 183.4, inputAgeSec: 13, platform: 'win32' });
  });

  it('accepts a body with only coordinates', () => {
    expect(sanitizeDesktopPingBody({ lat: 0, lng: 0 })).toEqual({ lat: 0, lng: 0, accuracyM: null, inputAgeSec: null, platform: null });
  });

  it('rejects missing, non-numeric, non-finite and out-of-range coordinates', () => {
    expect(sanitizeDesktopPingBody(null)).toBeNull();
    expect(sanitizeDesktopPingBody(undefined)).toBeNull();
    expect(sanitizeDesktopPingBody('text')).toBeNull();
    expect(sanitizeDesktopPingBody({})).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: '14.4', lng: 120.9 })).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: 14.4 })).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: Number.NaN, lng: 1 })).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: 1, lng: Number.POSITIVE_INFINITY })).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: 91, lng: 0 })).toBeNull();
    expect(sanitizeDesktopPingBody({ lat: 0, lng: -181 })).toBeNull();
  });

  it('keeps the coordinates but drops invalid optional fields', () => {
    expect(sanitizeDesktopPingBody({ lat: 1, lng: 2, accuracyM: -5, inputAgeSec: -1, platform: 42 }))
      .toEqual({ lat: 1, lng: 2, accuracyM: null, inputAgeSec: null, platform: null });
    expect(sanitizeDesktopPingBody({ lat: 1, lng: 2, accuracyM: 'x', inputAgeSec: Number.NaN, platform: '   ' }))
      .toEqual({ lat: 1, lng: 2, accuracyM: null, inputAgeSec: null, platform: null });
    expect(sanitizeDesktopPingBody({ lat: 1, lng: 2, accuracyM: 2_000_000, inputAgeSec: 10_000_000, platform: 'x'.repeat(40) }))
      .toEqual({ lat: 1, lng: 2, accuracyM: null, inputAgeSec: null, platform: null });
  });
});

describe('evaluateDesktopLocationEligibility', () => {
  it('is eligible when every condition holds', () => {
    expect(evaluateDesktopLocationEligibility(baseEligibility)).toEqual({ eligible: true });
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, mode: 'off' })).toEqual({ eligible: true });
  });

  it('is off by default for anyone outside the pilot', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, flagOn: false }))
      .toEqual({ eligible: false, reason: 'flag_off', retryAfterSec: DESKTOP_PING_RETRY_LONG_SEC });
  });

  it('rejects a disallowed platform but treats an unknown platform as not applicable to the check', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, platformAllowed: false }))
      .toMatchObject({ eligible: false, reason: 'platform_not_allowed' });
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, platformAllowed: null })).toEqual({ eligible: true });
  });

  it('rejects without an organization', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, hasOrganization: false }))
      .toMatchObject({ eligible: false, reason: 'no_org' });
  });

  it('rejects without consent and when the user opted out', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, hasConsent: false }))
      .toMatchObject({ eligible: false, reason: 'no_consent' });
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, optedOut: true }))
      .toMatchObject({ eligible: false, reason: 'opted_out' });
  });

  it('rejects when location is not required for the account', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, locationRequired: false }))
      .toMatchObject({ eligible: false, reason: 'not_required' });
  });

  it('never applies to phone-only always mode', () => {
    expect(evaluateDesktopLocationEligibility({ ...baseEligibility, mode: 'always' }))
      .toMatchObject({ eligible: false, reason: 'not_applicable' });
  });

  it('reports the first failing condition in a stable order', () => {
    expect(evaluateDesktopLocationEligibility({
      flagOn: false, platformAllowed: false, hasConsent: false, optedOut: true, locationRequired: false, mode: 'always',
    })).toMatchObject({ reason: 'flag_off' });
    expect(evaluateDesktopLocationEligibility({
      ...baseEligibility, hasConsent: false, optedOut: true, locationRequired: false, mode: 'always',
    })).toMatchObject({ reason: 'no_consent' });
  });
});

describe('evaluateDesktopPing', () => {
  const base = { ...baseEligibility, isOnShift: true, isOnBreak: false };

  it('accepts only while on shift and not on break', () => {
    expect(evaluateDesktopPing(base)).toEqual({ eligible: true });
    expect(evaluateDesktopPing({ ...base, isOnShift: false }))
      .toEqual({ eligible: false, reason: 'not_on_shift', retryAfterSec: DESKTOP_PING_RETRY_SHORT_SEC });
    expect(evaluateDesktopPing({ ...base, isOnBreak: true }))
      .toEqual({ eligible: false, reason: 'on_break', retryAfterSec: DESKTOP_PING_RETRY_SHORT_SEC });
  });

  it('reports eligibility failures before shift failures', () => {
    expect(evaluateDesktopPing({ ...base, flagOn: false, isOnShift: false })).toMatchObject({ reason: 'flag_off' });
    expect(evaluateDesktopPing({ ...base, hasConsent: false, isOnBreak: true })).toMatchObject({ reason: 'no_consent' });
  });
});
