import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import activityService from '../services/activity.service';
import logger from '../utils/logger';
import { getCustomerProfile, listCustomerRecords, updateCustomerRecord } from '../services/customerRecords.service';
import { getCustomerTimeline } from '../services/customerLifecycle.service';
import { getCustomerCatchUpStatus } from '../services/customerCatchUp.service';

const requireOrgId = (req: Request) => {
  const orgId = req.orgId ? String(req.orgId) : '';
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  return orgId;
};

const isCrmAdmin = (req: Request) => {
  const user: any = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  return user.role === 'admin';
};

export const getCustomerCatchUpStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = requireOrgId(req);
  if (!isCrmAdmin(req)) {
    res.json(new ApiResponse(200, { canView: false, ready: true, remaining: 0 }, 'Customer catch-up'));
    return;
  }
  const status = await getCustomerCatchUpStatus(orgId);
  res.json(new ApiResponse(200, { canView: true, ...status }, 'Customer catch-up'));
});

export const listCustomerRecordsHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = requireOrgId(req);
  const { search, status, sort, page, limit } = req.query;
  const result = await listCustomerRecords(orgId, { search, status, sort, page, limit });
  res.json(new ApiResponse(200, result, 'Customer records'));
});

export const getCustomerProfileHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = requireOrgId(req);
  const profile = await getCustomerProfile(orgId, String(req.params.id));
  res.json(new ApiResponse(200, profile, 'Customer profile'));
});

export const getCustomerTimelineHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = requireOrgId(req);
  const { filter, before, limit } = req.query;
  const timeline = await getCustomerTimeline(orgId, String(req.params.id), { filter, before, limit });
  res.json(new ApiResponse(200, timeline, 'Customer timeline'));
});

export const updateCustomerRecordHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = requireOrgId(req);
  const user: any = req.user || req.crmUser;
  if (!user?._id) throw new ApiError(401, 'Please authenticate');
  const profile = await updateCustomerRecord(orgId, String(req.params.id), req.body || {}, String(user._id));
  await activityService.createActivity({
    userId: String(user._id),
    organizationId: orgId,
    type: 'other',
    title: 'Customer Record Updated',
    description: `Customer ${[profile.customer.firstName, profile.customer.lastName].filter(Boolean).join(' ')} record updated`,
    metadata: { customerId: profile.customer.id },
  }).catch((error: unknown) => logger.warn({ error, customerId: profile.customer.id }, 'Customer record activity was not saved'));
  res.json(new ApiResponse(200, profile, 'Customer updated'));
});
