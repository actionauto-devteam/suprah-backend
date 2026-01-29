/**
 * Centralized notification message templates
 * This ensures consistency across all notifications
 */

interface QuoteData {
  customerName: string;
  vehicleName?: string;
  rate?: number;
}

interface ShipmentData {
  trackingNumber: string;
  customerName: string;
  status?: string;
}

interface ProfileData {
  fieldChanged?: string;
}

export const notificationTemplates = {
  quote_created: (data: QuoteData) => ({
    title: 'New Quote Created',
    message: `Quote created for ${data.customerName}${data.vehicleName ? ` - ${data.vehicleName}` : ''}`,
  }),

  quote_updated: (data: QuoteData) => ({
    title: 'Quote Updated',
    message: `Quote for ${data.customerName} has been updated`,
  }),

  quote_deleted: (data: QuoteData) => ({
    title: 'Quote Deleted',
    message: `Quote for ${data.customerName} has been deleted`,
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
};

export type NotificationTemplateType = keyof typeof notificationTemplates;