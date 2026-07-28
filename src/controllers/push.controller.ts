import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import PushService from '../services/push.service';

export class PushController {
    static subscribe = asyncHandler(async (req: Request, res: Response) => {
        const { subscription, deviceHint } = req.body;
        const userId = req.user?._id;

        if (!subscription || !subscription.endpoint || !subscription.keys) {
            throw new ApiError(400, 'Invalid subscription object. Expected endpoint and keys (p256dh, auth).');
        }

        // A browser/PWA push endpoint represents one installed app instance.
        // Keep endpoint ownership exclusive so a shared device or account switch
        // cannot keep receiving another user's notifications. Excluded: a CrmUser
        // record sharing this user's email — that's this same person's CRM/Supra
        // Space identity on the same device, not a foreign session. Without this
        // exclusion, this subscribe and the CRM subscribe race on every shared
        // dashboard load and silently strip each other's subscription.
        await Promise.all([
            User.updateMany(
                { 'pushSubscriptions.endpoint': subscription.endpoint },
                {
                    $pull: { pushSubscriptions: { endpoint: subscription.endpoint } },
                }
            ),
            CrmUser.updateMany(
                { email: { $ne: req.user?.email }, 'pushSubscriptions.endpoint': subscription.endpoint },
                {
                    $pull: { pushSubscriptions: { endpoint: subscription.endpoint } },
                }
            ),
        ]);

        await User.updateOne(
            { _id: userId },
            {
                $push: {
                    pushSubscriptions: {
                        endpoint: subscription.endpoint,
                        keys: subscription.keys,
                        deviceHint,
                        createdAt: new Date(),
                    },
                },
            }
        );

        return res.status(200).json(new ApiResponse(200, {}, 'Device subscribed to push notifications successfully.'));
    });

    static unsubscribe = asyncHandler(async (req: Request, res: Response) => {
        const { endpoint } = req.body;
        const userId = req.user?._id;

        if (!endpoint) {
            throw new ApiError(400, 'Endpoint is required for unsubscription.');
        }

        await User.updateOne(
            { _id: userId },
            {
                $pull: { pushSubscriptions: { endpoint } },
            }
        );

        return res.status(200).json(new ApiResponse(200, {}, 'Device unsubscribed from push notifications.'));
    });

    static broadcast = asyncHandler(async (req: Request, res: Response) => {
        const { roleTarget, userIds, title, body, url, image, icon } = req.body;

        if (req.user?.role !== 'super_admin' && req.user?.role !== 'admin') {
            throw new ApiError(403, 'You do not have permission to broadcast notifications.');
        }

        if (!title || !body) {
            throw new ApiError(400, 'title and body are required for broadcast.');
        }

        let targets: string[] = [];

        if (roleTarget) {
            const userQuery: Record<string, unknown> = {
                role: roleTarget,
                'pushSubscriptions.0': { $exists: true }
            };

            if (req.user?.role === 'admin') {
                if (!req.orgId) {
                    throw new ApiError(400, 'Organization context is required for admin broadcasts.');
                }
                userQuery.organizationId = req.orgId;
            }

            const users = await User.find(userQuery).select('_id');
            targets = users.map(u => u._id.toString());
        } else if (userIds && Array.isArray(userIds)) {
            targets = userIds;
        }

        if (targets.length === 0) {
            return res.status(200).json(new ApiResponse(200, [], 'No active subscriptions found for the given targets.'));
        }

        const payload = {
            title,
            body,
            image,
            icon,
            data: { url: url || '/' }
        };

        const results = await PushService.broadcast(targets, payload);

        return res.status(200).json(new ApiResponse(200, results, `Broadcast to ${targets.length} users completed.`));
    });
}

export default PushController;
