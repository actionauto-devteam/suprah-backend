import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import MarketingContact, { MarketingContactConsentStatus } from '../models/MarketingContact.model';
import EmailOptOut from '../models/EmailOptOut.model';
import {
  previewMarketingContactImport,
  commitMarketingContactImport,
  computeImportFingerprint,
  MarketingContactImportError,
  ImportSettings,
  SEND_ELIGIBLE_CONSENT_STATUSES,
} from '../services/marketingContact.service';

const VALID_CONSENT_STATUSES: MarketingContactConsentStatus[] = ['unknown', 'claimed_verbal', 'documented'];

function requireAdmin(req: Request) {
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can manage Marketing Contacts');
  return user;
}

function parseSettings(body: any): ImportSettings {
  const importLabel = String(body?.importLabel || '').trim();
  const source = String(body?.source || '').trim();
  const consentStatus = String(body?.consentStatus || '').trim() as MarketingContactConsentStatus;
  const consentNote = String(body?.consentNote || '').trim();

  if (!importLabel) throw new ApiError(400, 'importLabel is required');
  if (importLabel.length > 120) throw new ApiError(400, 'importLabel is limited to 120 characters');
  if (!source) throw new ApiError(400, 'source is required');
  if (source.length > 120) throw new ApiError(400, 'source is limited to 120 characters');
  if (!VALID_CONSENT_STATUSES.includes(consentStatus)) {
    throw new ApiError(400, `consentStatus must be one of: ${VALID_CONSENT_STATUSES.join(', ')}`);
  }
  if (consentNote.length > 1000) throw new ApiError(400, 'consentNote is limited to 1000 characters');

  return { importLabel, source, consentStatus, consentNote: consentNote || undefined };
}

export const importMarketingContacts = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAdmin(req);
  const orgId = String((req as any).orgId);

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError(400, 'A CSV file is required');
  }

  const settings = parseSettings(req.body);
  const confirm = String(req.body?.confirm || '').trim() === 'true';

  try {
    if (!confirm) {
      const { counts, samples } = await previewMarketingContactImport(orgId, file.buffer);
      const fingerprint = computeImportFingerprint(file.buffer, settings);
      res.json(new ApiResponse(200, { fingerprint, counts, samples }, 'Import preview generated'));
      return;
    }

    const providedFingerprint = String(req.body?.fingerprint || '').trim();
    if (!providedFingerprint) {
      throw new ApiError(400, 'A fingerprint from the preview step is required to confirm an import');
    }
    const recomputedFingerprint = computeImportFingerprint(file.buffer, settings);
    if (providedFingerprint !== recomputedFingerprint) {
      throw new ApiError(
        409,
        'The file or import settings have changed since you last previewed this import. Please preview again before confirming.',
      );
    }

    const result = await commitMarketingContactImport(orgId, String(user._id), file.buffer, settings);
    res.status(201).json(new ApiResponse(201, result, 'Import completed'));
  } catch (err: any) {
    if (err instanceof MarketingContactImportError) {
      throw new ApiError(err.statusCode, err.message);
    }
    throw err;
  }
});

export const listMarketingContacts = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = String((req as any).orgId);

  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10)));
  const search = String(req.query.search || '').trim();
  const importLabel = String(req.query.importLabel || '').trim();
  const eligibleOnly = String(req.query.eligibleOnly || '').trim() === 'true';

  const query: Record<string, unknown> = { organizationId: orgId };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    query.$or = [{ email: regex }, { firstName: regex }, { lastName: regex }];
  }
  if (importLabel) query.importLabel = importLabel;
  if (eligibleOnly) {
    query.consentStatus = { $in: SEND_ELIGIBLE_CONSENT_STATUSES };
    const suppressedEmails = await EmailOptOut.find({ organizationId: orgId, optedOut: true }).distinct('email');
    if (suppressedEmails.length > 0) {
      query.email = { $nin: suppressedEmails };
    }
  }

  const [contacts, total] = await Promise.all([
    MarketingContact.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    MarketingContact.countDocuments(query),
  ]);

  res.json(new ApiResponse(200, { contacts, total, page, limit }, 'Marketing contacts fetched'));
});

export const listMarketingContactImportLabels = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = String((req as any).orgId);
  const labels = await MarketingContact.distinct('importLabel', { organizationId: orgId });
  res.json(new ApiResponse(200, { labels: labels.sort() }, 'Import labels fetched'));
});

export const deleteMarketingContact = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = String((req as any).orgId);
  const { id } = req.params;

  const deleted = await MarketingContact.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!deleted) throw new ApiError(404, 'Marketing contact not found');

  res.json(new ApiResponse(200, { deleted: true }, 'Marketing contact deleted'));
});
