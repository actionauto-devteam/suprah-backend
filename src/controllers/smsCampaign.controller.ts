import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import SmsCampaign from '../models/SmsCampaign.model';
import SmsCampaignRecipient from '../models/SmsCampaignRecipient.model';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';

const MAX_RECIPIENTS = 500;
const VALID_STATUSES = LEAD_STATUS_VALUES;
const OPT_OUT_REMINDER = 'reply stop';

function parseStatuses(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const cleaned = list.map((value) => String(value).trim()).filter((value) => VALID_STATUSES.includes(value));
  return Array.from(new Set(cleaned));
}

function audienceQuery(orgId: string, statuses: string[]) {
  const query: Record<string, unknown> = {
    organizationId: orgId,
    phone: { $exists: true, $ne: '' },
  };
  if (statuses.length > 0) query.status = { $in: statuses };
  return query;
}

const MIN_SCHEDULE_LEAD_MS = 30 * 1000;

function resolveScheduling(rawScheduledAt: unknown): { status: 'queued' | 'scheduled'; scheduledAt?: Date } {
  if (!rawScheduledAt) return { status: 'queued' };
  const scheduledAt = new Date(String(rawScheduledAt));
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError(400, 'scheduledAt is not a valid date');
  }
  if (scheduledAt.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    throw new ApiError(400, 'scheduledAt must be at least 30 seconds in the future');
  }
  return { status: 'scheduled', scheduledAt };
}

export const getAudienceCount = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const statuses = parseStatuses(req.query.statuses);
  const count = await Lead.countDocuments(audienceQuery(orgId, statuses));

  res.json(new ApiResponse(200, { count, capped: Math.min(count, MAX_RECIPIENTS) }, 'Audience count'));
});

export const listCampaigns = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));

  const [campaigns, total] = await Promise.all([
    SmsCampaign.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    SmsCampaign.countDocuments({ organizationId: orgId }),
  ]);

  res.json(new ApiResponse(200, { campaigns, total, page, limit }, 'Campaigns fetched'));
});

export const getCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { id } = req.params;

  const campaign = await SmsCampaign.findOne({ _id: id, organizationId: orgId }).lean();
  if (!campaign) throw new ApiError(404, 'Campaign not found');

  const [failedSample, deliveryStatusRows] = await Promise.all([
    SmsCampaignRecipient.find({ campaignId: id, status: 'failed' })
      .select('customerName phone failureReason')
      .limit(20)
      .lean(),
    SmsCampaignRecipient.aggregate([
      { $match: { campaignId: campaign._id, status: 'sent' } },
      { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
    ]),
  ]);

  const deliveryStatusCounts: Record<string, number> = {};
  for (const row of deliveryStatusRows as Array<{ _id: string | null; count: number }>) {
    deliveryStatusCounts[row._id || 'accepted'] = row.count;
  }

  res.json(new ApiResponse(200, { campaign, failedSample, deliveryStatusCounts }, 'Campaign fetched'));
});

export const createCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can send SMS campaigns');

  const name = String(req.body?.name || '').trim();
  const message = String(req.body?.message || '').trim();
  const statuses = parseStatuses(req.body?.statuses);
  const { status: initialStatus, scheduledAt } = resolveScheduling(req.body?.scheduledAt);

  if (!name) throw new ApiError(400, 'Campaign name is required');
  if (!message) throw new ApiError(400, 'Message is required');
  if (message.length > 1000) throw new ApiError(400, 'Message is limited to 1000 characters');
  if (!message.toLowerCase().includes(OPT_OUT_REMINDER)) {
    throw new ApiError(400, 'Message must include an opt-out instruction, e.g. "Reply STOP to opt out."');
  }

  const audienceTotal = await Lead.countDocuments(audienceQuery(orgId, statuses));
  if (audienceTotal === 0) throw new ApiError(400, 'No leads with a phone number match this audience');
  if (audienceTotal > MAX_RECIPIENTS) {
    throw new ApiError(
      400,
      `This audience has ${audienceTotal} eligible leads, which is over the current ${MAX_RECIPIENTS}-recipient safe sending limit. Narrow your status filter to ${MAX_RECIPIENTS} or fewer leads before sending.`,
    );
  }

  const leads = await Lead.find(audienceQuery(orgId, statuses))
    .select('_id firstName lastName phone')
    .limit(MAX_RECIPIENTS)
    .lean();

  const campaign = await SmsCampaign.create({
    organizationId: orgId,
    name,
    message,
    audienceStatuses: statuses,
    status: initialStatus,
    scheduledAt,
    totalRecipients: leads.length,
    createdBy: user._id,
    createdByName: user.fullName || user.name || user.email || 'Staff',
  });

  await SmsCampaignRecipient.insertMany(
    leads.map((lead: any) => ({
      campaignId: campaign._id,
      organizationId: orgId,
      leadId: lead._id,
      phone: lead.phone,
      customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'there',
      status: 'pending',
    })),
  );

  res
    .status(201)
    .json(new ApiResponse(201, { campaign }, initialStatus === 'scheduled' ? 'Campaign scheduled' : 'Campaign queued'));
});

export const cancelCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can cancel SMS campaigns');

  const { id } = req.params;
  const campaign = await SmsCampaign.findOneAndUpdate(
    { _id: id, organizationId: orgId, status: { $in: ['scheduled', 'queued', 'sending'] } },
    { $set: { status: 'cancelled', completedAt: new Date() } },
    { new: true },
  );
  if (!campaign) throw new ApiError(404, 'Campaign not found or already finished');

  await SmsCampaignRecipient.updateMany(
    { campaignId: id, status: 'pending' },
    { $set: { status: 'skipped', failureReason: 'Campaign cancelled' } },
  );

  res.json(new ApiResponse(200, { campaign }, 'Campaign cancelled'));
});

export const rescheduleCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can reschedule SMS campaigns');

  const { id } = req.params;
  const { scheduledAt } = resolveScheduling(req.body?.scheduledAt);
  if (!scheduledAt) throw new ApiError(400, 'scheduledAt is required to reschedule a campaign');

  const campaign = await SmsCampaign.findOneAndUpdate(
    { _id: id, organizationId: orgId, status: { $in: ['queued', 'scheduled'] } },
    { $set: { status: 'scheduled', scheduledAt } },
    { new: true },
  );
  if (!campaign) {
    throw new ApiError(404, 'Campaign not found, or it has already started sending and can no longer be rescheduled');
  }

  res.json(new ApiResponse(200, { campaign }, 'Campaign rescheduled'));
});
