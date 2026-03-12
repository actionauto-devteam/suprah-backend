import Notification from '../models/Notification.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import { emitToUser } from '../utils/socketEmitter';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
}

const VALID_NOTIFICATION_TYPES = [
  'quote_created', 'quote_updated', 'quote_deleted', 'quote_converted',
  'shipment_created', 'shipment_updated', 'shipment_deleted', 'shipment_status_changed',
  'shipment_assigned', 'shipment_picked_up', 'shipment_delivered', 'proof_of_delivery',
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
  shipment_created: 'shipmentCreated',
  shipment_updated: 'shipmentUpdated',
  shipment_deleted: 'shipmentDeleted',
  shipment_status_changed: 'shipmentUpdated',
  shipment_assigned: 'shipmentCreated',
  shipment_picked_up: 'shipmentUpdated',
  shipment_delivered: 'shipmentUpdated',
  proof_of_delivery: 'shipmentUpdated',
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

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const preferenceKey = PREFERENCE_MAP[type];
  if (preferenceKey && user.notificationPreferences) {
    const isEnabled = (user.notificationPreferences as any)[preferenceKey];
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

  const personalFilter: any = { userId };
  if (isRead !== undefined) personalFilter.isRead = isRead;

  const broadcastFilter: any = {
    organizationId: orgId,
    isBroadcast: true,
  };
  if (userRole) broadcastFilter.roleTargets = { $in: [userRole] };
  if (isRead !== undefined) broadcastFilter.isRead = isRead;

  const fetchLimit = limit + skip;

  const [personalNotifs, broadcastNotifs, totalPersonal, totalBroadcast, unreadPersonal, unreadBroadcast] =
    await Promise.all([
      Notification.find(personalFilter).sort({ createdAt: -1 }).limit(fetchLimit).lean(),
      Notification.find(broadcastFilter).sort({ createdAt: -1 }).limit(fetchLimit).lean(),
      Notification.countDocuments(personalFilter),
      Notification.countDocuments(broadcastFilter),
      Notification.countDocuments({ ...personalFilter, isRead: false }),
      Notification.countDocuments({ ...broadcastFilter, isRead: false }),
    ]);

  const allNotifs = [...personalNotifs, ...broadcastNotifs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(skip, skip + limit);

  return {
    notifications: allNotifs,
    total: totalPersonal + totalBroadcast,
    unreadCount: unreadPersonal + unreadBroadcast,
  };
};

const markAsRead = async (notificationId: string, orgId: string, userId: string) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { isRead: true },
    { new: true }
  );

  if (!notification) {
    throw new ApiError(404, 'Notification not found');
  }

  emitToUser(userId, 'notification:read', { notificationId });

  return notification;
};

const markAllAsRead = async (userId: string, orgId: string) => {
  await Notification.updateMany({ userId, isRead: false }, { isRead: true });
  emitToUser(userId, 'notification:readAll', {});
  return { message: 'All notifications marked as read' };
};

const deleteNotification = async (notificationId: string, orgId: string, userId: string) => {
  const notification = await Notification.findOneAndDelete({
    _id: notificationId,
    userId,
  });

  if (!notification) {
    throw new ApiError(404, 'Notification not found');
  }

  return notification;
};

const deleteAllRead = async (userId: string, orgId: string) => {
  const result = await Notification.deleteMany({ userId, isRead: true });
  return { message: 'All read notifications deleted', deletedCount: result.deletedCount };
};

const getUnreadCount = async (userId: string, orgId: string) => {
  const [personalCount, broadcastCount] = await Promise.all([
    Notification.countDocuments({ userId, isRead: false }),
    Notification.countDocuments({
      organizationId: orgId,
      isBroadcast: true,
      isRead: false,
    }),
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