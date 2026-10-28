import Meeting from '../models/Meeting.model';

import { randomUUID } from 'crypto';
import {
  MEET_REMINDER_WINDOW_MS, notifyMeetingCreated, notifyMeetingReminder,
} from './suprahMeetNotification.service';
import logger from '../utils/logger';


let timer: NodeJS.Timeout | null = null;
let running = false;

export function initSuprahMeetReminders() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref();
  void tick();
  console.log('[SuprahMeet] scheduler started (ten-minute reminders)');
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await sendSuprahMeetNotifications().catch((err) => logger.error({ err }, '[SuprahMeet] reminder tick failed'));
  } finally {
    running = false;
  }
}

/** A deprecated compatibility export. The host is the only start authority. */
export async function openDueMeetings(now = new Date()) {
  // A scheduled time is a reminder, not authorization to open a room. Keep
  // this compatibility export inert for callers from older deployments.
  void now;
}

/** Exported for focused tests; importing this module never starts the scheduler. */
export async function sendSuprahMeetNotifications(now = new Date()) {
  // Recover creation notifications after a partial failure or API restart.
  // Only newly created meetings explicitly opt into this queue.
  const pending = await Meeting.find({
    invitationNotificationPending: true,
    status: { $in: ['scheduled', 'live'] },
  }).sort({ createdAt: 1 }).limit(20);
  for (const meeting of pending) {
    await notifyMeetingCreated(meeting).catch((err) =>
      logger.error({ err, meetingId: meeting._id }, '[SuprahMeet] Invitation retry failed'));
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

/* ── 2. Auto-end abandoned live meetings ──────────────────────────────── */
// Meetings are never auto-ended. Only the host's explicit end action may end
// a room, so the host can leave and return without losing the meeting.
