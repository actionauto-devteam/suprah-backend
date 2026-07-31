import cron from 'node-cron';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

const REVIEW_DAYS_AFTER_CUTOFF = 15;
const CRON_SCHEDULE = process.env.SCREENSHOT_RETENTION_CRON || '0 3 * * *';

function lastDayOfMonth(y: number, m: number): Date {
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
}

function deleteAfterDate(captureDateMs: number): Date {
  const d = new Date(captureDateMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const cutoffEnd: Date = day <= 15
    ? new Date(Date.UTC(y, m, 15, 23, 59, 59, 999))
    : lastDayOfMonth(y, m);

  return new Date(cutoffEnd.getTime() + REVIEW_DAYS_AFTER_CUTOFF * 24 * 60 * 60 * 1000);
}

async function purgeOldScreenshots(): Promise<{ deleted: number; failures: number }> {
  const all = await storageService.list('screenshots/', BucketType.PRIVATE);

  let deleted = 0;
  let failures = 0;

  for (const obj of all) {
    const parts = obj.key.split('/');
    const dateStr = parts[2];
    const captureDateMs = dateStr
      ? new Date(dateStr + 'T12:00:00.000Z').getTime()
      : (() => {
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
 * One-time admin operation: deletes TimeProof screenshots from R2.
 * TimeLog (clock-in/out history) is untouched.
 *
 * `allowedUserIds`, when provided, restricts deletion to objects whose
 * `screenshots/{userId}/...` path segment is in the set — callers must scope
 * this to their own organization's users rather than wiping the whole
 * platform's archive.
 */
export async function wipeAllScreenshots(allowedUserIds?: Set<string>): Promise<{ deleted: number; failures: number }> {
  const all = await storageService.list('screenshots/', BucketType.PRIVATE);
  if (all.length === 0) return { deleted: 0, failures: 0 };

  let deleted = 0;
  let failures = 0;
  for (const obj of all) {
    if (allowedUserIds) {
      const userIdSegment = obj.key.split('/')[1];
      if (!userIdSegment || !allowedUserIds.has(userIdSegment)) continue;
    }
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
