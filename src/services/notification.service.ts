import Notification from '../models/Notification.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import { NotificationCategory } from '../models/Notification.model';
import { ApiError } from '../utils/ApiError';
import { emitToUser } from '../utils/socketEmitter';
import UnifiedPushService from './unifiedPush.service';
import logger from '../utils/logger';

interface CreateNotificationParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
  // Repeat-event compiling: when set, a new call within groupWindowMinutes of
  // the last occurrence sharing the same {userId, dedupeKey} updates that
  // existing notification (occurrenceCount++, re-surfaced as unread) instead
  // of creating a new row. Always scope dedupeKey by the event's *subject*
  // (e.g. `agent-idle:${adminId}:${agentUserId}`), never just recipient+type,
  // so unrelated people's events never merge together.
  dedupeKey?: string;
  groupWindowMinutes?: number;
}

const formatOccurrenceTime = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

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
  'feed_mention_post', 'feed_mention_comment', 'feed_comment_on_post', 'feed_announcement',
  'pm_task_assigned', 'pm_task_comment', 'pm_task_status', 'pm_task_updated',
  'pm_group_added', 'pm_task_mention', 'pm_task_deadline',
  'calendar_event_reminder', 'calendar_event_today', 'calendar_event_assigned',
  'driver_request', 'driver_request_approved', 'driver_request_rejected',
  'dealership_inquiry',
  'driver_assigned', 'driver_location_update', 'driver_payout',
  'driver_tracker_geofence_alert', 'driver_tracker_offline_alert', 'driver_tracker_place_visit',
  'driver_dispatch_alert',
  'driver_status_request', 'driver_status_request_approved', 'driver_status_request_rejected',
  'driver_status_request_completed', 'driver_emergency_request',
  'payment_received', 'payment_pending', 'payment_failed', 'payment_request', 'payout_processed',
  'wallet_low_balance', 'wallet_payout_failed',
  'admin_broadcast', 'admin_system_alert', 'admin_staff_activity', 'admin_security_audit',
  'team_invite_sent', 'team_member_joined', 'team_member_left', 'role_changed', 'board_note_posted',
  'password_changed', 'email_changed', 'profile_updated', 'login_alert',
  'system_announcement', 'message_received', 'reminder', 'general', 'ping',
  'referral_joined', 'referral_rewarded',
  'absence_requested', 'absence_approved', 'absence_rejected',
  'delivery_confirmed', 'proof_submitted',
  'aftermarket_inquiry', 'aftermarket_invoice', 'aftermarket_order',
  'location_share_requested',
  'agent_idle', 'agent_idle_escalation', 'agent_screen_recording_missing',
  'customer_call_requested',
] as const;

