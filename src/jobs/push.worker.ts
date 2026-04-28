import { Worker, Job } from 'bullmq';
import webpush from 'web-push';
import config from '../config';
import User from '../models/User.model';
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

      const user = await User.findById(userId).select('pushSubscriptions');
      if (!user || !user.pushSubscriptions || user.pushSubscriptions.length === 0) {
        logger.debug(`${LOG_PREFIX} No subscriptions for user ${userId}. Skipping.`);
        return;
      }

      const stringifiedPayload = JSON.stringify(payload);
      const results = await Promise.allSettled(
        user.pushSubscriptions.map(async (sub) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: sub.endpoint,
                keys: sub.keys,
              },
              stringifiedPayload
            );
            logger.info(`${LOG_PREFIX} Successfully sent notification to user ${userId} on device ${sub.deviceHint || 'unknown'}`);
            return { endpoint: sub.endpoint, success: true };
          } catch (error: any) {
            // SELF-HEALING: If the push service returns 410 (Gone) or 404 (Not Found),
            // the subscription is no longer valid. We should remove it from the DB.
            if (error.statusCode === 410 || error.statusCode === 404) {
              logger.info(`${LOG_PREFIX} Pruning expired subscription for user ${userId}: ${sub.endpoint}`);
              return { endpoint: sub.endpoint, success: false, prune: true };
            }
            throw error;
          }
        })
      );

      // Identify endpoints that need to be pruned
      const endpointsToPrune = results
        .filter((r): r is PromiseFulfilledResult<{ endpoint: string; success: boolean; prune?: boolean }> => 
          r.status === 'fulfilled' && r.value.prune === true
        )
        .map(r => r.value.endpoint);

      if (endpointsToPrune.length > 0) {
        await User.updateOne(
          { _id: userId },
          {
            $pull: {
              pushSubscriptions: { endpoint: { $in: endpointsToPrune } },
            },
          }
        );
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
