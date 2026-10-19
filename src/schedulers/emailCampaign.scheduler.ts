import cron from 'node-cron';
import EmailCampaign from '../models/EmailCampaign.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import MarketingContact from '../models/MarketingContact.model';
import emailService from '../services/email.service';
import { hasSendPermission } from '../services/marketingContact.service';
import { isWithinSendingHours } from '../utils/sendingWindow';
import { retryDbWrite } from '../utils/retryDbWrite';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.EMAIL_CAMPAIGN_CRON || '* * * * *';
const BATCH_PER_TICK = parseInt(process.env.EMAIL_CAMPAIGN_BATCH_PER_TICK || '20', 10);
const ACTIVE_CAMPAIGN_LIMIT = 5;
const PROCESSING_TIMEOUT_MINUTES = parseInt(process.env.EMAIL_CAMPAIGN_PROCESSING_TIMEOUT_MINUTES || '10', 10);

interface EmailCampaignSweepStats {
  campaignsProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
  reclaimedUncertain: number;
}

async function reclaimStaleProcessingRecipients(): Promise<number> {
  const staleBefore = new Date(Date.now() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000);
  const staleRows = await EmailCampaignRecipient.find({
    status: 'processing',
    processingStartedAt: { $lte: staleBefore },
  })
    .select('_id campaignId')
    .lean();

  if (staleRows.length === 0) return 0;

  const ids = staleRows.map((row: any) => row._id);
  await EmailCampaignRecipient.updateMany(
    { _id: { $in: ids }, status: 'processing' },
    {
      $set: {
        status: 'uncertain',
        failureReason: 'Send outcome could not be confirmed (the process may have restarted mid-send)',
      },
    },
  );

  const countsByCampaign = new Map<string, number>();
  for (const row of staleRows as any[]) {
    const key = String(row.campaignId);
    countsByCampaign.set(key, (countsByCampaign.get(key) || 0) + 1);
  }
  await Promise.all(
    Array.from(countsByCampaign.entries()).map(([campaignId, count]) =>
      EmailCampaign.updateOne({ _id: campaignId }, { $inc: { uncertainCount: count } }).catch((err) => {
        logger.error({ err, campaignId }, '[EmailCampaign] Could not record reclaimed-uncertain count on campaign');
      }),
    ),
  );

  logger.warn({ reclaimed: staleRows.length }, '[EmailCampaign] Reclaimed stale processing recipients as uncertain');
  return staleRows.length;
}

async function claimCampaignForSending(campaignId: any): Promise<any | null> {
  const now = new Date();

  const freshlyClaimed = await EmailCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      $or: [
        { status: 'queued' },
        { status: 'scheduled', scheduledAt: { $lte: now } },
      ],
    },
    { $set: { status: 'sending', startedAt: now } },
    { new: true },
  );
  if (freshlyClaimed) return freshlyClaimed;

  return EmailCampaign.findOne({ _id: campaignId, status: 'sending' });
}

