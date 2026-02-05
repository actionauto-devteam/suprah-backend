import notificationService from '../services/notification.service';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
}

/**
 * Safely create a notification without throwing errors
 * This prevents notification failures from breaking the main operation
 */
export async function safeCreateNotification(params: CreateNotificationParams) {
  try {
    if (!params.userId) {
      console.warn('No user ID provided for notification');
      return null;
    }

    const notification = await notificationService.createNotification(params);

    if (!notification) {
      console.log(`Notification disabled by user preference: ${params.type}`);
    }

    return notification;
  } catch (error) {
    console.error('Failed to create notification:', error);
    // Don't throw - we don't want notification failures to break the main operation
    return null;
  }
}