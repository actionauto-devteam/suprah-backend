interface QuoteData {
  customerName: string;
  vehicleName?: string;
  rate?: number;
}

interface ShipmentData {
  trackingNumber: string;
  customerName?: string;
  status?: string;
  driverName?: string;
}

interface VehicleData {
  vehicleName: string;
  stockNumber?: string;
  year?: number;
  make?: string;
  model?: string;
  price?: number;
  status?: string;
}

interface LeadData {
  customerName: string;
  source?: string;
  vehicleInterest?: string;
}

interface AppointmentData {
  title: string;
  startTime?: string;
  customerName?: string;
}

interface TeamData {
  memberName: string;
  organizationName?: string;
  role?: string;
}

interface PaymentData {
  amount: number;
  trackingNumber?: string;
  customerName?: string;
  status?: string;
}

interface ProfileData {
  fieldChanged?: string;
}

interface DriverData {
  driverName: string;
  trackingNumber?: string;
  loadInfo?: string;
}

interface CRMData {
  taskTitle?: string;
  assignedBy?: string;
  dueDate?: string;
  customerName?: string;
  message?: string;
}

interface ReferralData {
  referredName: string;
  amount?: number;
  dealerName?: string;
}

interface FeedData {
  authorName: string;
  postPreview?: string;
}

interface ProjectTaskData {
  taskTitle: string;
  actorName?: string;
  dueDate?: string;
  groupName?: string;
  comment?: string;
}

interface CalendarEventData {
  eventTitle: string;
  startTime?: string;
}

interface DriverTrackerData {
  driverName: string;
  placeName?: string;
}

interface WalletData {
  amount?: number;
  reason?: string;
}

interface AdminAlertData {
  title: string;
  message: string;
}

