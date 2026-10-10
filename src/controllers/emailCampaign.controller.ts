import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import EmailCampaign from '../models/EmailCampaign.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import MarketingContact from '../models/MarketingContact.model';
import EmailOptOut from '../models/EmailOptOut.model';
import Organization from '../models/Organization.model';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';
import { isConsentEligibleForSend } from '../services/marketingContact.service';

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
  const audienceSource = req.body?.audienceSource === 'marketingContacts' ? 'marketingContacts' : 'leadStatus';

  if (!name) throw new ApiError(400, 'Campaign name is required');
  if (!subject) throw new ApiError(400, 'Subject is required');
  if (!greetingText) throw new ApiError(400, 'Greeting is required');
  if (!bodyText) throw new ApiError(400, 'Message body is required');
  if (bodyText.length > 5000) throw new ApiError(400, 'Message body is limited to 5000 characters');
  if (bannerImageUrl && !/^https?:\/\//i.test(bannerImageUrl)) {
    throw new ApiError(400, 'Banner image must be a valid http(s) URL');
  }

  const org = await Organization.findById(orgId).select('metadata').lean();
  const physicalMailingAddress = String((org?.metadata as any)?.physicalMailingAddress || '').trim();
  if (!physicalMailingAddress) {
    throw new ApiError(
      400,
      'A verified business mailing address is required before sending email campaigns. Add one in Settings.',
    );
  }

  let audienceStatuses: string[] = [];
  let totalRecipients: number;
  let recipientDocs: Record<string, unknown>[];
  let selectionSummary: Record<string, number> | undefined;

  if (audienceSource === 'marketingContacts') {
    const requestedRaw = Array.isArray(req.body?.marketingContactIds) ? req.body.marketingContactIds : [];
    const requestedIds: string[] = Array.from(
      new Set<string>(
        requestedRaw.map((id: unknown) => String(id).trim()).filter((id: string) => id.length > 0),
      ),
    );

    if (requestedIds.length === 0) throw new ApiError(400, 'Select at least one Marketing Contact');
    if (requestedIds.length > MAX_RECIPIENTS) {
      throw new ApiError(400, `You can select at most ${MAX_RECIPIENTS} recipients per campaign`);
    }

    const validObjectIds = requestedIds.filter((id) => mongoose.isValidObjectId(id));

    const matchedContacts = await MarketingContact.find({
      _id: { $in: validObjectIds },
      organizationId: orgId,
    })
      .select('_id email firstName lastName phone consentStatus')
      .lean();

    const matchedIdSet = new Set(matchedContacts.map((c: any) => String(c._id)));
    const notFoundOrWrongOrg = requestedIds.filter((id) => !matchedIdSet.has(id)).length;

    const consentEligible = matchedContacts.filter((c: any) => isConsentEligibleForSend(c.consentStatus));
    const consentExcludedCount = matchedContacts.length - consentEligible.length;

    const eligibleEmails = consentEligible.map((c: any) => c.email);
    const suppressedEmails =
      eligibleEmails.length > 0
        ? await EmailOptOut.find({ organizationId: orgId, email: { $in: eligibleEmails }, optedOut: true }).distinct(
            'email',
          )
        : [];
    const suppressedSet = new Set(suppressedEmails);

    const finalContacts = consentEligible.filter((c: any) => !suppressedSet.has(c.email));

    if (finalContacts.length === 0) {
      throw new ApiError(
        400,
        'None of the selected contacts are eligible to receive this campaign (consent not documented, or suppressed)',
      );
    }

    totalRecipients = finalContacts.length;
    recipientDocs = finalContacts.map((c: any) => ({
      organizationId: orgId,
      marketingContactId: c._id,
      email: c.email,
      phone: c.phone || undefined,
      customerName: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'there',
      status: 'pending',
    }));
    selectionSummary = {
      requested: requestedIds.length,
      notFoundOrWrongOrg,
      excludedConsentNotEligible: consentExcludedCount,
      excludedSuppressed: suppressedSet.size,
      included: finalContacts.length,
    };
  } else {
    const statuses = parseStatuses(req.body?.statuses);
    const leads = await Lead.find(audienceQuery(orgId, statuses))
      .select('_id firstName lastName email phone')
      .limit(MAX_RECIPIENTS)
      .lean();

    if (leads.length === 0) throw new ApiError(400, 'No leads with an email address match this audience');

    audienceStatuses = statuses;
    totalRecipients = leads.length;
    recipientDocs = leads.map((lead: any) => ({
      organizationId: orgId,
      leadId: lead._id,
      email: lead.email,
      phone: lead.phone || undefined,
      customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'there',
      status: 'pending',
    }));
  }

  const campaign = await EmailCampaign.create({
    organizationId: orgId,
    name,
    subject,
    greetingText,
    bodyText,
    bannerImageUrl: bannerImageUrl || undefined,
    signOffText: signOffText || undefined,
    audienceStatuses,
    status: 'queued',
    totalRecipients,
    createdBy: user._id,
    createdByName: user.fullName || user.name || user.email || 'Staff',
  });

  await EmailCampaignRecipient.insertMany(
    recipientDocs.map((doc) => ({ ...doc, campaignId: campaign._id })),
  );

  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { campaign, ...(selectionSummary ? { selection: selectionSummary } : {}) },
        'Campaign queued',
      ),
    );
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
