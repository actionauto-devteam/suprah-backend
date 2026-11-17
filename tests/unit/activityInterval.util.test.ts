type StoredInterval = { _id: string; userId: string; startAt: Date; endAt: Date; durationSeconds: number; shiftDate: string };

let stored: StoredInterval[] = [];

const chain = <T>(value: () => T) => ({
  select: () => chain(value),
  lean: async () => value(),
});

jest.mock('../../src/models/ActivityInterval.model', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn((filter: { userId: string; startAt: Date }) =>
      chain(() => stored.find((s) => s.userId === filter.userId && s.startAt.getTime() === filter.startAt.getTime()) ?? null)),
    updateOne: jest.fn(async (filter: { _id: string }, update: { $set: { endAt: Date; durationSeconds: number } }) => {
      const row = stored.find((s) => s._id === filter._id);
      if (row) Object.assign(row, update.$set);
      return { modifiedCount: row ? 1 : 0 };
    }),
    create: jest.fn(async (doc: Omit<StoredInterval, '_id'>) => {
      const row = { ...doc, _id: `iv${stored.length + 1}` };
      stored.push(row);
      return row;
    }),
  },
}));

jest.mock('../../src/models/AgentHeartbeat.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(() => chain(() => null)) },
}));

import {
  looksLikeWrongClientClock,
  liveTrackingStartMs,
  parseIntervalDate,
  saveActivityInterval,
} from '../../src/utils/activityInterval.util';
import { buildIdleLog } from '../../src/utils/timeLogEngine';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe('parseIntervalDate', () => {
  it('accepts ISO strings and rejects garbage', () => {
    expect(parseIntervalDate('2026-11-17T17:54:17.000Z')?.toISOString()).toBe('2026-11-17T17:54:17.000Z');
    expect(parseIntervalDate('not a date')).toBeNull();
    expect(parseIntervalDate({})).toBeNull();
    expect(parseIntervalDate(undefined)).toBeNull();
  });
});

describe('looksLikeWrongClientClock', () => {
  const now = at('2026-11-17T20:00:00Z');

  it('keeps live uploads on their own day', () => {
    expect(looksLikeWrongClientClock(at('2026-11-17T19:59:00Z'), now, false)).toBe(false);
  });

  it('still flags a live upload whose end is more than an hour off', () => {
    expect(looksLikeWrongClientClock(at('2026-11-17T17:00:00Z'), now, false)).toBe(true);
    expect(looksLikeWrongClientClock(at('2026-11-17T22:00:00Z'), now, false)).toBe(true);
  });

  it('trusts a re-sent upload that is hours or days late', () => {
    expect(looksLikeWrongClientClock(at('2026-11-17T15:00:00Z'), now, true)).toBe(false);
    expect(looksLikeWrongClientClock(at('2026-11-15T20:00:00Z'), now, true)).toBe(false);
  });

  it('does not trust a re-sent upload older than 7 days or far in the future', () => {
    expect(looksLikeWrongClientClock(at('2026-11-09T20:00:00Z'), now, true)).toBe(true);
    expect(looksLikeWrongClientClock(at('2026-11-17T22:00:00Z'), now, true)).toBe(true);
  });
});

