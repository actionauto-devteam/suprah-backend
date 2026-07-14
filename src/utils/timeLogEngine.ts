/**
 * Shared TimeLog "core math" — pairing raw time-in/time-out/break-in/break-out
 * events into sessions, building per-day calendars, and aggregating summaries.
 *
 * This logic was previously copy-pasted near-verbatim across crm.controller.ts,
 * crmTimeproof.controller.ts, and generalTimeclock.controller.ts. It is
 * deliberately kept free of any screenshot/ghost-hours/heartbeat concerns —
 * those stay in the controllers that need them, layered on top of this engine.
 */

export interface TimeLogEntry {
  type: 'time-in' | 'time-out' | 'break-in' | 'break-out';
  timestamp: Date | string;
}

export interface Session {
  in: Date;
  out: Date | null;
  duration: number;
  isLive: boolean;
  isOpen: boolean;
}

export interface BreakSession {
  in: Date;
  out: Date | null;
  duration: number;
  isActive: boolean;
}

export interface CalendarDay {
  sessions: Session[];
  totalSeconds: number;
  breaks: BreakSession[];
  breakSeconds: number;
  weekTotalSeconds?: number;
}

export interface HoursSummary {
  hours: number;
  minutes: number;
  totalSeconds: number;
  decimal: number;
}

/** Date → "YYYY-MM-DD" (UTC) */
export const toDateStr = (date: Date): string => date.toISOString().split('T')[0];

/** Date → "YYYY-MM-DD" in the user's local timezone (tzOffsetMinutes = minutes east of UTC) */
export const toLocalDateStr = (date: Date, tzOffsetMinutes: number): string => {
  const local = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  return local.toISOString().split('T')[0];
};

/** Start of ISO week (Monday 00:00:00) */
export const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Pair time-in / time-out logs into complete sessions */
export const buildSessions = (logs: TimeLogEntry[]): Session[] => {
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessions: Session[] = [];
  let currentIn: Date | null = null;

  for (const log of sorted) {
    if (log.type === 'time-in') {
      currentIn = new Date(log.timestamp);
    } else if (log.type === 'time-out' && currentIn) {
      const out = new Date(log.timestamp);
      sessions.push({
        in: currentIn,
        out,
        duration: (out.getTime() - currentIn.getTime()) / 1000,
        isLive: false,
        isOpen: false,
      });
      currentIn = null;
    }
  }

  // Currently clocked in (no matching time-out).
  // Cap at 12 hours so a single forgotten clock-out cannot inflate every subsequent
  // calendar day with 24:00 entries (one unclosed session -> one live slice per day).
  if (currentIn) {
    const now = new Date();
    const MAX_LIVE_MS = 12 * 60 * 60 * 1000;
    const elapsedMs = now.getTime() - currentIn.getTime();
    const isCapped = elapsedMs > MAX_LIVE_MS;
    sessions.push({
      in: currentIn,
      out: null,
      duration: Math.min(elapsedMs, MAX_LIVE_MS) / 1000,
      isLive: !isCapped,
      isOpen: true,
    });
  }

  return sessions;
};

/** Pair break-in / break-out logs into break sessions */
export const buildBreakSessions = (logs: TimeLogEntry[]): BreakSession[] => {
  const sorted = [...logs]
    .filter((l) => l.type === 'break-in' || l.type === 'break-out')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const breaks: BreakSession[] = [];
  let currentBreakIn: Date | null = null;

  for (const log of sorted) {
    if (log.type === 'break-in') {
      currentBreakIn = new Date(log.timestamp);
    } else if (log.type === 'break-out' && currentBreakIn) {
      const out = new Date(log.timestamp);
      breaks.push({
        in: currentBreakIn,
        out,
        duration: (out.getTime() - currentBreakIn.getTime()) / 1000,
        isActive: false,
      });
      currentBreakIn = null;
    }
  }

  if (currentBreakIn) {
    breaks.push({
      in: currentBreakIn,
      out: null,
      duration: (Date.now() - currentBreakIn.getTime()) / 1000,
      isActive: true,
    });
  }

  return breaks;
};

