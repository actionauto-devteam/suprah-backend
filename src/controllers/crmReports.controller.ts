import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import SmsCampaignRecipient from '../models/SmsCampaignRecipient.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import PriceDropEmailLog from '../models/PriceDropEmailLog.model';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import SmsOptOut from '../models/SmsOptOut.model';
import EmailOptOut from '../models/EmailOptOut.model';
import { normalizeLeadSourceForDisplay, isGenuineDemoLead, UNMAPPED_LEAD_SOURCE_LABEL } from '../constants/leadSource';

function parseDateRange(req: Request): { from: Date; to: Date } {
  const { from, to } = req.query;
  if (!from || !to) throw new ApiError(400, 'Query params "from" and "to" are required');
  const fromDate = new Date(String(from));
  const toDate = new Date(String(to));
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ApiError(400, 'Invalid "from" or "to" date');
  }
  if (fromDate.getTime() > toDate.getTime()) throw new ApiError(400, '"from" must not be after "to"');
  return { from: fromDate, to: toDate };
}

function countByStatus(rows: Array<{ _id: string; count: number }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row._id) counts[row._id] = row.count;
  }
  return counts;
}

const MDT_DAY_KEY_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });

function mdtDayKey(date: Date): string {
  return MDT_DAY_KEY_FORMATTER.format(date);
}

const MAX_ZERO_FILLED_DAYS = 180;

/** Buckets already-fetched (and already demo-filtered) leads by their Mountain
 *  Time calendar day, zero-filling every day in the range so the trend chart
 *  has no visual gaps — bounded to avoid an unbounded response on a very wide
 *  custom range, in which case only days with real activity are returned. */
function buildLeadsOverTime(leads: Array<{ createdAt: Date }>, from: Date, to: Date): Array<{ date: string; count: number }> {
  const countsByDay = new Map<string, number>();
  for (const lead of leads) {
    const createdAt = new Date(lead.createdAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    const key = mdtDayKey(createdAt);
    countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
  }

  // Calendar-date arithmetic only (never a fixed-millisecond add) — a day in
  // the range can be 23 or 25 real hours across a DST transition, so walking
  // forward by milliseconds from the range start can skip or repeat a day key.
  const [fromYear, fromMonth, fromDay] = mdtDayKey(from).split('-').map(Number);
  const [toYear, toMonth, toDay] = mdtDayKey(to).split('-').map(Number);
  const startUtcDate = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const endUtcDate = Date.UTC(toYear, toMonth - 1, toDay);
  const spanDays = Math.round((endUtcDate - startUtcDate) / 86_400_000) + 1;

  if (spanDays > 0 && spanDays <= MAX_ZERO_FILLED_DAYS) {
    const days: Array<{ date: string; count: number }> = [];
    for (let offset = 0; offset < spanDays; offset += 1) {
      const cursor = new Date(startUtcDate + offset * 86_400_000);
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
      days.push({ date: key, count: countsByDay.get(key) || 0 });
    }
    return days;
  }

  return Array.from(countsByDay.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Org-scoped, date-bounded summary across Leads, SMS/Email campaigns, Price Drop
 *  notifications, Vehicle Re-engagement, and SMS/Email unsubscribes — feeds the
 *  dedicated CRM Reports page. Leads are additionally filtered to drop genuine
 *  Demo Lab records (source "Demo" + a fictional phone), matching the same
 *  exclusion already applied to the Lead Source Report. The other categories
 *  are not demo-filtered in this pass. */
export const getCrmReportsOverview = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { from, to } = parseDateRange(req);
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const leadDateMatch = { createdAt: { $gte: from, $lte: to } };
  // Recipient date-bucketing is deliberately anchored on the one-time "claimed for
  // sending" timestamp (sentAt for SMS, processingStartedAt for Email), never on
  // updatedAt. updatedAt advances again whenever a later delivery-status webhook
  // (or the stale-processing reclaim sweep) touches the same row, which would
  // otherwise silently move an already-reported recipient into a later period's
  // count — or make it vanish from the period it actually happened in — every
  // time a delayed carrier confirmation arrives.
  const smsRecipientDateMatch = { organizationId: orgId, sentAt: { $gte: from, $lte: to } };
  const emailRecipientDateMatch = { organizationId: orgId, processingStartedAt: { $gte: from, $lte: to } };
  const stringOrgCreatedMatch = { organizationId: orgId, createdAt: { $gte: from, $lte: to } };

  const [
    leadRows,
    smsCampaignRows,
    emailCampaignRows,
    smsDeliveryStatusRows,
    priceDropRows,
    reengagementRows,
    smsUnsubscribeCount,
    emailUnsubscribeCount,
  ] = await Promise.all([
    Lead.find({ organizationId: orgObjectId, ...leadDateMatch })
      .select('status source channel phone createdAt')
      .lean(),
    SmsCampaignRecipient.aggregate([
      { $match: smsRecipientDateMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EmailCampaignRecipient.aggregate([
      { $match: emailRecipientDateMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SmsCampaignRecipient.aggregate([
      { $match: { ...smsRecipientDateMatch, status: 'sent' } },
      { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
    ]),
    PriceDropEmailLog.aggregate([
      { $match: stringOrgCreatedMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    VehicleReengagementLog.aggregate([
      { $match: stringOrgCreatedMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SmsOptOut.countDocuments({ organizationId: orgId, optedOut: true, changedAt: { $gte: from, $lte: to } }),
    EmailOptOut.countDocuments({ organizationId: orgId, optedOut: true, changedAt: { $gte: from, $lte: to } }),
  ]);

  const genuineLeads = (leadRows as any[]).filter((lead) => !isGenuineDemoLead(lead.source, lead.phone));
  const leadsByStatus: Record<string, number> = {};
  const leadsBySource: Record<string, number> = {};
  for (const lead of genuineLeads) {
    leadsByStatus[lead.status || 'Unknown'] = (leadsByStatus[lead.status || 'Unknown'] || 0) + 1;
    const normalized = normalizeLeadSourceForDisplay({ source: lead.source, channel: lead.channel });
    const sourceLabel = normalized.source || UNMAPPED_LEAD_SOURCE_LABEL;
    leadsBySource[sourceLabel] = (leadsBySource[sourceLabel] || 0) + 1;
  }

  const smsDeliveryStatusCounts: Record<string, number> = {};
  for (const row of smsDeliveryStatusRows as Array<{ _id: string | null; count: number }>) {
    smsDeliveryStatusCounts[row._id || 'accepted'] = row.count;
  }

  res.json(new ApiResponse(200, {
    range: { from: from.toISOString(), to: to.toISOString() },
    leads: {
      total: genuineLeads.length,
      byStatus: leadsByStatus,
      bySource: leadsBySource,
      overTime: buildLeadsOverTime(genuineLeads, from, to),
    },
    smsCampaigns: countByStatus(smsCampaignRows),
    smsDeliveryStatus: smsDeliveryStatusCounts,
    emailCampaigns: countByStatus(emailCampaignRows),
    priceDropEmails: countByStatus(priceDropRows),
    vehicleReengagement: countByStatus(reengagementRows),
    unsubscribes: {
      sms: smsUnsubscribeCount,
      email: emailUnsubscribeCount,
    },
  }, 'CRM reports overview'));
});
