import { buildCoverageReport, isDeviceAuthCapableVersion } from '../../src/utils/trayAccountCoverage.util';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe('isDeviceAuthCapableVersion', () => {
  it('treats 1.5.5 and later, including its prerelease, as capable', () => {
    expect(isDeviceAuthCapableVersion('1.5.5')).toBe(true);
    expect(isDeviceAuthCapableVersion('1.5.5-beta.1')).toBe(true);
    expect(isDeviceAuthCapableVersion('1.6.0')).toBe(true);
    expect(isDeviceAuthCapableVersion('2.0.0')).toBe(true);
  });

  it('treats anything earlier as older and anything unreadable as unknown', () => {
    expect(isDeviceAuthCapableVersion('1.5.4')).toBe(false);
    expect(isDeviceAuthCapableVersion('1.4.19')).toBe(false);
    expect(isDeviceAuthCapableVersion('0.9.9')).toBe(false);
    expect(isDeviceAuthCapableVersion(null)).toBeNull();
    expect(isDeviceAuthCapableVersion('')).toBeNull();
    expect(isDeviceAuthCapableVersion('beta')).toBeNull();
  });
});

describe('buildCoverageReport', () => {
  const inputs = {
    now: NOW,
    windowDays: [7, 30],
    heartbeats: [
      { userId: 'c1', lastSeenAt: daysAgo(1), appVersion: '1.5.5', platform: 'win32' },
      { userId: 'c2', lastSeenAt: daysAgo(2), appVersion: '1.5.4', platform: 'darwin' },
      { userId: 'c3', lastSeenAt: daysAgo(3), appVersion: null, platform: 'win32' },
      { userId: 'c4', lastSeenAt: daysAgo(4), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'c5', lastSeenAt: daysAgo(4), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'c6', lastSeenAt: daysAgo(5), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'm1', lastSeenAt: daysAgo(2), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'm2', lastSeenAt: daysAgo(6), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'x1', lastSeenAt: daysAgo(3), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'c7', lastSeenAt: daysAgo(20), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'm3', lastSeenAt: daysAgo(25), appVersion: '1.5.4', platform: 'win32' },
      { userId: 'c1', lastSeenAt: daysAgo(1), appVersion: '1.5.5', platform: 'win32' },
    ],
    crmRows: [
      { id: 'c1', isActive: true, isOffboarded: false, organizationId: 'org' },
      { id: 'c2', isActive: true, isOffboarded: false, organizationId: 'org' },
      { id: 'c3', isActive: true, organizationId: 'org' },
      { id: 'c4', isActive: false, isOffboarded: false, organizationId: 'org' },
      { id: 'c5', isActive: true, isOffboarded: true, organizationId: 'org' },
      { id: 'c6', isActive: true, isOffboarded: false, organizationId: null },
      { id: 'c7', isActive: true, isOffboarded: false, organizationId: 'org' },
    ],
    mainRows: [
      { id: 'm1', email: 'Linked@Example.com ' },
      { id: 'm2', email: 'solo@example.com' },
      { id: 'm3', email: null },
    ],
    crmEmails: new Set(['linked@example.com']),
  };

  const report = buildCoverageReport(inputs);

  it('counts each tray identity once even when it heartbeats several times', () => {
    expect(report['7'].trayIdentities).toBe(9);
    expect(report['7'].crmAccounts.total + report['7'].withoutCrmUser.total).toBe(9);
  });

  it('separates supported CRM accounts from the ones the connect endpoint would refuse', () => {
    const crm = report['7'].crmAccounts;
    expect(crm.total).toBe(6);
    expect(crm.eligible).toBe(3);
    expect(crm.blocked).toEqual({ inactive: 1, offboarded: 1, noOrganization: 1 });
  });

  it('reports the tray users who have no CrmUser row at all, split by what they are', () => {
    const none = report['7'].withoutCrmUser;
    expect(none.total).toBe(3);
    expect(none.mainAccountsOnly).toBe(2);
    expect(none.unresolved).toBe(1);
    expect(none.mainWithCrmByEmail).toBe(1);
    expect(report['7'].sampleIdsWithoutCrmUser.sort()).toEqual(['m1', 'm2', 'x1']);
  });

  it('respects the window: older heartbeats only appear in the wider window', () => {
    expect(report['30'].trayIdentities).toBe(11);
    expect(report['30'].crmAccounts.total).toBe(7);
    expect(report['30'].withoutCrmUser.total).toBe(4);
    expect(report['30'].withoutCrmUser.mainAccountsOnly).toBe(3);
  });

  it('shows how many trays are on a build that can use device authentication, without any personal data', () => {
    expect(report['7'].appVersions).toEqual({ deviceAuthCapable: 1, older: 7, unknown: 1 });
    expect(report['7'].platforms).toEqual({ win32: 8, darwin: 1 });
    expect(JSON.stringify(report)).not.toContain('example.com');
  });

  it('caps the identifier sample', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ userId: `m${i}`, lastSeenAt: daysAgo(1), appVersion: '1.5.5', platform: 'win32' }));
    const capped = buildCoverageReport({ ...inputs, heartbeats: many, crmRows: [], mainRows: [], windowDays: [7] });
    expect(capped['7'].withoutCrmUser.total).toBe(60);
    expect(capped['7'].sampleIdsWithoutCrmUser).toHaveLength(25);
  });

  it('handles an empty population', () => {
    const empty = buildCoverageReport({ ...inputs, heartbeats: [], windowDays: [7] });
    expect(empty['7'].trayIdentities).toBe(0);
    expect(empty['7'].sampleIdsWithoutCrmUser).toEqual([]);
  });
});
