import webpush from 'web-push';
import config from '../config';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';
import { normalizePushPayload } from '../utils/pushPayload';
import { emitToUser, emitToCrmUser } from '../utils/socketEmitter';

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
const pendingDeliveries = new Map<string, { recipient: string; done: Promise<boolean> }>();

function deliveryKey(endpoint: string, payload: Record<string, unknown>): string {
  return [endpoint, payload.tag, payload.title, payload.body].map((part) => String(part ?? '')).join('|');
}

function deliveredToOtherIdentity(key: string, recipient: string): boolean {
  const now = Date.now();
  const last = recentDeliveries.get(key);
  if (last && now - last.at < RECENT_DELIVERY_MS && last.recipient !== recipient) return true;
  if (last && now - last.at >= RECENT_DELIVERY_MS) recentDeliveries.delete(key);
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
  const stringifiedPayload = JSON.stringify(normalized);
  const endpointsToPrune: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const key = deliveryKey(sub.endpoint, normalized);
      const pending = pendingDeliveries.get(key);
      // A linked identity may race this request. Wait for its actual result
      // before suppressing a duplicate; a failed attempt is safe to retry.
      if (pending && pending.recipient !== recipient && await pending.done) return;
      if (deliveredToOtherIdentity(key, recipient)) return;
      let finish!: (delivered: boolean) => void;
      const reservation = { recipient, done: new Promise<boolean>(resolve => { finish = resolve; }) };
      pendingDeliveries.set(key, reservation);
      let delivered = false;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          stringifiedPayload,
          { TTL: 86400, urgency: 'high', timeout: 15_000, ...(topic ? { topic } : {}) }
        );
        sent += 1;
        delivered = true;
        if (recentDeliveries.size >= 10_000) {
          const oldest = recentDeliveries.keys().next().value;
          if (oldest !== undefined) recentDeliveries.delete(oldest);
        }
        recentDeliveries.set(key, { at: Date.now(), recipient });
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
      } finally {
        finish(delivered);
        if (pendingDeliveries.get(key) === reservation) pendingDeliveries.delete(key);
      }
    })
  );

  if (endpointsToPrune.length > 0) {
    await pruneEndpoints(model, userId, endpointsToPrune);
  }

  return { sent, failed, pruned: endpointsToPrune.length };
}

const sendToUser = async (userId: string, payload: object, includeSupraSpaceApp = false) => {
  if ((payload as { isSyncAction?: boolean }).isSyncAction) {
    return dismiss(userId, String((payload as { tag?: string }).tag || ''));
  }
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
  // Silent Web Push violates userVisibleOnly and can revoke Safari permission.
  // Connected clients can dismiss locally without waking a closed app.
  emitToUser(userId, 'notification:dismiss', { tag });
  emitToCrmUser(userId, 'notification:dismiss', { tag });
  return { sent: 0, failed: 0, pruned: 0 };
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
