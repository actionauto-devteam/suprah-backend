import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { findLicensePossibleMatches } from '../services/licensePossibleMatch.service';

export const getLicensePossibleMatchesHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user || (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please sign in');
  const orgId = String((req as any).orgId || '');
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const result = await findLicensePossibleMatches(orgId, {
    firstName: req.query.firstName,
    lastName: req.query.lastName,
    address: req.query.address,
  });
  res.json(new ApiResponse(200, result, 'Possible matches'));
});