describe('saveActivityInterval', () => {
  beforeEach(() => {
    stored = [];
  });

  const base = { userId: 'u1', shiftDate: '2026-11-17' };

  it('creates a new interval', async () => {
    const r = await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    expect(r).toEqual({ durationSeconds: 600, outcome: 'created' });
    expect(stored).toHaveLength(1);
  });

  it('ignores the same interval sent twice', async () => {
    await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    const r = await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    expect(r.outcome).toBe('duplicate');
    expect(stored).toHaveLength(1);
    expect(stored[0].durationSeconds).toBe(600);
  });

  it('extends instead of double counting when the same start comes back with a later end', async () => {
    await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    const r = await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:14:17Z') });
    expect(r).toEqual({ durationSeconds: 1200, outcome: 'extended' });
    expect(stored).toHaveLength(1);
    expect(stored[0].endAt.toISOString()).toBe('2026-11-17T18:14:17.000Z');
    expect(stored[0].durationSeconds).toBe(1200);
  });

  it('keeps intervals of other users separate', async () => {
    await saveActivityInterval({ ...base, start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    await saveActivityInterval({ ...base, userId: 'u2', start: at('2026-11-17T17:54:17Z'), end: at('2026-11-17T18:04:17Z') });
    expect(stored).toHaveLength(2);
  });
});

describe('liveTrackingStartMs', () => {
  const nowMs = at('2026-11-17T19:29:35Z').getTime();
  const fresh = { lastSeenAt: new Date(nowMs - 30_000), isIdle: false, isOnBreak: false };

  it('uses the tray current segment start when the tray is online and active', () => {
    expect(liveTrackingStartMs({ ...fresh, currentIntervalStartAt: at('2026-11-17T19:10:24Z') }, nowMs))
      .toBe(at('2026-11-17T19:10:24Z').getTime());
  });

  it('reaches back to the oldest unsent activity', () => {
    expect(liveTrackingStartMs({
      ...fresh,
      currentIntervalStartAt: at('2026-11-17T19:20:24Z'),
      unsentActivitySince: at('2026-11-17T18:54:17Z'),
    }, nowMs)).toBe(at('2026-11-17T18:54:17Z').getTime());
  });

  it('ignores unsent activity older than 2 hours', () => {
    expect(liveTrackingStartMs({
      ...fresh,
      currentIntervalStartAt: at('2026-11-17T19:20:24Z'),
      unsentActivitySince: at('2026-11-17T17:00:00Z'),
    }, nowMs)).toBe(at('2026-11-17T19:20:24Z').getTime());
  });

  it('returns nothing when the tray says idle, on break, or has gone quiet', () => {
    const start = { currentIntervalStartAt: at('2026-11-17T19:10:24Z') };
    expect(liveTrackingStartMs({ ...fresh, ...start, isIdle: true }, nowMs)).toBeNull();
    expect(liveTrackingStartMs({ ...fresh, ...start, isOnBreak: true }, nowMs)).toBeNull();
    expect(liveTrackingStartMs({ ...fresh, ...start, lastSeenAt: new Date(nowMs - 6 * MIN) }, nowMs)).toBeNull();
    expect(liveTrackingStartMs(null, nowMs)).toBeNull();
  });

  it('returns nothing when the tray has no segment running', () => {
    expect(liveTrackingStartMs({ ...fresh, currentIntervalStartAt: null, unsentActivitySince: null }, nowMs)).toBeNull();
  });
});

describe('buildIdleLog with live tracking', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(at('2026-11-17T19:29:35Z'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  const logs = [{ type: 'time-in' as const, timestamp: at('2026-11-17T16:56:14Z') }];
  const intervals = [
    { startAt: at('2026-11-17T16:56:14Z'), endAt: at('2026-11-17T17:54:17Z') },
    { startAt: at('2026-11-17T18:50:25Z'), endAt: at('2026-11-17T19:10:24Z') },
  ];

  it('shows the trailing gap as ongoing idle without live tracking (old behaviour)', () => {
    const idle = buildIdleLog(logs, intervals, 'America/Denver');
    expect(idle[0]).toMatchObject({ idleStart: '2026-11-17T19:10:24.000Z', idleEnd: null });
  });

  it('does not show ongoing idle while the tray is online and active', () => {
    const idle = buildIdleLog(logs, intervals, 'America/Denver', at('2026-11-17T19:10:24Z').getTime());
    expect(idle.find((p) => p.idleEnd === null)).toBeUndefined();
  });

  it('still shows a real gap that ended before the live segment', () => {
    const idle = buildIdleLog(logs, intervals, 'America/Denver', at('2026-11-17T19:10:24Z').getTime());
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ idleStart: '2026-11-17T17:54:17.000Z', idleEnd: '2026-11-17T18:50:25.000Z' });
  });

  it('still shows the gap between the last upload and a live segment that starts later', () => {
    const idle = buildIdleLog(logs, intervals, 'America/Denver', at('2026-11-17T19:25:00Z').getTime());
    expect(idle.find((p) => p.idleStart === '2026-11-17T19:10:24.000Z')).toMatchObject({ idleEnd: '2026-11-17T19:25:00.000Z' });
  });

  it('does not touch a closed session', () => {
    const closed = [...logs, { type: 'time-out' as const, timestamp: at('2026-11-17T19:29:00Z') }];
    const idle = buildIdleLog(closed, intervals, 'America/Denver', at('2026-11-17T19:10:24Z').getTime());
    expect(idle.find((p) => p.idleStart === '2026-11-17T19:10:24.000Z')).toMatchObject({ idleEnd: '2026-11-17T19:29:00.000Z' });
  });

  it('still skips a session that has no uploads yet', () => {
    const idle = buildIdleLog(logs, [], 'America/Denver', at('2026-11-17T19:10:24Z').getTime());
    expect(idle).toHaveLength(0);
  });
});
