import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import Organization from '../models/Organization.model';
import { verifyCrmCredentials } from '../services/crmCredentials.service';
import { issueCrmExtensionToken, revokeCrmExtensionToken } from '../middleware/crmExtensionAuth.middleware';
import { getLeadNotes, lookupLeadsByPhone } from '../services/crmExtension.service';

const publicUser = (user: any) => ({
  fullName: String(user.fullName || ''),
  username: String(user.username || ''),
  role: String(user.role || 'employee'),
});

const organizationName = async (orgId: unknown) => {
  const organization: any = await Organization.findById(orgId).select('name').lean();
  return String(organization?.name || '');
};

export const createSessionHandler = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  req.body = {};
  const user = await verifyCrmCredentials(username, password);
  if (!user.organizationId) throw new ApiError(403, 'Your account is not linked to a dealership');
  const { token, expiresAt } = await issueCrmExtensionToken(String(user._id));
  res.json(new ApiResponse(200, {
    token,
    expiresAt,
    user: publicUser(user),
    organization: { name: await organizationName(user.organizationId) },
  }, 'Signed in'));
});

export const getSessionHandler = asyncHandler(async (req: Request, res: Response) => {
  res.json(new ApiResponse(200, {
    user: publicUser(req.crmUser),
    organization: { name: await organizationName(req.orgId) },
  }, 'Session active'));
});

export const deleteSessionHandler = asyncHandler(async (req: Request, res: Response) => {
  await revokeCrmExtensionToken(String(req.crmAuthToken || ''));
  res.json(new ApiResponse(200, null, 'Signed out'));
});

export const lookupHandler = asyncHandler(async (req: Request, res: Response) => {
  const { phone } = req.body || {};
  req.body = {};
  const result = await lookupLeadsByPhone(String(req.orgId || ''), phone);
  logger.info({ crmUserId: String(req.crmUser?._id || ''), organizationId: req.orgId, matches: result.total }, '[CrmExtension] Phone lookup');
  res.json(new ApiResponse(200, result, 'Lookup complete'));
});

export const notesHandler = asyncHandler(async (req: Request, res: Response) => {
  const notes = await getLeadNotes(String(req.orgId || ''), String(req.params.id || ''));
  res.json(new ApiResponse(200, notes, 'Lead notes'));
});
