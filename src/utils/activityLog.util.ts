import type { IdlePeriod } from './timeLogEngine';

export type ActivityEventKind =
  | 'time-in'
  | 'time-out'
  | 'break-in'
  | 'break-out'
  | 'idle'
  | 'idle-stage'
  | 'shift-resumed'
  | 'monitoring-switch';

export type TimeOutReasonKind = 'auto' | 'admin' | 'early-end' | 'none';

export interface ActivityLogEvent {
  id: string;
  kind: ActivityEventKind;
  at: string;
  endAt?: string | null;
  durationSeconds?: number;
  ongoing?: boolean;
  note?: string | null;
  reasonKind?: TimeOutReasonKind;
  startedVia?: 'desktop' | 'mobile' | null;
  flaggedAt?: string | null;
  stage?: 2 | 3;
  removedTimeOutAt?: string | null;
  removedTimeOutNote?: string | null;
  switchedTo?: 'desktop' | 'mobile';
  switchedBy?: 'user' | 'admin';
  locationUpdates?: PhoneLocationUpdates | null;
}

export interface PhoneLocationUpdates {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ActivityLogSummary {
  firstTimeIn: string | null;
  lastTimeOut: string | null;
  isShiftOpen: boolean;
  breakCount: number;
  breakSeconds: number;
  idleCount: number;
  idleSeconds: number;
  resumeCount: number;
  switchCount: number;
}

export interface ActivityTimeLogInput {
  _id: unknown;
  type: 'time-in' | 'time-out' | 'break-in' | 'break-out';
  timestamp: Date | string;
  note?: string | null;
  startedVia?: 'desktop' | 'mobile' | null;
  createdAt?: Date | string | null;
}

export interface ActivityIdleDetectedInput {
  at: Date | string;
}

export interface ActivityIdleStageInput {
  at: Date | string;
  stage: number;
}

export interface ActivityResumeInput {
  at: Date | string;
  removedTimeOutAt?: Date | string | null;
  removedTimeOutNote?: string | null;
}

export interface ActivityDeviceSwitchInput {
  at: Date | string;
  to: 'desktop' | 'mobile';
  by: 'user' | 'admin';
  locationUpdates?: PhoneLocationUpdates | null;
}

export interface BuildActivityLogInput {
  timeLogs: ActivityTimeLogInput[];
  idlePeriods: IdlePeriod[];
  idleDetected: ActivityIdleDetectedInput[];
  idleStages: ActivityIdleStageInput[];
  resumes: ActivityResumeInput[];
  deviceSwitches?: ActivityDeviceSwitchInput[];
  dayStart: Date;
  dayEnd: Date;
  now: Date;
}

const KIND_RANK: Record<ActivityEventKind, number> = {
  'time-in': 0,
  'shift-resumed': 1,
  'break-in': 2,
  'monitoring-switch': 2.5,
  idle: 3,
  'idle-stage': 4,
  'break-out': 5,
  'time-out': 6,
};

const ADMIN_NOTE_PREFIXES = ['Manually clocked out by', 'Admin override', 'Corrected by', 'Added by'];

const toMs = (value: Date | string): number => new Date(value).getTime();
const toIso = (value: Date | string): string => new Date(value).toISOString();
const createdMsOf = (log: ActivityTimeLogInput): number => toMs(log.createdAt ?? log.timestamp);

export const classifyTimeOutReason = (note?: string | null): TimeOutReasonKind => {
  const text = (note ?? '').trim();
  if (!text) return 'none';
  if (text.startsWith('Auto clock-out')) return 'auto';
  if (ADMIN_NOTE_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'admin';
  return 'early-end';
};

interface SortableEntry {
  event: ActivityLogEvent;
  sortMs: number;
  createdMs: number;
}

export function buildActivityLog(input: BuildActivityLogInput): { events: ActivityLogEvent[]; summary: ActivityLogSummary } {
  const { timeLogs, idlePeriods, idleDetected, idleStages, resumes, dayStart, dayEnd, now } = input;
  const deviceSwitches = input.deviceSwitches ?? [];
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();
  const nowMs = now.getTime();
  const stateLimitMs = Math.min(dayEndMs, nowMs);

  const sortedLogs = [...timeLogs].sort((a, b) =>
    toMs(a.timestamp) - toMs(b.timestamp)
    || KIND_RANK[a.type] - KIND_RANK[b.type]
    || createdMsOf(a) - createdMsOf(b)
    || String(a._id).localeCompare(String(b._id))
  );

  let shiftOpen = false;
  for (const log of sortedLogs) {
    if (toMs(log.timestamp) >= stateLimitMs) break;
    if (log.type === 'time-in') shiftOpen = true;
    else if (log.type === 'time-out') shiftOpen = false;
  }

  const entries: SortableEntry[] = [];
  const push = (event: ActivityLogEvent, sortMs: number, createdMs: number = sortMs): void => {
    entries.push({ event, sortMs, createdMs });
  };

  let openBreak: { event: ActivityLogEvent; ms: number } | null = null;
  let breakCount = 0;
  let breakSeconds = 0;

  for (const log of sortedLogs) {
    const ms = toMs(log.timestamp);
    if (ms < dayStartMs || ms >= dayEndMs) continue;

    const trimmedNote = log.note?.trim() ? log.note.trim() : null;
    const event: ActivityLogEvent = {
      id: `punch-${String(log._id)}`,
      kind: log.type,
      at: toIso(log.timestamp),
      note: trimmedNote,
    };

    if (log.type === 'time-in') {
      event.startedVia = log.startedVia ?? null;
      openBreak = null;
    } else if (log.type === 'time-out') {
      event.reasonKind = classifyTimeOutReason(trimmedNote);
      openBreak = null;
    } else if (log.type === 'break-in') {
      breakCount += 1;
      openBreak = { event, ms };
    } else if (log.type === 'break-out' && openBreak) {
      const seconds = Math.max(0, Math.round((ms - openBreak.ms) / 1000));
      event.durationSeconds = seconds;
      breakSeconds += seconds;
      openBreak = null;
    }

    push(event, ms, createdMsOf(log));
  }

  if (openBreak && shiftOpen && nowMs < dayEndMs) {
    const seconds = Math.max(0, Math.round((nowMs - openBreak.ms) / 1000));
    openBreak.event.ongoing = true;
    openBreak.event.durationSeconds = seconds;
    breakSeconds += seconds;
  }

  const detectedMs = idleDetected.map((item) => toMs(item.at)).sort((a, b) => a - b);
  let idleCount = 0;
  let idleSeconds = 0;

  for (const period of idlePeriods) {
    const startMs = toMs(period.idleStart);
    if (startMs < dayStartMs || startMs >= dayEndMs) continue;
    const endMs = period.idleEnd ? toMs(period.idleEnd) : null;
    const flaggedMs = detectedMs.find((ms) => ms >= startMs && (endMs === null || ms <= endMs));

    idleCount += 1;
    idleSeconds += period.durationSeconds;
    push({
      id: `idle-${startMs}`,
      kind: 'idle',
      at: toIso(period.idleStart),
      endAt: period.idleEnd ? toIso(period.idleEnd) : null,
      durationSeconds: period.durationSeconds,
      ongoing: endMs === null,
      flaggedAt: flaggedMs !== undefined ? new Date(flaggedMs).toISOString() : null,
    }, startMs);
  }

  for (const marker of idleStages) {
    if (marker.stage !== 2 && marker.stage !== 3) continue;
    const stage: 2 | 3 = marker.stage === 2 ? 2 : 3;
    const ms = toMs(marker.at);
    push({
      id: `idle-stage-${stage}-${ms}`,
      kind: 'idle-stage',
      at: toIso(marker.at),
      stage,
    }, ms);
  }

  resumes.forEach((resume, index) => {
    const ms = toMs(resume.at);
    push({
      id: `resume-${ms}-${index}`,
      kind: 'shift-resumed',
      at: toIso(resume.at),
      removedTimeOutAt: resume.removedTimeOutAt ? toIso(resume.removedTimeOutAt) : null,
      removedTimeOutNote: resume.removedTimeOutNote ?? null,
    }, ms);
  });

  let switchCount = 0;
  deviceSwitches.forEach((change, index) => {
    const ms = toMs(change.at);
    if (ms < dayStartMs || ms >= dayEndMs) return;
    switchCount += 1;
    push({
      id: `switch-${ms}-${index}`,
      kind: 'monitoring-switch',
      at: toIso(change.at),
      switchedTo: change.to,
      switchedBy: change.by,
      locationUpdates: change.to === 'mobile' ? change.locationUpdates ?? null : null,
    }, ms);
  });

  entries.sort((a, b) =>
    a.sortMs - b.sortMs
    || KIND_RANK[a.event.kind] - KIND_RANK[b.event.kind]
    || a.createdMs - b.createdMs
    || a.event.id.localeCompare(b.event.id)
  );

  const events = entries.map((entry) => entry.event);
  const timeIns = events.filter((event) => event.kind === 'time-in');
  const timeOuts = events.filter((event) => event.kind === 'time-out');

  const summary: ActivityLogSummary = {
    firstTimeIn: timeIns.length > 0 ? timeIns[0].at : null,
    lastTimeOut: timeOuts.length > 0 ? timeOuts[timeOuts.length - 1].at : null,
    isShiftOpen: shiftOpen,
    breakCount,
    breakSeconds,
    idleCount,
    idleSeconds,
    resumeCount: resumes.length,
    switchCount,
  };

  return { events, summary };
}

export interface PhonePeriod {
  index: number;
  start: Date;
  end: Date;
  endedBy: 'switch' | 'time-out' | 'open';
}

export function computePhonePeriods(
  switches: Array<{ at: Date | string; to: 'desktop' | 'mobile' }>,
  timeOutsMs: number[],
  limitMs: number,
): PhonePeriod[] {
  const ordered = switches
    .map((change, index) => ({ index, ms: toMs(change.at), to: change.to }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  const periods: PhonePeriod[] = [];
  ordered.forEach((change, position) => {
    if (change.to !== 'mobile') return;
    const next = ordered[position + 1];
    const nextTimeOut = timeOutsMs.filter((ms) => ms > change.ms).sort((a, b) => a - b)[0];
    const switchMs = next ? next.ms : Infinity;
    const timeOutMs = nextTimeOut === undefined ? Infinity : nextTimeOut;
    const endMs = Math.max(change.ms, Math.min(limitMs, switchMs, timeOutMs));
    const endedBy = endMs === switchMs && switchMs <= timeOutMs ? 'switch' : endMs === timeOutMs ? 'time-out' : 'open';
    periods.push({ index: change.index, start: new Date(change.ms), end: new Date(endMs), endedBy });
  });
  return periods;
}
