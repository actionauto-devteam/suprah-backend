import {
  isHostPresent, leaveParticipantSession, reconcileMeetingTimer,
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
