import cron from 'node-cron';
import { runCalendarShipmentSync } from '../services/calendarShipments.service';
import logger from '../utils/logger';

/*
 * Keeps each dispatcher's Google Calendar in step with the loads they
 * dispatch (see calendarShipments.service). Every 5 minutes it looks at loads
 * changed since the last run; once an hour it checks every live dispatched
 * load, which picks up a newly connected calendar and retries failures.
 */

const OVERLAP_MS = 60 * 1000;
let lastRunStartedAt = new Date(Date.now() - 15 * 60 * 1000);
let runs = 0;
let running = false;

async function run() {
  if (running) return;
  running = true;
  const startedAt = new Date();
  const fullPass = runs % 12 === 0;
  runs++;
  try {
    // A little overlap so a load saved during the last run isn't missed.
    const result = await runCalendarShipmentSync(new Date(lastRunStartedAt.getTime() - OVERLAP_MS), fullPass);
    lastRunStartedAt = startedAt;
    if (result.synced || result.failed) logger.info({ ...result, fullPass }, '[CalendarShipmentSync] Google Calendar shipments updated');
  } catch (error) {
    logger.error({ error }, '[CalendarShipmentSync] Run failed');
  } finally {
    running = false;
  }
}

export const initCalendarShipmentSyncScheduler = () => {
  cron.schedule('*/5 * * * *', run);
  void run();
};
