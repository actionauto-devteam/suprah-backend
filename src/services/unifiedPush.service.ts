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

interface PushTarget {
  model: PushRecipientModel;
  id: string;
  pushSubscriptions: any[];
}

const RECENT_DELIVERY_MS = 30_000;
const recentDeliveries = new Map<string, { at: number; recipient: string }>();

function deliveryKey(endpoint: string, payload: Record<string, unknown>): string {
  return [endpoint, payload.tag, payload.title, payload.body].map((part) => String(part ?? '')).join('|');
}

function deliveredToOtherIdentity(key: string, recipient: string): boolean {
  const now = Date.now();
  if (recentDeliveries.size > 5000) {
    for (const [stored, entry] of recentDeliveries) if (now - entry.at > RECENT_DELIVERY_MS) recentDeliveries.delete(stored);
  }
  const last = recentDeliveries.get(key);
  if (last && now - last.at < RECENT_DELIVERY_MS && last.recipient !== recipient) return true;
  recentDeliveries.set(key, { at: now, recipient });
  return false;
}

const mainAppSubscriptions = (subs: any[] | undefined, includeSupraSpaceApp: boolean) =>
  includeSupraSpaceApp ? (subs || []) : (subs || []).filter((s: any) => s.appSource !== 'supraspace');

async function resolveTargets(userId: string, includeSupraSpaceApp = false): Promise<PushTarget[]> {
  const user = await User.findById(userId).select('pushSubscriptions email organizationId').lean();
  if (user) {
    const targets: PushTarget[] = [{ model: 'User', id: userId, pushSubscriptions: user.pushSubscriptions || [] }];
    const linked = user.email && user.organizationId
      ? await CrmUser.findOne({ email: user.email, organizationId: user.organizationId, isActive: { $ne: false } }).select('pushSubscriptions').lean()
      : null;
    if (linked) targets.push({ model: 'CrmUser', id: String(linked._id), pushSubscriptions: mainAppSubscriptions(linked.pushSubscriptions, includeSupraSpaceApp) });
    return targets;
  }
  const crmUser = await CrmUser.findById(userId).select('pushSubscriptions email organizationId').lean();
  if (!crmUser) return [];
  const targets: PushTarget[] = [{ model: 'CrmUser', id: userId, pushSubscriptions: mainAppSubscriptions(crmUser.pushSubscriptions, includeSupraSpaceApp) }];
  const linked = crmUser.email && crmUser.organizationId
    ? await User.findOne({ email: crmUser.email, organizationId: crmUser.organizationId }).select('pushSubscriptions').lean()
    : null;
  if (linked) targets.push({ model: 'User', id: String(linked._id), pushSubscriptions: linked.pushSubscriptions || [] });
  return targets;
}

async function sendToSubscriptions(
  model: PushRecipientModel,
  userId: string,
  subscriptions: Array<{ endpoint: string; keys: { p256dh: string; auth: string } }>,
  payload: object,
  recipient = userId,
) {
  if (!subscriptions.length) return { sent: 0, failed: 0, pruned: 0 };

  const { payload: normalized, topic } = normalizePushPayload(payload as any);
  subscriptions = subscriptions.filter((sub) => !deliveredToOtherIdentity(deliveryKey(sub.endpoint, normalized), recipient));
  if (!subscriptions.length) return { sent: 0, failed: 0, pruned: 0 };
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

const sendToUser = async (userId: string, payload: object, includeSupraSpaceApp = false) => {
  try {
    const targets = await resolveTargets(userId, includeSupraSpaceApp);
    if (!targets.length) {
      logger.debug(`${LOG_PREFIX} No User/CrmUser found for id ${userId}.`);
      return { sent: 0, failed: 0, pruned: 0, devices: 0 };
    }
    const seen = new Set<string>();
    const total = { sent: 0, failed: 0, pruned: 0, devices: 0 };
    for (const target of targets) {
      const subs = target.pushSubscriptions.filter((sub: any) => sub?.endpoint && !seen.has(sub.endpoint));
      subs.forEach((sub: any) => seen.add(sub.endpoint));
      total.devices += subs.length;
      const result = await sendToSubscriptions(target.model, target.id, subs, payload, userId);
      total.sent += result.sent;
      total.failed += result.failed;
      total.pruned += result.pruned;
    }
    return total;
  } catch (error: any) {
    logger.error(error, `${LOG_PREFIX} sendToUser failed for ${userId}`);
    return { sent: 0, failed: 1, pruned: 0, devices: 0 };
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
