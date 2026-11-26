import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { readLeadEmailAttachment } from '../services/leadEmailAttachment.service';

export const downloadLeadEmailAttachment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = (req as any).orgId;
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const file = await readLeadEmailAttachment({
    organizationId: String(orgId),
    leadId: String(req.params.id),
    gmailId: String(req.params.gmailId),
    index: Number(req.params.index),
  });
  if (!file) throw new ApiError(404, "This attachment can't be opened from Suprah. Open the email in Gmail to see it.");
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', String(file.buffer.length));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.buffer);
});
