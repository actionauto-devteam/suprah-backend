import webpush from 'web-push';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';

const LOG_PREFIX = '[CrmPushService]';

type CrmPushSendOptions = {
  deviceHints?: string[];
};

function matchesDeviceHint(deviceHint: string | undefined, allowedHints?: string[]): boolean {
  if (!allowedHints?.length) return true;
  const normalizedHint = (deviceHint || '').toLowerCase();
  return allowedHints.some((hint) => normalizedHint.includes(hint.toLowerCase()));
}

webpush.setVapidDetails(
  config.push.vapidSubject,
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);

export class CrmPushService {
  static async sendToUsers(userIds: string[], payload: object, options: CrmPushSendOptions = {}): Promise<void> {
    if (!userIds.length) return;
    const users = await CrmUser.find({ _id: { $in: userIds }, isActive: true })
      .select('_id pushSubscriptions')
      .lean();

    const stringifiedPayload = JSON.stringify(payload);

    await Promise.allSettled(
      users.map(async (user) => {
        if (!user.pushSubscriptions?.length) return;

        const endpointsToPrune: string[] = [];

        const targetSubscriptions = user.pushSubscriptions.filter((sub) =>
          matchesDeviceHint(sub.deviceHint, options.deviceHints)
        );
        if (!targetSubscriptions.length) return;

        await Promise.allSettled(
          targetSubscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                stringifiedPayload,
                { TTL: 86400 }
              );
            } catch (error: any) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                endpointsToPrune.push(sub.endpoint);
              } else {
                logger.warn(`${LOG_PREFIX} Push failed for user ${user._id}: ${error.message}`);
              }
            }
          })
        );

        if (endpointsToPrune.length > 0) {
          await CrmUser.updateOne(
            { _id: user._id },
            { $pull: { pushSubscriptions: { endpoint: { $in: endpointsToPrune } } } }
          );
        }
      })
    );
  }

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
                stringifiedPayload,
                { TTL: 86400 }
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
