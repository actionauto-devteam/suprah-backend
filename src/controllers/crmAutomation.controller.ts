import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import {
  canEditAutomations,
  canViewAutomations,
  createAutomation,
  deleteAutomation,
  duplicateAutomation,
  getAutomation as loadAutomation,
  getAutomationOptions,
  listAutomationActivity,
  listAutomations,
  setAutomationStatus,
  updateAutomationAlerts,
  updateAutomation,
} from '../services/crmAutomation.service';
import { createDataSync, deleteDataSync, getDataSync, listDataSyncs, updateDataSync } from '../services/crmDataSync.service';

function viewer(req: Request) {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  if (!canViewAutomations(user.role)) throw new ApiError(403, 'Only managers and admins can view automations');
  return { orgId, user, canEdit: canEditAutomations(user.role) };
}

function editor(req: Request) {
  const access = viewer(req);
  if (!access.canEdit) throw new ApiError(403, 'Only admins can add or change automations');
  return { orgId: access.orgId, actor: { userId: String(access.user._id), name: String(access.user.fullName || 'Admin') } };
}

export const getAutomations = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, canEdit } = viewer(req);
  res.json(new ApiResponse(200, { items: await listAutomations(orgId), canEdit }, 'Automations'));
});

export const getOptions = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, canEdit } = viewer(req);
  res.json(new ApiResponse(200, { ...(await getAutomationOptions(orgId)), canEdit }, 'Automation options'));
});

export const getAutomation = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, canEdit } = viewer(req);
  res.json(new ApiResponse(200, { automation: await loadAutomation(orgId, String(req.params.id)), canEdit }, 'Automation'));
});

export const postAutomation = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.status(201).json(new ApiResponse(201, { automation: await createAutomation(orgId, actor, req.body) }, 'Automation saved'));
});

export const patchAutomation = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.json(new ApiResponse(200, { automation: await updateAutomation(orgId, actor, String(req.params.id), req.body) }, 'Automation saved'));
});

export const postDuplicate = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.status(201).json(new ApiResponse(201, { automation: await duplicateAutomation(orgId, actor, String(req.params.id)) }, 'Automation duplicated'));
});

export const postStatus = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.json(new ApiResponse(200, { automation: await setAutomationStatus(orgId, actor, String(req.params.id), req.body?.status) }, 'Automation status saved'));
});

export const patchAlerts = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.json(new ApiResponse(200, { automation: await updateAutomationAlerts(orgId, actor, String(req.params.id), req.body) }, 'Alerts saved'));
});

export const getSyncs = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, canEdit } = viewer(req);
  res.json(new ApiResponse(200, { items: await listDataSyncs(orgId), canEdit }, 'Data syncs'));
});

export const getSync = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, canEdit } = viewer(req);
  res.json(new ApiResponse(200, { sync: await getDataSync(orgId, String(req.params.id)), canEdit }, 'Data sync'));
});

export const postSync = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.status(201).json(new ApiResponse(201, { sync: await createDataSync(orgId, actor, req.body) }, 'Data sync saved'));
});

export const patchSync = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, actor } = editor(req);
  res.json(new ApiResponse(200, { sync: await updateDataSync(orgId, actor, String(req.params.id), req.body) }, 'Data sync saved'));
});

export const removeSync = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = editor(req);
  await deleteDataSync(orgId, String(req.params.id));
  res.json(new ApiResponse(200, { deleted: true }, 'Data sync deleted'));
});

export const getActivity = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = viewer(req);
  const data = await listAutomationActivity(orgId, {
    automationId: req.query.automation ? String(req.query.automation) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    mode: req.query.mode ? String(req.query.mode) : undefined,
    page: Number(req.query.page) || 1,
  });
  res.json(new ApiResponse(200, data, 'Automation activity'));
});

export const removeAutomation = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = editor(req);
  await deleteAutomation(orgId, String(req.params.id));
  res.json(new ApiResponse(200, { deleted: true }, 'Automation deleted'));
});
