import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { searchInventoryForLead } from '../services/leadVehiclePick.service';

export const searchLeadVehiclesHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const vehicles = await searchInventoryForLead(orgId, req.query.q);
  res.json(new ApiResponse(200, vehicles, 'Inventory vehicles'));
});