export const notificationTemplates = {
  quote_created: (data: QuoteData) => ({
    title: 'New Quote Created',
    message: `Quote created for ${data.customerName}${data.vehicleName ? ` - ${data.vehicleName}` : ''}${data.rate ? ` ($${data.rate})` : ''}`,
  }),

  quote_updated: (data: QuoteData) => ({
    title: 'Quote Updated',
    message: `Quote for ${data.customerName} has been updated`,
  }),

  quote_deleted: (data: QuoteData) => ({
    title: 'Quote Deleted',
    message: `Quote for ${data.customerName} has been deleted`,
  }),

  quote_converted: (data: QuoteData & { trackingNumber: string }) => ({
    title: 'Quote Converted to Shipment',
    message: `Quote for ${data.customerName} converted to shipment ${data.trackingNumber}`,
  }),

  quote_accepted: (data: QuoteData) => ({
    title: 'Quote Accepted by Customer',
    message: `${data.customerName} has accepted the quote${data.vehicleName ? ` for ${data.vehicleName}` : ''}!`,
  }),

  shipment_created: (data: ShipmentData) => ({
    title: 'New Shipment Created',
    message: `Shipment ${data.trackingNumber} created for ${data.customerName}`,
  }),

  shipment_updated: (data: ShipmentData) => ({
    title: 'Shipment Updated',
    message: `Shipment ${data.trackingNumber} for ${data.customerName} has been updated${data.status ? ` - Status: ${data.status}` : ''}`,
  }),

  shipment_deleted: (data: ShipmentData) => ({
    title: 'Shipment Deleted',
    message: `Shipment ${data.trackingNumber} for ${data.customerName} has been deleted`,
  }),

  shipment_status_changed: (data: ShipmentData) => ({
    title: 'Shipment Status Updated',
    message: `Shipment ${data.trackingNumber} status changed to: ${data.status}`,
  }),

  shipment_assigned: (data: ShipmentData) => ({
    title: 'New Load Assigned',
    message: `You have been assigned to shipment ${data.trackingNumber}${data.customerName ? ` for ${data.customerName}` : ''}`,
  }),

  shipment_picked_up: (data: ShipmentData) => ({
    title: 'Vehicle Picked Up',
    message: `Shipment ${data.trackingNumber} has been picked up${data.driverName ? ` by ${data.driverName}` : ''}`,
  }),

  shipment_delivered: (data: ShipmentData) => ({
    title: 'Delivery Complete',
    message: `Shipment ${data.trackingNumber} has been delivered successfully`,
  }),

  proof_of_delivery: (data: { driverName: string; trackingNumber: string }) => ({
    title: 'Proof of Delivery Submitted',
    message: `${data.driverName} submitted proof of delivery for shipment ${data.trackingNumber}. View to verify.`,
  }),

  shipment_arrived_at_pickup: (data: { driverName: string; trackingNumber: string; origin: string }) => ({
    title: 'Driver Arrived at Pickup',
    message: `${data.driverName} has arrived at the pickup location: ${data.origin}`,
  }),

  shipment_arrived_at_delivery: (data: { driverName: string; trackingNumber: string; destination: string }) => ({
    title: 'Driver Arrived at Delivery',
    message: `${data.driverName} has arrived at the delivery location: ${data.destination}`,
  }),

  // ==================== VEHICLES/INVENTORY ====================
  vehicle_added: (data: VehicleData) => ({
    title: 'New Vehicle Added',
    message: `${data.vehicleName} has been added to inventory${data.stockNumber ? ` (Stock #${data.stockNumber})` : ''}`,
  }),

  vehicle_updated: (data: VehicleData) => ({
    title: 'Vehicle Updated',
    message: `${data.vehicleName} information has been updated`,
  }),

  vehicle_sold: (data: VehicleData) => ({
    title: 'Vehicle Sold',
    message: `${data.vehicleName} has been marked as sold${data.price ? ` for $${data.price.toLocaleString()}` : ''}`,
  }),

  vehicle_status_changed: (data: VehicleData) => ({
    title: 'Vehicle Status Changed',
    message: `${data.vehicleName} status changed to: ${data.status}`,
  }),

  inventory_sync: (data: { count: number; source: string }) => ({
    title: 'Inventory Synced',
    message: `${data.count} vehicles synced from ${data.source}`,
  }),

  new_inventory_alert: (data: { count: number; make?: string }) => ({
    title: 'New Inventory Available',
    message: `${data.count} new ${data.make || 'vehicles'} added to inventory`,
  }),

  // ==================== APPOINTMENTS ====================
  appointment_created: (data: AppointmentData) => ({
    title: 'New Appointment',
    message: `You have been invited to "${data.title}"${data.startTime ? ` on ${data.startTime}` : ''}`,
  }),

  appointment_updated: (data: AppointmentData) => ({
    title: 'Appointment Updated',
    message: `"${data.title}" has been rescheduled`,
  }),

  appointment_cancelled: (data: AppointmentData) => ({
    title: 'Appointment Cancelled',
    message: `"${data.title}" has been cancelled`,
  }),

  appointment_reminder: (data: AppointmentData) => ({
    title: 'Appointment Reminder',
    message: `Reminder: "${data.title}" is coming up${data.startTime ? ` at ${data.startTime}` : ' tomorrow'}`,
  }),

  guest_response: (data: { guestName: string; appointmentTitle: string; response: string }) => ({
    title: 'Guest Response',
    message: `${data.guestName} ${data.response} your invitation to "${data.appointmentTitle}"`,
  }),

  // ==================== CRM & LEADS ====================
  new_lead: (data: LeadData) => ({
    title: 'New Lead Received',
    message: `New lead from ${data.customerName}${data.source ? ` via ${data.source}` : ''}${data.vehicleInterest ? ` - Interested in ${data.vehicleInterest}` : ''}`,
  }),

  lead_assigned: (data: LeadData & { assignedTo: string }) => ({
    title: 'Lead Assigned to You',
    message: `${data.customerName} has been assigned to you`,
  }),

  lead_status_changed: (data: LeadData & { status: string }) => ({
    title: 'Lead Status Updated',
    message: `${data.customerName} status changed to: ${data.status}`,
  }),

  crm_message: (data: { from: string; preview: string }) => ({
    title: `Message from ${data.from}`,
    message: data.preview,
  }),

  crm_task_assigned: (data: CRMData) => ({
    title: 'New Task Assigned',
    message: `"${data.taskTitle}" assigned by ${data.assignedBy}${data.dueDate ? ` - Due: ${data.dueDate}` : ''}`,
  }),

  crm_task_due: (data: CRMData) => ({
    title: 'Task Due Soon',
    message: `"${data.taskTitle}" is due${data.dueDate ? ` on ${data.dueDate}` : ' soon'}`,
  }),

  crm_biometric: (data: { employeeName: string; action: string; device?: string }) => ({
    title: 'Biometric Activity',
    message: `${data.employeeName} ${data.action}${data.device ? ` via ${data.device}` : ''}`,
  }),

  crm_timeproof: (data: { employeeName: string; action: 'time-in' | 'time-out' }) => ({
    title: `Employee ${data.action === 'time-in' ? 'Time In' : 'Time Out'}`,
    message: `${data.employeeName} has clocked ${data.action === 'time-in' ? 'in' : 'out'}`,
  }),

  // ==================== DRIVER RELATED ====================
  driver_request: (data: { driverName: string; email: string }) => ({
    title: 'New Driver Registration',
    message: `${data.driverName} (${data.email}) wants to register as a driver`,
  }),

  driver_request_approved: () => ({
    title: 'Driver Request Approved',
    message: 'Your driver request has been approved. You can now access your driver dashboard.',
  }),

  driver_request_rejected: (data: { reason?: string }) => ({
    title: 'Driver Request Declined',
    message: `Your driver request was declined${data.reason ? `: ${data.reason}` : ''}`,
  }),

  driver_assigned: (data: DriverData) => ({
    title: 'New Load Available',
    message: `New load assigned: ${data.trackingNumber}${data.loadInfo ? ` - ${data.loadInfo}` : ''}`,
  }),

  driver_location_update: (data: { trackingNumber: string; location: string }) => ({
    title: 'Driver Location Update',
    message: `Shipment ${data.trackingNumber} - Driver is at ${data.location}`,
  }),

  driver_payout: (data: PaymentData) => ({
    title: 'Payout Processed',
    message: `Your payout of $${data.amount.toFixed(2)} has been processed${data.trackingNumber ? ` for shipment ${data.trackingNumber}` : ''}`,
  }),

  payment_received: (data: PaymentData) => ({
    title: 'Payment Received',
    message: `Payment of $${data.amount.toFixed(2)} received${data.customerName ? ` from ${data.customerName}` : ''}${data.trackingNumber ? ` for ${data.trackingNumber}` : ''}`,
  }),

  payment_pending: (data: PaymentData) => ({
    title: 'Payment Pending',
    message: `Payment of $${data.amount.toFixed(2)} is pending${data.trackingNumber ? ` for shipment ${data.trackingNumber}` : ''}`,
  }),

  payment_failed: (data: PaymentData) => ({
    title: 'Payment Failed',
    message: `Payment of $${data.amount.toFixed(2)} failed${data.trackingNumber ? ` for shipment ${data.trackingNumber}` : ''}`,
  }),

  payment_request: (data: { amount: number; dealerName: string; description: string }) => ({
    title: 'Payment Request',
    message: `You have a pending payment of $${data.amount.toFixed(2)} for "${data.description}" from ${data.dealerName}. Please log in to complete your payment.`,
  }),

  payout_processed: (data: PaymentData) => ({
    title: 'Payout Processed',
    message: `Payout of $${data.amount.toFixed(2)} has been processed`,
  }),

  // ==================== TEAM & ORGANIZATION ====================
  team_invite_sent: (data: { email: string; organizationName: string }) => ({
    title: 'Invitation Sent',
    message: `Invitation sent to ${data.email} to join ${data.organizationName}`,
  }),

  team_member_joined: (data: TeamData) => ({
    title: 'New Team Member',
    message: `${data.memberName} has joined ${data.organizationName || 'your team'}${data.role ? ` as ${data.role}` : ''}`,
  }),

  team_member_left: (data: TeamData) => ({
    title: 'Team Member Left',
    message: `${data.memberName} has left ${data.organizationName || 'your team'}`,
  }),

  role_changed: (data: { newRole: string }) => ({
    title: 'Role Updated',
    message: `Your role has been changed to ${data.newRole}`,
  }),

  // ==================== ACCOUNT & SECURITY ====================
  password_changed: () => ({
    title: 'Password Changed',
    message: 'Your password has been successfully changed',
  }),

  email_changed: (data: { newEmail: string }) => ({
    title: 'Email Address Changed',
    message: `Your email has been changed to ${data.newEmail}`,
  }),

  profile_updated: (data: ProfileData = {}) => ({
    title: 'Profile Updated',
    message: `Your profile${data.fieldChanged ? ` (${data.fieldChanged})` : ''} has been updated successfully`,
  }),

  login_alert: (data: { device?: string; location?: string }) => ({
    title: 'New Login Detected',
    message: `New login${data.device ? ` from ${data.device}` : ''}${data.location ? ` in ${data.location}` : ''}`,
  }),

  system_announcement: (data: { title: string; message: string }) => ({
    title: data.title,
    message: data.message,
  }),

  message_received: (data: { from: string; preview: string }) => ({
    title: `New message from ${data.from}`,
    message: data.preview,
  }),

  reminder: (data: { title: string; message: string }) => ({
    title: data.title,
    message: data.message,
  }),

  general: (data: { title: string; message: string }) => ({
    title: data.title,
    message: data.message,
  }),

  // ==================== REFERRALS ====================
  referral_joined: (data: ReferralData) => ({
    title: 'New Referral Signup!',
    message: `${data.referredName} just joined ${data.dealerName || 'Your Dealership'} using your referral code. You'll earn $100 when they purchase their first vehicle!`,
  }),

  referral_rewarded: (data: ReferralData) => ({
    title: 'Referral Reward Earned!',
    message: `Congratulations! ${data.referredName} has purchased a vehicle. $${data.amount || 100} has been added to your wallet.`,
  }),

  // Legacy support - keep delivery_confirmed for backwards compatibility
  delivery_confirmed: (data: { trackingNumber: string }) => ({
    title: 'Delivery Confirmed',
    message: `Your delivery for shipment ${data.trackingNumber} has been confirmed by the dealer`,
  }),

  // ==================== FEEDS ====================
  feed_mention_post: (data: FeedData) => ({
    title: `${data.authorName} mentioned you`,
    message: data.postPreview || `${data.authorName} mentioned you in a post`,
  }),

  feed_mention_comment: (data: FeedData) => ({
    title: `${data.authorName} mentioned you in a comment`,
    message: data.postPreview || `${data.authorName} mentioned you in a comment`,
  }),

  feed_comment_on_post: (data: FeedData) => ({
    title: `${data.authorName} commented on your post`,
    message: data.postPreview || `${data.authorName} left a comment on your post`,
  }),

  feed_announcement: (data: FeedData) => ({
    title: 'New Announcement',
    message: data.postPreview || `${data.authorName} posted an announcement`,
  }),

  // ==================== PROJECT MANAGEMENT ====================
  pm_task_assigned: (data: ProjectTaskData) => ({
    title: 'New Task Assigned',
    message: `"${data.taskTitle}" was assigned to you${data.actorName ? ` by ${data.actorName}` : ''}`,
  }),

  pm_task_comment: (data: ProjectTaskData) => ({
    title: `New comment on "${data.taskTitle}"`,
    message: data.comment || `${data.actorName || 'Someone'} commented on "${data.taskTitle}"`,
  }),

  pm_task_status: (data: ProjectTaskData) => ({
    title: 'Task Status Updated',
    message: `"${data.taskTitle}" status was updated${data.actorName ? ` by ${data.actorName}` : ''}`,
  }),

  pm_task_updated: (data: ProjectTaskData) => ({
    title: 'Task Updated',
    message: `"${data.taskTitle}" was updated${data.actorName ? ` by ${data.actorName}` : ''}`,
  }),

  pm_group_added: (data: ProjectTaskData) => ({
    title: 'Added to Project Group',
    message: `You were added to "${data.groupName || data.taskTitle}"`,
  }),

  pm_task_mention: (data: ProjectTaskData) => ({
    title: 'You were mentioned',
    message: `${data.actorName || 'Someone'} mentioned you on "${data.taskTitle}"`,
  }),

  pm_task_deadline: (data: ProjectTaskData) => ({
    title: 'Task Deadline Approaching',
    message: `"${data.taskTitle}" is due${data.dueDate ? ` on ${data.dueDate}` : ' soon'}`,
  }),

  // ==================== CALENDAR ====================
  calendar_event_reminder: (data: CalendarEventData) => ({
    title: 'Upcoming Event',
    message: `"${data.eventTitle}"${data.startTime ? ` starts at ${data.startTime}` : ' is coming up'}`,
  }),

  calendar_event_today: (data: CalendarEventData) => ({
    title: "Today's Event",
    message: `"${data.eventTitle}" is scheduled for today${data.startTime ? ` at ${data.startTime}` : ''}`,
  }),

  // ==================== DRIVER TRACKER ====================
  driver_tracker_geofence_alert: (data: DriverTrackerData) => ({
    title: 'Geofence Alert',
    message: `${data.driverName} ${data.placeName ? `left ${data.placeName}` : 'crossed a geofence boundary'}`,
  }),

  driver_tracker_offline_alert: (data: DriverTrackerData) => ({
    title: 'Driver Went Offline',
    message: `${data.driverName}'s location tracking has gone offline`,
  }),

  driver_tracker_place_visit: (data: DriverTrackerData) => ({
    title: 'Place Visit Detected',
    message: `${data.driverName} arrived at ${data.placeName || 'a tracked location'}`,
  }),

  // ==================== WALLET ====================
  wallet_low_balance: (data: WalletData) => ({
    title: 'Low Wallet Balance',
    message: `Your wallet balance is low${data.amount !== undefined ? ` ($${data.amount.toFixed(2)})` : ''}. Add funds to avoid interruptions.`,
  }),

  wallet_payout_failed: (data: WalletData) => ({
    title: 'Payout Failed',
    message: `A payout of $${(data.amount || 0).toFixed(2)} failed${data.reason ? `: ${data.reason}` : ''}`,
  }),

  // ==================== ADMIN ====================
  admin_broadcast: (data: AdminAlertData) => ({
    title: data.title,
    message: data.message,
  }),

  admin_system_alert: (data: AdminAlertData) => ({
    title: data.title,
    message: data.message,
  }),

  admin_staff_activity: (data: AdminAlertData) => ({
    title: data.title,
    message: data.message,
  }),

  admin_security_audit: (data: AdminAlertData) => ({
    title: data.title,
    message: data.message,
  }),
};

export type NotificationTemplateType = keyof typeof notificationTemplates;