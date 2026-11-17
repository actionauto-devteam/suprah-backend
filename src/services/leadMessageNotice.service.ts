import Notification from '../models/Notification.model';
import type { LeadNoticeInput } from './leadNoticeRouting.service';
import { notificationTemplates } from '../utils/notificationTemplates';

const notifyLeadPeople = async (input: LeadNoticeInput) => (await import('./leadNoticeRouting.service')).notifyLeadPeople(input);

const NEW_LEAD_WINDOW_MS = 60_000;
const HANDOFF_NOTICE_WINDOW_MS = 2 * 60_000;

const displayPhone = (value: unknown) => {
  const match = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(value || '').replace(/[^\d+]/g, ''));
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : '';
};

export function leadDisplayName(lead: any): string {
  const name = [lead?.firstName, lead?.lastName]
    .map((part) => String(part || '').trim())
    .filter((part) => part && !/^unknown$/i.test(part))
    .join(' ');
  return name || displayPhone(lead?.phone) || String(lead?.phone || '').trim() || String(lead?.email || '') || 'A customer';
}

export async function notifyLeadMessageUnlessHandoff(orgId: unknown, lead: any, channel: 'sms' | 'email', preview: string): Promise<boolean> {
  try {
    if (!lead?._id || !orgId) return false;
    const handoff = await Notification.exists({
      organizationId: String(orgId),
      type: 'ai_agent_handoff_needed',
      'metadata.leadId': String(lead._id),
      createdAt: { $gte: new Date(Date.now() - HANDOFF_NOTICE_WINDOW_MS) },
    });
    if (handoff) return false;
  } catch (error) {
    console.error('[comm] Handoff notice check failed', error);
  }
  return notifyLeadMessage(orgId, lead, channel, preview);
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
    await notifyLeadPeople({
      organizationId: orgId,
      leadId: lead._id,
      type: 'lead_message',
      title,
      message,
      metadata,
      topicText: preview,
      tagText: title,
    });
    return true;
  } catch (error) {
    console.error('[comm] Customer message notification failed', error);
    return false;
  }
}
