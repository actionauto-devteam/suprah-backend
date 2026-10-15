import cron from 'node-cron';
import TimeproofArchive from '../models/TimeproofArchive.model';
import { purgeArchivedTimeproof } from '../utils/timeproofArchivePurge.util';
import logger from '../utils/logger';

const RETENTION_DAYS = 90;
const CRON_SCHEDULE = process.env.TIMEPROOF_ARCHIVE_RETENTION_CRON || '0 4 * * *';

async function purgeExpiredArchives(): Promise<{ purged: number; failures: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await TimeproofArchive.find({
    autoDeleteEligible: true,
    offboardedAt: { $lte: cutoff },
  });

  let purged = 0;
  let failures = 0;

  for (const archived of expired) {
    try {
      await purgeArchivedTimeproof(archived, {
        reason: `Automatic retention — ${RETENTION_DAYS} days after offboarding`,
      });
      purged++;
    } catch (err) {
      failures++;
      logger.error({ err, userId: archived._id.toString() }, 'Failed to auto-purge expired Timeproof archive');
    }
  }

  return { purged, failures };
}

export const initTimeproofArchiveRetentionScheduler = () => {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      logger.info(`Running Timeproof archive retention (${RETENTION_DAYS} days after offboarding)…`);
      const { purged, failures } = await purgeExpiredArchives();
      logger.info(
        `✓ Timeproof archive retention finished — purged ${purged} account(s)` +
        (failures > 0 ? `, ${failures} purge(s) failed` : '')
      );
    } catch (err) {
      logger.error({ err }, 'Timeproof archive retention scheduler error');
    }
  });

  logger.info(
    `✓ Timeproof archive retention scheduler initialized (cron: ${CRON_SCHEDULE}, ` +
    `purges accounts offboarded ${RETENTION_DAYS}+ days ago that were offboarded after this feature shipped)`
  );
};

export const runTimeproofArchiveRetentionNow = purgeExpiredArchives;
