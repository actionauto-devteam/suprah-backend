import mongoose from 'mongoose';
import { pushQueue } from '../jobs/push.queue';
import logger from '../utils/logger';
import config from '../config';

const LOG_PREFIX = '[PushService]';

/**
 * Service for managing Web Push notifications.
 * Refactored to use BullMQ for background processing.
 */
export class PushService {
  /**
   * Queues a push notification for a specific user.
   * This is a non-blocking operation that returns immediately.
   * 
   * @param userId The ID of the user to notify
   * @param payload The notification payload
   */
  static async send(userId: string | mongoose.Types.ObjectId, payload: any) {
    if (!config.redis.enabled || !pushQueue) {
      logger.debug(`${LOG_PREFIX} Skipping push (Redis is disabled).`);
      return { success: true, message: 'Push skipped (Redis disabled).' };
    }
    try {
      await pushQueue.add('send-push', { 
        userId: userId.toString(), 
        payload 
      });
      return { success: true, message: 'Push notification job queued.' };
    } catch (error: any) {
      logger.error(`${LOG_PREFIX} Failed to queue push job for user ${userId}: ${error.message}`);
      return { success: false, message: 'Failed to queue push notification.' };
    }
  }

  /**
   * Queues a synchronized "dismiss" signal to clear notifications across devices.
   */
  static async dismiss(userId: string | mongoose.Types.ObjectId, tag: string) {
    const payload = {
      isSyncAction: true,
      action: 'dismiss',
      tag: tag,
    };
    return this.send(userId, payload);
  }

  /**
   * Efficiently queues broadcast push notifications for multiple users using bulk ingestion.
   * 
   * @param userIds Array of user IDs to notify
   * @param payload The notification payload
   */
  static async broadcast(userIds: (string | mongoose.Types.ObjectId)[], payload: any) {
    try {
      if (!userIds || userIds.length === 0) return { success: true, sentCount: 0 };

      const jobs = userIds.map(id => ({
        name: 'send-push',
        data: { 
          userId: id.toString(), 
          payload 
        }
      }));

      if (!config.redis.enabled || !pushQueue) {
        logger.debug(`${LOG_PREFIX} Skipping broadcast of ${jobs.length} notifications (Redis is disabled).`);
        return { success: true, sentCount: jobs.length };
      }

      // BullMQ addBulk is highly optimized for performance
      await pushQueue.addBulk(jobs);
      
      logger.info(`${LOG_PREFIX} Queued broadcast for ${jobs.length} users.`);
      return {
        success: true,
        sentCount: jobs.length,
      };
    } catch (error: any) {
      logger.error(`${LOG_PREFIX} Broadcast queuing failed: ${error.message}`);
      return { success: false, message: 'Broadcast queuing failed.' };
    }
  }
}

export default PushService;
