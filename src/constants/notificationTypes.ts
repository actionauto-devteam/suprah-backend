/**
 * Single source of truth for Notification.type.
 *
 * Both the Notification model enum and notificationService.createNotification
 * validate against this list. Keeping one list prevents the drift where a type
 * passed the service check but failed the model enum (or vice versa), which
 * silently dropped notifications and left lifecycle outbox events retrying
 * forever.
 */
export const NOTIFICATION_TYPES = [
  'quote_created', 'quote_updated', 'quote_deleted', 'quote_converted', 'quote_accepted',
  'shipment_created', 'shipment_updated', 'shipment_deleted', 'shipment_status_changed',
  'shipment_assigned', 'shipment_picked_up', 'shipment_delivered', 'proof_of_delivery',
  'shipment_arrived_at_pickup', 'shipment_arrived_at_delivery',
  'vehicle_added', 'vehicle_updated', 'vehicle_sold', 'vehicle_status_changed',
  'inventory_sync', 'new_inventory_alert',
  'appointment_created', 'appointment_updated', 'appointment_cancelled',
  'appointment_reminder', 'guest_response',
  'appointment_confirmed_via_sms', 'appointment_reschedule_requested', 'sms_opt_out',
  'new_lead', 'lead_assigned', 'lead_status_changed',
  'crm_message', 'crm_task_assigned', 'crm_task_due', 'crm_biometric', 'crm_timeproof',
  'feed_mention_post', 'feed_mention_comment', 'feed_comment_on_post', 'feed_announcement',
  'pm_task_assigned', 'pm_task_comment', 'pm_task_status', 'pm_task_updated',
  'pm_group_added', 'pm_task_mention', 'pm_task_deadline',
  'calendar_event_reminder', 'calendar_event_today', 'calendar_event_assigned',
  'driver_request', 'driver_request_approved', 'driver_request_rejected',
  'dealership_inquiry',
  'driver_assigned', 'load_accepted', 'load_amendment_acknowledged', 'driver_location_update', 'driver_payout',
  // Load lifecycle events emitted by Driver Tracker / Load Management.
  'load_amendment_required', 'load_picked_up', 'load_in_transit', 'load_delivered',
  'driver_tracker_geofence_alert', 'driver_tracker_offline_alert', 'driver_tracker_place_visit',
  'driver_dispatch_alert', 'driver_dispatch_message',
  'driver_status_request', 'driver_status_request_approved', 'driver_status_request_rejected',
  'driver_status_request_completed', 'driver_emergency_request',
  'driver_document_verified', 'driver_document_rejected', 'driver_profile_approved',
  'payment_received', 'payment_pending', 'payment_failed', 'payment_request', 'payout_processed',
  'wallet_low_balance', 'wallet_payout_failed',
  'admin_broadcast', 'admin_system_alert', 'admin_staff_activity', 'admin_security_audit',
  'team_invite_sent', 'team_member_joined', 'team_member_left', 'role_changed', 'board_note_posted',
  'eotm_winner_announced',
  'password_changed', 'email_changed', 'profile_updated', 'login_alert',
  'system_announcement', 'message_received', 'reminder', 'general', 'ping',
  'referral_joined', 'referral_rewarded',
  'absence_requested', 'absence_approved', 'absence_rejected',
  'delivery_confirmed', 'proof_submitted',
  'aftermarket_inquiry', 'aftermarket_invoice', 'aftermarket_order',
  'location_share_requested',
  'agent_idle', 'agent_idle_escalation', 'agent_idle_stage2', 'agent_idle_stage3', 'agent_screen_recording_missing',
  'customer_call_requested',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}
