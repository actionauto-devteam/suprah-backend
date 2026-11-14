import mongoose from 'mongoose';
import { pushQueue } from '../jobs/push.queue';
import logger from '../utils/logger';
import config from '../config';
import User from '../models/User.model';
import CrmPushService from './crmPush.service';
import UnifiedPushService from './unifiedPush.service';

const LOG_PREFIX = '[PushService]';

export class PushService {
  static async send(userId: string | mongoose.Types.ObjectId, payload: any) {
    if (payload?.isSyncAction) return UnifiedPushService.dismiss(userId.toString(), String(payload.tag || ''));
    if (!config.redis.enabled || !pushQueue) {
      // Keep delivery working on deployments without the optional queue.
      const result = await UnifiedPushService.sendToUser(userId.toString(), payload);
      return { success: result.failed === 0, ...result, message: 'Push processed directly.' };
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
   * Clear read notifications on connected devices without silent Web Push.
   */
  static async dismiss(userId: string | mongoose.Types.ObjectId, tag: string) {
    return UnifiedPushService.dismiss(userId.toString(), tag);
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
        const results = await Promise.all(userIds.map(id => UnifiedPushService.sendToUser(id.toString(), payload)));
        return { success: results.every(result => result.failed === 0),
          sentCount: results.reduce((sum, result) => sum + result.sent, 0) };
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
   * Single entry point for "notify this org's admins" regardless of which
   * account model (main User or CrmUser) they happen to be signed in with —
   * an admin who only has a CrmUser account, or only a User account, still
   * gets the notification either way. Used for system-level alerts (Lot Tech
   * events, CRM idle/break-exceeded alerts, etc).
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
      if (admins.length > 0) {
        await PushService.broadcast(admins.map((a) => a._id), { icon: '/icon-192x192.png', ...payload });
      }
    } catch (err: any) {
      logger.error(`${LOG_PREFIX} notifyOrgAdmins (User) failed for org ${orgId}: ${err.message}`);
    }

    try {
      await CrmPushService.sendToOrgAdmins(orgId as any, { icon: '/icon-192x192.png', ...payload });
    } catch (err: any) {
      logger.error(`${LOG_PREFIX} notifyOrgAdmins (CrmUser) failed for org ${orgId}: ${err.message}`);
    }
  }
}

export default PushService;
