import cron from 'node-cron';
import Appointment from '../models/Appointment.model';
import { sendReviewRequestText } from '../services/communication.service';
import logger from '../utils/logger';
import { isWithinSendingHours } from '../utils/sendingWindow';

const CRON_SCHEDULE = process.env.REVIEW_REQUEST_CRON || '*/15 * * * *';
const DELAY_MINUTES = parseInt(process.env.REVIEW_REQUEST_DELAY_MINUTES || '60', 10);
const MAX_AGE_HOURS = parseInt(process.env.REVIEW_REQUEST_MAX_AGE_HOURS || '48', 10);
const MAX_ATTEMPTS = parseInt(process.env.REVIEW_REQUEST_MAX_ATTEMPTS || '3', 10);
const RETRY_MINUTES = parseInt(process.env.REVIEW_REQUEST_RETRY_MINUTES || '15', 10);
const PROCESSING_TIMEOUT_MINUTES = 10;
const BATCH_LIMIT = 100;

interface ReviewRequestStats {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

export async function runReviewRequestSweep(): Promise<ReviewRequestStats> {
  const stats: ReviewRequestStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();
  if (!isWithinSendingHours(now)) return stats;

  const candidates = await Appointment.find({
    entryType: 'appointment',
    status: 'completed',
    reviewRequestSentAt: null,
    reviewRequestStatus: { $nin: ['sent', 'skipped'] },
    $and: [
      {
        $or: [
          { reviewRequestAttemptCount: { $lt: MAX_ATTEMPTS } },
          { reviewRequestAttemptCount: { $exists: false } },
        ],
      },
      {
        $or: [
          { reviewRequestNextRetryAt: null },
          { reviewRequestNextRetryAt: { $exists: false } },
          { reviewRequestNextRetryAt: { $lte: now } },
        ],
      },
      {
        $or: [
          { reviewRequestStatus: { $ne: 'processing' } },
          {
            reviewRequestLastAttemptAt: {
              $lte: new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000),
            },
          },
        ],
      },
    ],
    'customerBooking.phone': { $exists: true, $ne: '' },
    updatedAt: {
      $gte: new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60 * 1000),
      $lte: new Date(now.getTime() - DELAY_MINUTES * 60 * 1000),
    },
  })
    .select('title organizationId customerBooking leadId vehicleId reviewRequestAttemptCount')
    .limit(BATCH_LIMIT)
    .lean();

  stats.scanned = candidates.length;

  for (const appointment of candidates as any[]) {
    try {
      const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000);
      const claimed = await Appointment.findOneAndUpdate(
        {
          _id: appointment._id,
          status: 'completed',
          reviewRequestSentAt: null,
          reviewRequestStatus: { $nin: ['sent', 'skipped'] },
          $and: [
            {
              $or: [
                { reviewRequestAttemptCount: { $lt: MAX_ATTEMPTS } },
                { reviewRequestAttemptCount: { $exists: false } },
              ],
            },
            {
              $or: [
                { reviewRequestStatus: { $ne: 'processing' } },
                { reviewRequestLastAttemptAt: { $lte: staleBefore } },
              ],
            },
          ],
        },
        {
          $set: {
            reviewRequestStatus: 'processing',
            reviewRequestLastAttemptAt: now,
          },
          $inc: { reviewRequestAttemptCount: 1 },
          $unset: { reviewRequestFailureReason: 1, reviewRequestNextRetryAt: 1 },
        },
        { new: true, timestamps: false },
      );
      if (!claimed) continue;

      if (await sendReviewRequestText(appointment)) {
        await Appointment.updateOne(
          { _id: appointment._id, reviewRequestStatus: 'processing' },
          {
            $set: { reviewRequestStatus: 'sent', reviewRequestSentAt: new Date() },
            $unset: { reviewRequestNextRetryAt: 1, reviewRequestFailureReason: 1 },
          },
          { timestamps: false },
        );
        stats.sent++;
      } else {
        await Appointment.updateOne(
          { _id: appointment._id, reviewRequestStatus: 'processing' },
          {
            $set: {
              reviewRequestStatus: 'skipped',
              reviewRequestFailureReason: 'Customer opted out of SMS',
            },
            $unset: { reviewRequestNextRetryAt: 1 },
          },
          { timestamps: false },
        );
        stats.skipped++;
      }
    } catch (err) {
      const attempts = (appointment.reviewRequestAttemptCount || 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await Appointment.updateOne(
        { _id: appointment._id, reviewRequestStatus: 'processing' },
        {
          $set: {
            reviewRequestStatus: 'failed',
            reviewRequestFailureReason: String((err as any)?.message || err).slice(0, 500),
            ...(exhausted
              ? {}
              : {
                  reviewRequestNextRetryAt: new Date(
                    Date.now() + RETRY_MINUTES * attempts * 60 * 1000,
                  ),
                }),
          },
          ...(exhausted ? { $unset: { reviewRequestNextRetryAt: 1 } } : {}),
        },
        { timestamps: false },
      ).catch(() => undefined);
      stats.errors++;
      logger.error({ err, appointmentId: appointment._id }, '[ReviewRequest] Failed to process appointment');
    }
  }

  return stats;
}

export function initReviewRequestScheduler(): void {
  if (process.env.REVIEW_REQUEST_ENABLED !== 'true') {
    logger.info('[ReviewRequest] Disabled. Set REVIEW_REQUEST_ENABLED=true to enable');
    return;
  }

  runReviewRequestSweep().catch((err) => logger.error(err, '[ReviewRequest] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runReviewRequestSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[ReviewRequest] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[ReviewRequest] Sweep failed');
    }
  });

  logger.info(
    `[ReviewRequest] Initialized. Schedule: ${CRON_SCHEDULE}, delay: ${DELAY_MINUTES}m, window: ${MAX_AGE_HOURS}h`,
  );
}
