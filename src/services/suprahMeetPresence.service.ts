import { IMeeting, IMeetingParticipant } from '../models/Meeting.model';

export const MEET_PRESENCE_LEASE_MS = 90_000;

type ParticipantSession = {
  attendeeId: string;
  lastSeenAt: Date;
};

function sessions(person: IMeetingParticipant): ParticipantSession[] | undefined {
  return (person as IMeetingParticipant & { sessions?: ParticipantSession[] }).sessions;
}

export function participantKey(person: IMeetingParticipant): string {
  return person.crmUserId ? String(person.crmUserId) : `guest:${person.guestId}`;
}

export function isParticipantPresent(person: IMeetingParticipant, now = new Date()): boolean {
  const tracked = sessions(person);
  // Existing live meetings have no session leases yet. Treat an empty legacy
  // session list as present only until it is explicitly left or first touched.
  if (!Array.isArray(tracked) || tracked.length === 0) return !person.leftAt;
  const cutoff = now.getTime() - MEET_PRESENCE_LEASE_MS;
  return tracked.some((session) => new Date(session.lastSeenAt).getTime() >= cutoff);
}

export function isHostPresent(meeting: IMeeting, now = new Date()): boolean {
  return (meeting.participants ?? []).some((person) =>
    person.crmUserId
    && String(person.crmUserId) === String(meeting.hostCrmUserId)
    && isParticipantPresent(person, now));
}

export function touchParticipantSession(
  person: IMeetingParticipant,
  attendeeId: string,
  now = new Date(),
): void {
  const tracked = sessions(person) ?? [];
  const existing = tracked.find((session) => session.attendeeId === attendeeId);
  if (existing) existing.lastSeenAt = now;
  else tracked.push({ attendeeId, lastSeenAt: now });
  (person as IMeetingParticipant & { sessions: ParticipantSession[] }).sessions = tracked;
  person.leftAt = undefined;
}

export function hasParticipantSession(person: IMeetingParticipant, attendeeId: string): boolean {
  const tracked = sessions(person);
  return Array.isArray(tracked) && tracked.length > 0
    ? tracked.some((session) => session.attendeeId === attendeeId)
    : !person.leftAt;
}

export function leaveParticipantSession(
  person: IMeetingParticipant,
  attendeeId: string | undefined,
  now = new Date(),
): void {
  const tracked = sessions(person);
  if (Array.isArray(tracked)) {
    const remaining = attendeeId
      ? tracked.filter((session) => session.attendeeId !== attendeeId)
      : [];
    (person as IMeetingParticipant & { sessions: ParticipantSession[] }).sessions = remaining;
    person.leftAt = remaining.length === 0 ? now : undefined;
    return;
  }
  person.leftAt = now;
}

export function clearParticipantSessions(person: IMeetingParticipant, now = new Date()): void {
  (person as IMeetingParticipant & { sessions: ParticipantSession[] }).sessions = [];
  person.leftAt = now;
}

/** Drop abandoned browser/device leases and keep the user-level roster truthful. */
export function pruneParticipantSessions(meeting: IMeeting, now = new Date()): void {
  const cutoff = now.getTime() - MEET_PRESENCE_LEASE_MS;
  for (const person of meeting.participants ?? []) {
    const tracked = sessions(person);
    if (!Array.isArray(tracked)) continue;
    const active = tracked.filter((session) => new Date(session.lastSeenAt).getTime() >= cutoff);
    if (active.length !== tracked.length) {
      (person as IMeetingParticipant & { sessions: ParticipantSession[] }).sessions = active;
    }
    if (active.length === 0 && !person.leftAt) person.leftAt = now;
    if (active.length > 0 && person.leftAt) person.leftAt = undefined;
  }
}

/** Dated rooms become available at their scheduled instant even without the host. */
export function hasScheduledMeetingOpened(meeting: IMeeting, now = new Date()): boolean {
  return Boolean(meeting.scheduledAt && new Date(meeting.scheduledAt).getTime() <= now.getTime());
}

/** Scheduled calls count active time with two people, even when the host is away. */
export function reconcileMeetingTimer(
  meeting: IMeeting,
  now = new Date(),
): { startedNow: boolean; running: boolean } {
  pruneParticipantSessions(meeting, now);
  const present = (meeting.participants ?? []).filter((person) => isParticipantPresent(person, now));
  const hostPresent = isHostPresent(meeting, now);
  const hasSomeoneElse = present.some((person) => participantKey(person) !== String(meeting.hostCrmUserId));
  const shouldRun = hasScheduledMeetingOpened(meeting, now) ? present.length >= 2 : hostPresent && hasSomeoneElse;
  const activeSince = meeting.timerActiveSince;
  if (shouldRun && !activeSince) {
    meeting.timerActiveSince = now;
    const startedNow = !meeting.startedAt;
    if (startedNow) meeting.startedAt = now;
    return { startedNow, running: true };
  }
  if (!shouldRun && activeSince) {
    meeting.timerElapsedMs = Math.max(0, Number(meeting.timerElapsedMs ?? 0)
      + Math.max(0, now.getTime() - new Date(activeSince).getTime()));
    meeting.timerActiveSince = undefined;
  }
  return { startedNow: false, running: shouldRun };
}

