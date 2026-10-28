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

/** The elapsed clock runs only while the host and another active identity are present. */
export function reconcileMeetingTimer(
  meeting: IMeeting,
  now = new Date(),
): { startedNow: boolean; running: boolean } {
  pruneParticipantSessions(meeting, now);
  const present = (meeting.participants ?? []).filter((person) => isParticipantPresent(person, now));
  const hostPresent = isHostPresent(meeting, now);
  const hasSomeoneElse = present.some((person) => participantKey(person) !== String(meeting.hostCrmUserId));
  const shouldRun = hostPresent && hasSomeoneElse;
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
  };
}
