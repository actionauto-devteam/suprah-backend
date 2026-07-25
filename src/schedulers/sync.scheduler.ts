import cron from 'node-cron';
import config from '../config';
import syncService from '../services/sync.service';
import orgGmailService from '../services/orgGmail.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { notifyOrgAdmins, notifyAllOrganizations } from '../utils/safeNotification';

// Inventory sync is scoped to this single org (see sync.service.ts's own
// ACTION_AUTO_ORG_ID) — duplicated here rather than exported/imported so this
// scheduler doesn't reach into sync.service.ts's internals for one constant.
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
            // Fatal here means the cycle failed before per-org processing even
            // began (e.g. the OrgLeadConfig query itself) — platform-wide, so
            // every org's admins are notified rather than guessing at one.
            notifyAllOrganizations(
                'admin_system_alert',
                'Lead Sync Cycle Failed',
                `The scheduled multi-tenant lead sync failed to run: ${error.message}`,
            ).catch(() => {});
        }
    });
};

