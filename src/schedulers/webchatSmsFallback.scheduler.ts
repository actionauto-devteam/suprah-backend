import cron from 'node-cron';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { sendWebchatFallbackSms } from '../services/communication.service';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.WEBCHAT_SMS_FALLBACK_CRON || '*/2 * * * *';
const DELAY_MINUTES = parseInt(process.env.WEBCHAT_SMS_FALLBACK_DELAY_MINUTES || '5', 10);
const MAX_AGE_HOURS = parseInt(process.env.WEBCHAT_SMS_FALLBACK_MAX_AGE_HOURS || '24', 10);
const BATCH_LIMIT = 100;

interface FallbackStats {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

export async function runWebchatSmsFallbackSweep(): Promise<FallbackStats> {
  const stats: FallbackStats = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const now = new Date();

  const candidates = await WebChatSession.find({
    smsFallbackSentAt: null,
    visitorPhone: { $exists: true, $ne: '' },
    createdAt: {
      $gte: new Date(now.getTime() - MAX_AGE_HOURS * 60 * 60 * 1000),
      $lte: new Date(now.getTime() - DELAY_MINUTES * 60 * 1000),
    },
  })
    .select('organizationId leadId visitorPhone visitorName')
    .limit(BATCH_LIMIT)
    .lean();

  stats.scanned = candidates.length;

  for (const session of candidates as any[]) {
    try {
      const staffReplied = await WebChatMessage.exists({
        sessionId: session._id,
        direction: 'outbound',
      });
      if (staffReplied) {
        await WebChatSession.updateOne(
          { _id: session._id, smsFallbackSentAt: null },
          { $set: { smsFallbackSentAt: now } },
          { timestamps: false },
        );
        stats.skipped++;
        continue;
      }

      const claimed = await WebChatSession.updateOne(
        { _id: session._id, smsFallbackSentAt: null },
        { $set: { smsFallbackSentAt: now } },
        { timestamps: false },
      );
      if (claimed.modifiedCount === 0) continue;

      const delivered = await sendWebchatFallbackSms({
        orgId: session.organizationId,
        phone: session.visitorPhone,
        firstName: session.visitorName?.split(/\s+/)[0],
        leadId: session.leadId,
      });
      if (delivered) stats.sent++;
      else stats.skipped++;
    } catch (err) {
      stats.errors++;
      logger.error({ err, sessionId: session._id }, '[WebchatSmsFallback] Failed to process session');
    }
  }

  return stats;
}

export function initWebchatSmsFallbackScheduler(): void {
  if (process.env.WEBCHAT_SMS_FALLBACK_ENABLED !== 'true') {
    logger.info('[WebchatSmsFallback] Disabled. Set WEBCHAT_SMS_FALLBACK_ENABLED=true to enable');
    return;
  }

  runWebchatSmsFallbackSweep().catch((err) => logger.error(err, '[WebchatSmsFallback] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runWebchatSmsFallbackSweep();
      if (stats.sent > 0 || stats.errors > 0) {
        logger.info(stats, '[WebchatSmsFallback] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[WebchatSmsFallback] Sweep failed');
    }
  });

  logger.info(
    `[WebchatSmsFallback] Initialized. Schedule: ${CRON_SCHEDULE}, delay: ${DELAY_MINUTES}m`,
  );
}
