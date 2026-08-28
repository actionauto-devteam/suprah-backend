import webpush from 'web-push';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import logger from '../utils/logger';
import { normalizePushPayload } from '../utils/pushPayload';

const LOG_PREFIX = '[CrmPushService]';

// A push send can fail for reasons that never surface as a clean 404/410 (iOS
// web push is known to be inconsistent about this, especially for a
// torn-down/reinstalled PWA's orphaned endpoint) — without this, a dead
// subscription that never 404s just sits there forever, silently failing on
// every future send with nothing pruning it and nothing alerting anyone.
// Requiring several consecutive failures (not a single blip) avoids evicting
// a subscription over one transient network error.
const STALE_FAILURE_THRESHOLD = 5;

type CrmPushSendOptions = {
  deviceHints?: string[];
  // Restricts delivery to subscriptions registered from these app origins
  // ('main' | 'supraspace' — see ICrmPushSubscription.appSource). Undefined/
  // empty matches everything, same leniency as deviceHints, so subscriptions
  // predating this field (no appSource at all) are never silently dropped.
  appSources?: string[];
  // Endpoints to skip outright regardless of the filters above — used to
  // avoid double-pushing the same message to a phone that has both the
  // main app's embedded SupraSpace view and the dedicated SupraSpace app
  // installed (see pushToConversationMembers's hasDedicatedMobileApp).
  excludeEndpoints?: string[];
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

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

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

function matchesAppSource(appSource: string | undefined, allowedSources?: string[]): boolean {
  // Opposite leniency from matchesDeviceHint on purpose: a subscription with
  // no appSource predates this field, meaning it genuinely came from the
  // main-app flow (SupraSpace's own subdomain didn't exist yet) — treating
  // it as 'main' preserves the mute it was always subject to, rather than
  // accidentally exempting it.
  const normalized = appSource || 'main';
  if (!allowedSources?.length) {
    // No explicit filter = every OTHER CRM notification type (transportation,
    // leads, driver requests, general admin broadcasts, etc.) — none of them
    // pass appSources at all. The dedicated SupraSpace app is meant to be a
    // focused, chat-only surface (see pushToConversationMembers, the ONE
    // caller that explicitly opts back in with appSources including
    // 'supraspace'), so it's excluded by default here rather than included.
    return normalized !== 'supraspace';
  }
  return allowedSources.includes(normalized);
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

// Scoped to CrmUser only — deliberately does NOT also consider User-model
// owners of the same endpoint. A single device legitimately holds a push
// subscription row on BOTH models at once for the same physical person (main
// site + CRM/SupraSpace are separate logins) — the subscribe endpoints
// (push.controller.ts, crmTimeproof.controller.ts's subscribeCrmPush) already
// correctly guarantee exclusivity where it actually matters (a shared device
// switching between different real people, compared by email). Comparing
// across models here on every SEND re-litigated that already-settled question
// using stale createdAt timestamps instead, and would silently `$pull` a
// perfectly valid CrmUser subscription the moment the sibling User-model
// subscription happened to be re-POSTed more recently (e.g. on every app
// mount — see useWebPush.ts) — the actual cause of "push works on one surface
// but silently stops on the other" for anyone with both accounts.
async function getLatestPushEndpointOwners(endpoints: string[]): Promise<Map<string, { ownerKey: string; createdAt: number }>> {
  const owners = new Map<string, { ownerKey: string; createdAt: number }>();
  if (!endpoints.length) return owners;

  const crmOwners = await CrmUser.find({ 'pushSubscriptions.endpoint': { $in: endpoints } })
    .select('_id pushSubscriptions')
    .lean();

  crmOwners.forEach((user) => {
    user.pushSubscriptions?.forEach((sub) => {
      if (endpoints.includes(sub.endpoint)) {
        rememberLatestOwner(owners, sub.endpoint, `crm:${user._id.toString()}`, sub.createdAt);
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

    const { payload: normalized, topic } = normalizePushPayload(payload as any);
    const stringifiedPayload = JSON.stringify(normalized);

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
          if (options.excludeEndpoints?.includes(sub.endpoint)) return false;
          return matchesDeviceHint(sub.deviceHint, options.deviceHints) && matchesAppSource((sub as any).appSource, options.appSources);
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

        const endpointsSucceeded: string[] = [];
        const endpointsFailedSoft: string[] = [];

        await Promise.allSettled(
          targetSubscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                stringifiedPayload,
                { TTL: 86400, urgency: 'high', ...(topic ? { topic } : {}) }
              );
              stats.sent += 1;
              endpointsSucceeded.push(sub.endpoint);
            } catch (error: any) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                endpointsToPrune.push(sub.endpoint);
              } else {
                stats.failed += 1;
                logger.warn(
                  {
                    userId: user._id,
                    endpointHost: safeEndpointHost(sub.endpoint),
                    statusCode: error.statusCode,
                    body: (error.body || '').toString().slice(0, 500),
                    message: error.message,
                  },
                  `${LOG_PREFIX} Push failed for user ${user._id}`
                );
                const newFailureCount = (sub.failureCount || 0) + 1;
                if (newFailureCount >= STALE_FAILURE_THRESHOLD) {
                  logger.warn(`${LOG_PREFIX} Pruning endpoint for user ${user._id} after ${newFailureCount} consecutive non-410/404 failures.`);
                  endpointsToPrune.push(sub.endpoint);
                } else {
                  endpointsFailedSoft.push(sub.endpoint);
                }
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
        if (endpointsSucceeded.length > 0) {
          await CrmUser.updateOne(
            { _id: user._id },
            { $set: { 'pushSubscriptions.$[elem].lastSuccessAt': new Date(), 'pushSubscriptions.$[elem].failureCount': 0 } },
            { arrayFilters: [{ 'elem.endpoint': { $in: endpointsSucceeded } }] }
          );
        }
        if (endpointsFailedSoft.length > 0) {
          await CrmUser.updateOne(
            { _id: user._id },
            { $inc: { 'pushSubscriptions.$[elem].failureCount': 1 } },
            { arrayFilters: [{ 'elem.endpoint': { $in: endpointsFailedSoft } }] }
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

    const { payload: normalized, topic } = normalizePushPayload(payload as any);
    const stringifiedPayload = JSON.stringify(normalized);

    await Promise.allSettled(
      admins.map(async (admin) => {
        if (!admin.pushSubscriptions?.length) return;

        // General admin broadcasts (this function) are never SupraSpace chat
        // messages — the dedicated SupraSpace app must not receive them, same
        // default as matchesAppSource above.
        const targetSubscriptions = admin.pushSubscriptions.filter((sub: any) => sub.appSource !== 'supraspace');
        if (!targetSubscriptions.length) return;

        const endpointsToPrune: string[] = [];
        const endpointsSucceeded: string[] = [];
        const endpointsFailedSoft: string[] = [];

        await Promise.allSettled(
          targetSubscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                stringifiedPayload,
                { TTL: 86400, urgency: 'high', ...(topic ? { topic } : {}) }
              );
              endpointsSucceeded.push(sub.endpoint);
            } catch (error: any) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                endpointsToPrune.push(sub.endpoint);
              } else {
                logger.warn(
                  {
                    adminId: admin._id,
                    endpointHost: safeEndpointHost(sub.endpoint),
                    statusCode: error.statusCode,
                    body: (error.body || '').toString().slice(0, 500),
                    message: error.message,
                  },
                  `${LOG_PREFIX} Push failed for admin ${admin.fullName}`
                );
                const newFailureCount = (sub.failureCount || 0) + 1;
                if (newFailureCount >= STALE_FAILURE_THRESHOLD) {
                  endpointsToPrune.push(sub.endpoint);
                } else {
                  endpointsFailedSoft.push(sub.endpoint);
                }
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
        if (endpointsSucceeded.length > 0) {
          await CrmUser.updateOne(
            { _id: admin._id },
            { $set: { 'pushSubscriptions.$[elem].lastSuccessAt': new Date(), 'pushSubscriptions.$[elem].failureCount': 0 } },
            { arrayFilters: [{ 'elem.endpoint': { $in: endpointsSucceeded } }] }
          );
        }
        if (endpointsFailedSoft.length > 0) {
          await CrmUser.updateOne(
            { _id: admin._id },
            { $inc: { 'pushSubscriptions.$[elem].failureCount': 1 } },
            { arrayFilters: [{ 'elem.endpoint': { $in: endpointsFailedSoft } }] }
          );
        }
      })
    );
  }
}

export default CrmPushService;
