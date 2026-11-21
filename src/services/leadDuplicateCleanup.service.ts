import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import LeadInquiry from '../models/LeadInquiry.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { NOT_A_LEAD_STATUS } from '../constants/leadStatus';
import { isADFContent } from '../utils/adfParser';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { FREE_MAIL_DOMAINS } from '../utils/freeMailDomains';
import { SAME_REQUEST_WINDOW_MS, isSameRequest } from '../utils/inquiryKeys';
import { previewDuplicateLeads } from './leadDuplicateCombine.service';

export const NOTICE_CARD_REASON = 'DealersCloud notice email, not a customer';

const MOVABLE_STATUSES = ['New', 'Viewed', 'Bad Lead', 'Closed'];
const REQUEST_KINDS = ['provider_inquiry', 'website_inquiry'];
const KEPT_OUTCOMES = ['created_lead', 'appended', 'manual_create'];

export interface NoticeCardSummary {
  organizationId: string;
  sender: string;
  found: number;
  movable: Array<{ leadId: string; status: string; subject: string; createdAt: Date | null }>;
  forStaff: Array<{ leadId: string; status: string; subject: string; createdAt: Date | null }>;
  moved: number;
  changedMeanwhile: number;
}

export interface RepeatedInquirySummary {
  leadsChecked: number;
  leadsFixed: number;
  copies: number;
  folded: number;
  changedMeanwhile: number;
  leads: Array<{ leadId: string; firstName: string; lastName: string; before: number; after: number; copies: number; firstCopyAt: Date | null }>;
}

