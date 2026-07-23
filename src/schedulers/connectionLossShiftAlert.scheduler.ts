import cron from 'node-cron';
import logger from '../utils/logger';
import EmployeeLocation from '../models/EmployeeLocation.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import { fireShiftAlert } from '../services/shiftAlerts.service';
import { isLocationRequiredForTimeproof } from '../config/departmentMonitoring';

/**
 * The existing Lot-Tech-only offline check in locator.controller.ts's
 * ingestLocation is reactive — it only compares gaps when a NEW ping
 * arrives, so a connection that goes silent and never recovers (dead phone,
 * no signal for the rest of the shift) never trips it: there's no next ping
 * to trigger the comparison. This scheduler is the proactive counterpart,
 * covering every department, not just Lot Tech.
 *
 * Same threshold as the existing SHARING_STALE_MS / LOT_TECH_OFFLINE_THRESHOLD_MS
 * conventions in locator.controller.ts, kept independent here (rather than
 * imported) since that file's constant isn't exported and the two checks are
 * allowed to drift apart later without coupling them.
 */
const CONNECTION_LOST_THRESHOLD_MS = 10 * 60 * 1000;

export async function runConnectionLossShiftAlertCheck(): Promise<{ notified: number; checked: number }> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - CONNECTION_LOST_THRESHOLD_MS);

  // Deliberately includes BOTH 'sharing' and 'off_duty' rows — not just
  // 'sharing'. Reason: getActiveEmployeeLocations (locator.controller.ts)
  // self-heals any 'sharing' row that's gone stale past SHARING_STALE_MS
  // (10 min, same threshold as ours) by flipping it to 'off_duty' — and it
  // runs on every Team Pulse map poll, every 15 seconds. An admin with that
  // map open would almost always see the row get demoted to 'off_duty'
  // *before* our 5-minute cron tick got a chance to see it as 'sharing',
  // silently starving this alert of the exact rows it exists to catch.
  // Explicitly excluded: 'paused_manual' and 'paused_break' — those are
  // deliberate, known-reason pauses (see useLocationSharing.ts's
  // pauseManually/break handling), not a lost connection, and must never be
  // reinterpreted as one just because they also go stale.
  //
  // 'off_duty' also legitimately means "shift really ended" (stopSharing) —
  // that's why this alone isn't enough; the isOnShift/isOnBreak check below
  // (TimeLog-based, independent of sharingState) is what actually separates
  // "still on shift, just demoted by the race above" from "shift over".
  //
  // connectionLostNotifiedAt fires this alert AT MOST ONCE PER SHIFT, not
  // once per outage — it's only cleared back to null at the next time-in
  // (see crm.controller.ts / generalTimeclock.controller.ts). A device with
  // a flaky connection can drop and briefly reconnect dozens of times in one
  // shift; comparing against lastSeenAt (which every blip advances) would
  // re-arm the alert on each tiny reconnect and spam the channel all day for
  // what's really the same ongoing problem — so once notified, stay quiet
  // until the next shift starts.
  const candidates = await EmployeeLocation.find({
    sharingState: { $in: ['sharing', 'off_duty'] },
    lastSeenAt: { $lt: cutoff },
    connectionLostNotifiedAt: null,
  }).lean();

  let notified = 0;

  for (const loc of candidates) {
    // Atomically claim this candidate BEFORE doing any lookups or firing the
    // alert — the filter requires connectionLostNotifiedAt to still be null,
    // so if another concurrent run (overlapping tick, or a second server
    // process/instance) already claimed it between our find() above and now,
    // this returns null and we skip. Without this, two processes reading
    // the same "unclaimed" candidate and only writing back at the END (after
    // firing) could both fire — exactly what produced the duplicate message.
    const claimed = await EmployeeLocation.findOneAndUpdate(
      { _id: loc._id, connectionLostNotifiedAt: null },
      { connectionLostNotifiedAt: new Date() },
    );
    if (!claimed) continue;

    // Calling .findById() through a variable holding a union of the two
    // Model types doesn't type-check (their overload sets aren't
    // compatible with each other) — branch and call each concretely instead.
    const userDoc = (
      loc.userModel === 'User'
        ? await User.findById(loc.userId).select('locationConsent fullName organizationId department').lean()
        : await CrmUser.findById(loc.userId).select('locationConsent fullName organizationId department').lean()
    ) as any;
    if (!userDoc) continue;

    // Per-department kill switch for the whole feature (Settings → Departments
    // → "Require Location for TimeProof").
    if (!(await isLocationRequiredForTimeproof((loc.organizationId as any)?.toString(), userDoc.department))) continue;

    // Consent still granted (i.e. they never explicitly turned it off —
    // that path is handled immediately by locator.controller.ts's
    // handleLocationTurnedOff, not here) is what makes this a "went silent"
    // case rather than a deliberate toggle-off.
    if (!userDoc.locationConsent?.granted) continue;

    const { isOnShift, isOnBreak } = await getShiftStatusForActor(loc.userId);
    if (!isOnShift || isOnBreak) continue; // exempt while on break, and irrelevant once shift has ended

    const name = userDoc.fullName || loc.userName || 'A team member';
    const silentMin = Math.round((nowMs - new Date(loc.lastSeenAt).getTime()) / 60000);

    await fireShiftAlert({
      organizationId: (loc.organizationId as any).toString(),
      targetUserId: loc.userId.toString(),
      targetUserModel: loc.userModel as 'CrmUser' | 'User',
      chatMessage: `🟠 ${name}'s location stopped updating ~${silentMin} min ago while on shift — likely lost connection.`,
      notifyTitle: '📡 Connection Lost',
      notifyBody: `${name}'s location stopped updating — they may have lost internet connection.`,
      notifyTag: `shift-alert-connection-lost-${loc.userId}`,
      url: `/crm/timeproof/users/${loc.userId}`,
    });

    notified++;
  }

  return { notified, checked: candidates.length };
}

export const initConnectionLossShiftAlertScheduler = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { notified } = await runConnectionLossShiftAlertCheck();
      if (notified > 0) logger.info(`[connection-lost-alert] Notified ${notified} silent connection(s)`);
    } catch (error) {
      logger.error({ error }, 'Connection-loss Shift Alert scheduler error');
    }
  });

  logger.info('✓ Connection-loss Shift Alert scheduler initialized - Runs every 5 minutes');
};
