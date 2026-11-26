import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import { CallLog, CommunicationMessage } from '../models/communication.model';
import SmsCampaignRecipient from '../models/SmsCampaignRecipient.model';
import LeadHandlingEvent from '../models/LeadHandlingEvent.model';
import { NOT_A_LEAD_STATUS } from '../constants/leadStatus';
import { isGenuineDemoLead } from '../constants/leadSource';

export interface OutreachCount {
  leads: number;
  sent: number;
}

export interface RepOutreach {
  texts: OutreachCount;
  emails: OutreachCount;
  calls: OutreachCount;
}

type LeadRow = { _id: unknown; count: number };

const STAFF_ID = /^[0-9a-f]{24}$/i;
const CAMPAIGN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function staffOnly(field: string) {
  return { $or: [{ [field]: { $type: 'objectId' } }, { [field]: { $regex: STAFF_ID } }] };
}

function orgVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

async function campaignMessageIds(orgId: string, from: Date, to: Date): Promise<string[]> {
  const ids = await SmsCampaignRecipient.distinct('providerMessageId', {
    organizationId: orgId,
    sentAt: { $gte: new Date(from.getTime() - CAMPAIGN_LOOKBACK_MS), $lte: to },
    providerMessageId: { $exists: true, $nin: [null, ''] },
  });
  return ids.map(String);
}

async function loadLeads(orgId: string, ids: string[]): Promise<Map<string, any>> {
  const byId = new Map<string, any>();
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  let pending = ids.filter((id) => mongoose.isValidObjectId(id));
  for (let hop = 0; hop < 2 && pending.length; hop += 1) {
    const docs = await Lead.find({ _id: { $in: pending }, organizationId: orgObjectId })
      .select('status source phone combinedInto')
      .lean();
    for (const doc of docs as any[]) byId.set(String(doc._id), doc);
    pending = Array.from(new Set((docs as any[])
      .map((doc) => (doc.combinedInto?.leadId ? String(doc.combinedInto.leadId) : ''))
      .filter((id) => id && !byId.has(id))));
  }
  return byId;
}

function countedLeadId(byId: Map<string, any>, id: string): string | null {
  let lead = byId.get(id);
  if (lead?.combinedInto?.leadId) lead = byId.get(String(lead.combinedInto.leadId));
  if (!lead || lead.combinedInto?.leadId || lead.status === NOT_A_LEAD_STATUS) return null;
  if (isGenuineDemoLead(lead.source, lead.phone)) return null;
  return String(lead._id);
}

function tally(rows: LeadRow[], byId: Map<string, any>): OutreachCount {
  const leads = new Set<string>();
  let sent = 0;
  for (const row of rows) {
    const leadId = countedLeadId(byId, String(row._id));
    if (!leadId) continue;
    leads.add(leadId);
    sent += row.count;
  }
  return { leads: leads.size, sent };
}

export async function buildRepOutreach(orgId: string, from: Date, to: Date): Promise<RepOutreach> {
  const orgIds = orgVariants(orgId);
  const range = { $gte: from, $lte: to };
  const skipIds = await campaignMessageIds(orgId, from, to);

  const [textRows, emailRows, callRows] = await Promise.all([
    CommunicationMessage.aggregate([
      {
        $match: {
          orgId: { $in: orgIds },
          direction: 'outbound',
          createdAt: range,
          status: { $ne: 'failed' },
          leadId: { $ne: null },
          ...staffOnly('sentBy.userId'),
          ...(skipIds.length ? { providerMessageId: { $nin: skipIds } } : {}),
        },
      },
      { $group: { _id: '$leadId', count: { $sum: 1 } } },
    ]),
    LeadHandlingEvent.aggregate([
      { $match: { organizationId: orgId, action: 'email_sent', at: range, ...staffOnly('actor.userId') } },
      { $group: { _id: '$leadId', count: { $sum: 1 } } },
    ]),
    CallLog.aggregate([
      {
        $match: {
          orgId: { $in: orgIds },
          direction: 'outbound',
          createdAt: range,
          leadId: { $ne: null },
          ...staffOnly('placedBy.userId'),
        },
      },
      { $group: { _id: '$leadId', count: { $sum: 1 } } },
    ]),
  ]);

  const allIds = [...textRows, ...emailRows, ...callRows].map((row: LeadRow) => String(row._id));
  const byId = await loadLeads(orgId, Array.from(new Set(allIds)));

  return {
    texts: tally(textRows as LeadRow[], byId),
    emails: tally(emailRows as LeadRow[], byId),
    calls: tally(callRows as LeadRow[], byId),
  };
}
