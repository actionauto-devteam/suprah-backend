import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import {
  createDealershipNumber,
  currentNumberSuggestion,
  deleteDealershipNumber,
  listDealershipNumbers,
  recheckDealershipNumber,
  updateDealershipNumber,
} from '../services/dealershipPhoneNumber.service';

function admin(req: Request) {
  if (!req.orgId) throw new ApiError(400, 'Organization context missing');
  if (req.crmUser?.role !== 'admin') throw new ApiError(403, 'Only admins can manage phone numbers');
  return { orgId: String(req.orgId), userId: String(req.crmUser._id) };
}

export const listPhoneNumbersHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = admin(req);
  const [numbers, suggestion] = await Promise.all([listDealershipNumbers(orgId), currentNumberSuggestion(orgId)]);
  res.json(new ApiResponse(200, { numbers, suggestion }, 'Phone numbers'));
});

export const createPhoneNumberHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, userId } = admin(req);
  const number = await createDealershipNumber(orgId, userId, req.body);
  res.status(201).json(new ApiResponse(201, number, 'Phone number added'));
});

export const updatePhoneNumberHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, userId } = admin(req);
  const number = await updateDealershipNumber(orgId, String(req.params.id), userId, req.body);
  res.json(new ApiResponse(200, number, 'Phone number saved'));
});

export const recheckPhoneNumberHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = admin(req);
  const number = await recheckDealershipNumber(orgId, String(req.params.id));
  res.json(new ApiResponse(200, number, 'Phone number checked'));
});

export const deletePhoneNumberHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = admin(req);
  await deleteDealershipNumber(orgId, String(req.params.id));
  res.json(new ApiResponse(200, null, 'Phone number removed'));
});