/**
 * Splits a time range into calendar-day segments using LOCAL midnight boundaries.
 * tzOffsetMinutes: minutes east of UTC (e.g. -360 for Mountain Time UTC-6).
 * Each segment belongs to exactly one local calendar day.
 */
export const getMidnightSegments = (
  startTime: Date,
  endTime: Date,
  tzOffsetMinutes: number
): Array<{ date: string; segStart: Date; segEnd: Date }> => {
  const result: Array<{ date: string; segStart: Date; segEnd: Date }> = [];
  let segStart = new Date(startTime);

  while (true) {
    const segDateStr = toLocalDateStr(segStart, tzOffsetMinutes);
    const localDayStartUTC = new Date(segDateStr + 'T00:00:00.000Z').getTime();
    const nextLocalMidnightUTC = new Date(localDayStartUTC + 24 * 60 * 60 * 1000 - tzOffsetMinutes * 60_000);

    if (endTime <= nextLocalMidnightUTC) {
      result.push({ date: segDateStr, segStart: new Date(segStart), segEnd: new Date(endTime) });
      break;
    }

    result.push({ date: segDateStr, segStart: new Date(segStart), segEnd: new Date(nextLocalMidnightUTC) });
    segStart = new Date(nextLocalMidnightUTC);
  }

  return result;
};

/**
 * Attach weekTotalSeconds to the Saturday of each Sun-Sat week.
 * A skeleton CalendarDay is created for Saturday if no logs exist on that day,
 * so the frontend can still render the week-total badge. Break time is excluded.
 */
const attachWeekTotals = (calendar: Record<string, CalendarDay>): void => {
  const weekMap: Record<string, string[]> = {};

  for (const dateStr of Object.keys(calendar)) {
    if (calendar[dateStr].totalSeconds === 0) continue;
    const d = new Date(dateStr + 'T12:00:00Z');
    const dayOfWeek = d.getUTCDay(); // 0=Sun ... 6=Sat
    const daysToSaturday = dayOfWeek === 0 ? 6 : 6 - dayOfWeek;
    const saturday = new Date(d);
    saturday.setUTCDate(d.getUTCDate() + daysToSaturday);
    const saturdayStr = toDateStr(saturday);
    (weekMap[saturdayStr] ??= []).push(dateStr);
  }

  for (const [saturdayStr, dates] of Object.entries(weekMap)) {
    const weekTotal = dates.reduce((sum, d) => sum + calendar[d].totalSeconds, 0);
    if (!calendar[saturdayStr]) {
      calendar[saturdayStr] = { sessions: [], totalSeconds: 0, breaks: [], breakSeconds: 0 };
    }
    calendar[saturdayStr].weekTotalSeconds = weekTotal;
  }
};

/** Build per-day calendar map from raw log array with local-midnight-split support */
export const buildCalendarMap = (logs: TimeLogEntry[], tzOffsetMinutes = 0): Record<string, CalendarDay> => {
  const allSessions = buildSessions(logs);
  const allBreaks = buildBreakSessions(logs);

  const byDate: Record<string, { sessions: CalendarDay['sessions']; breaks: CalendarDay['breaks'] }> = {};
  const ensure = (d: string) => { if (!byDate[d]) byDate[d] = { sessions: [], breaks: [] }; };

  for (const s of allSessions) {
    // For capped sessions (out=null, isLive=false), reconstruct effective end from duration
    // so getMidnightSegments doesn't spread the session to "now" across all subsequent days.
    const endTime = s.out ?? (s.isLive ? new Date() : new Date(s.in.getTime() + s.duration * 1000));
    const segments = getMidnightSegments(s.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].sessions.push({
        in: segStart,
        out: s.out && isLast ? s.out : segEnd,
        duration: (segEnd.getTime() - segStart.getTime()) / 1000,
        isLive: s.isLive && isLast,
        isOpen: s.isOpen,
      });
    }
  }

  for (const b of allBreaks) {
    const endTime = b.out ?? new Date();
    const segments = getMidnightSegments(b.in, endTime, tzOffsetMinutes);
    for (const { date, segStart, segEnd } of segments) {
      ensure(date);
      const isLast = segEnd.getTime() === endTime.getTime();
      byDate[date].breaks.push({
        in: segStart,
        out: b.out && isLast ? b.out : segEnd,
        duration: (segEnd.getTime() - segStart.getTime()) / 1000,
        isActive: b.isActive && isLast,
      });
    }
  }

  const calendar: Record<string, CalendarDay> = {};
  for (const [date, data] of Object.entries(byDate)) {
    const grossSessionSeconds = data.sessions.reduce((sum, s) => sum + s.duration, 0);
    const breakSeconds = data.breaks.reduce((sum, b) => sum + b.duration, 0);
    // totalSeconds is NET work time (excludes breaks).
    calendar[date] = {
      sessions: data.sessions,
      totalSeconds: Math.max(0, grossSessionSeconds - breakSeconds),
      breaks: data.breaks,
      breakSeconds,
    };
  }

  attachWeekTotals(calendar);
  return calendar;
};

