import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import User from '../models/User.model';
import PushService from '../services/push.service';

export class PushController {
    /**
     * Upsert a push subscription for the authenticated user.
     * Path: POST /api/push/subscribe
     */
    static subscribe = asyncHandler(async (req: Request, res: Response) => {
        const { subscription, deviceHint } = req.body;
        const userId = req.user?._id;

        if (!subscription || !subscription.endpoint || !subscription.keys) {
            throw new ApiError(400, 'Invalid subscription object. Expected endpoint and keys (p256dh, auth).');
        }

        // Cleanup existing entry for this specific endpoint to avoid duplicates
        await User.updateOne(
            { _id: userId },
            {
                $pull: { pushSubscriptions: { endpoint: subscription.endpoint } },
            }
        );

        // Add the new/updated subscription
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

    /**
     * Remove a specific push subscription for the authenticated user.
     * Path: DELETE /api/push/subscribe
     */
    static unsubscribe = asyncHandler(async (req: Request, res: Response) => {
        const { endpoint } = req.body; // Usually passed in body or as a query param
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

    /**
     * Broadcast a push notification to specific users or an entire role (restricted to admins).
     * Path: POST /api/push/broadcast
     * Body: { roleTarget?: string, userIds?: string[], title: string, body: string, url?: string, image?: string, icon?: string }
     */
    static broadcast = asyncHandler(async (req: Request, res: Response) => {
        const { roleTarget, userIds, title, body, url, image, icon } = req.body;

        // Authorization: Only admin and super_admin can broadcast
        if (req.user?.role !== 'super_admin' && req.user?.role !== 'admin') {
            throw new ApiError(403, 'You do not have permission to broadcast notifications.');
        }

        if (!title || !body) {
            throw new ApiError(400, 'title and body are required for broadcast.');
        }

        let targets: string[] = [];

        if (roleTarget) {
            // Find all users with this role who have at least one valid push subscription
            const users = await User.find({
                role: roleTarget,
                'pushSubscriptions.0': { $exists: true }
            }).select('_id');
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
            image, // Rich marketing image
            icon,  // Custom campaign icon
            data: { url: url || '/' }
        };

        const results = await PushService.broadcast(targets, payload);

        return res.status(200).json(new ApiResponse(200, results, `Broadcast to ${targets.length} users completed.`));
    });
}

export default PushController;
