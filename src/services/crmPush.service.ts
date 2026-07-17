import webpush from 'web-push';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';

const LOG_PREFIX = '[CrmPushService]';

type CrmPushSendOptions = {
  deviceHints?: string[];
};

type CrmPushSendResult = {
  users: number;
  subscriptions: number;
  sent: number;
  failed: number;
  pruned: number;
  skippedNoSubscriptions: number;
  skippedNoMatchingHint: number;
};

function matchesDeviceHint(deviceHint: string | undefined, allowedHints?: string[]): boolean {
  if (!allowedHints?.length) return true;
  const normalizedHint = (deviceHint || '').toLowerCase();
  // Legacy CRM push subscriptions may not have a deviceHint because the field
  // was added after users had already installed the PWA. Do not drop those
  // subscriptions when SupraSpace sends to mobile/PWA devices while the socket
  // still appears online.
  if (!normalizedHint || normalizedHint === 'unknown') return true;
  return allowedHints.some((hint) => normalizedHint.includes(hint.toLowerCase()));
}

webpush.setVapidDetails(
  config.push.vapidSubject,
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);

export class CrmPushService {
  static async sendToUsers(userIds: string[], payload: object, options: CrmPushSendOptions = {}): Promise<CrmPushSendResult> {
    const stats: CrmPushSendResult = {
      users: 0,
      subscriptions: 0,
      sent: 0,
      failed: 0,
      pruned: 0,
      skippedNoSubscriptions: 0,
      skippedNoMatchingHint: 0,
    };
    if (!userIds.length) return stats;
    const users = await CrmUser.find({ _id: { $in: userIds }, isActive: true })
      .select('_id pushSubscriptions')
      .lean();
    stats.users = users.length;

    const stringifiedPayload = JSON.stringify(payload);

    await Promise.allSettled(
      users.map(async (user) => {
        if (!user.pushSubscriptions?.length) {
          stats.skippedNoSubscriptions += 1;
          logger.debug(`${LOG_PREFIX} No CRM push subscriptions for user ${user._id}.`);
          return;
        }

        const endpointsToPrune: string[] = [];

        const targetSubscriptions = user.pushSubscriptions.filter((sub) =>
          matchesDeviceHint(sub.deviceHint, options.deviceHints)
        );
        stats.subscriptions += targetSubscriptions.length;
        if (!targetSubscriptions.length) {
          stats.skippedNoMatchingHint += 1;
          logger.debug(`${LOG_PREFIX} No matching CRM push subscriptions for user ${user._id}. Stored hints: ${
            user.pushSubscriptions.map((sub) => sub.deviceHint || 'unknown').join(', ')
          }`);
          return;
        }

        await Promise.allSettled(
          targetSubscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                stringifiedPayload,
                { TTL: 86400 }
              );
              stats.sent += 1;
            } catch (error: any) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                endpointsToPrune.push(sub.endpoint);
              } else {
                stats.failed += 1;
                logger.warn(`${LOG_PREFIX} Push failed for user ${user._id}: ${error.message}`);
              }
            }
          })
        );

        if (endpointsToPrune.length > 0) {
          stats.pruned += endpointsToPrune.length;
          await CrmUser.updateOne(
            { _id: user._id },
            { $pull: { pushSubscriptions: { endpoint: { $in: endpointsToPrune } } } }
          );
        }
      })
    );
    return stats;
  }

  // Org-scoped — always prefer this over a global admin fan-out to avoid
  // leaking one organization's employee events to every other org's admins.
  static async sendToOrgAdmins(orgId: string | object, payload: object): Promise<void> {
    const admins = await CrmUser.find({ organizationId: orgId, role: { $in: ['admin', 'manager'] }, isActive: true })
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