export interface OpenDuplicateSummary {
  organizationId: string;
  customers: number;
  leads: number;
  skippedGroups: number;
  complete: boolean;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isBlank = (value: unknown) => value === undefined || value === null || String(value).trim() === '';
const time = (value: unknown) => new Date(value as string).getTime();
const orgFilter = (organizationId?: string) => (organizationId ? { organizationId: new mongoose.Types.ObjectId(organizationId) } : {});
const card = (lead: any) => ({
  leadId: String(lead._id),
  status: String(lead.status || ''),
  subject: String(lead.subject || ''),
  createdAt: lead.createdAt ? new Date(lead.createdAt) : null,
});

export async function moveNoticeCardsToOthers(options: { apply: boolean; organizationId?: string; now?: Date }): Promise<NoticeCardSummary[]> {
  const configs: any[] = await OrgLeadConfig.find({ ...orgFilter(options.organizationId), leadSourceEmail: { $nin: [null, ''] } })
    .select('organizationId leadSourceEmail')
    .lean();
  const results: NoticeCardSummary[] = [];

  for (const config of configs) {
    const source = normalizeIdentityEmail(config.leadSourceEmail);
    if (!source) continue;
    const domain = source.split('@')[1] || '';
    const ownDomain = Boolean(domain) && !FREE_MAIL_DOMAINS.has(domain);
    const sender = ownDomain
      ? new RegExp(`@${escapeRegex(domain)}\\s*$`, 'i')
      : new RegExp(`^\\s*${escapeRegex(source)}\\s*$`, 'i');
    const leads: any[] = await Lead.find({
      organizationId: config.organizationId,
      email: sender,
      identityEmailExcluded: true,
      source: 'Email Inquiry',
      status: { $ne: NOT_A_LEAD_STATUS },
      phone: { $in: [null, ''] },
      'combinedInto.leadId': { $exists: false },
    })
      .select('_id firstName lastName status subject body createdAt')
      .sort({ createdAt: 1 })
      .lean();
    const notices = leads.filter((lead) => ['', 'unknown'].includes(String(lead.firstName || '').trim().toLowerCase())
      && isBlank(lead.lastName)
      && !isADFContent(String(lead.body || '').toLowerCase()));
    if (!notices.length) continue;

    const movable = notices.filter((lead) => MOVABLE_STATUSES.includes(lead.status));
    const forStaff = notices.filter((lead) => !movable.includes(lead));
    const summary: NoticeCardSummary = {
      organizationId: String(config.organizationId),
      sender: ownDomain ? `@${domain}` : source,
      found: notices.length,
      movable: movable.map(card),
      forStaff: forStaff.map(card),
      moved: 0,
      changedMeanwhile: 0,
    };

    if (options.apply) {
      for (const lead of movable) {
        const changed = await Lead.updateOne(
          { _id: lead._id, organizationId: config.organizationId, status: lead.status, 'combinedInto.leadId': { $exists: false } },
          {
            $set: { status: NOT_A_LEAD_STATUS },
            $push: { statusHistory: { from: lead.status, to: NOT_A_LEAD_STATUS, changedAt: options.now || new Date(), reason: NOTICE_CARD_REASON } },
          },
        );
        if (changed.modifiedCount) summary.moved += 1;
        else summary.changedMeanwhile += 1;
      }
    }
    results.push(summary);
  }
  return results;
}

export async function foldRepeatedInquiries(options: { apply: boolean; organizationId?: string }): Promise<RepeatedInquirySummary> {
  const match: Record<string, unknown> = {
    ...orgFilter(options.organizationId),
    kind: { $in: REQUEST_KINDS },
    'association.state': 'associated',
    'association.outcome': { $in: KEPT_OUTCOMES },
    'association.leadId': { $ne: null },
  };
  const groups: any[] = await LeadInquiry.aggregate([
    { $match: match },
    { $group: { _id: { leadId: '$association.leadId', organizationId: '$organizationId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).allowDiskUse(true);

  const summary: RepeatedInquirySummary = { leadsChecked: groups.length, leadsFixed: 0, copies: 0, folded: 0, changedMeanwhile: 0, leads: [] };

  for (const group of groups) {
    const leadId = group._id.leadId;
    const organizationId = group._id.organizationId;
    const inquiries: any[] = await LeadInquiry.find({ ...match, organizationId, 'association.leadId': leadId })
      .select('_id receivedAt vehicle comments source sourceProvider sourceIds intakePolicy association.outcome')
      .sort({ receivedAt: 1, _id: 1 })
      .lean();
    const kept: any[] = [];
    const copies: Array<{ copy: any; of: any }> = [];
    for (const inquiry of inquiries) {
      const original = inquiry.intakePolicy === 'isolate' || inquiry.association?.outcome !== 'appended'
        ? null
        : kept.find((earlier) => earlier.intakePolicy !== 'isolate'
          && Math.abs(time(inquiry.receivedAt) - time(earlier.receivedAt)) <= SAME_REQUEST_WINDOW_MS
          && isSameRequest(earlier, inquiry));
      if (original) copies.push({ copy: inquiry, of: original });
      else kept.push(inquiry);
    }
    if (!copies.length) continue;

    const lead: any = await Lead.findOne({ _id: leadId, organizationId }).select('_id firstName lastName inquiryCount').lean();
    if (!lead) continue;
    const before = Number(lead.inquiryCount || inquiries.length);
    summary.leadsFixed += 1;
    summary.copies += copies.length;
    summary.leads.push({
      leadId: String(lead._id),
      firstName: String(lead.firstName || ''),
      lastName: String(lead.lastName || ''),
      before,
      after: Math.max(1, before - copies.length),
      copies: copies.length,
      firstCopyAt: copies[0].copy.receivedAt ? new Date(copies[0].copy.receivedAt) : null,
    });
    if (!options.apply) continue;

    for (const { copy, of } of copies) {
      const changed = await LeadInquiry.updateOne(
        { _id: copy._id, organizationId, 'association.leadId': leadId, 'association.state': 'associated', 'association.outcome': 'appended' },
        { $set: { 'association.state': 'resolved', 'association.outcome': 'dismissed', 'association.reason': 'duplicate_same_request', 'association.duplicateOf': of._id } },
      );
      if (!changed.modifiedCount) {
        summary.changedMeanwhile += 1;
        continue;
      }
      await Lead.updateOne(
        { _id: lead._id, organizationId },
        [{ $set: { inquiryCount: { $max: [1, { $subtract: [{ $ifNull: ['$inquiryCount', before] }, 1] }] } } }],
        { timestamps: false },
      );
      summary.folded += 1;
    }
  }
  return summary;
}

export async function previewOpenDuplicateCards(organizationId?: string): Promise<OpenDuplicateSummary[]> {
  const orgIds: string[] = organizationId
    ? [organizationId]
    : (await OrgLeadConfig.find({}).select('organizationId').lean()).map((config: any) => String(config.organizationId));
  const results: OpenDuplicateSummary[] = [];
  for (const id of orgIds) {
    const preview = await previewDuplicateLeads(id).catch(() => null);
    if (preview) results.push({ organizationId: id, ...preview });
  }
  return results;
}