async function processCampaign(campaign: any, budget: number): Promise<number> {
  if (budget <= 0) return 0;

  const claimed = await claimCampaignForSending(campaign._id);
  if (!claimed) return 0;

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
      { $set: { status: 'processing', processingStartedAt: new Date() }, $inc: { attemptCount: 1 } },
      { new: false },
    );
    if (!claimed) continue;
    spent += 1;

    if (recipient.marketingContactId) {
      const contact = await MarketingContact.findOne({ _id: recipient.marketingContactId, organizationId: campaign.organizationId })
        .select('consentStatus permissionOverride')
        .lean();
      if (!contact || !hasSendPermission(contact as any)) {
        const updateResult = await EmailCampaignRecipient.updateOne(
          { _id: recipient._id, status: 'processing' },
          { $set: { status: 'skipped', failureReason: 'Contact is no longer eligible (consent changed before send)' } },
        ).catch(() => null);
        if (updateResult && updateResult.matchedCount > 0) {
          await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } }).catch(() => undefined);
        }
        continue;
      }
    }

    let delivered: boolean;
    try {
      delivered = await emailService.sendCampaignEmail({
        to: recipient.email,
        phone: recipient.phone,
        customerName: recipient.customerName,
        greetingName: recipient.greetingName,
        subject: campaign.subject,
        greetingText: campaign.greetingText,
        bannerImageUrl: campaign.bannerImageUrl,
        bodyText: campaign.bodyText,
        bodyHtml: campaign.bodyHtml,
        signOffText: campaign.signOffText,
        organizationId: campaign.organizationId,
      });
    } catch (err) {
      const updateResult = await EmailCampaignRecipient.updateOne(
        { _id: recipient._id, status: 'processing' },
        { $set: { status: 'failed', failureReason: String((err as any)?.message || err).slice(0, 500) } },
      ).catch(() => null);
      if (updateResult && updateResult.matchedCount > 0) {
        await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { failedCount: 1 } }).catch(() => undefined);
      } else {
        logger.warn(
          { campaignId: campaign._id, recipientId: recipient._id },
          '[EmailCampaign] Recipient was no longer "processing" when recording a failed send (likely already reclaimed as uncertain) — skipping the failedCount increment to avoid overcounting.',
        );
      }
      logger.error({ err, campaignId: campaign._id, recipientId: recipient._id }, '[EmailCampaign] Send failed');
      continue;
    }

    if (delivered) {
      try {
        const updateResult = await EmailCampaignRecipient.updateOne(
          { _id: recipient._id, status: 'processing' },
          { $set: { status: 'sent', sentAt: new Date() } },
        );
        if (updateResult.matchedCount > 0) {
          await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 } });
        } else {
          logger.warn(
            { campaignId: campaign._id, recipientId: recipient._id },
            '[EmailCampaign] Recipient was no longer "processing" after a confirmed send (likely already reclaimed as uncertain by the stale-processing sweep) — skipping the sentCount increment to avoid overcounting. The recipient is not re-marked sent; its uncertain status (and uncertainCount) from the reclaim stands.',
          );
        }
      } catch (recordErr) {
        try {
          const retriedResult = await retryDbWrite(() =>
            EmailCampaignRecipient.updateOne(
              { _id: recipient._id, status: 'processing' },
              {
                $set: {
                  status: 'uncertain',
                  failureReason: 'Email was sent successfully but could not be recorded',
                },
              },
            ),
          );
          if (retriedResult.matchedCount > 0) {
            await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { uncertainCount: 1 } }).catch(() => undefined);
          } else {
            logger.warn(
              { campaignId: campaign._id, recipientId: recipient._id },
              '[EmailCampaign] Recipient was no longer "processing" while recovering from a bookkeeping failure (likely already reclaimed as uncertain) — skipping the uncertainCount increment to avoid double-counting.',
            );
          }
        } catch (retryErr) {
          logger.error(
            { err: retryErr, campaignId: campaign._id, recipientId: recipient._id },
            '[EmailCampaign] Could not record a confirmed send — recipient remains "processing" and will be reconciled as uncertain once the stale-processing timeout elapses.',
          );
        }
        logger.error(
          { err: recordErr, campaignId: campaign._id, recipientId: recipient._id },
          '[EmailCampaign] Email sent successfully but bookkeeping failed — marked uncertain, will not auto-retry',
        );
      }
    } else {
      const updateResult = await EmailCampaignRecipient.updateOne(
        { _id: recipient._id, status: 'processing' },
        { $set: { status: 'skipped', failureReason: 'Customer opted out of email' } },
      ).catch(() => null);
      if (updateResult && updateResult.matchedCount > 0) {
        await EmailCampaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } }).catch(() => undefined);
      } else {
        logger.warn(
          { campaignId: campaign._id, recipientId: recipient._id },
          '[EmailCampaign] Recipient was no longer "processing" when recording a skipped (opted-out) send (likely already reclaimed as uncertain) — skipping the skippedCount increment to avoid overcounting.',
        );
      }
    }
  }

  const remaining = await EmailCampaignRecipient.countDocuments({
    campaignId: campaign._id,
    status: { $in: ['pending', 'processing'] },
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
  const stats: EmailCampaignSweepStats = { campaignsProcessed: 0, sent: 0, failed: 0, skipped: 0, reclaimedUncertain: 0 };

  stats.reclaimedUncertain = await reclaimStaleProcessingRecipients();

  if (!isWithinSendingHours(new Date())) return stats;

  const now = new Date();
  const campaigns = await EmailCampaign.find({
    $or: [
      { status: { $in: ['queued', 'sending'] } },
      { status: 'scheduled', scheduledAt: { $lte: now } },
    ],
  })
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
      if (stats.campaignsProcessed > 0 || stats.reclaimedUncertain > 0) {
        logger.info(stats, '[EmailCampaign] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[EmailCampaign] Sweep failed');
    }
  });

  logger.info(`[EmailCampaign] Initialized. Schedule: ${CRON_SCHEDULE}, batch per tick: ${BATCH_PER_TICK}`);
}
