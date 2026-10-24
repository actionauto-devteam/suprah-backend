import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { buildLeadConversation, getEarlierConversation } from '../services/leadConversation.service';

function orgOf(req: Request) {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  return orgId;
}

export const getLeadConversation = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const data = await buildLeadConversation(orgId, String(req.params.id), {
    before: req.query.before ? String(req.query.before) : null,
    limit: Number(req.query.limit) || undefined,
  });
  res.json(new ApiResponse(200, data, 'Conversation'));
});

export const getLeadEarlierConversation = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const data = await getEarlierConversation(orgId, String(req.params.id), String(req.params.earlierId));
  res.json(new ApiResponse(200, data, 'Earlier conversation'));
});
