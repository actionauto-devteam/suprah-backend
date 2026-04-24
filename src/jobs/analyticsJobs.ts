import cron from 'node-cron';
import CrmUser from '../models/CrmUser.model';
import { rebuildRanks } from '../services/activityLogger.service';
import { evaluateBadges } from '../services/badge.service';
import { getPeriodKey } from '../services/kpiEngine.service';

/**
 * Rebuild daily ranks — runs every hour at :05
 */
export const dailyRankJob = cron.schedule('5 * * * *', async () => {
  console.log('[CRON] Rebuilding daily ranks...');
  try {
    const now = new Date();
    const periodKey = getPeriodKey(now, 'daily');
    const orgIds = await CrmUser.distinct('organizationId');

    for (const orgId of orgIds) {
      if (!orgId) continue;
      await rebuildRanks(orgId.toString(), 'daily', periodKey);
    }

    console.log(`[CRON] Daily ranks rebuilt for ${orgIds.length} organizations.`);
  } catch (err) {
    console.error('[CRON] Daily rank rebuild failed:', err);
  }
});

/**
 * Rebuild weekly ranks — runs every day at 00:10
 */
export const weeklyRankJob = cron.schedule('10 0 * * *', async () => {
  console.log('[CRON] Rebuilding weekly ranks...');
  try {
    const now = new Date();
    const periodKey = getPeriodKey(now, 'weekly');
    const orgIds = await CrmUser.distinct('organizationId');

    for (const orgId of orgIds) {
      if (!orgId) continue;
      await rebuildRanks(orgId.toString(), 'weekly', periodKey);
    }

    console.log(`[CRON] Weekly ranks rebuilt.`);
  } catch (err) {
    console.error('[CRON] Weekly rank rebuild failed:', err);
  }
});

/**
 * Rebuild monthly ranks — runs on the 1st of each month at 00:15
 */
export const monthlyRankJob = cron.schedule('15 0 1 * *', async () => {
  console.log('[CRON] Rebuilding monthly ranks...');
  try {
    const now = new Date();
    const periodKey = getPeriodKey(now, 'monthly');
    const orgIds = await CrmUser.distinct('organizationId');

    for (const orgId of orgIds) {
      if (!orgId) continue;
      await rebuildRanks(orgId.toString(), 'monthly', periodKey);
    }

    console.log(`[CRON] Monthly ranks rebuilt.`);
  } catch (err) {
    console.error('[CRON] Monthly rank rebuild failed:', err);
  }
});

/**
 * Badge evaluation — runs every 6 hours
 */
export const badgeEvalJob = cron.schedule('0 */6 * * *', async () => {
  console.log('[CRON] Evaluating badges...');
  try {
    const now = new Date();
    const users = await CrmUser.find({ isActive: true }).select('_id organizationId').lean();

    for (const user of users) {
      if (!user.organizationId) continue;
      for (const period of ['daily', 'weekly', 'monthly'] as const) {
        const key = getPeriodKey(now, period);
        await evaluateBadges(user.organizationId.toString(), user._id.toString(), period, key);
      }
    }

    console.log(`[CRON] Badge evaluation complete for ${users.length} users.`);
  } catch (err) {
    console.error('[CRON] Badge evaluation failed:', err);
  }
});

export function startAnalyticsCronJobs() {
  // Jobs are started by default when cron.schedule() is called without { scheduled: false }.
  // Call this function at server boot just for the log confirmation.
  console.log('[CRON] Analytics cron jobs active:');
  console.log('  • Daily rank rebuild  → every hour at :05');
  console.log('  • Weekly rank rebuild → daily at 00:10');
  console.log('  • Monthly rank rebuild→ 1st of month at 00:15');
  console.log('  • Badge evaluation    → every 6 hours');
}