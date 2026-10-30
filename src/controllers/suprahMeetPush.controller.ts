import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import CrmUser from '../models/CrmUser.model';
import { CrmPushService } from '../services/crmPush.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';

/** Sends an actual Web Push to the signed-in person's current browser only. */
export const testMeetingDevicePush = asyncHandler(async (req: Request, res: Response) => {
  const self = req.crmUser;
  if (!self?.organizationId) throw new ApiError(401, 'Sign in to test device notifications.');
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) throw new ApiError(400, 'Enable notifications on this device before testing.');
  const user = await CrmUser.findOne({ _id: self._id, organizationId: self.organizationId, isActive: true })
    .select('pushSubscriptions').lean();
  const subscriptions = user?.pushSubscriptions ?? [];
  if (!subscriptions.some((sub) => sub.endpoint === endpoint && sub.appSource !== 'supraspace')) {
    throw new ApiError(409, 'This device is not registered for Suprah Meet alerts. Enable device alerts here and try again.');
  }
  const result = await CrmPushService.sendToUsers([String(self._id)], {
    source: 'Suprah Meet', title: 'Device notification test',
    body: 'Meeting invitations, reminders, and room-open alerts can appear here, even when Suprah is closed.',
    tag: `suprah-meet-test:${randomUUID()}`,
    data: { url: '/crm/suprah-meet', priority: 'high', soundProfile: 'attention' },
  }, { excludeEndpoints: subscriptions.filter((sub) => sub.endpoint !== endpoint).map((sub) => sub.endpoint), ttlSeconds: 60, timeoutMs: 10_000 });
  if (result.sent === 0) throw new ApiError(502, 'The push service did not accept this device notification. Re-enable device alerts and try again.');
  res.json(new ApiResponse(200, { accepted: true }, 'Sent to the device push service. Look for the notification in your device notification area.'));
});
