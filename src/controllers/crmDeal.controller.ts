import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { resolveCrmStaff } from '../utils/crmStaff';
import { addDealOffer, createDeal, deleteDeal, getDeal, listDeals, searchDealLeads, updateDeal } from '../services/crmDeal.service';

async function context(req: Request) {
  const orgId = req.orgId ? String(req.orgId) : '';
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  return { orgId, staff: await resolveCrmStaff(orgId, req.crmUser) };
}

export const listDealsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  res.json(new ApiResponse(200, await listDeals(orgId, staff, req.query), 'Deals'));
});

export const searchDealLeadsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = await context(req);
  res.json(new ApiResponse(200, await searchDealLeads(orgId, req.query.search), 'Leads'));
});

export const getDealHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  res.json(new ApiResponse(200, await getDeal(orgId, staff, String(req.params.id)), 'Deal'));
});

export const createDealHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  res.status(201).json(new ApiResponse(201, await createDeal(orgId, staff, req.body || {}), 'Deal created'));
});

export const updateDealHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  res.json(new ApiResponse(200, await updateDeal(orgId, staff, String(req.params.id), req.body || {}), 'Deal updated'));
});

export const addDealOfferHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  res.status(201).json(new ApiResponse(201, await addDealOffer(orgId, staff, String(req.params.id), req.body || {}), 'Offer added'));
});

export const deleteDealHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, staff } = await context(req);
  await deleteDeal(orgId, staff, String(req.params.id));
  res.json(new ApiResponse(200, null, 'Deal deleted'));
});
