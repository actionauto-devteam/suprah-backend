import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import EmailCampaign from '../models/EmailCampaign.model';
import EmailCampaignRecipient from '../models/EmailCampaignRecipient.model';
import MarketingContact from '../models/MarketingContact.model';
import { buildMarketingContactQuery } from './marketingContact.controller';
import EmailOptOut from '../models/EmailOptOut.model';
import Organization from '../models/Organization.model';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';
import { hasSendPermission } from '../services/marketingContact.service';
import { sanitizeEmailHtml, htmlToPlainText } from '../utils/emailHtmlSanitizer';
import emailService, { campaignGreetingNameFor } from '../services/email.service';
import storageService, { BucketType } from '../services/storage.service';
import logger from '../utils/logger';

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

async function filterEligibleContacts(contacts: any[], orgId: string) {
  const consentEligible = contacts.filter((c: any) => hasSendPermission(c));
  const consentExcludedCount = contacts.length - consentEligible.length;

  const eligibleEmails = consentEligible.map((c: any) => c.email);
  const suppressedEmails =
    eligibleEmails.length > 0
      ? await EmailOptOut.find({ organizationId: orgId, email: { $in: eligibleEmails }, optedOut: true }).distinct('email')
      : [];
  const suppressedSet = new Set(suppressedEmails);

  const finalContacts = consentEligible.filter((c: any) => !suppressedSet.has(c.email));

  return { finalContacts, consentExcludedCount, suppressedCount: suppressedSet.size };
}

export const getAudienceCount = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const statuses = parseStatuses(req.query.statuses);
  const query = audienceQuery(orgId, statuses);
  const [count, sampleLead] = await Promise.all([
    Lead.countDocuments(query),
    Lead.findOne(query).select('firstName lastName email').lean(),
  ]);
  const previewRecipient = sampleLead
    ? {
        firstName: String((sampleLead as any).firstName || '').trim(),
        displayName: [(sampleLead as any).firstName, (sampleLead as any).lastName].filter(Boolean).join(' ').trim(),
        email: String((sampleLead as any).email || ''),
      }
    : null;

  res.json(new ApiResponse(200, { count, capped: Math.min(count, MAX_RECIPIENTS), previewRecipient }, 'Audience count'));
});

export const previewCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can send email campaigns');

  const subject = String(req.body?.subject || '');
  const greetingText = String(req.body?.greetingText || '');
  const rawBodyHtml = String(req.body?.bodyHtml || '').trim();
  const rawBannerImageUrl = String(req.body?.bannerImageUrl || '').trim();
  const signOffText = String(req.body?.signOffText || '');
  const previewFirstName = campaignGreetingNameFor(req.body?.previewFirstName);

  const bodyHtml = rawBodyHtml ? sanitizeEmailHtml(rawBodyHtml) : '';
  const bodyText = bodyHtml ? htmlToPlainText(bodyHtml) : String(req.body?.bodyText || '');
  const bannerImageUrl = /^https?:\/\//i.test(rawBannerImageUrl) ? rawBannerImageUrl : '';
  const countImages = (html: string) => (html.match(/<img\b/gi) || []).length;
  const insecureImageUrls = (rawBodyHtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi) || [])
    .map((tag) => (tag.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1] || '')
    .filter((src) => src && !/^https:\/\//i.test(src)).length + (rawBannerImageUrl && !/^https:\/\//i.test(rawBannerImageUrl) ? 1 : 0);

  const rendered = await emailService.renderCampaignEmail(
    {
      to: '',
      greetingName: previewFirstName,
      subject,
      greetingText,
      bannerImageUrl: bannerImageUrl || undefined,
      bodyText,
      bodyHtml: bodyHtml || undefined,
      signOffText,
      organizationId: orgId,
    },
    'preview',
  );

  res.json(new ApiResponse(200, {
    subject: rendered.subject,
    html: rendered.html,
    greetingName: rendered.greetingName,
    missingMailingAddress: rendered.missingMailingAddress,
    images: {
      inEditor: countImages(rawBodyHtml) + (rawBannerImageUrl ? 1 : 0),
      inEmail: rendered.imageCount,
      removedBySanitizer: countImages(rawBodyHtml) - countImages(bodyHtml) + (rawBannerImageUrl && !bannerImageUrl ? 1 : 0),
      notHttps: insecureImageUrls,
    },
  }, 'Campaign preview'));
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

  const [failedSample, uncertainSample] = await Promise.all([
    EmailCampaignRecipient.find({ campaignId: id, status: 'failed' })
      .select('customerName email failureReason')
      .limit(20)
      .lean(),
    EmailCampaignRecipient.find({ campaignId: id, status: 'uncertain' })
      .select('customerName email failureReason')
      .limit(20)
      .lean(),
  ]);

  res.json(new ApiResponse(200, { campaign, failedSample, uncertainSample }, 'Campaign fetched'));
});

