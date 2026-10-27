import Meeting, { IMeeting } from '../models/Meeting.model';
import CrmUser from '../models/CrmUser.model';
import notificationService from './notification.service';

export const MEET_REMINDER_WINDOW_MS = 10 * 60_000;

type MeetingNotice = Pick<IMeeting,
  '_id' | 'organizationId' | 'hostCrmUserId' | 'invitees' | 'inviteAll' |
  'title' | 'code' | 'scheduledAt'>;

/** Resolve only active people in this organization, including department-expanded invitees. */
async function recipients(meeting: MeetingNotice, includeHost: boolean) {
  const hostId = String(meeting.hostCrmUserId);
  const ids = [...new Set([
    ...meeting.invitees.map(String),
    ...(includeHost ? [hostId] : []),
  ])];
  const users = await CrmUser.find({
    organizationId: meeting.organizationId,
    isActive: true,
    isSystem: { $ne: true },
    ...(meeting.inviteAll ? {} : { _id: { $in: ids } }),
  }).select('_id').lean();
  return [...new Set(users.map((user) => String(user._id)))]
    .filter((id) => includeHost || id !== hostId);
}

async function send(meeting: MeetingNotice, kind: 'invitation' | 'reminder' | 'live', now: Date) {
  const host = await CrmUser.findOne({
    _id: meeting.hostCrmUserId, organizationId: meeting.organizationId,
  }).select('fullName').lean();
  const firstName = host?.fullName?.trim().split(/\s+/)[0] || 'Your host';
  const time = meeting.scheduledAt
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }).format(meeting.scheduledAt)
    : null;
  const isReminder = kind === 'reminder';
  const isLive = kind === 'live';
  const minutes = Math.max(1, Math.ceil(((meeting.scheduledAt?.getTime() ?? now.getTime()) - now.getTime()) / 60_000));
  const message = isLive
    ? `"${meeting.title}" is happening now. You're invited — open Suprah Meet to check your camera and microphone, then join.`
    : isReminder
    ? `${firstName}'s meeting "${meeting.title}" starts in ${minutes} minute${minutes === 1 ? '' : 's'}${time ? ` (${time})` : ''}. You're invited — join the meeting now.`
    : `${firstName} created "${meeting.title}"${time ? ` for ${time}` : ' and it is live now'}. You're invited${time ? ' — find it in Upcoming in Suprah Meet' : ' — join the meeting now'}.`;
  const type = isLive ? 'suprah_meet_live' : isReminder ? 'suprah_meet_reminder' : 'suprah_meet_invited';
  // One persisted notification per recipient/session/stage. A reschedule has
  // a new reminder key; retrying a partially delivered batch reuses existing rows.
  const eventKey = `meet:${String(meeting._id)}:${kind}${isReminder ? `:${meeting.scheduledAt?.toISOString()}` : ''}`;
  const targets = await recipients(meeting, isReminder);
  // Bounded batches keep an invite-all meeting from opening hundreds of writes at once.
  for (let i = 0; i < targets.length; i += 10) {
    const results = await Promise.allSettled(targets.slice(i, i + 10).map((userId) =>
      notificationService.createNotification({
        userId, organizationId: String(meeting.organizationId), type,
        title: isLive ? 'Suprah Meet is live now' : isReminder ? 'Suprah Meet starts soon' : `${firstName} invited you to a meeting`,
        message,
        idempotencyKey: eventKey,
        metadata: {
          meetingId: String(meeting._id), meetingCode: meeting.code,
          scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
          hostCrmUserId: String(meeting.hostCrmUserId),
          route: `/crm/suprah-meet/room/${encodeURIComponent(meeting.code)}`,
          pushSource: 'Suprah Meet', pushTag: eventKey, pushTopic: eventKey,
        },
      }),
    ));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

/** Leave the durable pending flag set if any recipient could not be persisted. */
export async function notifyMeetingCreated(meeting: MeetingNotice): Promise<void> {
  await send(meeting, 'invitation', new Date());
  await Meeting.updateOne({ _id: meeting._id, organizationId: meeting.organizationId }, {
    $set: { invitationNotificationPending: false },
  });
}

export async function notifyMeetingReminder(meeting: MeetingNotice, now: Date): Promise<void> {
  await send(meeting, 'reminder', now);
}

/** Sent once per meeting when a scheduled session actually goes live. */
export async function notifyMeetingLive(meeting: MeetingNotice): Promise<void> {
  await send(meeting, 'live', new Date());
}
