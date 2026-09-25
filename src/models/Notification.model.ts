import mongoose, { Document, Schema } from 'mongoose';
import { NOTIFICATION_TYPES } from '../constants/notificationTypes';
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
      enum: NOTIFICATION_TYPES,
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
// MongoDB partial indexes support equality filters and `$exists: true`, but
// not `$exists: false`. Equality to null matches documents where dedupeKey is
// either null or missing, which is exactly the ungrouped-notification set.
NotificationSchema.index(
  { createdAt: 1 },
  { name: 'createdAt_ttl_ungrouped', expireAfterSeconds: 7776000, partialFilterExpression: { dedupeKey: null } },
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