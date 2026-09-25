import { buildActivityLog, computePhonePeriods } from '../../src/utils/activityLog.util';

const DAY_START = new Date('2026-09-25T06:00:00.000Z');
const DAY_END = new Date('2026-09-26T06:00:00.000Z');
const NOW = new Date('2026-09-25T20:00:00.000Z');
const at = (hhmm: string) => new Date(`2026-09-25T${hhmm}:00.000Z`);

const baseInput = {
  timeLogs: [
    { _id: 'in1', type: 'time-in' as const, timestamp: at('10:00'), startedVia: 'desktop' as const },
  ],
  idlePeriods: [],
  idleDetected: [],
  idleStages: [],
  resumes: [],
  dayStart: DAY_START,
  dayEnd: DAY_END,
  now: NOW,
};

describe('buildActivityLog with monitoring switches', () => {
  it('lists each switch between the punches with who did it and where monitoring went', () => {
    const { events, summary } = buildActivityLog({
      ...baseInput,
      timeLogs: [
        ...baseInput.timeLogs,
        { _id: 'out1', type: 'time-out' as const, timestamp: at('14:00') },
      ],
      deviceSwitches: [
        { at: at('11:00'), to: 'mobile', by: 'user', locationUpdates: { count: 12, firstAt: at('11:01').toISOString(), lastAt: at('11:59').toISOString() } },
        { at: at('12:00'), to: 'desktop', by: 'admin' },
      ],
    });
    expect(events.map((event) => event.kind)).toEqual(['time-in', 'monitoring-switch', 'monitoring-switch', 'time-out']);
    expect(events[1]).toMatchObject({ switchedTo: 'mobile', switchedBy: 'user', locationUpdates: { count: 12 } });
    expect(events[2]).toMatchObject({ switchedTo: 'desktop', switchedBy: 'admin', locationUpdates: null });
    expect(summary.switchCount).toBe(2);
  });

  it('shows a phone period with no location updates as a count of zero, not as missing', () => {
    const { events } = buildActivityLog({
      ...baseInput,
      deviceSwitches: [{ at: at('11:00'), to: 'mobile', by: 'user', locationUpdates: { count: 0, firstAt: null, lastAt: null } }],
    });
    expect(events.find((event) => event.kind === 'monitoring-switch')?.locationUpdates).toEqual({ count: 0, firstAt: null, lastAt: null });
  });

  it('never carries location updates on a switch to the computer even if some were supplied', () => {
    const { events } = buildActivityLog({
      ...baseInput,
      deviceSwitches: [{ at: at('11:00'), to: 'desktop', by: 'user', locationUpdates: { count: 3, firstAt: null, lastAt: null } }],
    });
    expect(events.find((event) => event.kind === 'monitoring-switch')?.locationUpdates).toBeNull();
  });

  it('ignores a switch outside the day and does not count it', () => {
    const { events, summary } = buildActivityLog({
      ...baseInput,
      deviceSwitches: [
        { at: new Date('2026-09-25T05:00:00.000Z'), to: 'mobile', by: 'user' },
        { at: new Date('2026-09-26T07:00:00.000Z'), to: 'desktop', by: 'user' },
      ],
    });
    expect(events.filter((event) => event.kind === 'monitoring-switch')).toHaveLength(0);
    expect(summary.switchCount).toBe(0);
  });

  it('a day with no switches behaves exactly as before', () => {
    const withNone = buildActivityLog({ ...baseInput, deviceSwitches: [] });
    const without = buildActivityLog(baseInput);
    expect(withNone.events).toEqual(without.events);
    expect(without.summary.switchCount).toBe(0);
  });

  it('sorts a switch that happens at the same instant as a break-in after it', () => {
    const { events } = buildActivityLog({
      ...baseInput,
      timeLogs: [...baseInput.timeLogs, { _id: 'b1', type: 'break-in' as const, timestamp: at('11:00') }],
      deviceSwitches: [{ at: at('11:00'), to: 'mobile', by: 'user' }],
    });
    expect(events.map((event) => event.kind)).toEqual(['time-in', 'break-in', 'monitoring-switch']);
  });
});

describe('computePhonePeriods', () => {
  const ms = (hhmm: string) => at(hhmm).getTime();

  it('a phone period ends when monitoring moves back to the computer', () => {
    const periods = computePhonePeriods(
      [{ at: at('11:00'), to: 'mobile' }, { at: at('12:00'), to: 'desktop' }],
      [ms('14:00')],
      ms('20:00'),
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ index: 0 });
    expect(periods[0].start.getTime()).toBe(ms('11:00'));
    expect(periods[0].end.getTime()).toBe(ms('12:00'));
    expect(periods[0].endedBy).toBe('switch');
  });

  it('ends at the next time-out when the shift is closed while on the phone', () => {
    const periods = computePhonePeriods([{ at: at('11:00'), to: 'mobile' }], [ms('10:00'), ms('13:30')], ms('20:00'));
    expect(periods[0].end.getTime()).toBe(ms('13:30'));
    expect(periods[0].endedBy).toBe('time-out');
  });

  it('is still running at the limit when nothing ended it', () => {
    const periods = computePhonePeriods([{ at: at('11:00'), to: 'mobile' }], [], ms('15:00'));
    expect(periods[0].end.getTime()).toBe(ms('15:00'));
    expect(periods[0].endedBy).toBe('open');
  });

  it('handles several phone periods and keeps the original index of each', () => {
    const periods = computePhonePeriods(
      [
        { at: at('13:00'), to: 'desktop' },
        { at: at('11:00'), to: 'mobile' },
        { at: at('12:00'), to: 'desktop' },
        { at: at('16:00'), to: 'mobile' },
      ],
      [],
      ms('18:00'),
    );
    expect(periods.map((period) => period.index)).toEqual([1, 3]);
    expect(periods[0].end.getTime()).toBe(ms('12:00'));
    expect(periods[1].end.getTime()).toBe(ms('18:00'));
  });

  it('gives a desktop-only list no periods', () => {
    expect(computePhonePeriods([{ at: at('11:00'), to: 'desktop' }], [], ms('20:00'))).toEqual([]);
  });

  it('never returns an end before the start, even when the limit is earlier', () => {
    const periods = computePhonePeriods([{ at: at('11:00'), to: 'mobile' }], [], ms('10:00'));
    expect(periods[0].end.getTime()).toBe(ms('11:00'));
    expect(periods[0].endedBy).toBe('open');
  });

  it('a shift that started on the phone counts as a phone period from its time-in until it is moved or closed', () => {
    const periods = computePhonePeriods([{ at: at('10:00'), to: 'mobile' }, { at: at('11:30'), to: 'desktop' }], [ms('14:00')], ms('20:00'));
    expect(periods).toHaveLength(1);
    expect(periods[0].start.getTime()).toBe(ms('10:00'));
    expect(periods[0].end.getTime()).toBe(ms('11:30'));
    expect(periods[0].endedBy).toBe('switch');
  });

  it('prefers the time-out when it comes before the next switch', () => {
    const periods = computePhonePeriods([{ at: at('10:00'), to: 'mobile' }, { at: at('16:00'), to: 'desktop' }], [ms('12:00')], ms('20:00'));
    expect(periods[0].end.getTime()).toBe(ms('12:00'));
    expect(periods[0].endedBy).toBe('time-out');
  });
});
