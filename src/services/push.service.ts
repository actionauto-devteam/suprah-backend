import mongoose from 'mongoose';
import { pushQueue } from '../jobs/push.queue';
import logger from '../utils/logger';
import config from '../config';
import User from '../models/User.model';

const LOG_PREFIX = '[PushService]';

export class PushService {
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
        return { success: true, sentCount: 0, skippedCount: jobs.length };
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

  /**
   * Finds all admin/super_admin User accounts in the org and sends them a push notification.
   * Used for system-level alerts (e.g. Lot Tech employee events) where the recipient is
   * the organization's admin, not a specific user.
   */
  static async notifyOrgAdmins(
    orgId: string | mongoose.Types.ObjectId,
    payload: { title: string; body: string; tag?: string; data?: Record<string, any> },
  ) {
    try {
      const admins = await User.find({
        organizationId: orgId,
        role: { $in: ['admin', 'super_admin'] },
      }).select('_id').lean();
      if (admins.length === 0) return;
      await PushService.broadcast(admins.map((a) => a._id), { icon: '/icon-192x192.png', ...payload });
    } catch (err: any) {
      logger.error(`${LOG_PREFIX} notifyOrgAdmins failed for org ${orgId}: ${err.message}`);
    }
  }
}

export default PushService;
