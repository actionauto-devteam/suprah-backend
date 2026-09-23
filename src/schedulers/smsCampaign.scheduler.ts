import cron from 'node-cron';
import SmsCampaign from '../models/SmsCampaign.model';
import SmsCampaignRecipient from '../models/SmsCampaignRecipient.model';
import { sendStaffAttributedSms } from '../services/communication.service';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.SMS_CAMPAIGN_CRON || '* * * * *';
const BATCH_PER_TICK = parseInt(process.env.SMS_CAMPAIGN_BATCH_PER_TICK || '20', 10);
const ACTIVE_CAMPAIGN_LIMIT = 5;

interface CampaignSweepStats {
  campaignsProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function processCampaign(campaign: any, budget: number): Promise<number> {
  if (budget <= 0) return 0;

  await SmsCampaign.updateOne(
    { _id: campaign._id, status: 'queued' },
    { $set: { status: 'sending', startedAt: new Date() } },
  );

  const recipients = await SmsCampaignRecipient.find({
    campaignId: campaign._id,
    status: 'pending',
  })
    .limit(budget)
    .lean();

  let spent = 0;

  for (const recipient of recipients as any[]) {
    const claimed = await SmsCampaignRecipient.findOneAndUpdate(
      { _id: recipient._id, status: 'pending' },
      { $set: { status: 'sent', sentAt: new Date() } },
      { new: false },
    );
    if (!claimed) continue;
    spent += 1;

    try {
      const delivered = await sendStaffAttributedSms({
        orgId: campaign.organizationId,
        toPhone: recipient.phone,
        body: campaign.message,
        leadId: recipient.leadId,
        customerName: recipient.customerName,
        actor: { userId: String(campaign.createdBy), name: campaign.createdByName || 'Staff' },
      });

      if (delivered) {
        await SmsCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 } });
      } else {
        await SmsCampaignRecipient.updateOne(
          { _id: recipient._id },
          { $set: { status: 'skipped', failureReason: 'Customer opted out of SMS' } },
        );
        await SmsCampaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } });
      }
    } catch (err) {
      await SmsCampaignRecipient.updateOne(
        { _id: recipient._id },
        { $set: { status: 'failed', failureReason: String((err as any)?.message || err).slice(0, 500) } },
      );
      await SmsCampaign.updateOne({ _id: campaign._id }, { $inc: { failedCount: 1 } });
      logger.error({ err, campaignId: campaign._id, recipientId: recipient._id }, '[SmsCampaign] Send failed');
    }
  }

  const remaining = await SmsCampaignRecipient.countDocuments({
    campaignId: campaign._id,
    status: 'pending',
  });
  if (remaining === 0) {
    await SmsCampaign.updateOne(
      { _id: campaign._id, status: { $in: ['queued', 'sending'] } },
      { $set: { status: 'completed', completedAt: new Date() } },
    );
  }

  return spent;
}

export async function runSmsCampaignSweep(): Promise<CampaignSweepStats> {
  const stats: CampaignSweepStats = { campaignsProcessed: 0, sent: 0, failed: 0, skipped: 0 };
  if (!isWithinSendingHours(new Date())) return stats;

  const campaigns = await SmsCampaign.find({ status: { $in: ['queued', 'sending'] } })
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

export function initSmsCampaignScheduler(): void {
  if (process.env.SMS_CAMPAIGN_ENABLED !== 'true') {
    logger.info('[SmsCampaign] Disabled. Set SMS_CAMPAIGN_ENABLED=true to enable');
    return;
  }

  runSmsCampaignSweep().catch((err) => logger.error(err, '[SmsCampaign] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runSmsCampaignSweep();
      if (stats.campaignsProcessed > 0) {
        logger.info(stats, '[SmsCampaign] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[SmsCampaign] Sweep failed');
    }
  });

  logger.info(`[SmsCampaign] Initialized. Schedule: ${CRON_SCHEDULE}, batch per tick: ${BATCH_PER_TICK}`);
}
