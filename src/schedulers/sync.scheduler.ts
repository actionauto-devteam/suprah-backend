import cron from 'node-cron';
import config from '../config';
import syncService from '../services/sync.service';
import orgGmailService from '../services/orgGmail.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';

export const initSyncScheduler = () => {
    const inventorySchedule = config.sync.schedule || '0 0 * * *';
    console.log(`[Scheduler] Inventory Sync: ${inventorySchedule}`);

    cron.schedule(inventorySchedule, async () => {
        console.log(`[Scheduler] Starting inventory sync...`);
        try {
            const result = await syncService.syncInventory();
            console.log(`[Scheduler] Inventory sync success:`, result);
        } catch (error: any) {
            console.error(`[Scheduler] Inventory sync failed:`, error.message);
        }
    });

    // 2. Multi-Tenant Lead Sync (Hourly)
    // Runs at the start of every hour
    cron.schedule('0 * * * *', async () => {
        console.log(`[Scheduler] Starting multi-tenant lead sync...`);

        try {
            const configs = await OrgLeadConfig.find({
                isActive: true,
                gmailConnected: true
            }).select('organizationId');

            console.log(`[Scheduler] Found ${configs.length} active organizations for lead sync.`);

            // Chunked Concurrency: Process 5 orgs at a time to prevent server stress
            const chunkSize = 5;
            for (let i = 0; i < configs.length; i += chunkSize) {
                const chunk = configs.slice(i, i + chunkSize);
                console.log(`[Scheduler] Processing chunk ${Math.floor(i / chunkSize) + 1}...`);

                await Promise.allSettled(
                    chunk.map(c => orgGmailService.syncLeadsForOrg(c.organizationId.toString()))
                );
            }

            console.log(`[Scheduler] Multi-tenant lead sync cycle completed.`);
        } catch (error: any) {
            console.error(`[Scheduler] Lead sync cycle FATAL:`, error.message);
        }
    });
};

