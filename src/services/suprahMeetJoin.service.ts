import Meeting, { IMeeting } from '../models/Meeting.model';
import { ApiError } from '../utils/ApiError';
import { reconcileMeetingTimer } from './suprahMeetPresence.service';
import { randomInt } from 'crypto';

/** Merge a newly issued attendee into the current room, not an old read. */
export async function persistMeetingJoin(
  source: IMeeting,
  chime: { meetingId: string; mediaRegion?: string; previousMeetingId?: string },
  apply: (current: IMeeting) => void,
): Promise<{ meeting: IMeeting; openedNow: boolean }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await Meeting.findById(source._id);
    if (!current || String(current.organizationId) !== String(source.organizationId)) throw new ApiError(404, 'This meeting no longer exists.');
    if (current.status === 'ended') throw new ApiError(410, 'This meeting ended while you were joining.');
    if (current.chimeMeetingId && current.chimeMeetingId !== chime.previousMeetingId && current.chimeMeetingId !== chime.meetingId) {
      throw new ApiError(409, 'This meeting reconnected while you were joining. Please rejoin.');
    }
    const previousStatus = current.status;
    const updatedAt = current.updatedAt;
    const version = current.get('__v') ?? null;
    const needsMedia = current.chimeMeetingId !== chime.meetingId;
    apply(current);
    reconcileMeetingTimer(current);
    const openedNow = previousStatus === 'scheduled' && current.status === 'live';
    const saved = await Meeting.findOneAndUpdate({
      _id: current._id, organizationId: current.organizationId,
      status: previousStatus, updatedAt, __v: version,
    }, { $set: {
      status: current.status, openedAt: current.openedAt,
      chimeMeetingId: chime.meetingId, mediaRegion: chime.mediaRegion,
      participants: current.participants, startedAt: current.startedAt ?? null,
      timerElapsedMs: current.timerElapsedMs, timerActiveSince: current.timerActiveSince ?? null,
      ...(openedNow ? { liveNotificationPending: true } : {}),
      ...(needsMedia ? { captionsEnabled: false, captionStartClaimUntil: null } : {}),
    }, $inc: { __v: 1 } }, { new: true });
    if (saved) return { meeting: saved, openedNow };
    await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1) + randomInt(0, 20)));
  }
  throw new ApiError(409, 'This meeting is changing. Please try joining again.');
}
