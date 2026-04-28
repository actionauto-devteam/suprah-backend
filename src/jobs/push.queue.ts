import { Queue } from 'bullmq';
import config from '../config';
import logger from '../utils/logger';

const LOG_PREFIX = '[PushQueue]';

/**
 * Shared Redis connection settings for BullMQ.
 * Note: BullMQ requires a dedicated ioredis instance or connection object.
 */
export const bullConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  // Ensure the connection doesn't block the event loop
  maxRetriesPerRequest: null,
};

/**
 * The BullMQ Queue for handling Web Push notifications.
 * It is configured with exponential backoff and automatic cleanup.
 */
export let pushQueue: Queue | null = null;

if (config.redis.enabled) {
  pushQueue = new Queue('push-notifications', {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour for monitoring
          count: 1000,
      },
      removeOnFail: {
          age: 24 * 3600, // Keep failed jobs for 24 hours for debugging
          count: 5000,
      },
    },
  });
  logger.info(`${LOG_PREFIX} initialized.`);
} else {
  logger.info(`${LOG_PREFIX} skipped (REDIS_ENABLED=false).`);
}

export default pushQueue;
