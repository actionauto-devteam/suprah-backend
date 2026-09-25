import {
  DEFAULT_LOCATION_TUNING,
  effectiveDesktopInputAgeSec,
  getLocationTuning,
  isDesktopActiveOverPhone,
  isDesktopChannelFresh,
  isInputConfirmingPresence,
  isMobileFresh,
  isSilenceExcused,
  pickDisplayChannel,
  shouldIgnoreDesktopPing,
} from '../../src/utils/locationChannel.util';
import { isDesktopPlatformAllowed, isLocationFeatureOn } from '../../src/utils/locationFlags.util';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000);
const minutesAgo = (minutes: number) => secondsAgo(minutes * 60);

describe('locationFlags', () => {
  it('is off when the flag is unset, empty or off', () => {
    expect(isLocationFeatureOn('LOC_DESKTOP_EXCUSE', 'u1', {})).toBe(false);
    expect(isLocationFeatureOn('LOC_DESKTOP_EXCUSE', 'u1', { LOC_DESKTOP_EXCUSE: '' })).toBe(false);
    expect(isLocationFeatureOn('LOC_DESKTOP_EXCUSE', 'u1', { LOC_DESKTOP_EXCUSE: 'off' })).toBe(false);
    expect(isLocationFeatureOn('LOC_DESKTOP_EXCUSE', 'u1', { LOC_DESKTOP_EXCUSE: '  OFF ' })).toBe(false);
  });

  it('is on for everyone when set to all', () => {
    expect(isLocationFeatureOn('LOC_STICKY_MOBILE', 'u1', { LOC_STICKY_MOBILE: 'all' })).toBe(true);
    expect(isLocationFeatureOn('LOC_STICKY_MOBILE', null, { LOC_STICKY_MOBILE: 'ALL' })).toBe(true);
  });

  it('is on only for listed pilot users', () => {
    const env = { LOC_DESKTOP_CHANNEL: ' 65f0aa , 65F0BB,65f0cc ' };
    expect(isLocationFeatureOn('LOC_DESKTOP_CHANNEL', '65f0aa', env)).toBe(true);
    expect(isLocationFeatureOn('LOC_DESKTOP_CHANNEL', '65f0bb', env)).toBe(true);
    expect(isLocationFeatureOn('LOC_DESKTOP_CHANNEL', '65f0dd', env)).toBe(false);
    expect(isLocationFeatureOn('LOC_DESKTOP_CHANNEL', null, env)).toBe(false);
    expect(isLocationFeatureOn('LOC_DESKTOP_CHANNEL', undefined, env)).toBe(false);
  });

  it('accepts object ids by their string form', () => {
    const id = { toString: () => '65f0aa' };
    expect(isLocationFeatureOn('LOC_HANDOFF_SCREENSHOTS', id, { LOC_HANDOFF_SCREENSHOTS: '65f0aa' })).toBe(true);
  });

  it('does not let one flag enable another', () => {
    const env = { LOC_DESKTOP_CHANNEL: 'all' };
    expect(isLocationFeatureOn('LOC_DESKTOP_EXCUSE', 'u1', env)).toBe(false);
    expect(isLocationFeatureOn('LOC_STICKY_MOBILE', 'u1', env)).toBe(false);
    expect(isLocationFeatureOn('LOC_HANDOFF_SCREENSHOTS', 'u1', env)).toBe(false);
  });

  it('allows windows and mac by default and honors an override', () => {
    expect(isDesktopPlatformAllowed('win32', {})).toBe(true);
    expect(isDesktopPlatformAllowed('darwin', {})).toBe(true);
    expect(isDesktopPlatformAllowed('linux', {})).toBe(false);
    expect(isDesktopPlatformAllowed('darwin', { LOC_DESKTOP_PLATFORMS: 'win32' })).toBe(false);
    expect(isDesktopPlatformAllowed('WIN32', { LOC_DESKTOP_PLATFORMS: 'win32' })).toBe(true);
    expect(isDesktopPlatformAllowed(null, {})).toBe(false);
    expect(isDesktopPlatformAllowed('', {})).toBe(false);
  });
});

