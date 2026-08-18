import webpush from 'web-push';
import config from '../config';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';
import { normalizePushPayload } from '../utils/pushPayload';

const LOG_PREFIX = '[UnifiedPushService]';

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

export type PushRecipientModel = 'User' | 'CrmUser';

webpush.setVapidDetails(
  config.push.vapidSubject,
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);

async function pruneEndpoints(model: PushRecipientModel, userId: string, endpoints: string[]) {
  const update = { $pull: { pushSubscriptions: { endpoint: { $in: endpoints } } } };
  if (model === 'User') {
    await User.updateOne({ _id: userId }, update);
  } else {
    await CrmUser.updateOne({ _id: userId }, update);
  }
}

async function resolveRecipient(userId: string): Promise<{ model: PushRecipientModel; pushSubscriptions: any[] } | null> {
  const user = await User.findById(userId).select('pushSubscriptions').lean();
  if (user) return { model: 'User', pushSubscriptions: user.pushSubscriptions || [] };

  const crmUser = await CrmUser.findById(userId).select('pushSubscriptions').lean();
  if (crmUser) return { model: 'CrmUser', pushSubscriptions: crmUser.pushSubscriptions || [] };

  return null;
}

async function sendToSubscriptions(
  model: PushRecipientModel,
  userId: string,
  subscriptions: Array<{ endpoint: string; keys: { p256dh: string; auth: string } }>,
  payload: object
) {
  if (!subscriptions.length) return { sent: 0, failed: 0, pruned: 0 };

  const { payload: normalized, topic } = normalizePushPayload(payload as any);
  const stringifiedPayload = JSON.stringify(normalized);
  const endpointsToPrune: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          stringifiedPayload,
          { TTL: 86400, urgency: 'high', ...(topic ? { topic } : {}) }
        );
        sent += 1;
      } catch (error: any) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          endpointsToPrune.push(sub.endpoint);
        } else {
          failed += 1;
          logger.warn(
            {
              userId,
              model,
              endpointHost: safeEndpointHost(sub.endpoint),
              statusCode: error.statusCode,
              body: (error.body || '').toString().slice(0, 500),
              message: error.message,
            },
            `${LOG_PREFIX} Push failed for ${model} ${userId}`
          );
        }
      }
    })
  );

  if (endpointsToPrune.length > 0) {
    await pruneEndpoints(model, userId, endpointsToPrune);
  }

  return { sent, failed, pruned: endpointsToPrune.length };
}

const sendToUser = async (userId: string, payload: object) => {
  try {
    const recipient = await resolveRecipient(userId);
    if (!recipient) {
      logger.debug(`${LOG_PREFIX} No User/CrmUser found for id ${userId}.`);
      return { sent: 0, failed: 0, pruned: 0 };
    }
    return await sendToSubscriptions(recipient.model, userId, recipient.pushSubscriptions, payload);
  } catch (error: any) {
    logger.error(error, `${LOG_PREFIX} sendToUser failed for ${userId}`);
    return { sent: 0, failed: 0, pruned: 0 };
  }
};

const dismiss = async (userId: string, tag: string) => {
  return sendToUser(userId, { isSyncAction: true, action: 'dismiss', tag });
};

const broadcastToUsers = async (userIds: string[], payload: object) => {
  await Promise.allSettled(userIds.map((id) => sendToUser(id, payload)));
};

// Org-scoped admin fan-out across both identity models — an admin who only
// has a User account, or only a CrmUser account, still gets notified either
// way (mirrors the existing PushService.notifyOrgAdmins/CrmPushService.sendToOrgAdmins split).
const broadcastToOrgAdmins = async (orgId: string, payload: object) => {
  try {
    const admins = await User.find({
      organizationId: orgId,
      role: { $in: ['admin', 'super_admin'] },
    }).select('_id').lean();
    await Promise.allSettled(admins.map((a) => sendToUser(a._id.toString(), payload)));
  } catch (error: any) {
    logger.error(error, `${LOG_PREFIX} broadcastToOrgAdmins (User) failed for org ${orgId}`);
  }

  try {
    const crmAdmins = await CrmUser.find({
      organizationId: orgId,
      role: { $in: ['admin', 'manager'] },
      isActive: true,
    }).select('_id').lean();
    await Promise.allSettled(crmAdmins.map((a) => sendToUser(a._id.toString(), payload)));
  } catch (error: any) {
    logger.error(error, `${LOG_PREFIX} broadcastToOrgAdmins (CrmUser) failed for org ${orgId}`);
  }
};

export default {
  sendToUser,
  dismiss,
  broadcastToUsers,
  broadcastToOrgAdmins,
};
