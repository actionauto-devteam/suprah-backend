import webpush from 'web-push';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
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

function rememberLatestOwner(
  owners: Map<string, { ownerKey: string; createdAt: number }>,
  endpoint: string,
  ownerKey: string,
  createdAt?: Date
): void {
  const timestamp = createdAt?.getTime?.() || 0;
  const current = owners.get(endpoint);
  if (!current || timestamp >= current.createdAt) {
    owners.set(endpoint, { ownerKey, createdAt: timestamp });
  }
}

async function getLatestPushEndpointOwners(endpoints: string[]): Promise<Map<string, { ownerKey: string; createdAt: number }>> {
  const owners = new Map<string, { ownerKey: string; createdAt: number }>();
  if (!endpoints.length) return owners;

  const [crmOwners, appOwners] = await Promise.all([
    CrmUser.find({ 'pushSubscriptions.endpoint': { $in: endpoints } })
      .select('_id pushSubscriptions')
      .lean(),
    User.find({ 'pushSubscriptions.endpoint': { $in: endpoints } })
      .select('_id pushSubscriptions')
      .lean(),
  ]);

  crmOwners.forEach((user) => {
    user.pushSubscriptions?.forEach((sub) => {
      if (endpoints.includes(sub.endpoint)) {
        rememberLatestOwner(owners, sub.endpoint, `crm:${user._id.toString()}`, sub.createdAt);
      }
    });
  });

  appOwners.forEach((user) => {
    user.pushSubscriptions?.forEach((sub) => {
      if (endpoints.includes(sub.endpoint)) {
        rememberLatestOwner(owners, sub.endpoint, `user:${user._id.toString()}`, sub.createdAt);
      }
    });
  });

  return owners;
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

    const endpoints = [
      ...new Set(
        users.flatMap((user) =>
          (user.pushSubscriptions || []).map((sub) => sub.endpoint).filter(Boolean)
        )
      ),
    ];
    const latestOwnerByEndpoint = await getLatestPushEndpointOwners(endpoints);

    const stringifiedPayload = JSON.stringify(payload);

    await Promise.allSettled(
      users.map(async (user) => {
        if (!user.pushSubscriptions?.length) {
          stats.skippedNoSubscriptions += 1;
          logger.debug(`${LOG_PREFIX} No CRM push subscriptions for user ${user._id}.`);
          return;
        }

        const endpointsToPrune: string[] = [];

        const currentOwnerKey = `crm:${user._id.toString()}`;
        const targetSubscriptions = user.pushSubscriptions.filter((sub) => {
          const latestOwner = latestOwnerByEndpoint.get(sub.endpoint);
          if (latestOwner && latestOwner.ownerKey !== currentOwnerKey) {
            endpointsToPrune.push(sub.endpoint);
            logger.warn(
              `${LOG_PREFIX} Skipping stale push endpoint for user ${user._id}; latest owner is ${latestOwner.ownerKey}.`
            );
            return false;
          }
          return matchesDeviceHint(sub.deviceHint, options.deviceHints);
        });
        stats.subscriptions += targetSubscriptions.length;
        if (!targetSubscriptions.length) {
          if (endpointsToPrune.length > 0) {
            stats.pruned += endpointsToPrune.length;
            await CrmUser.updateOne(
              { _id: user._id },
              { $pull: { pushSubscriptions: { endpoint: { $in: endpointsToPrune } } } }
            );
          }
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