/** Compute consecutive working-day streak using local calendar dates */
export const computeStreak = (
  calendar: Record<string, CalendarDay>,
  tzOffsetMinutes = 0
): { streak: number; longestStreak: number } => {
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];

  let streak = 0;
  const check = new Date(localNow);
  check.setUTCHours(12, 0, 0, 0); // pin to noon to avoid DST edge cases

  while (true) {
    const dateStr = check.toISOString().split('T')[0];
    const hasWork = !!calendar[dateStr] && calendar[dateStr].totalSeconds > 0;

    if (hasWork) {
      streak++;
      check.setUTCDate(check.getUTCDate() - 1);
    } else if (dateStr === todayStr) {
      // Today hasn't been worked yet -- look back from yesterday
      check.setUTCDate(check.getUTCDate() - 1);
    } else {
      break;
    }
  }

  const sorted = Object.keys(calendar).sort();
  let longest = 0;
  let temp = 0;
  for (const d of sorted) {
    if (calendar[d].totalSeconds > 0) {
      temp++;
      longest = Math.max(longest, temp);
    } else {
      temp = 0;
    }
  }

  return { streak, longestStreak: longest };
};

/** Build 24-element array: how many clock-ins per hour-of-day (in user's local time) */
export const buildHourPattern = (logs: TimeLogEntry[], tzOffsetMinutes = 0): number[] => {
  const pattern = new Array(24).fill(0);
  for (const log of logs) {
    if (log.type === 'time-in') {
      const localTs = new Date(new Date(log.timestamp).getTime() + tzOffsetMinutes * 60_000);
      pattern[localTs.getUTCHours()]++;
    }
  }
  return pattern;
};

export const formatHours = (seconds: number): HoursSummary => ({
  hours: Math.floor(seconds / 3600),
  minutes: Math.floor((seconds % 3600) / 60),
  totalSeconds: Math.round(seconds),
  decimal: parseFloat((seconds / 3600).toFixed(2)),
});

/** Aggregate per-day data into today/week/month buckets using local calendar dates */
export const aggregateSummary = (
  calendar: Record<string, CalendarDay>,
  tzOffsetMinutes = 0
): { today: HoursSummary; thisWeek: HoursSummary; thisMonth: HoursSummary } => {
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const todayStr = localNow.toISOString().split('T')[0];

  const localDay = localNow.getUTCDay(); // 0=Sun ... 6=Sat
  const daysFromMonday = localDay === 0 ? 6 : localDay - 1;
  const localWeekStartMs = localNow.getTime() - daysFromMonday * 86_400_000;
  const weekStartStr = new Date(localWeekStartMs).toISOString().split('T')[0];

  const monthStartStr = todayStr.slice(0, 7) + '-01';

  let todaySeconds = 0;
  let weekSeconds = 0;
  let monthSeconds = 0;

  for (const [dateStr, data] of Object.entries(calendar)) {
    if (dateStr === todayStr) todaySeconds += data.totalSeconds;
    if (dateStr >= weekStartStr) weekSeconds += data.totalSeconds;
    if (dateStr >= monthStartStr) monthSeconds += data.totalSeconds;
  }

  return {
    today: formatHours(todaySeconds),
    thisWeek: formatHours(weekSeconds),
    thisMonth: formatHours(monthSeconds),
  };
};
