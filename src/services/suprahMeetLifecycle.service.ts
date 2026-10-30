import Meeting, { IMeeting } from '../models/Meeting.model';
import { deleteChimeMeeting, stopRecordingPipelines } from './suprahMeetAws.service';
import { notifyMeetingLive } from './suprahMeetNotification.service';
import { abandonedMeetingReason, clearParticipantSessions, hasScheduledMeetingOpened, reconcileMeetingTimer, stopMeetingTimer } from './suprahMeetPresence.service';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';

async function reloadMeeting(meeting: IMeeting): Promise<IMeeting> {
  const fresh = await Meeting.findById(meeting._id);
  if (!fresh || String(fresh.organizationId) !== String(meeting.organizationId)) throw new ApiError(404, 'Meeting no longer exists.');
  return fresh;
}

/** Atomic opening is shared by the worker and every signed-in/guest entry path. */
export async function openScheduledMeeting(meeting: IMeeting, now = new Date()): Promise<IMeeting> {
  if (meeting.status !== 'scheduled' || !hasScheduledMeetingOpened(meeting, now)) return meeting;
  const opened = await Meeting.findOneAndUpdate({
    _id: meeting._id, organizationId: meeting.organizationId,
    status: 'scheduled', scheduledAt: meeting.scheduledAt,
  }, { $set: { status: 'live', openedAt: meeting.scheduledAt, liveNotificationPending: true } }, { new: true });
  if (!opened) return reloadMeeting(meeting);
  // Historical missed sessions are closed as no-shows without broadcasting "live now".
  if (!abandonedMeetingReason(opened, now)) void notifyMeetingLive(opened).catch((err) =>
    logger.error({ err, meetingId: opened._id }, '[SuprahMeet] scheduled live notification pending retry'));
  return opened;
}

/** Close without overwriting a concurrent heartbeat, edit, or rejoin. */
export async function closeAbandonedMeeting(meeting: IMeeting, now = new Date()): Promise<IMeeting> {
  // Decide before pruning: expired lease timestamps are the inactivity evidence.
  const reason = abandonedMeetingReason(meeting, now);
  if (reason) {
    stopMeetingTimer(meeting, now);
    meeting.participants.forEach((person) => clearParticipantSessions(person, now));
    // A heartbeat/rejoin/edit since the read cancels this sweep's end attempt.
    const ended = await Meeting.findOneAndUpdate({
      _id: meeting._id, organizationId: meeting.organizationId,
      status: meeting.status, updatedAt: meeting.updatedAt,
    }, { $set: {
      status: 'ended', endedAt: now, endedReason: reason, participants: meeting.participants,
      timerElapsedMs: meeting.timerElapsedMs, timerActiveSince: null,
      liveNotificationPending: false, invitationNotificationPending: false,
      captionsEnabled: false, captionStartClaimUntil: null,
    } }, { new: true });
    if (!ended) return reloadMeeting(meeting);
    if (ended.recording?.status === 'recording' && ended.recording.capturePipelineId) {
      try {
        await stopRecordingPipelines(ended.recording.capturePipelineId);
        await Meeting.updateOne({ _id: ended._id, status: 'ended' }, { $set: {
          'recording.status': 'processing', 'recording.stoppedAt': now,
        } });
      } catch (err) {
        logger.error({ err, meetingId: ended._id }, '[SuprahMeet] abandoned recording stop failed');
        await Meeting.updateOne({ _id: ended._id, status: 'ended' }, { $set: {
          'recording.status': 'failed', 'recording.error': 'Failed to stop abandoned recording',
        } });
      }
    }
    if (ended.chimeMeetingId) await deleteChimeMeeting(ended.chimeMeetingId).catch((err) =>
      logger.error({ err, meetingId: ended._id }, '[SuprahMeet] abandoned Chime cleanup failed'));
    return ended;
  }
  return meeting;
}

/** A stale sweep/read must not replace a newer device heartbeat or attendee list. */
export async function reconcilePersistedPresence(meeting: IMeeting, now = new Date()): Promise<IMeeting> {
  if (meeting.status !== 'live') return meeting;
  reconcileMeetingTimer(meeting, now);
  if (typeof meeting.isModified !== 'function' || !meeting.isModified()) return meeting;
  const updated = await Meeting.findOneAndUpdate({
    _id: meeting._id, organizationId: meeting.organizationId, status: 'live', updatedAt: meeting.updatedAt,
  }, { $set: {
    participants: meeting.participants, timerElapsedMs: meeting.timerElapsedMs,
    timerActiveSince: meeting.timerActiveSince ?? null, startedAt: meeting.startedAt ?? null,
  } }, { new: true });
  if (updated) return updated;
  return reloadMeeting(meeting);
}
