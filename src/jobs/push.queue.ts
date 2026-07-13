import { Queue } from 'bullmq';
import config from '../config';
import logger from '../utils/logger';

const LOG_PREFIX = '[PushQueue]';

export const bullConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
};

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
          age: 3600,
          count: 1000,
      },
      removeOnFail: {
          age: 24 * 3600,
          count: 5000,
      },
    },
  });
  logger.info(`${LOG_PREFIX} initialized.`);
} else {
  logger.info(`${LOG_PREFIX} skipped (REDIS_ENABLED=false).`);
}

export default pushQueue;
