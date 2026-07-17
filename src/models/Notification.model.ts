import mongoose, { Document, Schema } from 'mongoose';

export interface INotification extends Document {
  userId?: mongoose.Types.ObjectId;
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;
  roleTargets?: string[];
  type: string;
  title: string;
  message: string;
  metadata?: any;
  isRead: boolean;
  isBroadcast: boolean;
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

        'driver_request',
        'driver_request_approved',
        'driver_request_rejected',
        'driver_assigned',
        'driver_location_update',
        'driver_payout',

        'payment_received',
        'payment_pending',
        'payment_failed',
        'payment_request',
        'payout_processed',

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
        'absence_approved',
        'absence_rejected',
        'board_note_posted',

        'proof_submitted',
        'delivery_confirmed',

        'aftermarket_inquiry',
        'aftermarket_invoice',
        'aftermarket_order',

        'location_share_requested',
      ],
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
  },
  {
    timestamps: true,
  }
);

NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });


NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ organizationId: 1, isBroadcast: 1, createdAt: -1 });
NotificationSchema.index({ organizationId: 1, roleTargets: 1, isBroadcast: 1 });

const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

export default Notification;