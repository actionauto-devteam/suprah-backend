import cron from 'node-cron';
import logger from '../utils/logger';
import EmployeeLocation from '../models/EmployeeLocation.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import { fireShiftAlert } from '../services/shiftAlerts.service';

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

  // Only rows that look like they're still mid-shift (sharingState hasn't
  // already been demoted to off_duty/paused by a read-time self-heal
  // elsewhere) and gone quiet past the threshold.
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
    sharingState: 'sharing',
    lastSeenAt: { $lt: cutoff },
    connectionLostNotifiedAt: null,
  }).lean();

  let notified = 0;

  for (const loc of candidates) {
    // Calling .findById() through a variable holding a union of the two
    // Model types doesn't type-check (their overload sets aren't
    // compatible with each other) — branch and call each concretely instead.
    const userDoc = (
      loc.userModel === 'User'
        ? await User.findById(loc.userId).select('locationConsent fullName organizationId').lean()
        : await CrmUser.findById(loc.userId).select('locationConsent fullName organizationId').lean()
    ) as any;
    if (!userDoc) continue;

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

    await EmployeeLocation.updateOne({ _id: loc._id }, { connectionLostNotifiedAt: new Date() });
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
