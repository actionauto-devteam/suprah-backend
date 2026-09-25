import Meeting from '../models/Meeting.model';
import CrmUser from '../models/CrmUser.model';
import { deleteChimeMeeting, stopRecordingPipelines } from './suprahMeetAws.service';

/**
 * Suprah Meet background scheduler — runs every 60s:
 *  1. 10-minute meeting reminders (fires once per session).
 *  2. Auto-end sweep: a meeting that is "live" but abandoned (everyone left
 *     and nobody pressed End) is closed out so "Happening now" stays truthful.
 */
export function initSuprahMeetReminders() {
  setInterval(() => { void tick(); }, 60_000);
  console.log('[SuprahMeet] scheduler started (reminders + auto-end sweep)');
}

async function tick() {
  await remindTick().catch((err) => console.error('[SuprahMeet] reminder tick failed:', err?.message));
  await autoEndTick().catch((err) => console.error('[SuprahMeet] auto-end tick failed:', err?.message));
}

/* ── 1. Reminders ─────────────────────────────────────────────────────── */
async function remindTick() {
  const now = Date.now();
  const due = await Meeting.find({
    status: 'scheduled',
    reminderSentAt: null,
    scheduledAt: { $gte: new Date(now), $lte: new Date(now + 10 * 60_000) },
  }).limit(20);

  for (const meeting of due) {
    meeting.reminderSentAt = new Date();
    await meeting.save();

    const targets = meeting.inviteAll
      ? (await CrmUser.find({
          organizationId: meeting.organizationId, isActive: true, isSystem: { $ne: true },
        }).select('_id').lean()).map((u) => u._id.toString())
      : meeting.invitees.map((id) => id.toString());
    if (!targets.includes(meeting.hostCrmUserId.toString())) {
      targets.push(meeting.hostCrmUserId.toString());
    }

    const mins = Math.max(1, Math.round(((meeting.scheduledAt?.getTime() ?? now) - now) / 60_000));
    const title = '📅 Suprah Meet reminder';
    const body = `"${meeting.title}" starts in ${mins} minute${mins === 1 ? '' : 's'} — code ${meeting.code}`;

    // In-app alert toasts come from GET /api/crm/meet/alerts regardless.
    // If your crmPush.service exposes a push method, wire it here:
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const push = require('./crmPush.service');
      if (typeof push?.sendToUsers === 'function') {
        await push.sendToUsers(targets, { title, body, url: `/crm/suprah-meet/room/${meeting.code}` });
      }
    } catch { /* push service optional */ }

    console.log(`[SuprahMeet] reminder sent for ${meeting.code} (${targets.length} users)`);
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
