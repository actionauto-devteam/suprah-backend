import cron from 'node-cron';
import Lead from '../models/lead.model';
import NotificationService from '../services/notification.service';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.LEAD_REMINDER_CRON || '0 */2 * * *';
const INACTIVITY_HOURS = parseInt(process.env.LEAD_INACTIVITY_HOURS || '4');
const REMINDER_INTERVAL_HOURS = parseInt(process.env.LEAD_REMINDER_INTERVAL_HOURS || '6');
const MAX_REMINDERS = parseInt(process.env.LEAD_MAX_REMINDERS || '3');
const BATCH_LIMIT = 200;

interface ReminderStats {
  leadsScanned: number;
  remindersSent: number;
  errors: number;
}

async function runLeadInactivityCheck(): Promise<ReminderStats> {
  const now = new Date();
  const inactivityCutoff = new Date(now.getTime() - INACTIVITY_HOURS * 60 * 60 * 1000);
  const reminderIntervalCutoff = new Date(now.getTime() - REMINDER_INTERVAL_HOURS * 60 * 60 * 1000);

  const staleLeads = await Lead.find({
    $and: [
      { status: { $in: ['New', 'Contacted', 'Pending'] } },
      {
        $or: [
          { 'followUp.lastCustomerActivityAt': { $lte: inactivityCutoff } },
          { 'followUp.lastCustomerActivityAt': null, createdAt: { $lte: inactivityCutoff } },
          { followUp: null, createdAt: { $lte: inactivityCutoff } },
        ],
      },
      {
        $or: [
          { 'followUp.lastRepResponseAt': null },
          { 'followUp.lastRepResponseAt': { $lte: inactivityCutoff } },
        ],
      },
      {
        $or: [
          { 'followUp.lastReminderSentAt': null },
          { 'followUp.lastReminderSentAt': { $lte: reminderIntervalCutoff } },
        ],
      },
      {
        $or: [
          { 'followUp.reminderCount': { $lt: MAX_REMINDERS } },
          { 'followUp.reminderCount': { $exists: false } },
        ],
      },
    ],
  })
    .select('_id organizationId createdBy firstName lastName email followUp createdAt')
    .limit(BATCH_LIMIT)
    .lean();

  let remindersSent = 0;
  let errors = 0;

  for (const lead of staleLeads) {
    try {
      const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Unknown Customer';
      const lastActivity = lead.followUp?.lastCustomerActivityAt ?? lead.createdAt;
      const hoursAgo = Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (60 * 60 * 1000));

      const notification = await NotificationService.createNotification({
        userId: lead.createdBy.toString(),
        organizationId: lead.organizationId.toString(),
        type: 'reminder',
        title: `Follow-up Needed: ${customerName}`,
        message: `${customerName}'s inquiry has been unanswered for ${hoursAgo}+ hour${hoursAgo !== 1 ? 's' : ''}. Follow up to keep them engaged.`,
        metadata: {
          leadId: lead._id,
          customerName,
          customerEmail: lead.email,
          route: '/crm',
        },
      });

      if (notification) {
        await Lead.updateOne(
          { _id: lead._id },
          {
            $set: { 'followUp.lastReminderSentAt': now },
            $inc: { 'followUp.reminderCount': 1 },
            $push: {
              'followUp.reminderHistory': {
                sentAt: now,
                userId: lead.createdBy,
                thresholdMinutes: INACTIVITY_HOURS * 60,
                notificationId: notification._id,
                note: `Auto-reminder: unanswered for ${hoursAgo}h`,
              },
            },
          }
        );

        remindersSent++;
        logger.info(
          { leadId: lead._id, assignedTo: lead.createdBy, hoursAgo },
          '[LeadReminder] Reminder sent'
        );
      }
    } catch (err) {
      errors++;
      logger.error({ err, leadId: lead._id }, '[LeadReminder] Failed to send reminder for lead');
    }
  }

  return { leadsScanned: staleLeads.length, remindersSent, errors };
}

export function initLeadInactivityReminderScheduler(): void {
  runLeadInactivityCheck().catch((err) =>
    logger.error(err, '[LeadReminder] Startup check failed')
  );

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runLeadInactivityCheck();
      logger.info(stats, '[LeadReminder] Cron complete');
    } catch (err) {
      logger.error(err, '[LeadReminder] Cron failed');
    }
  });

  logger.info(`[LeadReminder] Initialized — schedule: ${CRON_SCHEDULE}, threshold: ${INACTIVITY_HOURS}h, interval: ${REMINDER_INTERVAL_HOURS}h, max: ${MAX_REMINDERS}`);
}
