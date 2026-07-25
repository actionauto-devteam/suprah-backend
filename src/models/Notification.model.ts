import mongoose, { Document, Schema } from 'mongoose';
import logger from '../utils/logger';

export const NOTIFICATION_CATEGORIES = [
  'transportation', 'inventory', 'appointments', 'crm', 'feeds', 'projectManagement',
  'calendar', 'driverTracker', 'wallet', 'team', 'account', 'referrals', 'system',
  'adminBroadcasts', 'adminSystemAlerts', 'adminStaffActivity', 'adminSecurityAudit',
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

export interface INotification extends Document {
  userId?: mongoose.Types.ObjectId;
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;
  roleTargets?: string[];
  type: string;
  category: NotificationCategory;
  title: string;
  message: string;
  metadata?: any;
  isRead: boolean;
  isBroadcast: boolean;
  dedupeKey?: string;
  occurrenceCount: number;
  lastOccurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    roleTargets: {
      type: [String],
      enum: ['user', 'admin', 'driver', 'super_admin', 'dealer', 'customer'],
      default: [],
    },
    isBroadcast: {
      type: Boolean,
      default: false,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        'quote_created',
        'quote_updated',
        'quote_deleted',
        'quote_converted',
        'quote_accepted',

        'shipment_created',
        'shipment_updated',
        'shipment_deleted',
        'shipment_status_changed',
        'shipment_assigned',
        'shipment_picked_up',
        'shipment_delivered',
        'proof_of_delivery',
        'shipment_arrived_at_pickup',
        'shipment_arrived_at_delivery',

        'vehicle_added',
        'vehicle_updated',
        'vehicle_sold',
        'vehicle_status_changed',
        'inventory_sync',
        'new_inventory_alert',

        'appointment_created',
        'appointment_updated',
        'appointment_cancelled',
        'appointment_reminder',
        'guest_response',

        'new_lead',
        'lead_assigned',
        'lead_status_changed',
        'crm_message',
        'crm_task_assigned',
        'crm_task_due',
        'crm_biometric',
        'crm_timeproof',

        'feed_mention_post',
        'feed_mention_comment',
        'feed_comment_on_post',
        'feed_announcement',

        'pm_task_assigned',
        'pm_task_comment',
        'pm_task_status',
        'pm_task_updated',
        'pm_group_added',
        'pm_task_mention',
        'pm_task_deadline',

        'calendar_event_reminder',
        'calendar_event_today',
        'calendar_event_assigned',

        'driver_request',
        'driver_request_approved',
        'driver_request_rejected',
        'driver_assigned',
        'driver_location_update',
        'driver_payout',
        'driver_tracker_geofence_alert',
        'driver_tracker_offline_alert',
        'driver_tracker_place_visit',

        'payment_received',
        'payment_pending',
        'payment_failed',
        'payment_request',
        'payout_processed',
        'wallet_low_balance',
        'wallet_payout_failed',

        'admin_broadcast',
        'admin_system_alert',
        'admin_staff_activity',
        'admin_security_audit',

        'team_invite_sent',
        'team_member_joined',
        'team_member_left',
        'role_changed',

        'password_changed',
        'email_changed',
        'profile_updated',
        'login_alert',

        'system_announcement',
        'message_received',
        'reminder',
        'general',

        'referral_joined',
        'referral_rewarded',

        'ping',
        'absence_requested',
        'absence_approved',
        'absence_rejected',
        'board_note_posted',

        'proof_submitted',
        'delivery_confirmed',

        'aftermarket_inquiry',
        'aftermarket_invoice',
        'aftermarket_order',

        'location_share_requested',

        'agent_idle',
        'agent_idle_escalation',

        'customer_call_requested',
      ],
    },
    category: {
      type: String,
      required: true,
      enum: NOTIFICATION_CATEGORIES,
      index: true,
      default: 'system',
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Repeat-event compiling: when set, a new occurrence of the same
    // {userId, dedupeKey} within its grouping window updates this document
    // (bumping occurrenceCount/lastOccurredAt) instead of creating a new row —
    // see createNotification()'s grouping logic in notification.service.ts.
    dedupeKey: {
      type: String,
      index: true,
    },
    occurrenceCount: {
      type: Number,
      default: 1,
    },
    lastOccurredAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Split in two so an actively-recurring grouped notification (dedupeKey set,
// occurrenceCount kept incrementing on the SAME document — createdAt never
// changes once set) doesn't get silently TTL-deleted mid-recurrence while
// still unread. Grouped docs expire 90 days after their last occurrence
// instead of 90 days after they were first created.
//
// DEPLOY NOTE (confirmed against the live collection, not just theoretical):
// production already has two auto-named indexes on these exact key patterns
// with different options — `createdAt_1` (plain, no partialFilterExpression)
// and `lastOccurredAt_1` (no partialFilterExpression, from an earlier version
// of this same change) — Mongoose's autoIndex sync hits IndexOptionsConflict
// against BOTH on boot and neither replacement index below actually gets
// created until the old ones are dropped first (renaming alone does not
// bypass this — verified). Run
// `npx ts-node --transpile-only src/scripts/migrate-notification-ttl-index.ts`
// (or manually via `mongosh`: `db.notifications.dropIndex("createdAt_1")` and
// `db.notifications.dropIndex("lastOccurredAt_1")`) once, before deploying
// this change, or the grouping/dedupe TTL semantics described above silently
// never take effect (existing behavior is preserved either way — see the
// `.on('index', ...)` safety net below, which keeps a missed/late migration
// from crashing the process on boot instead of just logging it).
NotificationSchema.index(
  { createdAt: 1 },
  { name: 'createdAt_ttl_ungrouped', expireAfterSeconds: 7776000, partialFilterExpression: { dedupeKey: { $exists: false } } },
);
NotificationSchema.index(
  { lastOccurredAt: 1 },
  { name: 'lastOccurredAt_ttl_grouped', expireAfterSeconds: 7776000, partialFilterExpression: { dedupeKey: { $exists: true } } },
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ userId: 1, category: 1, createdAt: -1 });
NotificationSchema.index({ organizationId: 1, isBroadcast: 1, createdAt: -1 });
NotificationSchema.index({ organizationId: 1, roleTargets: 1, isBroadcast: 1 });
NotificationSchema.index({ userId: 1, dedupeKey: 1, lastOccurredAt: -1 });

const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

// Without this listener, a failed index build (e.g. IndexOptionsConflict
// against a pre-existing differently-configured index of the same name) is
// an unhandled rejection — which server.ts's global handler treats as fatal
// in production and shuts the whole process down on boot. Logging it here
// instead keeps the server up (serving on whatever indexes did succeed)
// while making the failure loud and traceable.
Notification.on('index', (err) => {
  if (err) logger.error({ err }, '[Notification] Index build failed — see deploy note in Notification.model.ts');
});

export default Notification;