import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import { Conversation } from '../models/communication.model';
import PriceDropEmailLog from '../models/PriceDropEmailLog.model';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import SmsCampaignRecipient from '../models/SmsCampaignRecipient.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import { LEAD_SOURCE } from '../constants/leadSource';
import { activeLeadStores, resolveLeadStore, storeForLabel, storeForStock, type LeadStore } from '../utils/leadStore';
import { firstContactForConversation } from '../utils/leadFirstContact';
import { LEAD_CAMPAIGN_FIELDS, type LeadCampaignKind } from '../utils/leadActivity';
import { INBOUND_LEAD_SOURCES } from '../utils/leadType';

const WRITE_BATCH = 500;
const CONVERSATION_SOURCES = new Set<string>([LEAD_SOURCE.INBOUND_SMS, LEAD_SOURCE.INBOUND_CALL]);

export interface LeadStoreTypeBackfillSummary {
  apply: boolean;
  scanned: number;
  updated: number;
  locationFilled: number;
  locationCorrected: number;
  locationByStore: Record<string, number>;
  leadTypeFilled: number;
  leadTypeByKind: Record<string, number>;
  campaignStamped: number;
  campaignByKind: Record<string, number>;
}

type LatestSends = Map<string, Date>;

async function latestSends(model: mongoose.Model<any>, match: Record<string, unknown>): Promise<LatestSends> {
  const rows: Array<{ _id: unknown; at: Date }> = await model.aggregate([
    { $match: { ...match, leadId: { $ne: null }, sentAt: { $type: 'date' } } },
    { $group: { _id: '$leadId', at: { $max: '$sentAt' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), new Date(row.at)]));
}

function add(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] || 0) + 1;
}

function dateOf(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function firstContactFor(lead: any) {
  const source = typeof lead.source === 'string' ? lead.source.trim() : '';
  if (source === LEAD_SOURCE.MANUAL_ENTRY) return { firstContactBy: 'team' as const, firstContactVia: 'added_by_team' as const };
  if (INBOUND_LEAD_SOURCES.includes(source) && !CONVERSATION_SOURCES.has(source)) {
    return { firstContactBy: 'customer' as const, firstContactVia: null };
  }
  const conversation: any = await Conversation.findOne({ leadId: lead._id }).select('_id').lean();
  if (!conversation?._id) return { firstContactBy: 'customer' as const, firstContactVia: null };
  return firstContactForConversation(conversation._id);
}

export async function runLeadStoreTypeBackfill(options: { apply?: boolean; organizationId?: string } = {}): Promise<LeadStoreTypeBackfillSummary> {
  const apply = options.apply === true;
  const summary: LeadStoreTypeBackfillSummary = {
    apply,
    scanned: 0,
    updated: 0,
    locationFilled: 0,
    locationCorrected: 0,
    locationByStore: {},
    leadTypeFilled: 0,
    leadTypeByKind: {},
    campaignStamped: 0,
    campaignByKind: {},
  };

  const sends: Record<LeadCampaignKind, LatestSends> = {
    price_drop: await latestSends(PriceDropEmailLog, { status: 'sent' }),
    reengagement: await latestSends(VehicleReengagementLog, { status: 'sent' }),
    sms_campaign: await latestSends(SmsCampaignRecipient, { status: 'sent' }),
    email_campaign: await latestSends(EmailCampaignRecipient, { status: 'sent' }),
  };

  const filter: Record<string, unknown> = {};
  if (options.organizationId) filter.organizationId = new mongoose.Types.ObjectId(options.organizationId);

  const cursor = Lead.find(filter)
    .select('_id organizationId location vehicle source firstContactBy campaignSentAt followUp.lastReengagementAt')
    .lean()
    .cursor();

  const storesByOrg = new Map<string, LeadStore[]>();
  const storesFor = async (orgId: unknown) => {
    const key = String(orgId);
    if (!storesByOrg.has(key)) storesByOrg.set(key, await activeLeadStores(key));
    return storesByOrg.get(key) as LeadStore[];
  };

  let ops: any[] = [];
  const flush = async () => {
    if (!ops.length) return;
    if (apply) await Lead.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  for await (const lead of cursor as AsyncIterable<any>) {
    summary.scanned += 1;
    const id = String(lead._id);
    const set: Record<string, unknown> = {};
    const max: Record<string, Date> = {};

    const savedLocation = String(lead.location || '').trim();
    const leadStock = String(lead.vehicle?.stock || '').trim();
    if (savedLocation && leadStock) {
      const stores = await storesFor(lead.organizationId);
      const stockStore = storeForStock(stores, leadStock);
      if (stockStore && storeForLabel(stores, savedLocation) !== stockStore) {
        set.location = stockStore;
        summary.locationCorrected += 1;
        add(summary.locationByStore, stockStore);
      }
    }

    if (!savedLocation) {
      const vehicle = lead.vehicle || {};
      const hasVehicle = Boolean(vehicle.vin || vehicle.stock || (vehicle.year && vehicle.make && vehicle.model));
      const context = hasVehicle
        ? await resolveLeadStore(lead.organizationId, {
          vin: vehicle.vin,
          stock: vehicle.stock,
          year: vehicle.year ? String(vehicle.year) : undefined,
          make: vehicle.make,
          model: vehicle.model,
        }).catch(() => null)
        : null;
      if (context?.location) {
        set.location = context.location;
        summary.locationFilled += 1;
        add(summary.locationByStore, context.location);
      }
    }

    if (lead.firstContactBy !== 'customer' && lead.firstContactBy !== 'team') {
      const firstContact = await firstContactFor(lead).catch(() => null);
      if (firstContact) {
        set.firstContactBy = firstContact.firstContactBy;
        set.firstContactVia = firstContact.firstContactVia;
        summary.leadTypeFilled += 1;
        add(summary.leadTypeByKind, firstContact.firstContactVia || firstContact.firstContactBy);
      }
    }

    const reengagementOnLead = dateOf(lead.followUp?.lastReengagementAt);
    for (const kind of Object.keys(LEAD_CAMPAIGN_FIELDS) as LeadCampaignKind[]) {
      let sentAt = sends[kind].get(id) || null;
      if (kind === 'reengagement' && reengagementOnLead && (!sentAt || reengagementOnLead > sentAt)) sentAt = reengagementOnLead;
      if (!sentAt) continue;
      const fieldKey = LEAD_CAMPAIGN_FIELDS[kind].split('.')[1];
      const current = dateOf(lead.campaignSentAt?.[fieldKey]);
      if (current && current.getTime() >= sentAt.getTime()) continue;
      max[LEAD_CAMPAIGN_FIELDS[kind]] = sentAt;
      add(summary.campaignByKind, kind);
    }
    if (Object.keys(max).length) summary.campaignStamped += 1;

    if (!Object.keys(set).length && !Object.keys(max).length) continue;
    summary.updated += 1;
    ops.push({
      updateOne: {
        filter: { _id: lead._id },
        update: {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(max).length ? { $max: max } : {}),
        },
      },
    });
    if (ops.length >= WRITE_BATCH) await flush();
  }

  await flush();
  return summary;
}
