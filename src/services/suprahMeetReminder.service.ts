import Meeting from '../models/Meeting.model';
import { closeAbandonedMeeting, openScheduledMeeting, reconcilePersistedPresence } from './suprahMeetLifecycle.service';

import { randomUUID } from 'crypto';
import {
  MEET_REMINDER_WINDOW_MS, notifyMeetingCreated, notifyMeetingLive, notifyMeetingReminder,
} from './suprahMeetNotification.service';
import logger from '../utils/logger';
import { MEET_HOST_AWAY_GRACE_MS } from './suprahMeetPresence.service';


let timer: NodeJS.Timeout | null = null;
let running = false;
let opening = false;

export function initSuprahMeetReminders() {
  if (timer) return;
  // The one-second opening worker is separate from slower reminders/presence work.
  const openingTimer = setInterval(() => {
    if (opening) return;
    opening = true;
    void openDueMeetings().catch((err) => logger.error({ err }, '[SuprahMeet] scheduled opening failed'))
      .finally(() => { opening = false; });
  }, 1000);
  openingTimer.unref();
  void openDueMeetings().catch((err) => logger.error({ err }, '[SuprahMeet] scheduled opening failed'));
  timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref();
  void tick();
  console.log('[SuprahMeet] scheduler started (ten-minute reminders)');
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await reconcileSuprahMeetPresence().catch((err) => logger.error({ err }, '[SuprahMeet] presence sweep failed'));
    await sendSuprahMeetNotifications().catch((err) => logger.error({ err }, '[SuprahMeet] reminder tick failed'));
  } finally {
    running = false;
  }
}

/** Expire browser/device leases even when every meeting tab disappeared. */
export async function reconcileSuprahMeetPresence(now = new Date()) {
  let afterId: string | undefined;
  for (;;) {
    const meetings = await Meeting.find({
      ...(afterId ? { _id: { $gt: afterId } } : {}),
      $or: [
        { status: 'live' },
        { status: 'scheduled', scheduledAt: null, createdAt: { $lte: new Date(now.getTime() - MEET_HOST_AWAY_GRACE_MS) } },
      ],
    }).sort({ _id: 1 }).limit(100);
    for (const meeting of meetings) {
      try {
        const current = await closeAbandonedMeeting(meeting, now);
        if (current !== meeting || current.status === 'ended') continue;
        const reconciled = await reconcilePersistedPresence(meeting, now);
        if (reconciled.status === 'live' && reconciled.liveNotificationPending) {
          await notifyMeetingLive(reconciled).catch((err) =>
            logger.error({ err, meetingId: meeting._id }, '[SuprahMeet] live notification pending retry'));
        }
      } catch (err) {
        logger.error({ err, meetingId: meeting._id }, '[SuprahMeet] presence reconciliation failed');
      }
    }
    if (meetings.length < 100) break;
    afterId = String(meetings[meetings.length - 1]._id);
  }
}

/** Open due rooms independently of the host; each row is claimed across workers. */
export async function openDueMeetings(now = new Date()) {
  const due = await Meeting.find({ status: 'scheduled', scheduledAt: { $lte: now, $ne: null } })
    .sort({ scheduledAt: 1 }).limit(100);
  for (const meeting of due) {
    try {
      const opened = await openScheduledMeeting(meeting, now);
      await closeAbandonedMeeting(opened, now);
    } catch (err) {
      logger.error({ err, meetingId: meeting._id }, '[SuprahMeet] scheduled room reconciliation failed');
    }
  }
}

/** Exported for focused tests; importing this module never starts the scheduler. */
export async function sendSuprahMeetNotifications(now = new Date()) {
  // Recover creation notifications after a partial failure or API restart.
  // Only newly created meetings explicitly opt into this queue.
  const pending = await Meeting.find({
    invitationNotificationPending: true,
    status: { $in: ['scheduled', 'live'] },
  }).sort({ updatedAt: 1 }).limit(20);
  for (const meeting of pending) {
    await notifyMeetingCreated(meeting).catch(async (err) => {
      // Rotate failed/no-subscription jobs behind other pending invitations.
      // Their immutable per-notification expiry still bounds the retry window.
      await Meeting.updateOne({ _id: meeting._id, organizationId: meeting.organizationId },
        { $set: { updatedAt: now } });
      logger.error({ err, meetingId: meeting._id }, '[SuprahMeet] Invitation retry failed');
    });
  }

  const due = await Meeting.find({
    status: { $in: ['scheduled', 'live'] },
    reminderSentAt: null,
    scheduledAt: { $gte: now, $lte: new Date(now.getTime() + MEET_REMINDER_WINDOW_MS) },
    $or: [{ reminderClaimUntil: null }, { reminderClaimUntil: { $lte: now } }],
  }).sort({ scheduledAt: 1 }).limit(50);

  for (const meeting of due) {
    const claimToken = randomUUID();
    // Lease across server instances; an interrupted worker can be retried.
    const claimed = await Meeting.findOneAndUpdate({
      _id: meeting._id, organizationId: meeting.organizationId,
      status: { $in: ['scheduled', 'live'] },
      scheduledAt: meeting.scheduledAt, reminderSentAt: null,
      $or: [{ reminderClaimUntil: null }, { reminderClaimUntil: { $lte: now } }],
    }, { $set: {
      reminderClaimToken: claimToken,
      reminderClaimUntil: new Date(now.getTime() + 2 * 60_000),
    } }, { new: true });
    if (!claimed) continue;

    const ownedClaim = {
      _id: claimed._id, organizationId: claimed.organizationId,
      scheduledAt: claimed.scheduledAt, reminderClaimToken: claimToken,
    };
    try {
      await notifyMeetingReminder(claimed, now);
      await Meeting.updateOne(ownedClaim, { $set: {
        reminderSentAt: new Date(), reminderClaimToken: null, reminderClaimUntil: null,
      } });
    } catch (err) {
      await Meeting.updateOne(ownedClaim, { $set: {
        reminderClaimToken: null, reminderClaimUntil: null,
      } });
      logger.error({ err, meetingId: claimed._id }, '[SuprahMeet] Reminder pending retry');
    }
  }
}
