import mongoose from 'mongoose';
import { emitToOrg } from './socketEmitter';

export const LEAD_CAMPAIGN_FIELDS = {
  price_drop: 'campaignSentAt.priceDrop',
  reengagement: 'campaignSentAt.reengagement',
  sms_campaign: 'campaignSentAt.smsCampaign',
  email_campaign: 'campaignSentAt.emailCampaign',
} as const;

export type LeadCampaignKind = keyof typeof LEAD_CAMPAIGN_FIELDS;

export async function stampLeadCampaign(leadId: unknown, kind: LeadCampaignKind, at?: Date | string | null): Promise<void> {
  const id = leadId ? String((leadId as any)?._id ?? leadId) : '';
  const field = LEAD_CAMPAIGN_FIELDS[kind];
  if (!field || !mongoose.isValidObjectId(id)) return;
  const when = at ? new Date(at) : new Date();
  const stamp = Number.isNaN(when.getTime()) ? new Date() : when;
  try {
    await mongoose.model('Lead').updateOne({ _id: id }, { $max: { [field]: stamp } });
  } catch {
    return;
  }
}

export async function touchLeadActivity(leadId: unknown, organizationId?: unknown, at?: Date | string | null): Promise<void> {
  const id = leadId ? String((leadId as any)?._id ?? leadId) : '';
  if (!mongoose.isValidObjectId(id)) return;
  const when = at ? new Date(at) : new Date();
  const stamp = Number.isNaN(when.getTime()) ? new Date() : when;
  try {
    const result = await mongoose.model('Lead').updateOne({ _id: id }, { $max: { 'followUp.lastActivityAt': stamp } });
    if (result.modifiedCount && organizationId) emitToOrg(String(organizationId), 'lead:update', { leadId: id });
  } catch {
    return;
  }
}