// Single source of truth for both (a) the `category` stored on the Notification
// doc (used for UI grouping/filter chips) and (b) the preference gate key looked
// up on the recipient's `notificationPreferences` — every type maps to exactly
// one category, so the two can never drift apart the way the old parallel
// VALID_NOTIFICATION_TYPES/schema-enum lists did.
const TYPE_CATEGORY_MAP: Record<string, NotificationCategory> = {
  quote_created: 'transportation', quote_updated: 'transportation', quote_deleted: 'transportation',
  quote_converted: 'transportation', quote_accepted: 'transportation',
  shipment_created: 'transportation', shipment_updated: 'transportation', shipment_deleted: 'transportation',
  shipment_status_changed: 'transportation', shipment_assigned: 'transportation',
  shipment_picked_up: 'transportation', shipment_delivered: 'transportation', proof_of_delivery: 'transportation',
  shipment_arrived_at_pickup: 'transportation', shipment_arrived_at_delivery: 'transportation',
  proof_submitted: 'transportation', delivery_confirmed: 'transportation',
  driver_request: 'transportation', driver_request_approved: 'transportation',
  driver_request_rejected: 'transportation', driver_assigned: 'transportation', driver_payout: 'transportation',

  vehicle_added: 'inventory', vehicle_updated: 'inventory', vehicle_sold: 'inventory',
  vehicle_status_changed: 'inventory', inventory_sync: 'inventory', new_inventory_alert: 'inventory',

  appointment_created: 'appointments', appointment_updated: 'appointments',
  appointment_cancelled: 'appointments', appointment_reminder: 'appointments', guest_response: 'appointments',

  new_lead: 'crm', lead_assigned: 'crm', lead_status_changed: 'crm', crm_message: 'crm',
  crm_task_assigned: 'crm', crm_task_due: 'crm', crm_biometric: 'crm', crm_timeproof: 'crm',
  reminder: 'crm', location_share_requested: 'crm',
  aftermarket_inquiry: 'crm', aftermarket_invoice: 'crm', aftermarket_order: 'crm',
  customer_call_requested: 'crm',

  feed_mention_post: 'feeds', feed_mention_comment: 'feeds', feed_comment_on_post: 'feeds', feed_announcement: 'feeds',

  pm_task_assigned: 'projectManagement', pm_task_comment: 'projectManagement', pm_task_status: 'projectManagement',
  pm_task_updated: 'projectManagement', pm_group_added: 'projectManagement', pm_task_mention: 'projectManagement',
  pm_task_deadline: 'projectManagement',

  calendar_event_reminder: 'calendar', calendar_event_today: 'calendar', calendar_event_assigned: 'calendar',

  driver_location_update: 'driverTracker', driver_tracker_geofence_alert: 'driverTracker',
  driver_tracker_offline_alert: 'driverTracker', driver_tracker_place_visit: 'driverTracker',
  driver_dispatch_alert: 'driverTracker',
  driver_status_request: 'driverTracker', driver_status_request_approved: 'driverTracker',
  driver_status_request_rejected: 'driverTracker', driver_status_request_completed: 'driverTracker',
  driver_emergency_request: 'driverTracker',

  payment_received: 'wallet', payment_pending: 'wallet', payment_failed: 'wallet', payment_request: 'wallet',
  payout_processed: 'wallet', wallet_low_balance: 'wallet', wallet_payout_failed: 'wallet',

  team_invite_sent: 'team', team_member_joined: 'team', team_member_left: 'team', role_changed: 'team',
  board_note_posted: 'team', absence_requested: 'team', absence_approved: 'team', absence_rejected: 'team', ping: 'team',

  password_changed: 'account', email_changed: 'account', profile_updated: 'account', login_alert: 'account',

  referral_joined: 'referrals', referral_rewarded: 'referrals',

  system_announcement: 'system', message_received: 'system', general: 'system',

  admin_broadcast: 'adminBroadcasts',
  admin_system_alert: 'adminSystemAlerts',
  admin_staff_activity: 'adminStaffActivity',
  admin_security_audit: 'adminSecurityAudit',
  dealership_inquiry: 'adminSystemAlerts',

  // Admin-only staff-monitoring alerts — every recipient is always an
  // admin/manager watching another agent's activity (see
  // crmTimeproof.controller.ts), never the agent themselves. Previously
  // mapped to 'crm', which meant the "Staff Activity" admin toggle had no
  // effect on them at all (reported by Erik: turning off Staff Activity
  // didn't stop Agent Idle alerts) — they belong here instead.
  agent_idle: 'adminStaffActivity',
  agent_idle_escalation: 'adminStaffActivity',
  agent_screen_recording_missing: 'adminStaffActivity',
};

// These always deliver (in-app + push) regardless of preference toggles.
// Security events and dispatcher safety alerts must not be silently dropped.
const SECURITY_CRITICAL_TYPES = new Set([
  'password_changed',
  'login_alert',
  'driver_dispatch_alert',
  'driver_emergency_request',
]);

