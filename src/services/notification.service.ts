import Notification from '../models/Notification.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';
import { emitToUser } from '../utils/socketEmitter';
import PushService from './push.service';
import logger from '../utils/logger';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
}

const VALID_NOTIFICATION_TYPES = [
  'quote_created', 'quote_updated', 'quote_deleted', 'quote_converted', 'quote_accepted',
  'shipment_created', 'shipment_updated', 'shipment_deleted', 'shipment_status_changed',
  'shipment_assigned', 'shipment_picked_up', 'shipment_delivered', 'proof_of_delivery',
  'shipment_arrived_at_pickup', 'shipment_arrived_at_delivery',
  'vehicle_added', 'vehicle_updated', 'vehicle_sold', 'vehicle_status_changed',
  'inventory_sync', 'new_inventory_alert',
  'appointment_created', 'appointment_updated', 'appointment_cancelled',
  'appointment_reminder', 'guest_response',
  'new_lead', 'lead_assigned', 'lead_status_changed',
  'crm_message', 'crm_task_assigned', 'crm_task_due', 'crm_biometric', 'crm_timeproof',
  'driver_request', 'driver_request_approved', 'driver_request_rejected',
  'driver_assigned', 'driver_location_update', 'driver_payout',
  'payment_received', 'payment_pending', 'payment_failed', 'payment_request', 'payout_processed',
  'team_invite_sent', 'team_member_joined', 'team_member_left', 'role_changed',
  'password_changed', 'email_changed', 'profile_updated', 'login_alert',
  'system_announcement', 'message_received', 'reminder', 'general',
  'referral_joined', 'referral_rewarded',
  'delivery_confirmed', 'proof_submitted',
] as const;

const PREFERENCE_MAP: Record<string, string> = {
  quote_created: 'quoteCreated',
  quote_updated: 'quoteUpdated',
  quote_deleted: 'quoteDeleted',
  quote_converted: 'quoteCreated',
  quote_accepted: 'quoteUpdated',
  shipment_created: 'shipmentCreated',
  shipment_updated: 'shipmentUpdated',
  shipment_deleted: 'shipmentDeleted',
  shipment_status_changed: 'shipmentUpdated',
  shipment_assigned: 'shipmentCreated',
  shipment_picked_up: 'shipmentUpdated',
  shipment_delivered: 'shipmentUpdated',
  proof_of_delivery: 'shipmentUpdated',
  shipment_arrived_at_pickup: 'shipmentUpdated',
  shipment_arrived_at_delivery: 'shipmentUpdated',
  appointment_created: 'appointmentCreated',
  appointment_updated: 'appointmentUpdated',
  appointment_cancelled: 'appointmentCancelled',
  appointment_reminder: 'appointmentCreated',
  guest_response: 'appointmentUpdated',
  password_changed: 'passwordChanged',
  email_changed: 'emailChanged',
  profile_updated: 'profileUpdated',
  login_alert: 'loginAlerts',
  driver_request: 'driverRequests',
  driver_request_approved: 'driverRequests',
  driver_request_rejected: 'driverRequests',
  driver_assigned: 'shipmentCreated',
  driver_payout: 'shipmentUpdated',
  new_lead: 'crmActivity',
  lead_assigned: 'crmActivity',
  lead_status_changed: 'crmActivity',
  crm_message: 'crmActivity',
  crm_task_assigned: 'crmActivity',
  crm_task_due: 'crmActivity',
  crm_biometric: 'crmActivity',
  crm_timeproof: 'crmActivity',
  reminder: 'crmActivity',
  team_invite_sent: 'crmActivity',
  team_member_joined: 'crmActivity',
  team_member_left: 'crmActivity',
  referral_joined: 'referral_joined',
  referral_rewarded: 'referral_rewarded',
};

