import cron from 'node-cron';
import config from '../config';
import syncService from '../services/sync.service';

/**
 * Initializes scheduled tasks
 */
export const initSyncScheduler = () => {
    const schedule = config.sync.schedule || '0 0 * * *'; // Default: Midnight every day

    console.log(`[Scheduler] Initializing DealersCloud Sync with schedule: ${schedule}`);

    cron.schedule(schedule, async () => {
        console.log(`[Scheduler] Starting automated inventory sync...`);
        try {
            const result = await syncService.syncInventory();
            console.log(`[Scheduler] Sync completed successfully:`, result);
        } catch (error: any) {
            console.error(`[Scheduler] Sync failed:`, error.message);
        }
    });
};