// Short human label per category, prefixed onto the OS push notification's
// title (see utils/pushPayload.ts's normalizePushPayload) so the device-level
// popup itself indicates which part of the system it's from, not just the
// in-app inbox.
const CATEGORY_PUSH_LABELS: Record<NotificationCategory, string> = {
  transportation: 'Transportation', inventory: 'Inventory', appointments: 'Appointments',
  crm: 'CRM', feeds: 'Feeds', projectManagement: 'Project Mgmt', calendar: 'Calendar',
  driverTracker: 'Driver Tracker', wallet: 'Suprah Pay', team: 'Team', account: 'Account',
  referrals: 'Referrals', system: 'System', adminBroadcasts: 'Admin', adminSystemAlerts: 'Admin',
  adminStaffActivity: 'Admin', adminSecurityAudit: 'Admin',
};

// Project Management notification navigation is intentionally normalized here
// because this service also owns the URL embedded in web/PWA push payloads.
// Preserve any future/custom PM route, but repair obsolete Project Management
// aliases and provide a task deep link when taskId is available.
const PROJECT_MANAGEMENT_NOTIFICATION_TYPES = new Set([
  'pm_task_assigned',
  'pm_task_comment',
  'pm_task_status',
  'pm_task_updated',
  'pm_group_added',
  'pm_task_mention',
  'pm_task_deadline',
]);

const LEGACY_PROJECT_MANAGEMENT_PATHS = new Set([
  '/crm/project',
  '/crm/project/',
  '/projects',
  '/projects/',
]);

function parseInternalRoute(route: string): URL | null {
  try {
    return new URL(route, 'http://suprah.local');
  } catch {
    return null;
  }
}

function getProjectManagementTargetUrl(metadata?: any): string {
  const metadataTaskId = String(metadata?.taskId ?? '').trim();
  const metadataGroupId = String(metadata?.groupId ?? '').trim();
  const route = typeof metadata?.route === 'string' ? metadata.route.trim() : '';
  const parsedRoute = route ? parseInternalRoute(route) : null;
  const routeTaskId = String(parsedRoute?.searchParams.get('task') ?? '').trim();
  const routeGroupId = String(parsedRoute?.searchParams.get('group') ?? '').trim();
  const taskId = metadataTaskId || routeTaskId;
  const groupId = metadataGroupId || routeGroupId;

  const params = new URLSearchParams();
  if (groupId) params.set('group', groupId);
  if (taskId) params.set('task', taskId);

  const query = params.toString();
  return query ? `/project?${query}` : '/project';
}

function resolveMetadataRoute(type: string, metadata?: any): string | undefined {
  const route = typeof metadata?.route === 'string' ? metadata.route : '';

  // Non-PM notification routing is intentionally untouched.
  if (!PROJECT_MANAGEMENT_NOTIFICATION_TYPES.has(type)) {
    return route || undefined;
  }

  const normalizedRoute = route.trim();
  const parsedRoute = normalizedRoute ? parseInternalRoute(normalizedRoute) : null;
  const routePathname = parsedRoute?.pathname ?? '';

  // Normalize legacy PM aliases even when they carry query params such as
  // `/projects?task=...`. Comparing the full route string would miss them.
  if (!normalizedRoute || LEGACY_PROJECT_MANAGEMENT_PATHS.has(routePathname)) {
    return getProjectManagementTargetUrl(metadata);
  }

  return route;
}