describe('getLocationTuning', () => {
  it('uses the documented defaults', () => {
    expect(getLocationTuning({})).toEqual({ mobileStickyMs: 180000, desktopFreshMs: 150000, inputConfirmSec: 300 });
  });

  it('reads valid overrides and ignores invalid ones', () => {
    expect(getLocationTuning({ LOC_MOBILE_STICKY_MS: '60000', LOC_DESKTOP_FRESH_MS: '90000', LOC_INPUT_CONFIRM_SEC: '120' }))
      .toEqual({ mobileStickyMs: 60000, desktopFreshMs: 90000, inputConfirmSec: 120 });
    expect(getLocationTuning({ LOC_MOBILE_STICKY_MS: 'abc', LOC_DESKTOP_FRESH_MS: '0', LOC_INPUT_CONFIRM_SEC: '-5' }))
      .toEqual(DEFAULT_LOCATION_TUNING);
  });
});

describe('isMobileFresh matches the existing isOnMobileNow rule', () => {
  const TEN_MINUTES = 10 * 60 * 1000;

  it('is fresh for a sharing mobile ping inside the window', () => {
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'sharing', lastSeenAt: minutesAgo(9) }, NOW, TEN_MINUTES)).toBe(true);
  });

  it('is not fresh once the window has passed', () => {
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'sharing', lastSeenAt: minutesAgo(11) }, NOW, TEN_MINUTES)).toBe(false);
  });

  it('treats the exact window edge as fresh', () => {
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'sharing', lastSeenAt: NOW - TEN_MINUTES }, NOW, TEN_MINUTES)).toBe(true);
  });

  it('is not fresh for desktop, paused, declined or missing records', () => {
    expect(isMobileFresh({ deviceType: 'desktop', sharingState: 'sharing', lastSeenAt: minutesAgo(1) }, NOW, TEN_MINUTES)).toBe(false);
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'paused_break', lastSeenAt: minutesAgo(1) }, NOW, TEN_MINUTES)).toBe(false);
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'declined_permission', lastSeenAt: minutesAgo(1) }, NOW, TEN_MINUTES)).toBe(false);
    expect(isMobileFresh({ deviceType: 'mobile', sharingState: 'sharing', lastSeenAt: null }, NOW, TEN_MINUTES)).toBe(false);
    expect(isMobileFresh(null, NOW, TEN_MINUTES)).toBe(false);
    expect(isMobileFresh(undefined, NOW, TEN_MINUTES)).toBe(false);
  });
});

describe('desktop channel helpers', () => {
  it('is fresh only inside the fresh window', () => {
    expect(isDesktopChannelFresh({ desktopLastSeenAt: secondsAgo(60) }, NOW, 150_000)).toBe(true);
    expect(isDesktopChannelFresh({ desktopLastSeenAt: secondsAgo(151) }, NOW, 150_000)).toBe(false);
    expect(isDesktopChannelFresh({ desktopLastSeenAt: null }, NOW, 150_000)).toBe(false);
    expect(isDesktopChannelFresh(null, NOW, 150_000)).toBe(false);
    expect(isDesktopChannelFresh({ desktopLastSeenAt: 'not a date' }, NOW, 150_000)).toBe(false);
  });

  it('rejects timestamps far in the future', () => {
    expect(isDesktopChannelFresh({ desktopLastSeenAt: new Date(NOW + 10 * 60_000) }, NOW, 150_000)).toBe(false);
  });

  it('adds the time since the report to the reported input age', () => {
    expect(effectiveDesktopInputAgeSec({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 20 }, NOW)).toBeCloseTo(50, 5);
    expect(effectiveDesktopInputAgeSec({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: null }, NOW)).toBeNull();
    expect(effectiveDesktopInputAgeSec({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: -1 }, NOW)).toBeNull();
    expect(effectiveDesktopInputAgeSec({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: Number.NaN }, NOW)).toBeNull();
    expect(effectiveDesktopInputAgeSec({ desktopLastSeenAt: null, desktopInputAgeSec: 5 }, NOW)).toBeNull();
  });

  it('confirms presence only when input is recent enough', () => {
    expect(isInputConfirmingPresence({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 250 }, NOW, 300)).toBe(true);
    expect(isInputConfirmingPresence({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 290 }, NOW, 300)).toBe(false);
    expect(isInputConfirmingPresence({ desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: null }, NOW, 300)).toBe(false);
  });
});

