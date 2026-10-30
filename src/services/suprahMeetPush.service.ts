import { createHash, randomUUID } from 'crypto';
import Notification from '../models/Notification.model';
import { ICrmPushSubscription } from '../models/CrmUser.model';
import { CrmPushService } from './crmPush.service';

type MeetingPushState = {
  status?: 'sent' | 'pending' | 'expired';
  deliveredDevices?: string[];
  attemptedAt?: Date;
};
const fingerprint = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

/** Durable per-device delivery through the same CRM sender used by other device alerts. */
export async function deliverMeetingDevicePush(notification: any, subscriptions: ICrmPushSubscription[], payload: object) {
  const previous: MeetingPushState = notification.metadata?.devicePush ?? {};
  if (previous.status === 'sent' || previous.status === 'expired') return;
  const expiry = new Date(notification.metadata?.pushExpiresAt ?? notification.createdAt?.getTime?.() + 3_600_000).getTime();
  const scope = { _id: notification._id, userId: notification.userId, organizationId: notification.organizationId };
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    await Notification.updateOne(scope, { $set: { 'metadata.devicePush': { ...previous, status: 'expired', attemptedAt: new Date() } } });
    return;
  }
  const claimToken = randomUUID();
  const claim = await Notification.updateOne({ ...scope,
    'metadata.devicePush.status': { $nin: ['sent', 'expired'] },
    // Reject a stale snapshot if another attempt finished between read and claim.
    'metadata.devicePush.attemptedAt': previous.attemptedAt ?? { $exists: false },
    $or: [
      { 'metadata.devicePush.claimUntil': { $exists: false } },
      { 'metadata.devicePush.claimUntil': { $lte: new Date() } },
    ],
  }, { $set: {
    'metadata.devicePush.claimToken': claimToken,
    'metadata.devicePush.claimUntil': new Date(Date.now() + 45_000),
  } });
  if (claim.modifiedCount === 0) throw new Error('Device push delivery is already being processed');
  const delivered = new Set(previous.deliveredDevices ?? []);
  const excludeEndpoints = subscriptions.filter((sub) => delivered.has(fingerprint(sub.endpoint))).map((sub) => sub.endpoint);
  const delivery = await CrmPushService.sendToUsers([String(notification.userId)], payload, {
    excludeEndpoints, timeoutMs: 10_000,
    ttlSeconds: Number.isFinite(expiry) ? Math.max(0, Math.min(86400, Math.ceil((expiry - Date.now()) / 1000))) : 3600,
    onDelivered: (endpoint) => { delivered.add(fingerprint(endpoint)); },
  });
  const pending = delivery.failed > 0 || delivered.size === 0;
  // Store hashes only. Browser subscription endpoints are credentials and must not
  // be copied into bell notifications that are also delivered to page clients.
  await Notification.updateOne({ ...scope, 'metadata.devicePush.claimToken': claimToken }, { $set: { 'metadata.devicePush': {
    status: pending ? 'pending' : 'sent', deliveredDevices: [...delivered],
    attemptedAt: new Date(), accepted: delivered.size, failed: delivery.failed,
    noSubscriptions: pending && (delivery.skippedNoSubscriptions > 0 || delivery.skippedNoMatchingHint > 0),
  } } });
  if (pending) throw new Error(delivery.failed > 0
    ? `Device push failed for ${delivery.failed} subscription(s)`
    : 'No registered device accepted this meeting notification');
}
