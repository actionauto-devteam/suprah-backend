import {
  AUTO_SWITCH_AWAY_GAP_MS,
  AUTO_SWITCH_AWAY_MS,
  AUTO_SWITCH_PING_FRESH_MS,
  classifyAgainstWorkSites,
  decideAutoSwitchStep,
  getAutoSwitchAwayMs,
  isAutoSwitchEnabledForUser,
  isAwayBlockActive,
  normalizeAutoSwitchOverride,
  workSiteExitThresholdM,
} from '../../src/utils/autoSwitch.util';

const LEHI = { name: 'Action Auto Lehi', coords: { lat: 40.3916, lng: -111.8507 }, radiusM: 100 };
const OREM = { name: 'Action Auto Orem', coords: { lat: 40.2969, lng: -111.6946 }, radiusM: 150, warningRadiusM: 250 };
const metersNorth = (site: { coords: { lat: number; lng: number } }, meters: number) => ({
  lat: site.coords.lat + meters / 111_320,
  lng: site.coords.lng,
});

describe('auto-switch enablement', () => {
  it('normalizes anything unexpected to default', () => {
    expect(normalizeAutoSwitchOverride('on')).toBe('on');
    expect(normalizeAutoSwitchOverride('off')).toBe('off');
    for (const value of ['ON', 'true', '', null, undefined, 1, {}]) {
      expect(normalizeAutoSwitchOverride(value)).toBe('default');
    }
  });

  it('needs the device switch to be on for the user as well', () => {
    expect(isAutoSwitchEnabledForUser({ _id: 'u1', autoSwitchOverride: 'on' }, {})).toBe(false);
    expect(isAutoSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'on', autoSwitchOverride: 'on' }, {})).toBe(true);
  });

  it('an off override beats an on environment list, and an on override needs no environment setting', () => {
    const env = { MON_DEVICE_SWITCH: 'all', MON_AUTO_SWITCH: 'all' };
    expect(isAutoSwitchEnabledForUser({ _id: 'u1', autoSwitchOverride: 'off' }, env)).toBe(false);
    expect(isAutoSwitchEnabledForUser({ _id: 'u1', deviceSwitchOverride: 'on', autoSwitchOverride: 'on' }, {})).toBe(true);
  });

  it('is off by default and follows the environment list for a default user', () => {
    const on = { _id: 'u1', deviceSwitchOverride: 'on' };
    expect(isAutoSwitchEnabledForUser(on, {})).toBe(false);
    expect(isAutoSwitchEnabledForUser(on, { MON_AUTO_SWITCH: 'off' })).toBe(false);
    expect(isAutoSwitchEnabledForUser(on, { MON_AUTO_SWITCH: 'u1,u2' })).toBe(true);
    expect(isAutoSwitchEnabledForUser({ ...on, _id: 'u3' }, { MON_AUTO_SWITCH: 'u1,u2' })).toBe(false);
    expect(isAutoSwitchEnabledForUser({ ...on, _id: 'u3' }, { MON_AUTO_SWITCH: 'all' })).toBe(true);
    expect(isAutoSwitchEnabledForUser({ ...on, _id: 'u3' }, { MON_AUTO_SWITCH: 'true' })).toBe(false);
  });

  it('the kill switch beats everything', () => {
    expect(
      isAutoSwitchEnabledForUser(
        { _id: 'u1', deviceSwitchOverride: 'on', autoSwitchOverride: 'on' },
        { MON_AUTO_SWITCH_DISABLED: 'true' },
      ),
    ).toBe(false);
  });

  it('is off for a missing user', () => {
    expect(isAutoSwitchEnabledForUser(null, {})).toBe(false);
    expect(isAutoSwitchEnabledForUser(undefined, {})).toBe(false);
  });
});

describe('getAutoSwitchAwayMs', () => {
  it('defaults to one minute and only accepts sane overrides', () => {
    expect(getAutoSwitchAwayMs({})).toBe(AUTO_SWITCH_AWAY_MS);
    expect(getAutoSwitchAwayMs({ MON_AUTO_SWITCH_AWAY_MS: '2000' })).toBe(2000);
    expect(getAutoSwitchAwayMs({ MON_AUTO_SWITCH_AWAY_MS: '10' })).toBe(AUTO_SWITCH_AWAY_MS);
    expect(getAutoSwitchAwayMs({ MON_AUTO_SWITCH_AWAY_MS: '99999999' })).toBe(AUTO_SWITCH_AWAY_MS);
    expect(getAutoSwitchAwayMs({ MON_AUTO_SWITCH_AWAY_MS: 'abc' })).toBe(AUTO_SWITCH_AWAY_MS);
  });
});

