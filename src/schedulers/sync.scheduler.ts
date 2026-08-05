import cron from 'node-cron';
import config from '../config';
import syncService from '../services/sync.service';
import orgGmailService from '../services/orgGmail.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { notifyOrgAdmins, notifyAllOrganizations } from '../utils/safeNotification';

// Org-scoped inventory sync (ACTION_AUTO_ORG_ID); constant duplicated here
// to avoid reaching into sync.service.ts internals
const ACTION_AUTO_ORG_ID = process.env.ACTION_AUTO_ORG_ID || '69d6a26499bee4596c1ea94c';

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
            notifyOrgAdmins(
                ACTION_AUTO_ORG_ID,
                'admin_system_alert',
                'Inventory Sync Failed',
                `The scheduled inventory sync failed: ${error.message}`,
                { route: '/inventory' },
            ).catch(() => {});
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
          // Fatal = platform-wide failure before per-org processing (e.g. OrgLeadConfig query),
          // so notify all admins instead of guessing which org was affected
          notifyAllOrganizations(
            "admin_system_alert",
            "Lead Sync Cycle Failed",
            `The scheduled multi-tenant lead sync failed to run: ${error.message}`,
          ).catch(() => {});
        }
    });
};

