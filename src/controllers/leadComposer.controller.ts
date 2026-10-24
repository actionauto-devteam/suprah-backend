import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { getLeadReplyOptions } from '../services/leadComposer.service';
import { generateStaffDraft } from '../services/aiAgentDraft.service';

export const getLeadReplyOptionsHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const options = await getLeadReplyOptions(orgId, req.params.id);
  res.json(new ApiResponse(200, options, 'Reply options'));
});

export const generateLeadAiDraftHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const result = await generateStaffDraft({
    organizationId: orgId,
    leadId: req.params.id,
    channel: req.body?.channel,
    staff: { userId: user._id, name: user.fullName || user.name },
  });
  res.json(new ApiResponse(200, result, 'Draft ready'));
});
