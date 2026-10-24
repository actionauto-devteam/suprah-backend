import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { getLeadVehiclePreview } from '../services/leadVehiclePreview.service';

export const getLeadVehiclePreviewHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const preview = await getLeadVehiclePreview(orgId, req.params.id);
  res.json(new ApiResponse(200, preview, 'Vehicle of interest'));
});
