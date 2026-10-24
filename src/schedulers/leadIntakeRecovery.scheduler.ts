import cron from 'node-cron';
import { recoverLeadIntake } from '../services/leadIntake.service';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.LEAD_INTAKE_RECOVERY_CRON || '* * * * *';
let running = false;

export async function runLeadIntakeRecovery() {
  if (running) return null;
  running = true;
  try {
    return await recoverLeadIntake({ limit: 50, minAgeMs: 2 * 60 * 1000 });
  } finally {
    running = false;
  }
}

export function initLeadIntakeRecoveryScheduler(): void {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runLeadIntakeRecovery();
      if (stats && (stats.processed || stats.sideEffects || stats.movedToReview)) {
        logger.info(stats, '[LeadIntake] Recovery sweep');
      }
    } catch (err) {
      logger.error({ err }, '[LeadIntake] Recovery sweep failed');
    }
  });
}
