import webpush from 'web-push';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';

const LOG_PREFIX = '[CrmPushService]';

webpush.setVapidDetails(
  config.push.vapidSubject,
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);

export class CrmPushService {
  static async sendToAdmins(payload: object): Promise<void> {
    const admins = await CrmUser.find({ role: { $in: ['admin', 'manager'] }, isActive: true })
      .select('_id fullName pushSubscriptions')
      .lean();

    const stringifiedPayload = JSON.stringify(payload);

    await Promise.allSettled(
      admins.map(async (admin) => {
        if (!admin.pushSubscriptions?.length) return;

        const endpointsToPrune: string[] = [];

        await Promise.allSettled(
          admin.pushSubscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                stringifiedPayload
              );
            } catch (error: any) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                endpointsToPrune.push(sub.endpoint);
              } else {
                logger.warn(`${LOG_PREFIX} Push failed for admin ${admin.fullName}: ${error.message}`);
              }
            }
          })
        );

        if (endpointsToPrune.length > 0) {
          await CrmUser.updateOne(
            { _id: admin._id },
            { $pull: { pushSubscriptions: { endpoint: { $in: endpointsToPrune } } } }
          );
        }
      })
    );
  }
}

export default CrmPushService;
