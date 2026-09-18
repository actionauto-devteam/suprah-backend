import cron from 'node-cron';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

const RETENTION_DAYS = parseInt(process.env.IDLE_RECORDING_RETENTION_DAYS || '2', 10);
const CRON_SCHEDULE = process.env.IDLE_RECORDING_RETENTION_CRON || '30 3 * * *';

async function purgeOldIdleRecordings(): Promise<{ deleted: number; failures: number }> {
  const all = await storageService.list('idle-recordings/', BucketType.PRIVATE);

  let deleted = 0;
  let failures = 0;
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const obj of all) {
    const parts = obj.key.split('/');
    const dateStr = parts[2];
    const objDateMs = dateStr
      ? new Date(dateStr + 'T12:00:00.000Z').getTime()
      : (obj.lastModified?.getTime() ?? Date.now());

    if (objDateMs > cutoffMs) continue;

    try {
      await storageService.delete(obj.key, BucketType.PRIVATE);
      deleted++;
    } catch (err) {
      failures++;
      logger.warn({ err, key: obj.key }, 'Failed to delete idle recording from R2');
    }
  }

  return { deleted, failures };
}

export const initIdleRecordingRetentionScheduler = () => {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      logger.info(`Running idle-recording retention (${RETENTION_DAYS} days)…`);
      const { deleted, failures } = await purgeOldIdleRecordings();
      logger.info(
        `✓ Idle-recording retention finished — purged ${deleted} object(s)` +
        (failures > 0 ? `, ${failures} delete(s) failed` : '')
      );
    } catch (err) {
      logger.error({ err }, 'Idle-recording retention scheduler error');
    }
  });

  logger.info(
    `✓ Idle-recording retention scheduler initialized (cron: ${CRON_SCHEDULE}, keeps ${RETENTION_DAYS} days)`
  );
};

export const runIdleRecordingRetentionNow = purgeOldIdleRecordings;
