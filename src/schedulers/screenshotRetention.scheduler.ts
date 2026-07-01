// repush
import cron from 'node-cron';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

// Screenshots are retained until 21 days after the end of the payroll period
// they belong to. There are two cut-off periods per month:
//   1st cut-off:  1st – 15th  → period ends on the 15th
//   2nd cut-off: 16th – EOM   → period ends on the last day of the month
// TimeLog records (clock-in/out) are kept indefinitely — only the JPEG files
// in R2 are deleted. Screenshots live ONLY in R2 (no MongoDB metadata).
const REVIEW_DAYS_AFTER_CUTOFF = 21;
const CRON_SCHEDULE = process.env.SCREENSHOT_RETENTION_CRON || '0 3 * * *';

/** Returns the last day of month m (0-based) in year y as a UTC Date at 23:59:59.999 */
function lastDayOfMonth(y: number, m: number): Date {
  // Day 0 of next month = last day of this month
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
}

/**
 * Returns the date after which this screenshot may be deleted.
 * = end-of-payroll-period + REVIEW_DAYS_AFTER_CUTOFF
 */
function deleteAfterDate(captureDateMs: number): Date {
  const d = new Date(captureDateMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const cutoffEnd: Date = day <= 15
    ? new Date(Date.UTC(y, m, 15, 23, 59, 59, 999))  // 1st cut-off ends on the 15th
    : lastDayOfMonth(y, m);                            // 2nd cut-off ends on last day of month

  return new Date(cutoffEnd.getTime() + REVIEW_DAYS_AFTER_CUTOFF * 24 * 60 * 60 * 1000);
}

async function purgeOldScreenshots(): Promise<{ deleted: number; failures: number }> {
  const all = await storageService.list('screenshots/', BucketType.PRIVATE);

  let deleted = 0;
  let failures = 0;

  for (const obj of all) {
    // Key format: screenshots/{userId}/{YYYY-MM-DD}/{ms}-{flag}.jpg
    // Use the date folder segment to determine the payroll period.
    const parts = obj.key.split('/');
    const dateStr = parts[2]; // 'YYYY-MM-DD'
    const captureDateMs = dateStr
      ? new Date(dateStr + 'T12:00:00.000Z').getTime()
      : (() => {
          // Fallback: parse ms from filename tail
          const fileName = parts[parts.length - 1] ?? '';
          const dashIdx = fileName.lastIndexOf('-');
          const ms = dashIdx >= 0 ? parseInt(fileName.slice(0, dashIdx), 10) : NaN;
          return Number.isFinite(ms) ? ms : (obj.lastModified?.getTime() ?? Date.now());
        })();

    if (Date.now() <= deleteAfterDate(captureDateMs).getTime()) continue;

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
      logger.info(`Running screenshot retention (payroll cut-off + ${REVIEW_DAYS_AFTER_CUTOFF} days)…`);
      const { deleted, failures } = await purgeOldScreenshots();
      logger.info(
        `✓ Screenshot retention finished — purged ${deleted} object(s)` +
        (failures > 0 ? `, ${failures} delete(s) failed` : '')
      );
    } catch (err) {
      logger.error({ err }, 'Screenshot retention scheduler error');
    }
  });

  logger.info(
    `✓ Screenshot retention scheduler initialized (cron: ${CRON_SCHEDULE}, ` +
    `keeps until ${REVIEW_DAYS_AFTER_CUTOFF} days after each payroll cut-off)`
  );
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
