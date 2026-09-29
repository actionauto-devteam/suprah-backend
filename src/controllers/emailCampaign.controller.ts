import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import EmailCampaign from '../models/EmailCampaign.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';

const MAX_RECIPIENTS = 500;
const VALID_STATUSES = LEAD_STATUS_VALUES;

function parseStatuses(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const cleaned = list.map((value) => String(value).trim()).filter((value) => VALID_STATUSES.includes(value));
  return Array.from(new Set(cleaned));
}

function audienceQuery(orgId: string, statuses: string[]) {
  const query: Record<string, unknown> = {
    organizationId: orgId,
    email: { $exists: true, $ne: '' },
  };
  if (statuses.length > 0) query.status = { $in: statuses };
  return query;
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
    EmailCampaign.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EmailCampaign.countDocuments({ organizationId: orgId }),
  ]);

  res.json(new ApiResponse(200, { campaigns, total, page, limit }, 'Campaigns fetched'));
});

export const getCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { id } = req.params;

  const campaign = await EmailCampaign.findOne({ _id: id, organizationId: orgId }).lean();
  if (!campaign) throw new ApiError(404, 'Campaign not found');

  const failedSample = await EmailCampaignRecipient.find({
    campaignId: id,
    status: 'failed',
  })
    .select('customerName email failureReason')
    .limit(20)
    .lean();

  res.json(new ApiResponse(200, { campaign, failedSample }, 'Campaign fetched'));
});

export const createCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can send email campaigns');

  const name = String(req.body?.name || '').trim();
  const subject = String(req.body?.subject || '').trim();
  const greetingText = String(req.body?.greetingText || '').trim();
  const bodyText = String(req.body?.bodyText || '').trim();
  const bannerImageUrl = String(req.body?.bannerImageUrl || '').trim();
  const signOffText = String(req.body?.signOffText || '').trim();
  const statuses = parseStatuses(req.body?.statuses);

  if (!name) throw new ApiError(400, 'Campaign name is required');
  if (!subject) throw new ApiError(400, 'Subject is required');
  if (!greetingText) throw new ApiError(400, 'Greeting is required');
  if (!bodyText) throw new ApiError(400, 'Message body is required');
  if (bodyText.length > 5000) throw new ApiError(400, 'Message body is limited to 5000 characters');
  if (bannerImageUrl && !/^https?:\/\//i.test(bannerImageUrl)) {
    throw new ApiError(400, 'Banner image must be a valid http(s) URL');
  }

  const leads = await Lead.find(audienceQuery(orgId, statuses))
    .select('_id firstName lastName email phone')
    .limit(MAX_RECIPIENTS)
    .lean();

  if (leads.length === 0) throw new ApiError(400, 'No leads with an email address match this audience');

  const campaign = await EmailCampaign.create({
    organizationId: orgId,
    name,
    subject,
    greetingText,
    bodyText,
    bannerImageUrl: bannerImageUrl || undefined,
    signOffText: signOffText || undefined,
    audienceStatuses: statuses,
    status: 'queued',
    totalRecipients: leads.length,
    createdBy: user._id,
    createdByName: user.fullName || user.name || user.email || 'Staff',
  });

  await EmailCampaignRecipient.insertMany(
    leads.map((lead: any) => ({
      campaignId: campaign._id,
      organizationId: orgId,
      leadId: lead._id,
      email: lead.email,
      phone: lead.phone || undefined,
      customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'there',
      status: 'pending',
    })),
  );

  res.status(201).json(new ApiResponse(201, { campaign }, 'Campaign queued'));
});

export const cancelCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can cancel email campaigns');

  const { id } = req.params;
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: id, organizationId: orgId, status: { $in: ['queued', 'sending'] } },
    { $set: { status: 'cancelled', completedAt: new Date() } },
    { new: true },
  );
  if (!campaign) throw new ApiError(404, 'Campaign not found or already finished');

  await EmailCampaignRecipient.updateMany(
    { campaignId: id, status: 'pending' },
    { $set: { status: 'skipped', failureReason: 'Campaign cancelled' } },
  );

  res.json(new ApiResponse(200, { campaign }, 'Campaign cancelled'));
});
