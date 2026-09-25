import {
  BOOTSTRAP_CODE_TTL_SEC,
  MAX_ACTIVE_DEVICES_PER_USER,
  computeDeviceExpiry,
  decideConnect,
  generateBootstrapCode,
  generateDeviceId,
  generateDeviceSecret,
  getDeviceIdleMs,
  getTrayDeviceAuthMode,
  getTrayTokenTtl,
  hashSecret,
  isDeviceExpired,
  isPlausibleCode,
  isPlausibleSecret,
  isTrayDeviceAuthEnabled,
  isTrayDeviceAuthEnabledForUser,
  isTrayDeviceAuthKilled,
  normalizeTrayDeviceAuthOverride,
  isValidDeviceId,
  sanitizeDeviceMeta,
  secretsMatch,
} from '../../src/utils/trayDevice.util';

describe('generators', () => {
  it('produces well-formed unique identifiers and secrets', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDeviceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isValidDeviceId(id)).toBe(true);
    const secret = generateDeviceSecret();
    expect(isPlausibleSecret(secret)).toBe(true);
    expect(secret.length).toBeGreaterThanOrEqual(43);
    const code = generateBootstrapCode();
    expect(isPlausibleCode(code)).toBe(true);
    expect(generateBootstrapCode()).not.toBe(code);
  });

  it('exposes the documented constants', () => {
    expect(MAX_ACTIVE_DEVICES_PER_USER).toBe(5);
    expect(BOOTSTRAP_CODE_TTL_SEC).toBe(90);
  });
});

describe('hashing', () => {
  it('hashes deterministically and never returns the secret', () => {
    const secret = generateDeviceSecret();
    const hash = hashSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
    expect(hashSecret(secret)).toBe(hash);
  });

  it('matches only the right secret', () => {
    const secret = generateDeviceSecret();
    const hash = hashSecret(secret);
    expect(secretsMatch(secret, hash)).toBe(true);
    expect(secretsMatch(secret + 'x', hash)).toBe(false);
    expect(secretsMatch('', hash)).toBe(false);
    expect(secretsMatch(secret, '')).toBe(false);
    expect(secretsMatch(secret, 'not-hex')).toBe(false);
    expect(secretsMatch(secret, hash.slice(0, 32))).toBe(false);
    expect(secretsMatch(secret, undefined as unknown as string)).toBe(false);
  });
});

describe('input validation', () => {
  it('validates device ids, secrets and codes', () => {
    expect(isValidDeviceId('td_' + 'a'.repeat(24))).toBe(true);
    expect(isValidDeviceId('td_' + 'A'.repeat(24))).toBe(false);
    expect(isValidDeviceId('td_short')).toBe(false);
    expect(isValidDeviceId(123)).toBe(false);
    expect(isValidDeviceId(undefined)).toBe(false);
    expect(isPlausibleSecret('a'.repeat(31))).toBe(false);
    expect(isPlausibleSecret('a'.repeat(129))).toBe(false);
    expect(isPlausibleSecret('a'.repeat(40) + '!')).toBe(false);
    expect(isPlausibleCode('a'.repeat(23))).toBe(false);
    expect(isPlausibleCode('a'.repeat(30))).toBe(true);
    expect(isPlausibleCode(null)).toBe(false);
  });

  it('cleans and caps device metadata', () => {
    expect(sanitizeDeviceMeta({ label: '  DESKTOP-ABC \n', platform: ' WIN32 ', appVersion: '1.5.5' }))
      .toEqual({ label: 'DESKTOP-ABC', platform: 'win32', appVersion: '1.5.5' });
    const long = sanitizeDeviceMeta({ label: 'x'.repeat(200), platform: 'y'.repeat(100), appVersion: 'z'.repeat(100) });
    expect(long.label.length).toBe(80);
    expect(long.platform.length).toBe(32);
    expect(long.appVersion.length).toBe(32);
    expect(sanitizeDeviceMeta(null)).toEqual({ label: '', platform: '', appVersion: '' });
    expect(sanitizeDeviceMeta({ label: 5, platform: {}, appVersion: [] })).toEqual({ label: '', platform: '', appVersion: '' });
    expect(sanitizeDeviceMeta({ label: 'a\u0000b\u001fc' }).label).toBe('abc');
  });
});

