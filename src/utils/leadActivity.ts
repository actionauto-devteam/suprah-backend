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

function leadIdOf(leadId: unknown): string {
  const id = leadId ? String((leadId as any)?._id ?? leadId) : '';
  return mongoose.isValidObjectId(id) ? id : '';
}

function stampOf(at?: Date | string | null): Date {
  const when = at ? new Date(at) : new Date();
  return Number.isNaN(when.getTime()) ? new Date() : when;
}

export async function markLeadAwaitingReply(
  leadId: unknown,
  at?: Date | string | null,
  organizationId?: unknown,
  always = false,
): Promise<void> {
  const id = leadIdOf(leadId);
  if (!id) return;
  const stamp = stampOf(at);
  try {
    const marked = await mongoose.model('Lead').updateOne(
      always
        ? { _id: id }
        : {
            _id: id,
            $and: [
              { $or: [{ 'followUp.lastAnsweredAt': null }, { 'followUp.lastAnsweredAt': { $lt: stamp } }] },
              { $or: [{ 'followUp.lastRepResponseAt': null }, { 'followUp.lastRepResponseAt': { $lt: stamp } }] },
            ],
          },
      { $min: { 'followUp.awaitingReplySince': stamp } },
      { timestamps: false },
    );
    if (marked.modifiedCount && organizationId) emitToOrg(String(organizationId), 'lead:update', { leadId: id });
  } catch {
    return;
  }
}

export async function moveLeadAwaitingReply(fromLeadIds: unknown[], toLeadId: unknown, organizationId?: unknown): Promise<void> {
  const from = fromLeadIds.map(leadIdOf).filter(Boolean);
  const to = leadIdOf(toLeadId);
  if (!from.length || !to) return;
  try {
    const LeadModel = mongoose.model('Lead');
    const waiting: any[] = await LeadModel.find({ _id: { $in: from }, 'followUp.awaitingReplySince': { $ne: null } })
      .select('followUp.awaitingReplySince')
      .lean();
    const times = waiting
      .map((lead) => new Date(lead?.followUp?.awaitingReplySince).getTime())
      .filter((time) => Number.isFinite(time));
    if (!times.length) return;
    await LeadModel.updateMany(
      { _id: { $in: waiting.map((lead) => lead._id) } },
      { $unset: { 'followUp.awaitingReplySince': 1 } },
      { timestamps: false },
    );
    await markLeadAwaitingReply(to, new Date(Math.min(...times)), organizationId);
  } catch {
    return;
  }
}

export async function clearLeadAwaitingReply(leadId: unknown, organizationId?: unknown, handledAt?: Date | null): Promise<boolean> {
  const id = leadIdOf(leadId);
  if (!id) return false;
  try {
    const cleared = await mongoose.model('Lead').updateOne(
      { _id: id, 'followUp.awaitingReplySince': { $ne: null } },
      {
        $unset: { 'followUp.awaitingReplySince': 1 },
        ...(handledAt ? { $max: { 'followUp.lastAnsweredAt': stampOf(handledAt) } } : {}),
      },
      { timestamps: false },
    );
    if (cleared.modifiedCount && organizationId) emitToOrg(String(organizationId), 'lead:update', { leadId: id });
    return cleared.modifiedCount > 0;
  } catch {
    return false;
  }
}

export async function recordLeadAnswered(leadId: unknown, organizationId?: unknown, at?: Date | string | null): Promise<void> {
  const id = leadIdOf(leadId);
  if (!id) return;
  const stamp = stampOf(at);
  try {
    const LeadModel = mongoose.model('Lead');
    await LeadModel.updateOne({ _id: id }, { $max: { 'followUp.lastAnsweredAt': stamp } }, { timestamps: false });
    const cleared = await LeadModel.updateOne(
      {
        _id: id,
        'followUp.awaitingReplySince': { $ne: null },
        $or: [{ 'followUp.lastCustomerActivityAt': { $lte: stamp } }, { 'followUp.lastCustomerActivityAt': null }],
      },
      { $unset: { 'followUp.awaitingReplySince': 1 } },
      { timestamps: false },
    );
    if (cleared.modifiedCount && organizationId) emitToOrg(String(organizationId), 'lead:update', { leadId: id });
  } catch {
    return;
  }
}