const createNotification = async (params: CreateNotificationParams) => {
  const { userId, organizationId, type, title, message, metadata } = params;

  if (!userId || !type || !title || !message) {
    throw new ApiError(400, 'Missing required notification fields');
  }

  if (!VALID_NOTIFICATION_TYPES.includes(type as any)) {
    throw new ApiError(400, `Invalid notification type: ${type}`);
  }

  if (title.length > 200) {
    throw new ApiError(400, 'Notification title must be less than 200 characters');
  }

  if (message.length > 1000) {
    throw new ApiError(400, 'Notification message must be less than 1000 characters');
  }

  // Identity resolution for notifications
  const user = await User.findById(userId) || await CrmUser.findById(userId);
  if (!user) {
    throw new ApiError(404, 'Notification target user not found');
  }

  const preferenceKey = PREFERENCE_MAP[type];
  if (preferenceKey && (user as any).notificationPreferences) {
    const isEnabled = ((user as any).notificationPreferences as any)[preferenceKey];
    if (isEnabled === false) {
      return null;
    }
  }

  const notification = await Notification.create({
    userId,
    organizationId,
    type,
    title,
    message,
    metadata: metadata || {},
    isRead: false,
  });

  emitToUser(userId, 'notification:new', notification);

  // Trigger Web Push Notification
  try {
    const urlMap: Record<string, string> = {
      shipment_assigned: '/driver/loads',
      message_received: '/driver/notifications',
      quote_created: '/transportation?tab=drafts',
      quote_accepted: '/transportation?tab=quotes',
      shipment_delivered: '/transportation?tab=shipments',
      proof_of_delivery: '/driver-tracker',
      shipment_arrived_at_pickup: '/driver-tracker',
      shipment_arrived_at_delivery: '/driver-tracker',
      new_lead: '/crm/dashboard',
      crm_task_due: metadata?.route || '/crm/leads',
      reminder: metadata?.route || '/crm/leads',
      driver_request: '/driver-tracker',
      driver_request_approved: '/driver/loads',
      driver_request_rejected: '/notifications',
    };

    const pushPayload: any = {
      title,
      body: message,
      tag: preferenceKey || 'general', // Group by preference category
      data: {
        url: urlMap[type] || '/notifications',
        notificationId: notification._id,
      },
    };

    // Add interactive actions for driver join requests
    if (type === 'driver_request') {
      pushPayload.actions = [
        { action: 'approve', title: 'Approve' },
        { action: 'reject', title: 'Reject' }
      ];
      // Include the ID in data so the SW can call the API
      pushPayload.data.driverRequestId = metadata?.driverRequestId || notification._id;
    }

    PushService.send(userId, pushPayload).catch(err =>
      logger.error(err, `[PushService] Failed to queue push for user ${userId}`)
    );
  } catch (error: any) {
    logger.error(error, '[NotificationService] Error triggering web push');
  }

  return notification;
};

const createNotificationBatch = async (notifications: CreateNotificationParams[]) => {
  const results = await Promise.allSettled(
    notifications.map(params => createNotification(params))
  );

  return {
    successful: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
    results,
  };
};

const getUserNotifications = async (
  userId: string,
  orgId: string,
  options: { limit?: number; skip?: number; isRead?: boolean; userRole?: string } = {}
) => {
  const { limit = 50, skip = 0, isRead, userRole } = options;
  const normalizedLimit = Number.isFinite(limit) ? Math.max(limit, 0) : 50;
  const normalizedSkip = Number.isFinite(skip) ? Math.max(skip, 0) : 0;
  const shouldFetchAll = normalizedLimit === 0;

  const personalFilter: any = { userId };
  if (isRead !== undefined) personalFilter.isRead = isRead;

  // Support legacy org-level broadcast docs that may not have userId.
  // Newer broadcast notifications are created per-user and are already covered by personalFilter.
  const broadcastFilter: any = {
    organizationId: orgId,
    isBroadcast: true,
    $or: [{ userId: { $exists: false } }, { userId: null }],
  };
  if (userRole) broadcastFilter.roleTargets = { $in: [userRole] };
  if (isRead !== undefined) broadcastFilter.isRead = isRead;

  const fetchLimit = shouldFetchAll ? undefined : normalizedLimit + normalizedSkip;
  const personalQuery = Notification.find(personalFilter).sort({ createdAt: -1 });
  const broadcastQuery = Notification.find(broadcastFilter).sort({ createdAt: -1 });

  if (fetchLimit !== undefined) {
    personalQuery.limit(fetchLimit);
    broadcastQuery.limit(fetchLimit);
  }

  const [personalNotifs, broadcastNotifs, totalPersonal, totalBroadcast, unreadPersonal, unreadBroadcast] =
    await Promise.all([
      personalQuery.lean(),
      broadcastQuery.lean(),
      Notification.countDocuments(personalFilter),
      Notification.countDocuments(broadcastFilter),
      Notification.countDocuments({ ...personalFilter, isRead: false }),
      Notification.countDocuments({ ...broadcastFilter, isRead: false }),
    ]);

  const mergedNotifs = [...personalNotifs, ...broadcastNotifs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(
      normalizedSkip,
      shouldFetchAll ? undefined : normalizedSkip + normalizedLimit,
    );

  return {
    notifications: mergedNotifs,
    total: totalPersonal + totalBroadcast,
    unreadCount: unreadPersonal + unreadBroadcast,
  };
};

const markAsRead = async (notificationId: string, orgId: string, userId: string) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId, organizationId: orgId }, // Strict org scoping
    { isRead: true },
    { new: true }
  );

  if (!notification) {
    throw new ApiError(404, 'Notification not found or access denied');
  }

  // SYNC: Tell other devices to dismiss the push notification
  const preferenceKey = PREFERENCE_MAP[notification.type] || 'general';
  PushService.dismiss(userId, preferenceKey).catch(err =>
    logger.error(err, '[NotificationService] Sync dismiss failed')
  );

  emitToUser(userId, 'notification:read', { notificationId });

  return notification;
};

