import webpush from 'web-push';
import config from '../config';
import User from '../models/User.model';
import mongoose from 'mongoose';

// Initialize web-push with VAPID details
webpush.setVapidDetails(
    config.push.vapidSubject,
    config.push.vapidPublicKey,
    config.push.vapidPrivateKey
);

export class PushService {
    /**
     * Sends a push notification to all valid subscriptions for a specific user.
     * Handles automatic cleanup of dead/expired subscriptions (410, 404).
     * 
     * @param userId The ID of the user to notify
     * @param payload The notification payload (title, body, url, etc.)
     */
    static async send(userId: string | mongoose.Types.ObjectId, payload: any) {
        const user = await User.findById(userId);

        if (!user || !user.pushSubscriptions || user.pushSubscriptions.length === 0) {
            return { success: false, message: 'No active push subscriptions found for user.' };
        }

        const payloadString = JSON.stringify(payload);
        const results = await Promise.allSettled(
            user.pushSubscriptions.map(async (sub) => {
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: sub.endpoint,
                            keys: {
                                p256dh: sub.keys.p256dh,
                                auth: sub.keys.auth,
                            },
                        },
                        payloadString
                    );
                } catch (error: any) {
                    // 410 Gone or 404 Not Found - The subscription is no longer valid
                    if (error.statusCode === 410 || error.statusCode === 404) {
                        await User.updateOne(
                            { _id: userId },
                            { $pull: { pushSubscriptions: { endpoint: sub.endpoint } } }
                        );
                    }
                    throw error;
                }
            })
        );

        const successful = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.filter((r) => r.status === 'rejected').length;

        return {
            success: true,
            sentCount: successful,
            failedCount: failed,
        };
    }

    /**
     * Sends a broadcast push notification to multiple users.
     */
    static async broadcast(userIds: (string | mongoose.Types.ObjectId)[], payload: any) {
        return Promise.allSettled(userIds.map((id) => this.send(id, payload)));
    }
}

export default PushService;
