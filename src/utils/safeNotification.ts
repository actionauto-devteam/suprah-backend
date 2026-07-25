import notificationService from '../services/notification.service';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import Organization from '../models/Organization.model';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
  dedupeKey?: string;
  groupWindowMinutes?: number;
}

interface BroadcastParams {
  organizationId: string;
  roles: string[];
  type: string;
  title: string;
  message: string;
  metadata?: any;
  excludeUserId?: string;
  // Per-recipient dedupeKey is derived as `${dedupeKeyPrefix}:${recipientUserId}`
  // so repeat events about the same subject compile into one evolving
  // notification per admin instead of one row per occurrence.
  grouping?: { dedupeKeyPrefix: string; groupWindowMinutes?: number };
}

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

/**
 * Broadcast notification to all users with specific roles in an organization
 * Useful for notifying all admins, all drivers, etc.
 */
export async function safeBroadcastNotification(params: BroadcastParams) {
  try {
    const { organizationId, roles, type, title, message, metadata, excludeUserId, grouping } = params;

    // Find all users in the organization with the specified roles
    const users = await User.find({
      organizationId,
      $or: [
        { role: { $in: roles } },
        { organizationRole: { $in: roles } }
      ]
    }).select('_id');

    if (users.length === 0) {
      console.log(`No users found in org ${organizationId} with roles ${roles.join(',')}`);
      return null;
    }

    // Create notifications for each user (excluding the triggering user if specified)
    const notifications = await Promise.all(
      users
        .filter(user => !excludeUserId || user._id.toString() !== excludeUserId)
        .map(user =>
          safeCreateNotification({
            userId: user._id.toString(),
            organizationId,
            type,
            title,
            message,
            metadata,
            ...(grouping ? {
              dedupeKey: `${grouping.dedupeKeyPrefix}:${user._id}`,
              groupWindowMinutes: grouping.groupWindowMinutes,
            } : {}),
          })
        )
    );

    const successful = notifications.filter(n => n !== null).length;
    console.log(`Broadcast ${successful}/${users.length} notifications to ${roles.join(',')} in org ${organizationId}`);

    return { successful, total: users.length };
  } catch (error) {
    console.error('Failed to broadcast notification:', error);
    return null;
  }
}

/**
 * Notify all admins in an organization — reaches both identity models: the
 * main-site User admins/super_admins AND CrmUser admins/managers, since a
 * person doing day-to-day admin work may only be logged in via one or the
 * other (they're linked solely by email, not a shared _id).
 */
export async function notifyOrgAdmins(
  organizationId: string,
  type: string,
  title: string,
  message: string,
  metadata?: any,
  excludeUserId?: string,
  grouping?: { dedupeKeyPrefix: string; groupWindowMinutes?: number }
) {
  const userResult = await safeBroadcastNotification({
    organizationId,
    roles: ['admin', 'super_admin'],
    type,
    title,
    message,
    metadata,
    excludeUserId,
    grouping,
  });

  try {
    const crmAdmins = await CrmUser.find({
      organizationId,
      role: { $in: ['admin', 'manager'] },
      isActive: true,
      _id: { $ne: excludeUserId },
    }).select('_id');

    await Promise.all(
      crmAdmins.map((admin) =>
        safeCreateNotification({
          userId: admin._id.toString(),
          organizationId,
          type,
          title,
          message,
          metadata,
          ...(grouping ? {
            dedupeKey: `${grouping.dedupeKeyPrefix}:${admin._id}`,
            groupWindowMinutes: grouping.groupWindowMinutes,
          } : {}),
        })
      )
    );
  } catch (error) {
    console.error('Failed to notify CRM admins:', error);
  }

  return userResult;
}

/**
 * Notify all drivers in an organization
 */
export async function notifyOrgDrivers(
  organizationId: string,
  type: string,
  title: string,
  message: string,
  metadata?: any
) {
  return safeBroadcastNotification({
    organizationId,
    roles: ['driver'],
    type,
    title,
    message,
    metadata,
  });
}

/**
 * Notify all members in an organization (everyone)
 */
export async function notifyOrgMembers(
  organizationId: string,
  type: string,
  title: string,
  message: string,
  metadata?: any,
  excludeUserId?: string
) {
  return safeBroadcastNotification({
    organizationId,
    roles: ['admin', 'super_admin', 'member', 'driver'],
    type,
    title,
    message,
    metadata,
    excludeUserId,
  });
}

/**
 * Notify specific users by their IDs
 */
export async function notifyUsers(
  userIds: string[],
  organizationId: string,
  type: string,
  title: string,
  message: string,
  metadata?: any
) {
  try {
    const notifications = await Promise.all(
      userIds.map(userId =>
        safeCreateNotification({
          userId,
          organizationId,
          type,
          title,
          message,
          metadata,
        })
      )
    );

    const successful = notifications.filter(n => n !== null).length;
    console.log(`Notified ${successful}/${userIds.length} users`);

    return { successful, total: userIds.length };
  } catch (error) {
    console.error('Failed to notify users:', error);
    return null;
  }
}

export async function notifyAllOrganizations(
  type: string,
  title: string,
  message: string,
  metadata?: any,
  excludeOrgId?: string
) {
  try {
    const orgs = await Organization.find({ status: 'active' }).select('_id');
    const results = await Promise.all(
      orgs
        .filter(org => org._id.toString() !== excludeOrgId)
        .map(org => safeBroadcastNotification({
          organizationId: org._id.toString(),
          roles: ['admin', 'super_admin'],
          type,
          title,
          message,
          metadata,
        }))
    );
    console.log(`Cross-org notification sent to ${results.length} organizations`);
    return results;
  } catch (error) {
    console.error('Failed to send cross-org notifications:', error);
    return null;
  }
}