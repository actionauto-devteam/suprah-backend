import cron from 'node-cron';
import Appointment from '../models/Appointment.model';
import { sendNoShowFollowUpText } from '../services/communication.service';
import logger from '../utils/logger';
import { isWithinSendingHours } from '../utils/sendingWindow';

const CRON_SCHEDULE = process.env.NOSHOW_FOLLOWUP_CRON || '*/10 * * * *';
const DELAY_MINUTES = parseInt(process.env.NOSHOW_FOLLOWUP_DELAY_MINUTES || '30', 10);
const MAX_AGE_HOURS = parseInt(process.env.NOSHOW_FOLLOWUP_MAX_AGE_HOURS || '24', 10);
const MAX_APPOINTMENT_AGE_MS = 72 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

interface FollowUpStats {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

async function hasUpcomingAppointment(appointment: any, now: Date): Promise<boolean> {
  const customerFilter = appointment.leadId
    ? { leadId: appointment.leadId }
    : { 'customerBooking.phone': appointment.customerBooking.phone };

  const upcoming = await Appointment.exists({
    _id: { $ne: appointment._id },
    organizationId: appointment.organizationId,
    entryType: 'appointment',
    status: { $in: ['scheduled', 'confirmed'] },
    startTime: { $gt: now },
    ...customerFilter,
  });

  return !!upcoming;
}

export async function runNoShowFollowUpSweep(): Promise<FollowUpStats> {
  const stats: FollowUpStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();
  if (!isWithinSendingHours(now)) return stats;

  const candidates = await Appointment.find({
    entryType: 'appointment',
    status: 'no-show',
    noShowFollowUpSentAt: null,
    'customerBooking.phone': { $exists: true, $ne: '' },
    updatedAt: {
      $gte: new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60 * 1000),
      $lte: new Date(now.getTime() - DELAY_MINUTES * 60 * 1000),
    },
    startTime: { $gte: new Date(now.getTime() - MAX_APPOINTMENT_AGE_MS) },
  })
    .select('title startTime organizationId customerBooking leadId')
    .limit(BATCH_LIMIT)
    .lean();

  stats.scanned = candidates.length;

  for (const appointment of candidates as any[]) {
    try {
      if (await hasUpcomingAppointment(appointment, now)) {
        stats.skipped++;
        continue;
      }

      const claimed = await Appointment.updateOne(
        { _id: appointment._id, status: 'no-show', noShowFollowUpSentAt: null },
        { $set: { noShowFollowUpSentAt: now } },
        { timestamps: false },
      );
      if (claimed.modifiedCount === 0) continue;

      if (await sendNoShowFollowUpText(appointment)) stats.sent++;
      else stats.skipped++;
    } catch (err) {
      stats.errors++;
      logger.error({ err, appointmentId: appointment._id }, '[NoShowFollowUp] Failed to process appointment');
    }
  }

  return stats;
}

export function initNoShowFollowUpScheduler(): void {
  if (process.env.NOSHOW_FOLLOWUP_ENABLED === 'false') {
    logger.info('[NoShowFollowUp] Disabled via NOSHOW_FOLLOWUP_ENABLED');
    return;
  }

  runNoShowFollowUpSweep().catch((err) =>
    logger.error(err, '[NoShowFollowUp] Startup sweep failed'),
  );

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runNoShowFollowUpSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[NoShowFollowUp] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[NoShowFollowUp] Sweep failed');
    }
  });

  logger.info(
    `[NoShowFollowUp] Initialized — schedule: ${CRON_SCHEDULE}, delay: ${DELAY_MINUTES}m, window: ${MAX_AGE_HOURS}h`,
  );
}
