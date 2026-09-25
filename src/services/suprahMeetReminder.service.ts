import Meeting from '../models/Meeting.model';
import CrmUser from '../models/CrmUser.model';

/**
 * 10-minute meeting reminders. Runs every 60s; marks each meeting so a
 * reminder fires once. In-app alert toasts come from GET /api/crm/meet/alerts
 * regardless — this service additionally pushes through your existing CRM
 * push service if its API matches; adjust the guarded call below to the real
 * method signature in services/crmPush.service.ts.
 */
export function initSuprahMeetReminders() {
  setInterval(() => { void tick(); }, 60_000);
  console.log('[SuprahMeet] reminder scheduler started');
}

async function tick() {
  try {
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
      const body = `"${meeting.title}" starts in ${mins} min — code ${meeting.code}`;
      const url = `/crm/suprah-meet/room/${meeting.code}`;

      // Best-effort web push via your existing CRM push service. If the
      // method name differs, change it here — everything else still works
      // (in-app toasts from /alerts don't depend on this).
      try {
        const mod: any = await import('./crmPush.service');
        const push = mod?.default ?? mod;
        for (const userId of targets) {
          if (typeof push?.sendToUser === 'function') {
            await push.sendToUser(userId, { title, body, url, tag: `meet-${meeting.code}` });
          } else if (typeof push?.sendToCrmUser === 'function') {
            await push.sendToCrmUser(userId, { title, body, url, tag: `meet-${meeting.code}` });
          }
        }
      } catch {
        /* push service unavailable — in-app alerts still cover it */
      }
    }
  } catch (err) {
    console.error('[SuprahMeet] reminder tick failed:', err);
  }
}