import {
  abandonedMeetingReason, isHostPresent, leaveParticipantSession, reconcileMeetingTimer,
  touchParticipantSession,
} from '../../src/services/suprahMeetPresence.service';

const makeMeeting = () => ({
  hostCrmUserId: 'host',
  participants: [
    { crmUserId: 'host', fullName: 'Host', role: 'host', joinedAt: new Date(), sessions: [] },
    { crmUserId: 'person', fullName: 'Person', role: 'participant', joinedAt: new Date(), sessions: [] },
  ],
  timerElapsedMs: 0,
  timerActiveSince: undefined,
  startedAt: undefined,
} as any);

it('runs only with an active host session and another active identity', () => {
  const meeting = makeMeeting();
  const now = new Date('2026-10-28T12:00:00Z');
  touchParticipantSession(meeting.participants[0], 'host-a', now);
  expect(reconcileMeetingTimer(meeting, now).running).toBe(false);
  touchParticipantSession(meeting.participants[1], 'person-a', now);
  expect(reconcileMeetingTimer(meeting, now).running).toBe(true);
  expect(meeting.startedAt).toEqual(now);
});

it('one host device can leave without marking another host device absent', () => {
  const meeting = makeMeeting();
  const now = new Date('2026-10-28T12:00:00Z');
  touchParticipantSession(meeting.participants[0], 'host-a', now);
  touchParticipantSession(meeting.participants[0], 'host-b', now);
  leaveParticipantSession(meeting.participants[0], 'host-a', now);
  expect(isHostPresent(meeting, now)).toBe(true);
  expect(meeting.participants[0].leftAt).toBeUndefined();
});

it('expires abandoned sessions and pauses the accumulated clock', () => {
  const meeting = makeMeeting();
  const started = new Date('2026-10-28T12:00:00Z');
  touchParticipantSession(meeting.participants[0], 'host-a', started);
  touchParticipantSession(meeting.participants[1], 'person-a', started);
  reconcileMeetingTimer(meeting, started);
  const later = new Date('2026-10-28T12:02:00Z');
  expect(reconcileMeetingTimer(meeting, later).running).toBe(false);
  expect(meeting.timerElapsedMs).toBe(120_000);
  expect(meeting.participants.every((person: any) => person.leftAt instanceof Date)).toBe(true);
});

const sweepTime = new Date('2026-10-30T18:00:00Z');
const oldRoom = () => ({ ...makeMeeting(), status: 'live', participants: [], createdAt: new Date('2026-10-30T16:00:00Z') });
it('expires empty rooms after grace, preserving brief disconnects', () => {
  const meeting = oldRoom();
  meeting.participants = [{ crmUserId: 'host', leftAt: new Date(sweepTime.getTime() - 299_999), sessions: [] }] as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
  meeting.participants[0].leftAt = new Date(sweepTime.getTime() - 300_000);
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('empty');
});
it('keeps host-only rooms open while the host is present', () => {
  const meeting = oldRoom();
  meeting.participants = [{ crmUserId: 'host', sessions: [{ attendeeId: 'a', lastSeenAt: sweepTime }] }] as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
});
it('expires host-away rooms even when another attendee remains', () => {
  const meeting = oldRoom();
  meeting.participants = [
    { crmUserId: 'host', leftAt: new Date(sweepTime.getTime() - 900_000), sessions: [] },
    { crmUserId: 'person', sessions: [{ attendeeId: 'a', lastSeenAt: sweepTime }] },
  ] as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('host-away');
  touchParticipantSession(meeting.participants[0], 'returned', sweepTime);
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
});
it('cleans legacy abandoned rooms and never-started instant rooms without touching dated schedules', () => {
  const meeting = oldRoom();
  meeting.participants = [{ crmUserId: 'host', joinedAt: meeting.createdAt }] as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('empty');
  meeting.status = 'scheduled';
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('never-started');
  meeting.scheduledAt = new Date('2026-10-30T20:00:00Z');
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
});

it('holds an unoccupied due scheduled room for an hour, then records a no-show', () => {
  const meeting = { ...oldRoom(), scheduledAt: new Date(sweepTime.getTime() - 3_599_999) };
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
  meeting.scheduledAt = new Date(sweepTime.getTime() - 3_600_000);
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('no-show');
});
it('keeps a scheduled call running with two attendees even while the host is away', () => {
  const meeting = { ...oldRoom(), scheduledAt: new Date(sweepTime.getTime() - 7_200_000), participants: [
    { crmUserId: 'a', sessions: [{ attendeeId: 'a1', lastSeenAt: sweepTime }] },
    { crmUserId: 'b', sessions: [{ attendeeId: 'b1', lastSeenAt: sweepTime }] },
  ] } as any;
  expect(reconcileMeetingTimer(meeting, sweepTime).running).toBe(true);
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
});
it('a scheduled call that people attended still closes after everyone leaves', () => {
  const meeting = { ...oldRoom(), scheduledAt: new Date(sweepTime.getTime() - 600_000), participants: [
    { crmUserId: 'a', joinedAt: new Date(sweepTime.getTime() - 600_000), leftAt: new Date(sweepTime.getTime() - 300_000), sessions: [] },
  ] } as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBe('empty');
});

it('preserves a future scheduled session after an early host visit and departure', () => {
  const meeting = { ...oldRoom(), scheduledAt: new Date(sweepTime.getTime() + 3_600_000), participants: [
    { crmUserId: 'host', joinedAt: new Date(sweepTime.getTime() - 1_800_000), leftAt: new Date(sweepTime.getTime() - 900_000), sessions: [] },
  ] } as any;
  expect(abandonedMeetingReason(meeting, sweepTime)).toBeNull();
});
