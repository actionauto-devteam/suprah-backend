import mongoose, { Document, Schema } from 'mongoose';

export type ActivityType =
  | 'login'
  | 'logout'
  | 'profile_update'
  | 'password_change'
  | 'email_change'
  | 'settings_change'
  | 'quote_created'
  | 'quote_updated'
  | 'quote_deleted'
  | 'shipment_created'
  | 'shipment_updated'
  | 'shipment_deleted'
  | 'load_created'
  | 'load_updated'
  | 'load_deleted'
  | 'appointment_created'
  | 'appointment_updated'
  | 'appointment_cancelled'
  | 'vehicle_added'
  | 'vehicle_updated'
  | 'google_calendar_connected'
  | 'google_calendar_disconnected'
  | 'avatar_updated'
  // Driver Actions
  | 'load_posted'
  | 'load_assigned'
  | 'load_updated'
  | 'load_delivered'
  | 'compliance_uploaded'
  | 'doc_verified'
  | 'payout_received'
  // Customer Actions
  | 'referral_applied'
  | 'withdrawal_requested'
  | 'wallet_adjustment'
  | 'payment_completed'
  // Admin Actions
  | 'user_suspended'
  | 'user_activated'
  | 'org_suspended'
  | 'subscription_changed'
  | 'logs_cleared'
  | 'other';

export interface IUserActivity extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  type: ActivityType;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const UserActivitySchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
    },
    type: {
      type: String,
      enum: [
        'login',
        'logout',
        'profile_update',
        'password_change',
        'email_change',
        'settings_change',
        'quote_created',
        'quote_updated',
        'quote_deleted',
        'shipment_created',
        'shipment_updated',
        'shipment_deleted',
        'load_created',
        'load_updated',
        'load_deleted',
        'appointment_created',
        'appointment_updated',
        'appointment_cancelled',
        'vehicle_added',
        'vehicle_updated',
        'google_calendar_connected',
        'google_calendar_disconnected',
        'avatar_updated',
        'load_posted',
        'load_assigned',
        'load_updated',
        'load_delivered',
        'compliance_uploaded',
        'doc_verified',
        'payout_received',
        'referral_applied',
        'withdrawal_requested',
        'wallet_adjustment',
        'payment_completed',
        'user_suspended',
        'user_activated',
        'org_suspended',
        'subscription_changed',
        'logs_cleared',
        'other',
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
UserActivitySchema.index({ userId: 1, createdAt: -1 });
UserActivitySchema.index({ organizationId: 1, createdAt: -1 });

// Auto-delete activities older than 14 days (Staging optimization)
UserActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

const UserActivity = mongoose.model<IUserActivity>('UserActivity', UserActivitySchema);

export default UserActivity;