const markAllAsRead = async (userId: string, orgId: string) => {
  await Notification.updateMany({ userId, organizationId: orgId, isRead: false }, { isRead: true });
  emitToUser(userId, 'notification:readAll', {});
  return { message: 'All notifications marked as read' };
};

const deleteNotification = async (notificationId: string, orgId: string, userId: string) => {
  const notification = await Notification.findOneAndDelete({
    _id: notificationId,
    userId,
    organizationId: orgId, // Strict org scoping
  });

  if (!notification) {
    throw new ApiError(404, 'Notification not found or access denied');
  }

  return notification;
};

const deleteAllRead = async (userId: string, orgId: string) => {
  const result = await Notification.deleteMany({ userId, organizationId: orgId, isRead: true });
  return { message: 'All read notifications deleted', deletedCount: result.deletedCount };
};

const getUnreadCount = async (userId: string, orgId: string, userRole?: string) => {
  const broadcastFilter: any = {
    organizationId: orgId,
    isBroadcast: true,
    isRead: false,
    $or: [{ userId: { $exists: false } }, { userId: null }],
  };

  if (userRole) {
    broadcastFilter.roleTargets = { $in: [userRole] };
  }

  const [personalCount, broadcastCount] = await Promise.all([
    Notification.countDocuments({ userId, isRead: false }),
    Notification.countDocuments(broadcastFilter),
  ]);

  return personalCount + broadcastCount;
};

const cleanupOldNotifications = async (userId: string, daysOld: number = 30) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await Notification.deleteMany({
    userId,
    isRead: true,
    createdAt: { $lt: cutoffDate },
  });

  return result.deletedCount;
};

const broadcastNotification = async (params: {
  organizationId: string;
  roleTargets: string[];
  type: string;
  title: string;
  message: string;
  metadata?: any;
}) => {
  const { organizationId, roleTargets, type, title, message, metadata } = params;

  const users = await User.find({
    organizationId,
    $or: roleTargets.map(role => ({ role })),
  }).select('_id');

  if (users.length === 0) return null;

  const notifications = users.map(user => ({
    userId: user._id,
    organizationId,
    roleTargets,
    type,
    title,
    message,
    metadata,
    isRead: false,
    isBroadcast: true,
  }));

  const created = await Notification.insertMany(notifications);

  users.forEach(user => {
    const userNotif = created.find(n => n.userId?.toString() === user._id.toString());
    if (userNotif) {
      emitToUser(user._id.toString(), 'notification:new', userNotif);
    }
  });

  // Trigger Web Push Broadcast
  try {
    const urlMap: Record<string, string> = {
      shipment_assigned: '/driver/loads',
      message_received: '/driver/notifications',
      quote_created: '/transportation?tab=drafts',
      shipment_delivered: '/transportation?tab=shipments',
      new_lead: '/crm/dashboard',
      driver_request: '/notifications',
    };

    const broadcastPayload = {
      title,
      body: message,
      data: {
        url: urlMap[type] || '/notifications',
      },
    };

    const userIds = users.map(u => u._id.toString());
    PushService.broadcast(userIds, broadcastPayload).catch(err =>
      logger.error(err, '[PushService] Broadcast failed')
    );
  } catch (error: any) {
    logger.error(error, '[NotificationService] Error triggering web push broadcast');
  }

  return created;
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
  broadcastNotification,
};