const createNotification = async (params: CreateNotificationParams) => {
  const { userId, organizationId, type, title, message, metadata, dedupeKey, groupWindowMinutes } = params;

  if (!userId || !type || !title || !message) {
    throw new ApiError(400, 'Missing required notification fields');
  }

  if (!VALID_NOTIFICATION_TYPES.includes(type as any)) {
    throw new ApiError(400, `Invalid notification type: ${type}`);
  }

  if (title.length > 200) throw new ApiError(400, 'Notification title must be less than 200 characters');
  if (message.length > 1000) throw new ApiError(400, 'Notification message must be less than 1000 characters');

  const user = await User.findById(userId) || await CrmUser.findById(userId);
  if (!user) throw new ApiError(404, 'Notification target user not found');

  const category = TYPE_CATEGORY_MAP[type] || 'system';

  if (!SECURITY_CRITICAL_TYPES.has(type) && (user as any).notificationPreferences) {
    const prefs = (user as any).notificationPreferences as any;
    const isEnabled = prefs[category];
    if (isEnabled === false) return null;
    // Finer-grained mute on top of the category toggle — e.g. `crm` stays
    // enabled overall but this specific type (SupraSpace messages, etc.) has
    // been individually silenced.
    if (Array.isArray(prefs.mutedTypes) && prefs.mutedTypes.includes(type)) return null;
  }

  let notification: any = null;
  let isGroupedUpdate = false;

  if (dedupeKey) {
    const windowMinutes = groupWindowMinutes ?? 20;
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    const existing = await Notification.findOne({
      userId, dedupeKey, lastOccurredAt: { $gte: windowStart },
    }).sort({ lastOccurredAt: -1 });

    if (existing) {
      existing.occurrenceCount = (existing.occurrenceCount || 1) + 1;
      existing.lastOccurredAt = new Date();
      existing.isRead = false;
      existing.title = title;
      existing.message = `${message} — ${existing.occurrenceCount}× in the last ${windowMinutes} min, most recently at ${formatOccurrenceTime(existing.lastOccurredAt)}`;
      if (metadata) existing.metadata = { ...(existing.metadata || {}), ...metadata };
      await existing.save();
      notification = existing;
      isGroupedUpdate = true;
    }
  }

  if (!notification) {
    notification = await Notification.create({
      userId, organizationId, type, category, title, message,
      metadata: metadata || {}, isRead: false,
      ...(dedupeKey ? { dedupeKey, occurrenceCount: 1, lastOccurredAt: new Date() } : {}),
    });
  }

  emitToUser(userId, isGroupedUpdate ? 'notification:updated' : 'notification:new', notification);

  try {
    const resolvedMetadataRoute = resolveMetadataRoute(type, metadata);
    const projectManagementTargetUrl = getProjectManagementTargetUrl(metadata);

    const urlMap: Record<string, string> = {
      shipment_assigned: '/driver/loads',
      message_received: '/driver/notifications',
      quote_created: '/transportation?tab=drafts',
      quote_accepted: '/transportation?tab=quotes',
      shipment_delivered: '/transportation?tab=shipments',
      proof_of_delivery: '/driver-tracker',
      shipment_arrived_at_pickup: '/driver-tracker',
      shipment_arrived_at_delivery: '/driver-tracker',
      appointment_created: '/crm/appointments',
      appointment_updated: '/crm/appointments',
      appointment_cancelled: '/crm/appointments',
      appointment_reminder: '/crm/appointments',
      guest_response: '/crm/appointments',
      new_lead: '/crm/dashboard',
      lead_assigned: '/crm/dashboard',
      lead_status_changed: '/crm/dashboard',
      crm_message: metadata?.route || '/crm/supra-space',
      crm_task_assigned: metadata?.route || '/crm/leads',
      crm_task_due: metadata?.route || '/crm/leads',
      crm_biometric: metadata?.route || '/crm/biometrics',
      crm_timeproof: metadata?.route || '/crm/biometrics',
      reminder: metadata?.route || '/crm/leads',
      driver_request: '/settings?tab=drivers',
      driver_request_approved: '/driver/loads',
      driver_request_rejected: '/driver/loads',
      driver_assigned: '/driver/loads',
      driver_payout: '/driver/earnings',
      payment_request: metadata?.route || '/customer/payments',
      payment_received: metadata?.route || '/billing',
      payment_pending: metadata?.route || '/billing',
      payment_failed: metadata?.route || '/billing',
      payout_processed: metadata?.route || '/billing',
      referral_joined: metadata?.route || '/customer/refer',
      referral_rewarded: metadata?.route || '/customer/refer',
      system_announcement: metadata?.route || '/notifications',
      general: metadata?.route || '/notifications',
      // ── Aftermarket ──
      aftermarket_inquiry: metadata?.route || '/crm/support-center?tab=aftermarket',
      aftermarket_invoice: metadata?.route || '/customer/payments',
      aftermarket_order: metadata?.route || '/crm/aftermarket',
      // ── Feeds ──
      feed_mention_post: metadata?.route || '/crm/feeds',
      feed_mention_comment: metadata?.route || '/crm/feeds',
      feed_comment_on_post: metadata?.route || '/crm/feeds',
      feed_announcement: metadata?.route || '/crm/feeds',
      // ── Project Management ──
      pm_task_assigned: projectManagementTargetUrl,
      pm_task_comment: projectManagementTargetUrl,
      pm_task_status: projectManagementTargetUrl,
      pm_task_updated: projectManagementTargetUrl,
      pm_group_added: projectManagementTargetUrl,
      pm_task_mention: projectManagementTargetUrl,
      pm_task_deadline: projectManagementTargetUrl,
      // ── Calendar ──
      calendar_event_reminder: metadata?.route || '/crm/suprah-calendar',
      calendar_event_today: metadata?.route || '/crm/suprah-calendar',
      calendar_event_assigned: metadata?.route || '/crm/suprah-calendar',
      // ── Driver Tracker ──
      driver_location_update: metadata?.route || '/driver-tracker',
      driver_tracker_geofence_alert: metadata?.route || '/driver-tracker',
      driver_tracker_offline_alert: metadata?.route || '/driver-tracker',
      driver_tracker_place_visit: metadata?.route || '/driver-tracker',
      driver_dispatch_alert: metadata?.route || '/driver/notifications',
      driver_status_request: metadata?.route || '/driver-tracker',
      driver_emergency_request: metadata?.route || '/driver-tracker',
      driver_status_request_approved: metadata?.route || '/driver',
      driver_status_request_rejected: metadata?.route || '/driver',
      driver_status_request_completed: metadata?.route || '/driver',
      // ── Wallet ──
      wallet_low_balance: metadata?.route || '/billing',
      wallet_payout_failed: metadata?.route || '/billing',
      // ── Admin ──
      admin_broadcast: metadata?.route || '/notifications',
      admin_system_alert: metadata?.route || '/notifications',
      admin_staff_activity: metadata?.route || '/notifications',
      admin_security_audit: metadata?.route || '/notifications',
      dealership_inquiry: metadata?.route || '/admin/organizations',
    };

    const targetUrl = resolvedMetadataRoute || urlMap[type] || '/notifications';

    const pushPayload: any = {
      title: notification.title,
      body: notification.message,
      tag: dedupeKey || category,
      // Only set when dedupeKey is present — collapses repeat pushes for the
      // SAME subject at the push-service level (fixes the "machine gunned
      // with notifications" burst-on-reconnect problem), never for the bare
      // category fallback, which would risk silently dropping genuinely
      // unrelated notifications that just happen to share a category.
      topic: dedupeKey,
      // metadata.pushSource lets a caller override the category-derived label
      // when it knows a more precise one (e.g. an @mention is technically
      // `crm`-categorized but is more usefully labeled "SupraSpace").
      source: metadata?.pushSource || CATEGORY_PUSH_LABELS[category],
      data: { url: targetUrl, notificationId: notification._id },
    };

    if (type === 'driver_request') {
      pushPayload.actions = [
        { action: 'approve', title: 'Approve' },
        { action: 'reject', title: 'Reject' },
      ];
      pushPayload.data.driverRequestId = metadata?.driverRequestId || notification._id;
    }

    if (type === 'driver_dispatch_alert') {
      pushPayload.actions = [
        { action: 'acknowledge', title: 'Acknowledge' },
        { action: 'on-my-way', title: 'On My Way' },
      ];
      pushPayload.data.alertId = notification._id.toString();
    }

    // Lets a caller (e.g. Shift Alerts) request its own distinct notification
    // sound via metadata rather than every push sharing one generic tone.
    if (metadata?.playSound) {
      pushPayload.data.playSound = true;
      if (metadata.soundFile) pushPayload.data.soundFile = metadata.soundFile;
    }

    UnifiedPushService.sendToUser(userId, pushPayload).catch(err =>
      logger.error(err, `[UnifiedPushService] Failed to send push for user ${userId}`)
    );
  } catch (error: any) {
    logger.error(error, '[NotificationService] Error triggering web push');
  }

  return notification;
};

