import cron from 'node-cron';
import logger from '../utils/logger';
import EmployeeLocation from '../models/EmployeeLocation.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';
import { isLocationRequiredForUser } from '../config/departmentMonitoring';
import { isMandatoryLocationDept } from '../constants/departments';

// Proactive offline check for all depts, independent of Lot Tech
const CONNECTION_LOST_THRESHOLD_MS = 10 * 60 * 1000;

export async function runConnectionLossShiftAlertCheck(): Promise<{ notified: number; checked: number }> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - CONNECTION_LOST_THRESHOLD_MS);

  // Include 'sharing' and 'off_duty' rows to catch stale connections; skip deliberate pauses
  const candidates = await EmployeeLocation.find({
    sharingState: { $in: ["sharing", "off_duty"] },
    lastSeenAt: { $lt: cutoff },
    connectionLostNotifiedAt: null,
  }).lean();

  let notified = 0;
  // Batch employee alerts per org to avoid spamming
  const chatMessagesByOrg = new Map<string, string[]>();

  for (const loc of candidates) {
    // Atomically claim candidate before lookups to prevent duplicate alerts
    const claimed = await EmployeeLocation.findOneAndUpdate(
      { _id: loc._id, connectionLostNotifiedAt: null },
      { connectionLostNotifiedAt: new Date() },
    );
    if (!claimed) continue;

    // Branch calls per Model type since .findById() overloads differ
    const userDoc = (
      loc.userModel === "User"
        ? await User.findById(loc.userId)
            .select(
              "locationConsent fullName organizationId department locationRequiredOverride",
            )
            .lean()
        : await CrmUser.findById(loc.userId)
            .select(
              "locationConsent fullName organizationId department locationRequiredOverride",
            )
            .lean()
    ) as any;
    if (!userDoc) continue;

    // Department-level kill switch (Require Location for TimeProof) with per-user override
    if (
      !(await isLocationRequiredForUser(
        (loc.organizationId as any)?.toString(),
        userDoc.department,
        userDoc.locationRequiredOverride,
      ))
    )
      continue;

    // Treat silence as lost connection only if consent still on
    if (!userDoc.locationConsent?.granted) continue;

    // Mandatory-location depts (Lot Tech) get faster detection + a real escalation with
    // consequence via lotTechLocationEscalation.scheduler.ts — skip here to avoid double alerts.
    if (await isMandatoryLocationDept((loc.organizationId as any)?.toString(), userDoc.department)) continue;

    const { isOnShift, isOnBreak } = await getShiftStatusForActor(loc.userId);
    if (!isOnShift || isOnBreak) continue; // exempt while on break, and irrelevant once shift has ended

    const name = userDoc.fullName || loc.userName || "A team member";
    const silentMin = Math.round(
      (nowMs - new Date(loc.lastSeenAt).getTime()) / 60000,
    );
    const orgId = (loc.organizationId as any).toString();
    const chatMessage = `🟠 ${name}'s location stopped updating ~${silentMin} min ago while on shift — likely lost connection.`;

    await fireShiftAlert({
      organizationId: orgId,
      targetUserId: loc.userId.toString(),
      targetUserModel: loc.userModel as "CrmUser" | "User",
      chatMessage,
      notifyTitle: "📡 Connection Lost",
      notifyBody: `Your location stopped updating — you may have lost internet connection.`,
      adminNotifyBody: `${name}'s location stopped updating — they may have lost internet connection.`,
      notifyTag: `shift-alert-connection-lost-${loc.userId}`,
      url: `/crm/timeproof/users/${loc.userId}`,
      skipChatMessage: true,
    });
    if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
    chatMessagesByOrg.get(orgId)!.push(chatMessage);

    notified++;
  }

  await Promise.allSettled(
    Array.from(chatMessagesByOrg.entries()).map(([orgId, messages]) =>
      postBatchedShiftAlertMessages(orgId, messages),
    ),
  );

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
