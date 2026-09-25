import {
  isLocationFeatureOnForUser,
  normalizeDesktopLocationOverride,
} from '../../src/utils/locationFlags.util';

describe('normalizeDesktopLocationOverride', () => {
  it('keeps on and off and turns anything else into default', () => {
    expect(normalizeDesktopLocationOverride('on')).toBe('on');
    expect(normalizeDesktopLocationOverride('off')).toBe('off');
    for (const value of ['ON', 'true', '', null, undefined, 1, {}, 'all']) {
      expect(normalizeDesktopLocationOverride(value)).toBe('default');
    }
  });
});

describe('isLocationFeatureOnForUser', () => {
  const desktopFlags = ['LOC_DESKTOP_CHANNEL', 'LOC_DESKTOP_EXCUSE', 'LOC_DESKTOP_DISPLAY'] as const;

  it.each(desktopFlags)('%s follows the environment list for a user left on default', (flag) => {
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1' }, {})).toBe(false);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1' }, { [flag]: 'u1' })).toBe(true);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u2' }, { [flag]: 'u1' })).toBe(false);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u2' }, { [flag]: 'all' })).toBe(true);
  });

  it.each(desktopFlags)('%s is turned on for one user by an admin with no environment setting at all', (flag) => {
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'on' }, {})).toBe(true);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u2' }, {})).toBe(false);
  });

  it.each(desktopFlags)('%s is turned off by an admin even when the environment says all', (flag) => {
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'off' }, { [flag]: 'all' })).toBe(false);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'off' }, { [flag]: 'u1' })).toBe(false);
  });

  it.each(desktopFlags)('%s is stopped by the kill switch, including for a user set to on', (flag) => {
    const env = { [flag]: 'all', LOC_DESKTOP_DISABLED: 'true' };
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'on' }, env)).toBe(false);
    expect(isLocationFeatureOnForUser(flag, { _id: 'u1' }, env)).toBe(false);
  });

  it('never lets the override switch on the phone-side behaviours', () => {
    for (const flag of ['LOC_STICKY_MOBILE', 'LOC_HANDOFF_SCREENSHOTS'] as const) {
      expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'on' }, {})).toBe(false);
      expect(isLocationFeatureOnForUser(flag, { _id: 'u1', desktopLocationOverride: 'off' }, { [flag]: 'u1' })).toBe(true);
    }
  });

  it('a missing user is never enabled', () => {
    expect(isLocationFeatureOnForUser('LOC_DESKTOP_CHANNEL', null, { LOC_DESKTOP_CHANNEL: 'all' })).toBe(false);
    expect(isLocationFeatureOnForUser('LOC_DESKTOP_CHANNEL', undefined, {})).toBe(false);
  });
});