describe('expiry and tuning', () => {
  it('slides the idle expiry and detects expired devices', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    const idle = getDeviceIdleMs({});
    expect(idle).toBe(30 * 24 * 60 * 60 * 1000);
    expect(computeDeviceExpiry(now, idle).getTime()).toBe(now + idle);
    expect(isDeviceExpired(new Date(now + 1000), now)).toBe(false);
    expect(isDeviceExpired(new Date(now), now)).toBe(true);
    expect(isDeviceExpired(new Date(now - 1000), now)).toBe(true);
    expect(isDeviceExpired(null, now)).toBe(true);
    expect(isDeviceExpired('garbage', now)).toBe(true);
  });

  it('honors idle day overrides and ignores invalid ones', () => {
    expect(getDeviceIdleMs({ TRAY_DEVICE_IDLE_DAYS: '7' })).toBe(7 * 24 * 60 * 60 * 1000);
    expect(getDeviceIdleMs({ TRAY_DEVICE_IDLE_DAYS: '0' })).toBe(30 * 24 * 60 * 60 * 1000);
    expect(getDeviceIdleMs({ TRAY_DEVICE_IDLE_DAYS: 'abc' })).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('keeps the token ttl at 12 hours unless a valid override is set', () => {
    expect(getTrayTokenTtl({})).toBe('12h');
    expect(getTrayTokenTtl({ TRAY_TOKEN_TTL: '4h' })).toBe('4h');
    expect(getTrayTokenTtl({ TRAY_TOKEN_TTL: '90m' })).toBe('90m');
    expect(getTrayTokenTtl({ TRAY_TOKEN_TTL: 'forever' })).toBe('12h');
    expect(getTrayTokenTtl({ TRAY_TOKEN_TTL: '' })).toBe('12h');
  });
});

describe('feature flag', () => {
  it('is off by default and for unlisted users', () => {
    expect(isTrayDeviceAuthEnabled('u1', {})).toBe(false);
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: 'off' })).toBe(false);
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: 'u2,u3' })).toBe(false);
    expect(isTrayDeviceAuthEnabled(null, { TRAY_DEVICE_AUTH: 'u2' })).toBe(false);
  });

  it('is on for all or for listed pilot users', () => {
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: 'all' })).toBe(true);
    expect(isTrayDeviceAuthEnabled('U1', { TRAY_DEVICE_AUTH: ' u2 , u1 ' })).toBe(true);
    expect(isTrayDeviceAuthEnabled({ toString: () => 'u1' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(true);
  });

  it('matches whole user ids only, never a prefix, suffix or substring of one', () => {
    const env = { TRAY_DEVICE_AUTH: '64a1b2c3d4e5f60718293a4b' };
    expect(isTrayDeviceAuthEnabled('64a1b2c3d4e5f60718293a4b', env)).toBe(true);
    expect(isTrayDeviceAuthEnabled('64a1b2c3d4e5f60718293a4', env)).toBe(false);
    expect(isTrayDeviceAuthEnabled('64a1b2c3d4e5f60718293a4b0', env)).toBe(false);
    expect(isTrayDeviceAuthEnabled('4a1b2c3d4e5f60718293a4b', env)).toBe(false);
    expect(isTrayDeviceAuthEnabled('', env)).toBe(false);
  });

  it('only the exact word "all" enables everyone; every other spelling fails closed', () => {
    for (const value of ['true', '1', 'yes', 'on', '*', 'enabled', 'ALL,', 'all,64a1', '64a1,all', 'a11', 'al l']) {
      expect(isTrayDeviceAuthEnabled('someone-else', { TRAY_DEVICE_AUTH: value })).toBe(false);
    }
    expect(isTrayDeviceAuthEnabled('someone-else', { TRAY_DEVICE_AUTH: 'ALL' })).toBe(true);
  });

  it('a list that contains the word "all" never turns it on for anyone but a user literally called all', () => {
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: 'all,u2' })).toBe(false);
    expect(isTrayDeviceAuthEnabled('u2', { TRAY_DEVICE_AUTH: 'all,u2' })).toBe(true);
  });

  it('tolerates quotes copied into an env file, but still allowlists only the named user', () => {
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: '"u1"' })).toBe(true);
    expect(isTrayDeviceAuthEnabled('u2', { TRAY_DEVICE_AUTH: '"u1"' })).toBe(false);
    expect(isTrayDeviceAuthEnabled('u2', { TRAY_DEVICE_AUTH: "'u1', 'u2'" })).toBe(true);
    expect(isTrayDeviceAuthEnabled('u3', { TRAY_DEVICE_AUTH: "'u1', 'u2'" })).toBe(false);
  });

  it('empty entries never match an empty or missing id', () => {
    expect(isTrayDeviceAuthEnabled('', { TRAY_DEVICE_AUTH: ',,' })).toBe(false);
    expect(isTrayDeviceAuthEnabled(undefined, { TRAY_DEVICE_AUTH: 'u1' })).toBe(false);
  });

  it('describes the active mode', () => {
    expect(getTrayDeviceAuthMode({})).toEqual({ mode: 'off', allowlistSize: 0 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: 'off' })).toEqual({ mode: 'off', allowlistSize: 0 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: ',' })).toEqual({ mode: 'off', allowlistSize: 0 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: 'all' })).toEqual({ mode: 'all', allowlistSize: 0 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: 'u1' })).toEqual({ mode: 'allowlist', allowlistSize: 1 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: 'u1, u2 ,u3' })).toEqual({ mode: 'allowlist', allowlistSize: 3 });
    expect(getTrayDeviceAuthMode({ TRAY_DEVICE_AUTH: 'all', TRAY_DEVICE_AUTH_DISABLED: 'true' })).toEqual({ mode: 'killed', allowlistSize: 0 });
  });

  it('is turned off by the kill switch even for all', () => {
    expect(isTrayDeviceAuthKilled({ TRAY_DEVICE_AUTH_DISABLED: 'true' })).toBe(true);
    expect(isTrayDeviceAuthKilled({ TRAY_DEVICE_AUTH_DISABLED: 'false' })).toBe(false);
    expect(isTrayDeviceAuthEnabled('u1', { TRAY_DEVICE_AUTH: 'all', TRAY_DEVICE_AUTH_DISABLED: 'TRUE' })).toBe(false);
  });
});

