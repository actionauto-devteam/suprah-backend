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
  | 'appointment_created'
  | 'appointment_updated'
  | 'appointment_cancelled'
  | 'vehicle_added'
  | 'vehicle_updated'
  | 'google_calendar_connected'
  | 'google_calendar_disconnected'
  | 'avatar_updated'
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
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
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
        'appointment_created',
        'appointment_updated',
        'appointment_cancelled',
        'vehicle_added',
        'vehicle_updated',
        'google_calendar_connected',
        'google_calendar_disconnected',
        'avatar_updated',
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
