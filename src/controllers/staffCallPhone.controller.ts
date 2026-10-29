import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { actor } from './communication.controller';
import { getStaffCallPhone, saveStaffCallPhone, startStaffPhoneVerification } from '../services/staffCallPhone.service';

const who = (req: Request) => {
  const organizationId = String((req as any).orgId || '');
  const userId = String(actor(req).userId || '');
  if (!organizationId || !userId) throw new ApiError(401, 'Please sign in to Suprah CRM');
  return { organizationId, userId };
};

export const getMyCallPhoneHandler = asyncHandler(async (req: Request, res: Response) => {
  const { organizationId, userId } = who(req);
  res.json(new ApiResponse(200, await getStaffCallPhone(organizationId, userId), 'Call phone'));
});

export const saveMyCallPhoneHandler = asyncHandler(async (req: Request, res: Response) => {
  const { organizationId, userId } = who(req);
  res.json(new ApiResponse(200, await saveStaffCallPhone(organizationId, userId, req.body), 'Call phone saved'));
});

export const verifyMyCallPhoneHandler = asyncHandler(async (req: Request, res: Response) => {
  const { organizationId, userId } = who(req);
  res.json(new ApiResponse(200, await startStaffPhoneVerification(organizationId, userId), 'Calling your phone'));
});