describe('shouldIgnoreDesktopPing', () => {
  const phoneFresh = { deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt: secondsAgo(30) };

  it('ignores a desktop ping while the phone is fresh in switching mode', () => {
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: phoneFresh, nowMs: NOW })).toBe(true);
  });

  it('lets the desktop ping through once the phone has been quiet longer than the sticky window', () => {
    const phoneStale = { ...phoneFresh, lastSeenAt: minutesAgo(4) };
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: phoneStale, nowMs: NOW })).toBe(false);
  });

  it('never ignores outside switching mode', () => {
    expect(shouldIgnoreDesktopPing({ mode: 'off', incomingDeviceType: 'desktop', previous: phoneFresh, nowMs: NOW })).toBe(false);
    expect(shouldIgnoreDesktopPing({ mode: 'always', incomingDeviceType: 'desktop', previous: phoneFresh, nowMs: NOW })).toBe(false);
  });

  it('never ignores a phone ping or a ping with no fresh phone record', () => {
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'mobile', previous: phoneFresh, nowMs: NOW })).toBe(false);
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: null, nowMs: NOW })).toBe(false);
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: { ...phoneFresh, deviceType: 'desktop' }, nowMs: NOW })).toBe(false);
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: { ...phoneFresh, sharingState: 'paused_break' }, nowMs: NOW })).toBe(false);
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: undefined, previous: phoneFresh, nowMs: NOW })).toBe(false);
  });

  it('respects a custom sticky window', () => {
    const tuning = { ...DEFAULT_LOCATION_TUNING, mobileStickyMs: 20_000 };
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: phoneFresh, nowMs: NOW, tuning })).toBe(false);
  });
});

