import cron from 'node-cron';
import config from '../config';
import syncService from '../services/sync.service';
import orgGmailService from '../services/orgGmail.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { notifyOrgAdmins, notifyAllOrganizations } from '../utils/safeNotification';

// Org-scoped inventory sync (ACTION_AUTO_ORG_ID); constant duplicated here
// to avoid reaching into sync.service.ts internals
const ACTION_AUTO_ORG_ID = process.env.ACTION_AUTO_ORG_ID || '69d6a26499bee4596c1ea94c';
const LEAD_SYNC_CRON = cron.validate(process.env.LEAD_SYNC_CRON || '') ? String(process.env.LEAD_SYNC_CRON) : '* * * * *';
let leadSyncRunning = false;

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

    console.log(`[Scheduler] Lead Sync: ${LEAD_SYNC_CRON}`);
    cron.schedule(LEAD_SYNC_CRON, async () => {
        if (leadSyncRunning) return;
        leadSyncRunning = true;

        try {
            const configs = await OrgLeadConfig.find({
                isActive: true,
                gmailConnected: true
            }).select('organizationId');

            // Chunked Concurrency: Process 5 orgs at a time to prevent server stress
            const chunkSize = 5;
            let synced = 0;
            for (let i = 0; i < configs.length; i += chunkSize) {
                const chunk = configs.slice(i, i + chunkSize);
                const results = await Promise.allSettled(
                    chunk.map(c => orgGmailService.syncLeadsForOrg(c.organizationId.toString()))
                );
                for (const result of results) {
                    if (result.status === 'fulfilled') synced += result.value.synced;
                }
            }

            if (synced > 0) console.log(`[Scheduler] Lead sync added ${synced} new lead(s).`);
        } catch (error: any) {
          console.error(`[Scheduler] Lead sync cycle FATAL:`, error.message);
          // Fatal = platform-wide failure before per-org processing (e.g. OrgLeadConfig query),
          // so notify all admins instead of guessing which org was affected
          notifyAllOrganizations(
            "admin_system_alert",
            "Lead Sync Cycle Failed",
            `The scheduled multi-tenant lead sync failed to run: ${error.message}`,
          ).catch(() => {});
        } finally {
            leadSyncRunning = false;
        }
    });
};