describe('per-user override', () => {
  it('normalizes anything unexpected to default', () => {
    expect(normalizeTrayDeviceAuthOverride('on')).toBe('on');
    expect(normalizeTrayDeviceAuthOverride('off')).toBe('off');
    for (const value of ['default', 'ON', 'true', '', null, undefined, 1, {}]) {
      expect(normalizeTrayDeviceAuthOverride(value)).toBe('default');
    }
  });

  it('default follows the environment exactly as before', () => {
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1' }, {})).toBe(false);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'default' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(true);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u2', trayDeviceAuthOverride: 'default' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(false);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u2' }, { TRAY_DEVICE_AUTH: 'all' })).toBe(true);
  });

  it('on enables that one user with no environment setting at all', () => {
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'on' }, {})).toBe(true);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'on' }, { TRAY_DEVICE_AUTH: 'off' })).toBe(true);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u2' }, {})).toBe(false);
  });

  it('off wins over an allowlist entry and over all', () => {
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'off' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(false);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'off' }, { TRAY_DEVICE_AUTH: 'all' })).toBe(false);
  });

  it('the kill switch beats everything, including on', () => {
    const env = { TRAY_DEVICE_AUTH: 'all', TRAY_DEVICE_AUTH_DISABLED: 'true' };
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1', trayDeviceAuthOverride: 'on' }, env)).toBe(false);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1' }, env)).toBe(false);
  });

  it('a missing user is never enabled', () => {
    expect(isTrayDeviceAuthEnabledForUser(null, { TRAY_DEVICE_AUTH: 'all' })).toBe(false);
    expect(isTrayDeviceAuthEnabledForUser(undefined, {})).toBe(false);
  });

  it('a user object with no override field (for example a synthetic account) behaves as default', () => {
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u1' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(true);
    expect(isTrayDeviceAuthEnabledForUser({ _id: 'u3' }, { TRAY_DEVICE_AUTH: 'u1' })).toBe(false);
  });
});

