import Meeting from '../models/Meeting.model';
import { deleteChimeMeeting, stopRecordingPipelines } from './suprahMeetAws.service';

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
  console.log('[SuprahMeet] scheduler started (ten-minute reminders + auto-end sweep)');
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await sendSuprahMeetNotifications().catch((err) => logger.error({ err }, '[SuprahMeet] reminder tick failed'));
    await autoEndTick().catch((err) => logger.error({ err }, '[SuprahMeet] auto-end tick failed'));
  } finally {
    running = false;
  }
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
// Rules (all must hold):
//  - status is "live" and it started at least 5 minutes ago
//  - every participant has a leftAt (nobody is in the room)
//  - the last person left more than 10 minutes ago (grace for refresh/rejoin,
//    since a page refresh briefly looks like "everyone left")
const ABANDON_GRACE_MS = 10 * 60_000;

async function autoEndTick() {
  const now = Date.now();
  const candidates = await Meeting.find({
    status: 'live',
    startedAt: { $lte: new Date(now - 5 * 60_000) },
  }).limit(50);

  for (const meeting of candidates) {
    const people = meeting.participants ?? [];
    if (people.length === 0) {
      // Live for 5+ minutes yet nobody ever joined (crashed before join completed).
      if ((meeting.startedAt?.getTime() ?? 0) > now - ABANDON_GRACE_MS) continue;
    } else {
      const somebodyPresent = people.some((p) => !p.leftAt);
      if (somebodyPresent) continue;
      const lastLeft = Math.max(...people.map((p) => p.leftAt?.getTime() ?? 0));
      if (lastLeft > now - ABANDON_GRACE_MS) continue; // still inside the grace window
    }

    // Close it out exactly like endMeeting does.
    if (meeting.recording.status === 'recording' && meeting.recording.capturePipelineId) {
      try {
        await stopRecordingPipelines(meeting.recording.capturePipelineId);
        meeting.recording.status = 'processing';
        meeting.recording.stoppedAt = new Date();
      } catch (err: any) {
        meeting.recording.status = 'failed';
        meeting.recording.error = err?.message || 'Failed to stop recording (auto-end)';
      }
    }
    if (meeting.chimeMeetingId) await deleteChimeMeeting(meeting.chimeMeetingId).catch(() => {});

    const lastLeft = people.length
      ? Math.max(...people.map((p) => p.leftAt?.getTime() ?? 0))
      : now;
    meeting.status = 'ended';
    meeting.endedAt = new Date(lastLeft || now);
    await meeting.save();
    console.log(`[SuprahMeet] auto-ended abandoned meeting ${meeting.code}`);
  }
}
