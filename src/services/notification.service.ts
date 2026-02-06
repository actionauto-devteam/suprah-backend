import Notification from '../models/Notification.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
}

/**
 * Valid notification types
 */
const VALID_NOTIFICATION_TYPES = [
  'quote_created',
  'quote_updated',
  'quote_deleted',
  'shipment_created',
  'shipment_updated',
  'shipment_deleted',
  'password_changed',
  'email_changed',
  'profile_updated',
  'appointment_created',
  'appointment_updated',
  'appointment_cancelled',
  'appointment_reminder',
  'guest_response', // NEW: For guest RSVP changes
  'message_received',
] as const;

/**
 * Create a new notification
 */
const createNotification = async (params: CreateNotificationParams) => {
  try {
    console.log('=== NOTIFICATION SERVICE DEBUG ===');
    console.log('1. Received params:', params);

    const { userId, type, title, message, metadata } = params;

    // Validate required fields
    if (!userId || !type || !title || !message) {
      console.error('Missing required fields:', { userId, type, title, message });
      throw new ApiError(400, 'Missing required notification fields');
    }

    // Validate notification type
    if (!VALID_NOTIFICATION_TYPES.includes(type as any)) {
      console.error('Invalid notification type:', type);
      throw new ApiError(400, `Invalid notification type: ${type}`);
    }

    // Validate lengths
    if (title.length > 200) {
      console.error('Title too long:', title.length);
      throw new ApiError(400, 'Notification title must be less than 200 characters');
    }

    if (message.length > 1000) {
      console.error('Message too long:', message.length);
      throw new ApiError(400, 'Notification message must be less than 1000 characters');
    }

    // Check if user has notifications enabled for this type
    console.log('2. Looking up user with ID:', userId);
    const user = await User.findById(userId);

    if (!user) {
      console.log('3. ❌ User not found!');
      throw new ApiError(404, 'User not found');
    }

    console.log('3. ✅ User found:', {
      id: user._id,
      email: user.email,
      name: user.name
    });
    console.log('4. User notification preferences:', user.notificationPreferences);

    // Map notification types to preference keys
    const preferenceMap: { [key: string]: keyof typeof user.notificationPreferences } = {
      'quote_created': 'quoteCreated',
      'quote_updated': 'quoteUpdated',
      'quote_deleted': 'quoteDeleted',
      'shipment_created': 'shipmentCreated',
      'shipment_updated': 'shipmentUpdated',
      'shipment_deleted': 'shipmentDeleted',
      'password_changed': 'passwordChanged',
      'email_changed': 'emailChanged',
      'profile_updated': 'profileUpdated',
    };

    const preferenceKey = preferenceMap[type];
    console.log('5. Preference key for type', type, ':', preferenceKey);

    if (preferenceKey) {
      const isEnabled = user.notificationPreferences[preferenceKey];
      console.log('6. Preference enabled?:', isEnabled);

      if (!isEnabled) {
        console.log('7. ❌ Notification disabled by user preference');
        return null;
      }
    }

    console.log('8. Creating notification in database...');
    const notification = await Notification.create({
      userId,
      organizationId: params.organizationId,
      type,
      title,
      message,
      metadata: metadata || {},
      isRead: false,
    });

    console.log('9. ✅ Notification created:', {
      id: notification._id,
      type: notification.type,
      title: notification.title
    });
    console.log('================================');

    return notification;
  } catch (error) {
    console.error('Error in createNotification:', error);
    throw error;
  }
};

/**
 * Create multiple notifications in batch
 */
const createNotificationBatch = async (notifications: CreateNotificationParams[]) => {
  try {
    console.log(`Creating ${notifications.length} notifications in batch`);

    const results = await Promise.allSettled(
      notifications.map(params => createNotification(params))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`Batch complete: ${successful} successful, ${failed} failed`);

    return {
      successful,
      failed,
      results
    };
  } catch (error) {
    console.error('Error in createNotificationBatch:', error);
    throw error;
  }
};

/**
 * Get all notifications for a user
 */
const getUserNotifications = async (userId: string, orgId: string, options: {
  limit?: number;
  skip?: number;
  isRead?: boolean;
} = {}) => {
  try {
    const { limit = 50, skip = 0, isRead } = options;

    const filter: any = { userId, organizationId: orgId };
    if (isRead !== undefined) {
      filter.isRead = isRead;
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await Notification.countDocuments(filter);
    const unreadCount = await Notification.countDocuments({ userId, organizationId: orgId, isRead: false });

    return {
      notifications,
      total,
      unreadCount,
    };
  } catch (error) {
    console.error('Error in getUserNotifications:', error);
    throw error;
  }
};

/**
 * Mark notification as read
 */
const markAsRead = async (notificationId: string, orgId: string, userId: string) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, organizationId: orgId, userId },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      throw new ApiError(404, 'Notification not found');
    }

    return notification;
  } catch (error) {
    console.error('Error in markAsRead:', error);
    throw error;
  }
};

/**
 * Mark all notifications as read
 */
const markAllAsRead = async (userId: string, orgId: string) => {
  try {
    await Notification.updateMany(
      { userId, organizationId: orgId, isRead: false },
      { isRead: true }
    );

    return { message: 'All notifications marked as read' };
  } catch (error) {
    console.error('Error in markAllAsRead:', error);
    throw error;
  }
};

/**
 * Delete a notification
 */
const deleteNotification = async (notificationId: string, orgId: string, userId: string) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      organizationId: orgId,
      userId,
    });

    if (!notification) {
      throw new ApiError(404, 'Notification not found');
    }

    return notification;
  } catch (error) {
    console.error('Error in deleteNotification:', error);
    throw error;
  }
};

/**
 * Delete all read notifications
 */
const deleteAllRead = async (userId: string, orgId: string) => {
  try {
    const result = await Notification.deleteMany({ userId, organizationId: orgId, isRead: true });
    console.log(`Deleted ${result.deletedCount} read notifications for user ${userId}`);
    return { message: 'All read notifications deleted', deletedCount: result.deletedCount };
  } catch (error) {
    console.error('Error in deleteAllRead:', error);
    throw error;
  }
};

/**
 * Get unread count
 */
const getUnreadCount = async (userId: string, orgId: string) => {
  try {
    const count = await Notification.countDocuments({ userId, organizationId: orgId, isRead: false });
    return count;
  } catch (error) {
    console.error('Error in getUnreadCount:', error);
    throw error;
  }
};

/**
 * Clean up old read notifications
 * @param userId - User ID to clean notifications for
 * @param daysOld - Delete read notifications older than this many days (default: 30)
 */
const cleanupOldNotifications = async (
  userId: string,
  daysOld: number = 30
) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await Notification.deleteMany({
      userId,
      isRead: true,
      createdAt: { $lt: cutoffDate }
    });

    console.log(`Cleaned up ${result.deletedCount} old notifications for user ${userId}`);
    return result.deletedCount;
  } catch (error) {
    console.error('Error in cleanupOldNotifications:', error);
    throw error;
  }
};

export default {
  createNotification,
  createNotificationBatch,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  getUnreadCount,
  cleanupOldNotifications,
};