export const uploadCampaignImage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can send email campaigns');

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file?.buffer?.length) throw new ApiError(400, 'Choose a JPG, PNG, WEBP, or GIF image to upload');

  let url: string;
  try {
    url = await storageService.upload(file, `email-campaigns/${orgId}`, BucketType.PUBLIC, { allowLocalFallback: false });
  } catch (err) {
    logger.error({ err, orgId }, '[EmailCampaign] Campaign image upload failed');
    throw new ApiError(502, 'The image could not be uploaded right now. Please try again.');
  }
  if (!/^https:\/\//i.test(url)) {
    logger.error({ orgId, url }, '[EmailCampaign] Image storage returned a non-public URL');
    throw new ApiError(500, 'Image storage is not set up for email images yet. Please contact your developer.');
  }

  res.status(201).json(new ApiResponse(201, { url }, 'Image uploaded'));
});

export const createCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can send email campaigns');

  const name = String(req.body?.name || '').trim();
  const subject = String(req.body?.subject || '').trim();
  const greetingText = String(req.body?.greetingText || '').trim();
  const rawBodyHtml = String(req.body?.bodyHtml || '').trim();
  const bannerImageUrl = String(req.body?.bannerImageUrl || '').trim();
  const signOffText = String(req.body?.signOffText || '').trim();
  const audienceSource = req.body?.audienceSource === 'marketingContacts' ? 'marketingContacts' : 'leadStatus';
  const { status: initialStatus, scheduledAt } = resolveScheduling(req.body?.scheduledAt);

  let bodyHtml = '';
  let bodyText = String(req.body?.bodyText || '').trim();
  if (rawBodyHtml) {
    bodyHtml = sanitizeEmailHtml(rawBodyHtml);
    if (bodyHtml.length > 50000) throw new ApiError(400, 'Message body is limited to 50000 characters');
    bodyText = htmlToPlainText(bodyHtml);
  }

  if (!name) throw new ApiError(400, 'Campaign name is required');
  if (!subject) throw new ApiError(400, 'Subject is required');
  if (!greetingText) throw new ApiError(400, 'Greeting is required');
  if (!bodyText) throw new ApiError(400, 'Message body is required');
  if (!bodyHtml && bodyText.length > 5000) throw new ApiError(400, 'Message body is limited to 5000 characters');
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
    const marketingContactsMode = req.body?.marketingContactsMode === 'filter' ? 'filter' : 'ids';

    if (marketingContactsMode === 'filter') {
      const search = String(req.body?.search || '').trim();
      const importLabel = String(req.body?.importLabel || '').trim();
      const query = await buildMarketingContactQuery(orgId, { search, importLabel, eligibleOnly: false });

      const audienceTotal = await MarketingContact.countDocuments(query);
      if (audienceTotal === 0) throw new ApiError(400, 'No Marketing Contacts match this filter');
      if (audienceTotal > MAX_RECIPIENTS) {
        throw new ApiError(
          400,
          `This filter matches ${audienceTotal} contacts, which is over the current ${MAX_RECIPIENTS}-recipient safe sending limit. Narrow your filter to ${MAX_RECIPIENTS} or fewer contacts before sending.`,
        );
      }

      const matchedContacts = await MarketingContact.find(query)
        .select('_id email firstName lastName phone consentStatus permissionOverride')
        .limit(MAX_RECIPIENTS)
        .lean();

      const { finalContacts, consentExcludedCount, suppressedCount } = await filterEligibleContacts(matchedContacts, orgId);

      if (finalContacts.length === 0) {
        throw new ApiError(
          400,
          'None of the contacts matching this filter are eligible to receive this campaign (consent not documented, or suppressed)',
        );
      }

      totalRecipients = finalContacts.length;
      recipientDocs = finalContacts.map((c: any) => ({
        organizationId: orgId,
        marketingContactId: c._id,
        email: c.email,
        phone: c.phone || undefined,
        customerName: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'there',
        greetingName: campaignGreetingNameFor(c.firstName),
        status: 'pending',
      }));
      selectionSummary = {
        requested: matchedContacts.length,
        notFoundOrWrongOrg: 0,
        excludedConsentNotEligible: consentExcludedCount,
        excludedSuppressed: suppressedCount,
        included: finalContacts.length,
      };
    } else {
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
        .select('_id email firstName lastName phone consentStatus permissionOverride')
        .lean();

      const matchedIdSet = new Set(matchedContacts.map((c: any) => String(c._id)));
      const notFoundOrWrongOrg = requestedIds.filter((id) => !matchedIdSet.has(id)).length;

      const { finalContacts, consentExcludedCount, suppressedCount } = await filterEligibleContacts(matchedContacts, orgId);

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
        greetingName: campaignGreetingNameFor(c.firstName),
        status: 'pending',
      }));
      selectionSummary = {
        requested: requestedIds.length,
        notFoundOrWrongOrg,
        excludedConsentNotEligible: consentExcludedCount,
        excludedSuppressed: suppressedCount,
        included: finalContacts.length,
      };
    }
  } else {
    const statuses = parseStatuses(req.body?.statuses);
    const audienceTotal = await Lead.countDocuments(audienceQuery(orgId, statuses));
    if (audienceTotal === 0) throw new ApiError(400, 'No leads with an email address match this audience');
    if (audienceTotal > MAX_RECIPIENTS) {
      throw new ApiError(
        400,
        `This audience has ${audienceTotal} eligible leads, which is over the current ${MAX_RECIPIENTS}-recipient safe sending limit. Narrow your status filter to ${MAX_RECIPIENTS} or fewer leads before sending.`,
      );
    }

    const leads = await Lead.find(audienceQuery(orgId, statuses))
      .select('_id firstName lastName email phone')
      .limit(MAX_RECIPIENTS)
      .lean();

    audienceStatuses = statuses;
    totalRecipients = leads.length;
    recipientDocs = leads.map((lead: any) => ({
      organizationId: orgId,
      leadId: lead._id,
      email: lead.email,
      phone: lead.phone || undefined,
      customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'there',
      greetingName: campaignGreetingNameFor(lead.firstName),
      status: 'pending',
    }));
  }

  const campaign = await EmailCampaign.create({
    organizationId: orgId,
    name,
    subject,
    greetingText,
    bodyText,
    bodyHtml: bodyHtml || undefined,
    bannerImageUrl: bannerImageUrl || undefined,
    signOffText: signOffText || undefined,
    audienceStatuses,
    status: initialStatus,
    scheduledAt,
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
        initialStatus === 'scheduled' ? 'Campaign scheduled' : 'Campaign queued',
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
    { _id: id, organizationId: orgId, status: { $in: ['scheduled', 'queued', 'sending'] } },
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

export const rescheduleCampaign = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can reschedule email campaigns');

  const { id } = req.params;
  const { scheduledAt } = resolveScheduling(req.body?.scheduledAt);
  if (!scheduledAt) throw new ApiError(400, 'scheduledAt is required to reschedule a campaign');

  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: id, organizationId: orgId, status: { $in: ['queued', 'scheduled'] } },
    { $set: { status: 'scheduled', scheduledAt } },
    { new: true },
  );
  if (!campaign) {
    throw new ApiError(404, 'Campaign not found, or it has already started sending and can no longer be rescheduled');
  }

  res.json(new ApiResponse(200, { campaign }, 'Campaign rescheduled'));
});
