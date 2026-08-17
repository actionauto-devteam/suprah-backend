import cron from 'node-cron';
import logger from '../utils/logger';
import EmployeeLocation from '../models/EmployeeLocation.model';
import TimeLog from '../models/TimeLog.model';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import { fireShiftAlert, postBatchedShiftAlertMessages } from '../services/shiftAlerts.service';
import { isMandatoryLocationDept } from '../constants/departments';

// Mandatory-location depts (Lot Tech) only — other depts keep the lighter-touch single alert
// in connectionLossShiftAlert.scheduler.ts, since they're allowed to go silent.
const SILENCE_DETECT_MS = 2 * 60 * 1000; // ~4 missed pings at the 30s ping interval
const STAGE_2_MS = 5 * 60 * 1000;
const STAGE_3_MS = 10 * 60 * 1000;
const CLOCKOUT_MS = 15 * 60 * 1000;

export async function runLotTechLocationEscalation(): Promise<{ warned: number; clockedOut: number; checked: number }> {
  const now = new Date();
  const nowMs = now.getTime();

  // Deliberately does NOT filter out sharingState: 'off_duty'. — a mandatory-location employee
  // who's clocked in but never granted consent this session (e.g. was already on shift when
  // "Require Location" got turned on for their department) would otherwise sit in off_duty
  // forever, invisible to every candidate check below, with no warning and no auto-clockout
  // ever firing despite sharing nothing. The per-row isMandatoryLocationDept/isOnShift checks
  // further down already filter this down to genuinely relevant cases.
  const candidates = await EmployeeLocation.find({
    $or: [
      { sharingState: 'off_duty' },
      { lastSeenAt: { $lt: new Date(nowMs - SILENCE_DETECT_MS) } },
      { locationIssueDetectedAt: { $ne: null } },
    ],
  }).lean();

  let warned = 0;
  let clockedOut = 0;
  const chatMessagesByOrg = new Map<string, string[]>();

  for (const loc of candidates) {
    const orgId = (loc.organizationId as any)?.toString();
    if (!orgId) continue;
    if (!(await isMandatoryLocationDept(orgId, loc.department))) continue;

    const { isOnShift, isOnBreak } = await getShiftStatusForActor(loc.userId);
    if (!isOnShift || isOnBreak) continue;

    const lastTimeIn = await TimeLog.findOne({ userId: loc.userId, type: 'time-in' })
      .sort({ timestamp: -1 })
      .select('timestamp')
      .lean();
    const shiftStartedAt = lastTimeIn?.timestamp ? new Date(lastTimeIn.timestamp) : null;
    if (!shiftStartedAt) continue;

    let detectedAt = loc.locationIssueDetectedAt ? new Date(loc.locationIssueDetectedAt) : null;
    let stage = loc.locationWarningStage || 0;
    // Leftover episode from a previous shift — don't trust it, re-evaluate fresh below.
    if (detectedAt && detectedAt.getTime() < shiftStartedAt.getTime()) {
      detectedAt = null;
      stage = 0;
    }

    const name = loc.userName || 'A team member';
    const userModel = loc.userModel as 'CrmUser' | 'User';
    // off_duty counts as silent by definition — this is what catches "never started sharing"
    // (see the query comment above), not just "started, then went quiet."
    const isCurrentlySilent = loc.sharingState === 'off_duty' || nowMs - new Date(loc.lastSeenAt).getTime() >= SILENCE_DETECT_MS;
    const isDenied = loc.sharingState === 'declined_permission';

    if (!detectedAt) {
      if (!isCurrentlySilent && !isDenied) continue; // nothing wrong, no episode to track
      // Fresh passive detection — the declined_permission path already sets these fields
      // instantly via reportPermissionDenied, so this only fires for silence the client
      // never explicitly reported.
      const chatMessage = `📡 ${name}'s location stopped updating while clocked in — Lot Tech policy escalation started.`;
      await fireShiftAlert({
        organizationId: orgId,
        targetUserId: loc.userId.toString(),
        targetUserModel: userModel,
        chatMessage,
        notifyTitle: '📡 Location Signal Lost',
        notifyBody: 'Your location stopped updating while clocked in — please check your connection and turn location back on.',
        adminNotifyBody: `${name}'s location stopped updating while clocked in.`,
        notifyTag: `shift-alert-location-silent-${loc.userId}`,
        url: `/crm/timeproof/users/${loc.userId}`,
        skipChatMessage: true,
      });
      if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
      chatMessagesByOrg.get(orgId)!.push(chatMessage);
      warned++;
      await EmployeeLocation.updateOne({ _id: loc._id }, { locationIssueDetectedAt: now, locationWarningStage: 1 });
      continue;
    }

    const elapsedMs = nowMs - detectedAt.getTime();

    if (elapsedMs >= CLOCKOUT_MS) {
      await TimeLog.create({
        userId: loc.userId,
        userModel,
        type: 'time-out',
        timestamp: now,
        note: 'Auto clock-out — Lot Tech location access lost for 15+ minutes while on shift',
      });
      const chatMessage = `🔴 ${name} was auto-clocked-out — location access was off for 15+ minutes while on shift.`;
      await fireShiftAlert({
        organizationId: orgId,
        targetUserId: loc.userId.toString(),
        targetUserModel: userModel,
        chatMessage,
        notifyTitle: '🔴 Auto Clocked Out — Location Off',
        notifyBody: 'You were automatically clocked out because location access was off for 15+ minutes while on shift.',
        adminNotifyBody: `${name} was auto-clocked-out — location access was off for 15+ minutes while on shift.`,
        notifyTag: `shift-alert-location-clockout-${loc.userId}`,
        url: `/crm/timeproof/users/${loc.userId}`,
        skipChatMessage: true,
      });
      if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
      chatMessagesByOrg.get(orgId)!.push(chatMessage);
      await EmployeeLocation.updateOne({ _id: loc._id }, { locationIssueDetectedAt: null, locationWarningStage: 0 });
      clockedOut++;
      continue;
    }

    if (elapsedMs >= STAGE_3_MS && stage < 3) {
      const chatMessage = `⏳ ${name}'s location has been off for 10 minutes while on shift — will be auto-clocked-out in 5 minutes if not restored.`;
      await fireShiftAlert({
        organizationId: orgId,
        targetUserId: loc.userId.toString(),
        targetUserModel: userModel,
        chatMessage,
        notifyTitle: '⏳ Auto Clock-Out in 5 Minutes',
        notifyBody: 'Your location has been off for 10 minutes. You will be automatically clocked out in 5 minutes if location is not restored.',
        adminNotifyBody: `${name}'s location has been off for 10 minutes — will be auto-clocked-out in 5 minutes if not restored.`,
        notifyTag: `shift-alert-location-stage3-${loc.userId}`,
        url: `/crm/timeproof/users/${loc.userId}`,
        skipChatMessage: true,
      });
      if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
      chatMessagesByOrg.get(orgId)!.push(chatMessage);
      warned++;
      await EmployeeLocation.updateOne({ _id: loc._id }, { locationWarningStage: 3 });
    } else if (elapsedMs >= STAGE_2_MS && stage < 2) {
      const chatMessage = `⚠️ ${name}'s location has been off for 5 minutes while on shift — final warning before auto clock-out.`;
      await fireShiftAlert({
        organizationId: orgId,
        targetUserId: loc.userId.toString(),
        targetUserModel: userModel,
        chatMessage,
        notifyTitle: '⚠️ Last Chance — Turn Location Back On',
        notifyBody: 'Your location has been off for 5 minutes. Please turn it back on now to avoid being automatically clocked out.',
        adminNotifyBody: `${name}'s location has been off for 5 minutes — final warning before auto clock-out.`,
        notifyTag: `shift-alert-location-stage2-${loc.userId}`,
        url: `/crm/timeproof/users/${loc.userId}`,
        skipChatMessage: true,
      });
      if (!chatMessagesByOrg.has(orgId)) chatMessagesByOrg.set(orgId, []);
      chatMessagesByOrg.get(orgId)!.push(chatMessage);
      warned++;
      await EmployeeLocation.updateOne({ _id: loc._id }, { locationWarningStage: 2 });
    }
  }

  await Promise.allSettled(
    Array.from(chatMessagesByOrg.entries()).map(([orgId, messages]) =>
      postBatchedShiftAlertMessages(orgId, messages),
    ),
  );

  return { warned, clockedOut, checked: candidates.length };
}

export const initLotTechLocationEscalationScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const { warned, clockedOut } = await runLotTechLocationEscalation();
      if (warned > 0 || clockedOut > 0) {
        logger.info(`[lot-tech-location-escalation] Warned ${warned}, clocked out ${clockedOut}`);
      }
    } catch (error) {
      logger.error({ error }, 'Lot Tech location escalation scheduler error');
    }
  });

  logger.info('✓ Lot Tech location escalation scheduler initialized - Runs every 1 minute');
};