describe('classifyAgainstWorkSites', () => {
  it('is not away inside the radius', () => {
    const at = metersNorth(LEHI, 40);
    expect(classifyAgainstWorkSites(at.lat, at.lng, [LEHI])).toMatchObject({ away: false, siteName: 'Action Auto Lehi' });
  });

  it('treats the small buffer past the radius as still at the site, so edge jitter cannot flip it', () => {
    expect(workSiteExitThresholdM(LEHI)).toBe(120);
    const inBuffer = metersNorth(LEHI, 110);
    expect(classifyAgainstWorkSites(inBuffer.lat, inBuffer.lng, [LEHI]).away).toBe(false);
    const beyond = metersNorth(LEHI, 140);
    expect(classifyAgainstWorkSites(beyond.lat, beyond.lng, [LEHI]).away).toBe(true);
  });

  it('uses the wider warning zone as the exit line when the site has one', () => {
    expect(workSiteExitThresholdM(OREM)).toBe(250);
    const inWarning = metersNorth(OREM, 200);
    expect(classifyAgainstWorkSites(inWarning.lat, inWarning.lng, [OREM]).away).toBe(false);
    const beyond = metersNorth(OREM, 300);
    expect(classifyAgainstWorkSites(beyond.lat, beyond.lng, [OREM]).away).toBe(true);
  });

  it('ignores a warning zone that is not wider than the radius', () => {
    expect(workSiteExitThresholdM({ ...LEHI, warningRadiusM: 80 })).toBe(120);
    expect(workSiteExitThresholdM({ ...LEHI, warningRadiusM: null })).toBe(120);
  });

  it('is at a site when it is inside any one of several', () => {
    const at = metersNorth(OREM, 20);
    expect(classifyAgainstWorkSites(at.lat, at.lng, [LEHI, OREM])).toMatchObject({ away: false, siteName: 'Action Auto Orem' });
  });

  it('names the nearest site when away from all of them', () => {
    const farFromLehi = metersNorth(LEHI, 3000);
    const reading = classifyAgainstWorkSites(farFromLehi.lat, farFromLehi.lng, [OREM, LEHI]);
    expect(reading.away).toBe(true);
    expect(reading.siteName).toBe('Action Auto Lehi');
    expect(reading.distanceM).toBeGreaterThan(2900);
  });

  it('is never away when there are no work sites', () => {
    expect(classifyAgainstWorkSites(40, -111, [])).toEqual({ away: false, siteName: null, distanceM: null });
  });
});

describe('decideAutoSwitchStep', () => {
  const now = 10_000_000;
  const away = { away: true, activeDevice: 'desktop' as const, nowMs: now, awayMs: 60_000 };

  it('does nothing while at a site with no away record', () => {
    expect(decideAutoSwitchStep({ ...away, away: false, awaySince: null, awayLastPingAt: null })).toBe('none');
  });

  it('clears the away record as soon as the phone is back at a site', () => {
    expect(decideAutoSwitchStep({ ...away, away: false, awaySince: now - 500_000, awayLastPingAt: now - 30_000 })).toBe('clear');
  });

  it('starts the away clock on the first ping outside', () => {
    expect(decideAutoSwitchStep({ ...away, awaySince: null, awayLastPingAt: null })).toBe('start');
  });

  it('keeps counting while away for less than the required time', () => {
    expect(decideAutoSwitchStep({ ...away, awaySince: now - 30_000, awayLastPingAt: now - 30_000 })).toBe('refresh');
  });

  it('switches once the phone has been away long enough and the computer is still the monitored device', () => {
    expect(decideAutoSwitchStep({ ...away, awaySince: now - 60_000, awayLastPingAt: now - 30_000 })).toBe('switch');
  });

  it('never switches when the phone is already the monitored device or the device is unknown', () => {
    const since = { awaySince: now - 600_000, awayLastPingAt: now - 30_000 };
    expect(decideAutoSwitchStep({ ...away, ...since, activeDevice: 'mobile' })).toBe('refresh');
    expect(decideAutoSwitchStep({ ...away, ...since, activeDevice: null })).toBe('refresh');
  });

  it('restarts the clock after a long gap in pings, so old away time is not trusted', () => {
    const step = decideAutoSwitchStep({
      ...away,
      awaySince: now - 3_600_000,
      awayLastPingAt: now - AUTO_SWITCH_AWAY_GAP_MS - 1000,
    });
    expect(step).toBe('start');
  });

  it('does not switch while paused by an admin, keeps refreshing, and clears the pause once the phone is back at a site', () => {
    const since = { awaySince: now - 600_000, awayLastPingAt: now - 30_000, paused: true };
    expect(decideAutoSwitchStep({ ...away, ...since })).toBe('refresh');
    expect(decideAutoSwitchStep({ ...away, ...since, away: false })).toBe('clear');
    expect(decideAutoSwitchStep({ ...away, away: false, awaySince: null, awayLastPingAt: null, paused: true })).toBe('clear');
  });

  it('accepts dates and ISO strings for the stored times', () => {
    expect(
      decideAutoSwitchStep({
        ...away,
        awaySince: new Date(now - 90_000),
        awayLastPingAt: new Date(now - 30_000).toISOString(),
      }),
    ).toBe('switch');
  });
});

describe('isAwayBlockActive', () => {
  const now = 10_000_000;
  const awayMs = 60_000;

  it('is off without an away record', () => {
    expect(isAwayBlockActive(null, now, awayMs)).toBe(false);
    expect(isAwayBlockActive({}, now, awayMs)).toBe(false);
  });

  it('is on when the phone has been confirmed away and pinged recently', () => {
    expect(isAwayBlockActive({ awaySince: now - 200_000, awayLastPingAt: now - 30_000 }, now, awayMs)).toBe(true);
  });

  it('is off when the away time is shorter than the confirmation time', () => {
    expect(isAwayBlockActive({ awaySince: now - 40_000, awayLastPingAt: now - 10_000 }, now, awayMs)).toBe(false);
  });

  it('is off while an admin override is in force', () => {
    expect(isAwayBlockActive({ awaySince: now - 200_000, awayLastPingAt: now - 30_000, awayPaused: true }, now, awayMs)).toBe(false);
  });

  it('is off once the phone has gone quiet, because nobody knows where it is', () => {
    expect(
      isAwayBlockActive({ awaySince: now - 900_000, awayLastPingAt: now - AUTO_SWITCH_PING_FRESH_MS - 1000 }, now, awayMs),
    ).toBe(false);
  });
});
