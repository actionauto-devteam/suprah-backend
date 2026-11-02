import mongoose from 'mongoose';
import { notifyOrgAdmins, notifyUsers } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';

const NEW_LEAD_WINDOW_MS = 60_000;

const displayPhone = (value: unknown) => {
  const match = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(value || '').replace(/[^\d+]/g, ''));
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : '';
};

export function leadDisplayName(lead: any): string {
  return [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim() || displayPhone(lead?.phone) || String(lead?.email || '') || 'A customer';
}

export async function notifyLeadMessage(orgId: unknown, lead: any, channel: 'sms' | 'email', preview: string): Promise<boolean> {
  try {
    if (!lead?._id || !orgId) return false;
    const createdAt = new Date(lead.createdAt || 0).getTime();
    if (Number.isFinite(createdAt) && Date.now() - createdAt < NEW_LEAD_WINDOW_MS) return false;
    const customerName = leadDisplayName(lead);
    const { title, message } = notificationTemplates.lead_message({ customerName, channel, preview });
    const metadata = {
      leadId: String(lead._id),
      customerName,
      channel,
      route: `/crm/leads?leadId=${lead._id}`,
      pushTag: `lead-message-${lead._id}`,
    };
    const assigned = lead.assignedTo && mongoose.isValidObjectId(String(lead.assignedTo)) ? String(lead.assignedTo) : '';
    if (assigned) await notifyUsers([assigned], String(orgId), 'lead_message', title, message, metadata);
    else await notifyOrgAdmins(String(orgId), 'lead_message', title, message, metadata);
    return true;
  } catch (error) {
    console.error('[comm] Customer message notification failed', error);
    return false;
  }
}
