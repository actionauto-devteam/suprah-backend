// repush
import cron from 'node-cron';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

// TimeProof screenshot retention. After this many days the JPEG in R2 is deleted.
// TimeLog records (clock-in/out) are kept indefinitely — only the screenshot
// objects roll off. Screenshots live ONLY in R2 (no MongoDB metadata), so this
// just walks R2 and deletes objects older than the cutoff.
const RETENTION_DAYS = 25;
const CRON_SCHEDULE = process.env.SCREENSHOT_RETENTION_CRON || '0 3 * * *';

async function purgeOldScreenshots(): Promise<{ deleted: number; failures: number }> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const all = await storageService.list('screenshots/', BucketType.PRIVATE);

  let deleted = 0;
  let failures = 0;

  for (const obj of all) {
    // Extract capturedAtMs from the key tail: screenshots/{userId}/{date}/{ms}-{flag}.jpg
    const fileName = obj.key.split('/').pop() ?? '';
    const dashIdx = fileName.lastIndexOf('-');
    const ms = dashIdx >= 0 ? parseInt(fileName.slice(0, dashIdx), 10) : NaN;
    // Fall back to R2 lastModified if the key isn't in our expected shape
    const ts = Number.isFinite(ms) ? ms : (obj.lastModified?.getTime() ?? Date.now());
    if (ts >= cutoff) continue;

    try {
      await storageService.delete(obj.key, BucketType.PRIVATE);
      deleted++;
    } catch (err) {
      failures++;
      logger.warn({ err, key: obj.key }, 'Failed to delete screenshot from R2');
    }
  }

  return { deleted, failures };
}

export const initScreenshotRetentionScheduler = () => {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      logger.info(`Running screenshot retention (>${RETENTION_DAYS} days)…`);
      const { deleted, failures } = await purgeOldScreenshots();
      logger.info(
        `✓ Screenshot retention finished — purged ${deleted} object(s)` +
        (failures > 0 ? `, ${failures} delete(s) failed` : '')
      );
    } catch (err) {
      logger.error({ err }, 'Screenshot retention scheduler error');
    }
  });

  logger.info(`✓ Screenshot retention scheduler initialized (cron: ${CRON_SCHEDULE}, keeps ${RETENTION_DAYS} days)`);
};

export const runScreenshotRetentionNow = purgeOldScreenshots;

/**
 * One-time admin operation: deletes ALL TimeProof screenshots from R2.
 * TimeLog (clock-in/out history) is untouched.
 */
export async function wipeAllScreenshots(): Promise<{ deleted: number; failures: number }> {
  const all = await storageService.list('screenshots/', BucketType.PRIVATE);
  if (all.length === 0) return { deleted: 0, failures: 0 };

  let deleted = 0;
  let failures = 0;
  for (const obj of all) {
    try {
      await storageService.delete(obj.key, BucketType.PRIVATE);
      deleted++;
    } catch (err) {
      failures++;
      logger.warn({ err, key: obj.key }, 'Failed to delete screenshot from R2 during wipe');
    }
  }
  return { deleted, failures };
}