describe('isSilenceExcused', () => {
  const desktopOnlyMain = { deviceType: 'desktop' as const, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(10) };
  const phoneLockedMain = { deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(4) };
  const trayFresh = (inputAgeSec: number | null, seenSecondsAgo = 30) => ({
    desktopLastSeenAt: secondsAgo(seenSecondsAgo),
    desktopInputAgeSec: inputAgeSec,
  });

  it('excuses a desktop-only user whose tab has been hidden for ten minutes', () => {
    expect(isSilenceExcused({ mode: 'off', main: desktopOnlyMain, desktop: trayFresh(4000), nowMs: NOW })).toBe(true);
    expect(isSilenceExcused({ mode: 'switching', main: desktopOnlyMain, desktop: trayFresh(4000), nowMs: NOW })).toBe(true);
  });

  it('excuses a legacy record with no device type when the tray is fresh', () => {
    const legacy = { deviceType: null, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(10) };
    expect(isSilenceExcused({ mode: 'switching', main: legacy, desktop: trayFresh(null), nowMs: NOW })).toBe(true);
  });

  it('excuses a locked phone only when the computer shows recent input', () => {
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(20), nowMs: NOW })).toBe(true);
  });

  it('does not excuse a locked phone when the computer has had no input for hours', () => {
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(7200), nowMs: NOW })).toBe(false);
  });

  it('does not excuse a locked phone when the input age is missing or invalid', () => {
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(null), nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(-5), nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(Number.NaN), nowMs: NOW })).toBe(false);
  });

  it('counts the time since the tray reported when judging input age', () => {
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(250, 30), nowMs: NOW })).toBe(true);
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(290, 30), nowMs: NOW })).toBe(false);
  });

  it('does not excuse when the tray channel is stale or absent', () => {
    expect(isSilenceExcused({ mode: 'switching', main: desktopOnlyMain, desktop: trayFresh(10, 300), nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: desktopOnlyMain, desktop: {}, nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: desktopOnlyMain, desktop: null, nowMs: NOW })).toBe(false);
  });

  it.each(['declined_permission', 'paused_break', 'paused_manual', 'off_duty'] as const)(
    'never excuses a %s state even with a fresh tray',
    (sharingState) => {
      expect(isSilenceExcused({ mode: 'switching', main: { ...desktopOnlyMain, sharingState }, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
      expect(isSilenceExcused({ mode: 'off', main: { ...desktopOnlyMain, sharingState }, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
    },
  );

  it('never excuses phone-only always mode', () => {
    expect(isSilenceExcused({ mode: 'always', main: desktopOnlyMain, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'always', main: phoneLockedMain, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
  });

  it('does not excuse when there is no main record', () => {
    expect(isSilenceExcused({ mode: 'switching', main: null, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: undefined, desktop: trayFresh(5), nowMs: NOW })).toBe(false);
  });

  it('respects custom tuning', () => {
    const tuning = { ...DEFAULT_LOCATION_TUNING, desktopFreshMs: 20_000, inputConfirmSec: 30 };
    expect(isSilenceExcused({ mode: 'switching', main: desktopOnlyMain, desktop: trayFresh(5, 30), nowMs: NOW, tuning })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(25, 10), nowMs: NOW, tuning })).toBe(false);
    expect(isSilenceExcused({ mode: 'switching', main: phoneLockedMain, desktop: trayFresh(5, 10), nowMs: NOW, tuning })).toBe(true);
  });
});

describe('isDesktopActiveOverPhone', () => {
  const phoneMain = (lastSeenAt: Date | null) => ({ deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt });

  it('prefers the computer when input is recent and newer than the last phone ping', () => {
    expect(isDesktopActiveOverPhone({
      mode: 'switching',
      main: phoneMain(minutesAgo(4)),
      desktop: { desktopLastSeenAt: secondsAgo(20), desktopInputAgeSec: 10 },
      nowMs: NOW,
    })).toBe(true);
  });

  it('keeps the phone when it pinged after the computer report', () => {
    expect(isDesktopActiveOverPhone({
      mode: 'switching',
      main: phoneMain(secondsAgo(5)),
      desktop: { desktopLastSeenAt: secondsAgo(20), desktopInputAgeSec: 10 },
      nowMs: NOW,
    })).toBe(false);
  });

  it('keeps the phone when the computer has had no recent input', () => {
    expect(isDesktopActiveOverPhone({
      mode: 'switching',
      main: phoneMain(minutesAgo(4)),
      desktop: { desktopLastSeenAt: secondsAgo(20), desktopInputAgeSec: 7200 },
      nowMs: NOW,
    })).toBe(false);
  });

  it('never applies outside switching mode or when the last device was not a phone', () => {
    const desktop = { desktopLastSeenAt: secondsAgo(20), desktopInputAgeSec: 10 };
    expect(isDesktopActiveOverPhone({ mode: 'off', main: phoneMain(minutesAgo(4)), desktop, nowMs: NOW })).toBe(false);
    expect(isDesktopActiveOverPhone({ mode: 'always', main: phoneMain(minutesAgo(4)), desktop, nowMs: NOW })).toBe(false);
    expect(isDesktopActiveOverPhone({ mode: 'switching', main: { deviceType: 'desktop', sharingState: 'sharing', lastSeenAt: minutesAgo(4) }, desktop, nowMs: NOW })).toBe(false);
    expect(isDesktopActiveOverPhone({ mode: 'switching', main: null, desktop, nowMs: NOW })).toBe(false);
  });

  it('treats a phone record with no last-seen time as older than the computer', () => {
    expect(isDesktopActiveOverPhone({
      mode: 'switching',
      main: phoneMain(null),
      desktop: { desktopLastSeenAt: secondsAgo(20), desktopInputAgeSec: 10 },
      nowMs: NOW,
    })).toBe(true);
  });
});

describe('a recon day walked through the rules', () => {
  it('follows the user from computer to phone and back without conflicts', () => {
    const atComputer = { deviceType: 'desktop' as const, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(8) };
    const tray = { desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 15 };
    expect(isSilenceExcused({ mode: 'switching', main: atComputer, desktop: tray, nowMs: NOW })).toBe(true);

    const phoneJustOpened = { deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt: secondsAgo(10) };
    expect(shouldIgnoreDesktopPing({ mode: 'switching', incomingDeviceType: 'desktop', previous: phoneJustOpened, nowMs: NOW })).toBe(true);
    expect(isDesktopActiveOverPhone({ mode: 'switching', main: phoneJustOpened, desktop: tray, nowMs: NOW })).toBe(false);

    const phoneLocked = { ...phoneJustOpened, lastSeenAt: minutesAgo(5) };
    const awayFromPc = { desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 3 * 3600 };
    expect(isSilenceExcused({ mode: 'switching', main: phoneLocked, desktop: awayFromPc, nowMs: NOW })).toBe(false);

    const backAtPc = { desktopLastSeenAt: secondsAgo(30), desktopInputAgeSec: 12 };
    expect(isSilenceExcused({ mode: 'switching', main: phoneLocked, desktop: backAtPc, nowMs: NOW })).toBe(true);
    expect(isDesktopActiveOverPhone({ mode: 'switching', main: phoneLocked, desktop: backAtPc, nowMs: NOW })).toBe(true);
  });
});

describe('pickDisplayChannel', () => {
  const desktopOnlyMain = { deviceType: 'desktop' as const, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(10) };
  const tray = (seenSecondsAgo = 30) => ({ desktopLastSeenAt: secondsAgo(seenSecondsAgo), desktopInputAgeSec: 5 });

  it('shows the computer channel when it is fresh and newer than a silent browser channel', () => {
    expect(pickDisplayChannel({ main: desktopOnlyMain, desktop: tray(), nowMs: NOW })).toBe('desktop');
  });

  it('keeps the main channel when the browser pinged after the computer report', () => {
    const main = { ...desktopOnlyMain, lastSeenAt: secondsAgo(5) };
    expect(pickDisplayChannel({ main, desktop: tray(30), nowMs: NOW })).toBe('main');
  });

  it('keeps the main channel while the phone is fresh', () => {
    const main = { deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt: secondsAgo(40) };
    expect(pickDisplayChannel({ main, desktop: tray(20), nowMs: NOW })).toBe('main');
  });

  it('shows the computer once a locked phone has been quiet past the sticky window', () => {
    const main = { deviceType: 'mobile' as const, sharingState: 'sharing' as const, lastSeenAt: minutesAgo(5) };
    expect(pickDisplayChannel({ main, desktop: tray(20), nowMs: NOW })).toBe('desktop');
  });

  it('keeps the main channel when the computer channel is stale or absent', () => {
    expect(pickDisplayChannel({ main: desktopOnlyMain, desktop: tray(600), nowMs: NOW })).toBe('main');
    expect(pickDisplayChannel({ main: desktopOnlyMain, desktop: {}, nowMs: NOW })).toBe('main');
    expect(pickDisplayChannel({ main: desktopOnlyMain, desktop: null, nowMs: NOW })).toBe('main');
  });

  it.each(['declined_permission', 'paused_break', 'paused_manual', 'off_duty'] as const)(
    'never shows the computer channel for a %s state',
    (sharingState) => {
      expect(pickDisplayChannel({ main: { ...desktopOnlyMain, sharingState }, desktop: tray(), nowMs: NOW })).toBe('main');
    },
  );

  it('handles a missing main record', () => {
    expect(pickDisplayChannel({ main: null, desktop: tray(), nowMs: NOW })).toBe('main');
  });

  it('treats a main record with no last-seen time as older than the computer channel', () => {
    expect(pickDisplayChannel({ main: { ...desktopOnlyMain, lastSeenAt: null }, desktop: tray(), nowMs: NOW })).toBe('desktop');
  });
});