export function stopMeetingTimer(meeting: IMeeting, now = new Date()): void {
  const activeSince = meeting.timerActiveSince;
  if (!activeSince) return;
  meeting.timerElapsedMs = Math.max(0, Number(meeting.timerElapsedMs ?? 0)
    + Math.max(0, now.getTime() - new Date(activeSince).getTime()));
  meeting.timerActiveSince = undefined;
}

export function meetingTimerSnapshot(meeting: IMeeting, now = new Date()) {
  const activeSince = meeting.timerActiveSince;
  return {
    elapsedMs: Math.max(0, Number(meeting.timerElapsedMs ?? 0)),
    running: Boolean(activeSince),
    activeSince: activeSince ? new Date(activeSince).toISOString() : null,
    hostPresent: isHostPresent(meeting, now),
    scheduledOpen: hasScheduledMeetingOpened(meeting, now),
  };
}

/** Reconnect grace: empty rooms close after 5 minutes; host-away rooms after 15. */
export const MEET_NO_SHOW_GRACE_MS = 60 * 60_000;
export const MEET_EMPTY_GRACE_MS = 5 * 60_000;
export const MEET_HOST_AWAY_GRACE_MS = 15 * 60_000;

export function abandonedMeetingReason(meeting: IMeeting, now = new Date()): string | null {
  const timestamp = (value: Date | undefined) => value ? new Date(value).getTime() : 0;
  const current = now.getTime();
  if (meeting.status === 'scheduled') {
    return !meeting.scheduledAt && timestamp(meeting.createdAt) > 0
      && current - timestamp(meeting.createdAt) >= MEET_HOST_AWAY_GRACE_MS
      ? 'never-started' : null;
  }
  if (meeting.status !== 'live') return null;
  // An early host visit must not cancel a future scheduled session.
  if (meeting.scheduledAt && !hasScheduledMeetingOpened(meeting, now)) return null;
  const activity = (person: IMeetingParticipant) => Math.max(
    timestamp(person.joinedAt), timestamp(person.leftAt),
    ...(person.sessions ?? []).map((session) => timestamp(session.lastSeenAt) + MEET_PRESENCE_LEASE_MS),
  );
  const present = (person: IMeetingParticipant) => isParticipantPresent(person, now)
    && ((person.sessions?.length ?? 0) > 0 || current - activity(person) < MEET_PRESENCE_LEASE_MS);
  const people = meeting.participants ?? [];
  const scheduledOpen = hasScheduledMeetingOpened(meeting, now);
  const baseline = Math.max(timestamp(meeting.openedAt), timestamp(meeting.startedAt),
    scheduledOpen ? timestamp(meeting.scheduledAt) : timestamp(meeting.createdAt));
  if (scheduledOpen && !people.some(present) && people.every((person) => activity(person) < timestamp(meeting.scheduledAt))) {
    return current - timestamp(meeting.scheduledAt) >= MEET_NO_SHOW_GRACE_MS ? 'no-show' : null;
  }
  const lastActivity = Math.max(baseline, ...people.map(activity));
  if (!people.some(present) && lastActivity > 0 && current - lastActivity >= MEET_EMPTY_GRACE_MS) return 'empty';
  const host = people.filter((person) => String(person.crmUserId) === String(meeting.hostCrmUserId));
  const hostActivity = Math.max(baseline, ...host.map(activity));
  if (!scheduledOpen && !host.some(present) && hostActivity > 0 && current - hostActivity >= MEET_HOST_AWAY_GRACE_MS) return 'host-away';
  return null;
}

export function meetingEndedMessage(reason?: string): string {
  switch (reason) {
    case 'no-show': return 'This meeting closed because nobody joined within one hour of its scheduled time.';
    case 'empty': return 'This meeting closed after everyone left and the reconnect grace period expired.';
    case 'host-away': return 'This meeting closed because the host was away for more than fifteen minutes.';
    case 'never-started': return 'This instant meeting closed because nobody started it within fifteen minutes.';
    case 'host-ended': return 'The host ended this meeting for everyone.';
    default: return 'This meeting has already ended.';
  }
}