const createNotificationBatch = async (notifications: CreateNotificationParams[]) => {
  const results = await Promise.allSettled(notifications.map(params => createNotification(params)));
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
    .slice(normalizedSkip, shouldFetchAll ? undefined : normalizedSkip + normalizedLimit);

  return {
    notifications: mergedNotifs,
    total: totalPersonal + totalBroadcast,
    unreadCount: unreadPersonal + unreadBroadcast,
  };
};

const markAsRead = async (notificationId: string, orgId: string, userId: string) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId, organizationId: orgId },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw new ApiError(404, 'Notification not found or access denied');

  const category = TYPE_CATEGORY_MAP[notification.type] || 'system';
  UnifiedPushService.dismiss(userId, category).catch(err =>
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
  const notification = await Notification.findOneAndDelete({ _id: notificationId, userId, organizationId: orgId });
  if (!notification) throw new ApiError(404, 'Notification not found or access denied');
  return notification;
};

const deleteAllRead = async (userId: string, orgId: string) => {
  const result = await Notification.deleteMany({ userId, organizationId: orgId, isRead: true });
  return { message: 'All read notifications deleted', deletedCount: result.deletedCount };
};

const getUnreadCount = async (userId: string, orgId: string, userRole?: string) => {
  const broadcastFilter: any = {
    organizationId: orgId, isBroadcast: true, isRead: false,
    $or: [{ userId: { $exists: false } }, { userId: null }],
  };
  if (userRole) broadcastFilter.roleTargets = { $in: [userRole] };

  const [personalCount, broadcastCount] = await Promise.all([
    Notification.countDocuments({ userId, isRead: false }),
    Notification.countDocuments(broadcastFilter),
  ]);
  return personalCount + broadcastCount;
};

