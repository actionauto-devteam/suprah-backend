import { getTraccarConfig, ipAllowed, normalizeIp } from '../../src/config/traccar';
import { isTrustedTraccarForward, TRACCAR_FORWARD_PATH } from '../../src/services/traccarForwardGuard';
import { globalRequestLimit } from '../../src/middleware/rate-limit.middleware';

// Made-up test values, set only inside this test process.
const SECRET = 'simulated-forward-secret-for-tests-0123456789';
const ENV: Record<string, string> = {
  TRACCAR_INTEGRATION_ENABLED: 'true',
  TRACCAR_BASE_URL: 'https://traccar.simulated.test',
  TRACCAR_API_TOKEN: 'simulated-api-token',
  TRACCAR_FORWARD_SECRET: SECRET,
  TRACCAR_FORWARD_ALLOWED_IPS: '203.0.113.7, 172.18.0.0/16',
  TRACCAR_DEVICE_SERVER_URL: 'https://gps.simulated.test',
};

const forward = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  originalUrl: TRACCAR_FORWARD_PATH,
  ip: '203.0.113.7',
  headers: { authorization: `Bearer ${SECRET}` },
  ...overrides,
});

describe('Traccar forward guard', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...Object.keys(ENV), 'TRACCAR_FORWARD_MAX_PER_MINUTE']) saved[key] = process.env[key];
    Object.assign(process.env, ENV);
    delete process.env.TRACCAR_FORWARD_MAX_PER_MINUTE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('matches single addresses and ranges, for IPv4 and IPv6', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('::ffff:172.18.4.2', ['172.18.0.0/16'])).toBe(true);
    expect(ipAllowed('172.19.0.1', ['172.18.0.0/16'])).toBe(false);
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('203.0.113.7', [])).toBe(false);
    expect(ipAllowed('not-an-address', ['203.0.113.7'])).toBe(false);
  });

  it('requires the address list once switched on and refuses entries that are not addresses', () => {
    expect(getTraccarConfig(ENV).usable).toBe(true);
    expect(getTraccarConfig({ ...ENV, TRACCAR_FORWARD_ALLOWED_IPS: '' }).problems.join(' ')).toMatch(/TRACCAR_FORWARD_ALLOWED_IPS \(missing/);
    const named = getTraccarConfig({ ...ENV, TRACCAR_FORWARD_ALLOWED_IPS: '203.0.113.7, traccar.example.com' });
    expect(named.usable).toBe(false);
    expect(named.problems.join(' ')).toMatch(/isn't an IP address or CIDR range/);
    // The problem names the setting, never its value.
    expect(named.problems.join(' ')).not.toContain('traccar.example.com');
    expect(getTraccarConfig({ ...ENV, TRACCAR_FORWARD_ALLOWED_IPS: '10.0.0.0/33' }).usable).toBe(false);
  });

  it('sizes the fleet budget from its setting, within limits', () => {
    expect(getTraccarConfig(ENV).forwardMaxPerMinute).toBe(1200);
    expect(getTraccarConfig({ ...ENV, TRACCAR_FORWARD_MAX_PER_MINUTE: '3000' }).forwardMaxPerMinute).toBe(3000);
    expect(getTraccarConfig({ ...ENV, TRACCAR_FORWARD_MAX_PER_MINUTE: '5' }).forwardMaxPerMinute).toBe(1200);
    expect(getTraccarConfig({ ...ENV, TRACCAR_FORWARD_MAX_PER_MINUTE: '999999' }).forwardMaxPerMinute).toBe(20000);
  });

  it('trusts only forwards from an allowed address with the right secret', () => {
    expect(isTrustedTraccarForward(forward())).toBe(true);
    expect(isTrustedTraccarForward(forward({ ip: '::ffff:172.18.0.9' }))).toBe(true);
    expect(isTrustedTraccarForward(forward({ ip: '198.51.100.1' }))).toBe(false);
    expect(isTrustedTraccarForward(forward({ headers: { authorization: 'Bearer wrong' } }))).toBe(false);
    expect(isTrustedTraccarForward(forward({ headers: {} }))).toBe(false);
    expect(isTrustedTraccarForward(forward({ originalUrl: '/api/loads' }))).toBe(false);
    expect(isTrustedTraccarForward(forward({ method: 'GET' }))).toBe(false);
    process.env.TRACCAR_INTEGRATION_ENABLED = 'false';
    expect(isTrustedTraccarForward(forward())).toBe(false);
  });

  it('keeps the global limit at 1000 for everyone else, including made-up tokens', () => {
    expect(globalRequestLimit(forward())).toBe(1200 * 15);
    process.env.TRACCAR_FORWARD_MAX_PER_MINUTE = '2000';
    expect(globalRequestLimit(forward())).toBe(2000 * 15);
    expect(globalRequestLimit(forward({ ip: '198.51.100.1' }))).toBe(1000);
    expect(globalRequestLimit(forward({ headers: { authorization: 'Bearer a-different-made-up-token' } }))).toBe(1000);
    expect(globalRequestLimit({ method: 'POST', originalUrl: '/api/loads', ip: '203.0.113.7', headers: {} })).toBe(1000);
    expect(globalRequestLimit({ method: 'GET', originalUrl: '/api/driver-tracking/active-drivers', ip: '203.0.113.7', headers: {} })).toBe(1000);
  });
});
