import { Worker, Job } from 'bullmq';
import webpush from 'web-push';
import config from '../config';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';
import { bullConnection } from './push.queue';

const LOG_PREFIX = '[PushWorker]';

// Initialize web-push with VAPID credentials from config
webpush.setVapidDetails(
  config.push.vapidSubject,
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);

/**
 * Worker to process push notification jobs.
 * This worker runs in the background and handles the actual HTTP delivery to push vendors.
 */
export let pushWorker: Worker | null = null;

if (config.redis.enabled) {
  pushWorker = new Worker(
    'push-notifications',
    async (job: Job) => {
      const { userId, payload } = job.data;

      if (!userId || !payload) {
        logger.warn(`${LOG_PREFIX} Invalid job data for job ${job.id}`);
        return;
      }

      // Resolve subscriptions: try User first, then CrmUser (SupraSpace targets)
      const userDoc = await User.findById(userId).select('pushSubscriptions');
      let subscriptions: any[] = userDoc?.pushSubscriptions ?? [];
      let isCrmUser = false;

      if (subscriptions.length === 0) {
        const crmUserDoc = await CrmUser.findById(userId).select('pushSubscriptions');
        if (crmUserDoc?.pushSubscriptions?.length) {
          subscriptions = crmUserDoc.pushSubscriptions as any;
          isCrmUser = true;
        }
      }

      if (subscriptions.length === 0) {
        logger.debug(`${LOG_PREFIX} No subscriptions for user ${userId}. Skipping.`);
        return;
      }

      const stringifiedPayload = JSON.stringify(payload);
      const results = await Promise.allSettled(
        subscriptions.map(async (sub: any) => {
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, stringifiedPayload);
            logger.info(`${LOG_PREFIX} Sent to user ${userId} on device ${sub.deviceHint || 'unknown'}`);
            return { endpoint: sub.endpoint, success: true };
          } catch (error: any) {
            if (error.statusCode === 410 || error.statusCode === 404) {
              logger.info(`${LOG_PREFIX} Pruning expired subscription for user ${userId}: ${sub.endpoint}`);
              return { endpoint: sub.endpoint, success: false, prune: true };
            }
            throw error;
          }
        })
      );

      const endpointsToPrune = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value.prune === true)
        .map(r => r.value.endpoint);

      if (endpointsToPrune.length > 0) {
        const ModelToUpdate: any = isCrmUser ? CrmUser : User;
        await ModelToUpdate.updateOne({ _id: userId }, { $pull: { pushSubscriptions: { endpoint: { $in: endpointsToPrune } } } });
      }

      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        throw new Error(`Failed to send push notification to ${rejected.length} endpoints`);
      }

      logger.debug(`${LOG_PREFIX} Processed ${results.length} subscriptions for user ${userId} (Pruned: ${endpointsToPrune.length})`);
    },
    {
      connection: bullConnection,
      concurrency: 50, // Process up to 50 notifications in parallel
      limiter: {
        max: 100, // Limit to 100 pushes per second to avoid vendor throttling
        duration: 1000,
      },
    }
  );

  // Event handlers for monitoring
  pushWorker.on('completed', (job) => {
    logger.debug(`${LOG_PREFIX} Job ${job.id} completed successfully.`);
  });

  pushWorker.on('failed', (job, err) => {
    logger.error(err, `${LOG_PREFIX} Job ${job?.id} failed`);
  });

  logger.info(`${LOG_PREFIX} initialized and listening for jobs.`);
} else {
  logger.info(`${LOG_PREFIX} skipped (REDIS_ENABLED=false).`);
}

export default pushWorker;
