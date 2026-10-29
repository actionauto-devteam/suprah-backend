import cron from 'node-cron';
import { runPendingDuplicateCombines } from '../services/leadDuplicateCombine.service';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.LEAD_DUPLICATE_COMBINE_CRON || '*/10 * * * *';
let running = false;

export async function runLeadDuplicateCombineSweep() {
  if (running) return null;
  running = true;
  try {
    return await runPendingDuplicateCombines();
  } finally {
    running = false;
  }
}

export function initLeadDuplicateCombineScheduler(): void {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const results = await runLeadDuplicateCombineSweep();
      if (results && results.length) logger.info({ results }, '[LeadCombine] Duplicate combine sweep');
    } catch (err) {
      logger.error({ err }, '[LeadCombine] Duplicate combine sweep failed');
    }
  });
}
