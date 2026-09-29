import cron from 'node-cron';
import EmailCampaign from '../models/EmailCampaign.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import emailService from '../services/email.service';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.EMAIL_CAMPAIGN_CRON || '* * * * *';
const BATCH_PER_TICK = parseInt(process.env.EMAIL_CAMPAIGN_BATCH_PER_TICK || '20', 10);
const ACTIVE_CAMPAIGN_LIMIT = 5;

interface EmailCampaignSweepStats {
  campaignsProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function processCampaign(campaign: any, budget: number): Promise<number> {
  if (budget <= 0) return 0;

  await EmailCampaign.updateOne(
    { _id: campaign._id, status: 'queued' },
    { $set: { status: 'sending', startedAt: new Date() } },
  );

  const recipients = await EmailCampaignRecipient.find({
    campaignId: campaign._id,
    status: 'pending',
  })
    .limit(budget)
    .lean();

  let spent = 0;

  for (const recipient of recipients as any[]) {
    const claimed = await EmailCampaignRecipient.findOneAndUpdate(
      { _id: recipient._id, status: 'pending' },
      { $set: { status: 'sent', sentAt: new Date() } },
      { new: false },
    );
    if (!claimed) continue;
    spent += 1;

    try {
      const delivered = await emailService.sendCampaignEmail({
        to: recipient.email,
        phone: recipient.phone,
        customerName: recipient.customerName,
        subject: campaign.subject,
        greetingText: campaign.greetingText,
        bannerImageUrl: campaign.bannerImageUrl,
        bodyText: campaign.bodyText,
        signOffText: campaign.signOffText,
        organizationId: campaign.organizationId,
      });

      if (delivered) {
        await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 } });
      } else {
        await EmailCampaignRecipient.updateOne(
          { _id: recipient._id },
          { $set: { status: 'skipped', failureReason: 'Customer opted out of email' } },
        );
        await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } });
      }
    } catch (err) {
      await EmailCampaignRecipient.updateOne(
        { _id: recipient._id },
        { $set: { status: 'failed', failureReason: String((err as any)?.message || err).slice(0, 500) } },
      );
      await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { failedCount: 1 } });
      logger.error({ err, campaignId: campaign._id, recipientId: recipient._id }, '[EmailCampaign] Send failed');
    }
  }

  const remaining = await EmailCampaignRecipient.countDocuments({
    campaignId: campaign._id,
    status: 'pending',
  });
  if (remaining === 0) {
    await EmailCampaign.updateOne(
      { _id: campaign._id, status: { $in: ['queued', 'sending'] } },
      { $set: { status: 'completed', completedAt: new Date() } },
    );
  }

  return spent;
}

export async function runEmailCampaignSweep(): Promise<EmailCampaignSweepStats> {
  const stats: EmailCampaignSweepStats = { campaignsProcessed: 0, sent: 0, failed: 0, skipped: 0 };
  if (!isWithinSendingHours(new Date())) return stats;

  const campaigns = await EmailCampaign.find({ status: { $in: ['queued', 'sending'] } })
    .sort({ createdAt: 1 })
    .limit(ACTIVE_CAMPAIGN_LIMIT)
    .lean();

  let budget = BATCH_PER_TICK;
  for (const campaign of campaigns) {
    if (budget <= 0) break;
    const spent = await processCampaign(campaign, budget);
    budget -= spent;
    stats.campaignsProcessed += 1;
  }

  return stats;
}

export function initEmailCampaignScheduler(): void {
  if (process.env.EMAIL_CAMPAIGN_ENABLED !== 'true') {
    logger.info('[EmailCampaign] Disabled. Set EMAIL_CAMPAIGN_ENABLED=true to enable');
    return;
  }

  runEmailCampaignSweep().catch((err) => logger.error(err, '[EmailCampaign] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runEmailCampaignSweep();
      if (stats.campaignsProcessed > 0) {
        logger.info(stats, '[EmailCampaign] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[EmailCampaign] Sweep failed');
    }
  });

  logger.info(`[EmailCampaign] Initialized. Schedule: ${CRON_SCHEDULE}, batch per tick: ${BATCH_PER_TICK}`);
}
