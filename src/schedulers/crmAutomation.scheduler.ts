import cron from 'node-cron';
import logger from '../utils/logger';
import { isAutomationEngineEnabled } from '../services/crmAutomation.service';
import { runAutomationTick } from '../services/crmAutomationEngine.service';

const CRON_SCHEDULE = process.env.CRM_AUTOMATIONS_CRON || '* * * * *';

let running = false;

export function initCrmAutomationScheduler(): void {
  if (!isAutomationEngineEnabled()) {
    logger.info('[CrmAutomation] Disabled. Set CRM_AUTOMATIONS_ENABLED=true to run automations');
    return;
  }

  cron.schedule(CRON_SCHEDULE, async () => {
    if (running) return;
    running = true;
    try {
      const stats = await runAutomationTick();
      if (stats.started || stats.processed || stats.replies || stats.alerts) logger.info(stats, '[CrmAutomation] Tick complete');
    } catch (err) {
      logger.error(err, '[CrmAutomation] Tick failed');
    } finally {
      running = false;
    }
  });

  logger.info(`[CrmAutomation] Initialized — schedule: ${CRON_SCHEDULE}`);
}