const cleanupOldNotifications = async (userId: string, daysOld: number = 30) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const result = await Notification.deleteMany({ userId, isRead: true, createdAt: { $lt: cutoffDate } });
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

  const users = await User.find({ organizationId, $or: roleTargets.map(role => ({ role })) })
    .select('_id notificationPreferences');
  if (users.length === 0) return null;

  const category = TYPE_CATEGORY_MAP[type] || 'system';
  const eligibleUsers = SECURITY_CRITICAL_TYPES.has(type)
    ? users
    : users.filter(u => {
      const prefs = (u as any).notificationPreferences;
      if (prefs?.[category] === false) return false;
      if (Array.isArray(prefs?.mutedTypes) && prefs.mutedTypes.includes(type)) return false;
      return true;
    });
  if (eligibleUsers.length === 0) return null;

  const notifications = eligibleUsers.map(user => ({
    userId: user._id, organizationId, roleTargets, type, category, title, message, metadata,
    isRead: false, isBroadcast: true,
  }));

  const created = await Notification.insertMany(notifications);

  eligibleUsers.forEach(user => {
    const userNotif = created.find(n => n.userId?.toString() === user._id.toString());
    if (userNotif) emitToUser(user._id.toString(), 'notification:new', userNotif);
  });

  try {
    const urlMap: Record<string, string> = {
      shipment_assigned: '/driver/loads',
      message_received: '/driver/notifications',
      quote_created: '/transportation?tab=drafts',
      shipment_delivered: '/transportation?tab=shipments',
      new_lead: '/crm/dashboard',
      driver_request: '/notifications',
      admin_broadcast: '/notifications',
    };
    const broadcastPayload = { title, body: message, tag: category, source: CATEGORY_PUSH_LABELS[category], data: { url: metadata?.route || urlMap[type] || '/notifications' } };
    const userIds = eligibleUsers.map(u => u._id.toString());
    UnifiedPushService.broadcastToUsers(userIds, broadcastPayload).catch(err =>
      logger.error(err, '[UnifiedPushService] Broadcast failed')
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