describe('decideConnect', () => {
  const base = {
    deviceState: 'valid' as const,
    codeState: 'none' as const,
    codeUserMatchesDevice: false,
    confirmSwitch: false,
    deviceUserHasOpenShift: false,
  };

  it('opens a session for a valid device with no code, or with an invalid code', () => {
    expect(decideConnect(base)).toEqual({ action: 'SESSION' });
    expect(decideConnect({ ...base, codeState: 'invalid' })).toEqual({ action: 'SESSION' });
  });

  it('opens a session and consumes the code when the code belongs to the same user', () => {
    expect(decideConnect({ ...base, codeState: 'valid', codeUserMatchesDevice: true })).toEqual({ action: 'SESSION_CONSUME_CODE' });
  });

  it('asks for confirmation when a different user code arrives, and switches only when confirmed', () => {
    const differentUser = { ...base, codeState: 'valid' as const };
    expect(decideConnect(differentUser)).toEqual({ action: 'MISMATCH' });
    expect(decideConnect({ ...differentUser, confirmSwitch: true })).toEqual({ action: 'REBIND' });
  });

  it('never switches while the registered user has an open shift', () => {
    const differentUser = { ...base, codeState: 'valid' as const, deviceUserHasOpenShift: true };
    expect(decideConnect(differentUser)).toEqual({ action: 'SHIFT_IN_PROGRESS' });
    expect(decideConnect({ ...differentUser, confirmSwitch: true })).toEqual({ action: 'SHIFT_IN_PROGRESS' });
  });

  it('does not let an open shift block the same user', () => {
    expect(decideConnect({ ...base, codeState: 'valid', codeUserMatchesDevice: true, deviceUserHasOpenShift: true }))
      .toEqual({ action: 'SESSION_CONSUME_CODE' });
    expect(decideConnect({ ...base, deviceUserHasOpenShift: true })).toEqual({ action: 'SESSION' });
  });

  it.each(['none', 'unknown', 'revoked', 'expired'] as const)('registers with a valid code when the device is %s', (deviceState) => {
    expect(decideConnect({ ...base, deviceState, codeState: 'valid' })).toEqual({ action: 'REGISTER' });
  });

  it('reports the precise machine code when there is no valid device and no valid code', () => {
    expect(decideConnect({ ...base, deviceState: 'revoked' })).toEqual({ action: 'ERROR', code: 'DEVICE_REVOKED' });
    expect(decideConnect({ ...base, deviceState: 'expired' })).toEqual({ action: 'ERROR', code: 'DEVICE_EXPIRED' });
    expect(decideConnect({ ...base, deviceState: 'unknown' })).toEqual({ action: 'ERROR', code: 'DEVICE_UNKNOWN' });
    expect(decideConnect({ ...base, deviceState: 'none' })).toEqual({ action: 'ERROR', code: 'NEEDS_SETUP' });
    expect(decideConnect({ ...base, deviceState: 'none', codeState: 'invalid' })).toEqual({ action: 'ERROR', code: 'NEEDS_SETUP' });
    expect(decideConnect({ ...base, deviceState: 'revoked', codeState: 'invalid' })).toEqual({ action: 'ERROR', code: 'DEVICE_REVOKED' });
  });
});
