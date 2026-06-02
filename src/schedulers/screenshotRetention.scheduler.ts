import cron from 'node-cron';
import Screenshot from '../models/Screenshot.model';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

// TimeProof screenshot retention. After this many days the binary file in R2
// and its metadata document in MongoDB are deleted. The TimeLog records (when
// the user clocked in/out) are kept indefinitely — only the screenshots roll off.
const RETENTION_DAYS = 25;

// Default: 03:00 UTC daily. Override via env var if needed.
const CRON_SCHEDULE = process.env.SCREENSHOT_RETENTION_CRON || '0 3 * * *';

async function purgeOldScreenshots(): Promise<{ deleted: number; r2Failures: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const stale = await Screenshot.find({ capturedAt: { $lt: cutoff } }).lean();

  if (stale.length === 0) return { deleted: 0, r2Failures: 0 };

  let r2Failures = 0;
  for (const doc of stale) {
    try {
      await storageService.delete(doc.r2Key, BucketType.PRIVATE);
    } catch (err) {
      r2Failures++;
      logger.warn({ err, r2Key: doc.r2Key }, 'Failed to delete screenshot from R2');
    }
  }

  const ids = stale.map(d => d._id);
  const { deletedCount } = await Screenshot.deleteMany({ _id: { $in: ids } });
  return { deleted: deletedCount ?? 0, r2Failures };
}

export const initScreenshotRetentionScheduler = () => {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      logger.info(`Running screenshot retention (>${RETENTION_DAYS} days)…`);
      const { deleted, r2Failures } = await purgeOldScreenshots();
      logger.info(
        `✓ Screenshot retention finished — purged ${deleted} record(s)` +
        (r2Failures > 0 ? `, ${r2Failures} R2 delete(s) failed` : '')
      );
    } catch (err) {
      logger.error({ err }, 'Screenshot retention scheduler error');
    }
  });

  logger.info(`✓ Screenshot retention scheduler initialized (cron: ${CRON_SCHEDULE}, keeps ${RETENTION_DAYS} days)`);
};

// Exposed for manual/admin trigger (not wired into a route by default)
export const runScreenshotRetentionNow = purgeOldScreenshots;

/**
 * One-time admin operation: deletes ALL TimeProof screenshots from BOTH R2
 * and MongoDB. TimeLog (clock-in/out history) is untouched — only the screenshot
 * binaries and their metadata are removed. Use to fully free storage when the
 * cumulative archive is too large.
 */
export async function wipeAllScreenshots(): Promise<{ deleted: number; r2Failures: number }> {
  const all = await Screenshot.find({}).lean();
  if (all.length === 0) return { deleted: 0, r2Failures: 0 };

  let r2Failures = 0;
  // Delete R2 binaries first; if any fail we still proceed with MongoDB cleanup
  // so the metadata doesn't keep pointing at unrecoverable orphan keys.
  for (const doc of all) {
    try {
      await storageService.delete(doc.r2Key, BucketType.PRIVATE);
    } catch (err) {
      r2Failures++;
      logger.warn({ err, r2Key: doc.r2Key }, 'Failed to delete screenshot from R2 during wipe');
    }
  }

  const { deletedCount } = await Screenshot.deleteMany({});
  return { deleted: deletedCount ?? 0, r2Failures };
}
