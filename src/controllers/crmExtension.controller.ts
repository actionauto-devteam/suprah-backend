import { NextFunction, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import Organization from '../models/Organization.model';
import { verifyCrmCredentials } from '../services/crmCredentials.service';
import { issueCrmExtensionToken, revokeCrmExtensionToken } from '../middleware/crmExtensionAuth.middleware';
import {
  addExtensionLeadNote,
  getExtensionReplyOptions,
  getLeadAiControlChannel,
  getLeadAiStatus,
  getLeadHistory,
  getLeadNotes,
  lookupLeadsByEmail,
  lookupLeadsByPhone,
  sendExtensionEmail,
  sendExtensionText,
} from '../services/crmExtension.service';
import { actor, pauseSmsAi, resumeSmsAi } from './communication.controller';
import { pauseEmailAi, resumeEmailAi } from './lead.controller';
import { pauseWebchatAi, resumeWebchatAi } from './webchat.controller';

const AI_CONTROL_HANDLERS = {
  pause: { sms: pauseSmsAi, webchat: pauseWebchatAi, email: asyncHandler(pauseEmailAi) },
  resume: { sms: resumeSmsAi, webchat: resumeWebchatAi, email: asyncHandler(resumeEmailAi) },
};

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
  const { phone, email } = req.body || {};
  req.body = {};
  const hasPhone = phone !== undefined && phone !== null && phone !== '';
  const hasEmail = email !== undefined && email !== null && email !== '';
  if (hasPhone && hasEmail) throw new ApiError(400, 'Look up one phone number or email address at a time');
  const orgId = String(req.orgId || '');
  const result = hasEmail ? await lookupLeadsByEmail(orgId, email) : await lookupLeadsByPhone(orgId, phone);
  logger.info({ crmUserId: String(req.crmUser?._id || ''), organizationId: req.orgId, matches: result.total }, hasEmail ? '[CrmExtension] Email lookup' : '[CrmExtension] Phone lookup');
  res.json(new ApiResponse(200, result, 'Lookup complete'));
});

export const historyHandler = asyncHandler(async (req: Request, res: Response) => {
  const history = await getLeadHistory(String(req.orgId || ''), String(req.params.id || ''), req.query.before);
  res.json(new ApiResponse(200, history, 'Lead history'));
});

export const addNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const { note } = req.body || {};
  req.body = {};
  const user: any = req.crmUser;
  const result = await addExtensionLeadNote(
    String(req.orgId || ''),
    { id: String(user?._id || ''), name: String(user?.fullName || user?.username || 'Team member') },
    String(req.params.id || ''),
    note,
  );
  logger.info({ crmUserId: String(user?._id || ''), organizationId: req.orgId, leadId: String(req.params.id || ''), duplicate: result.duplicate }, '[CrmExtension] Note added');
  res.status(result.duplicate ? 200 : 201).json(new ApiResponse(result.duplicate ? 200 : 201, result, result.duplicate ? 'Note already saved' : 'Note saved'));
});

export const aiStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const status = await getLeadAiStatus(String(req.orgId || ''), String(req.params.id || ''));
  res.json(new ApiResponse(200, status, 'AI agent status'));
});

export const replyOptionsHandler = asyncHandler(async (req: Request, res: Response) => {
  const options = await getExtensionReplyOptions(String(req.orgId || ''), String(req.params.id || ''));
  res.json(new ApiResponse(200, options, 'Reply options'));
});

const sendInput = (req: Request) => {
  const { message, clientRequestId, recipient } = req.body || {};
  req.body = {};
  return { body: message, clientRequestId, confirmedRecipient: recipient };
};

const sendLog = (req: Request, channel: string, duplicate: boolean) => {
  logger.info({ crmUserId: String(req.crmUser?._id || ''), organizationId: req.orgId, leadId: String(req.params.id || ''), channel, duplicate }, '[CrmExtension] Message sent');
};

export const sendTextHandler = asyncHandler(async (req: Request, res: Response) => {
  const input = sendInput(req);
  const result = await sendExtensionText(String(req.orgId || ''), actor(req), String(req.params.id || ''), input);
  sendLog(req, 'sms', result.duplicate);
  const status = result.duplicate ? 200 : 201;
  res.status(status).json(new ApiResponse(status, result, result.duplicate ? 'Text already sent' : 'Text sent'));
});

export const sendEmailHandler = asyncHandler(async (req: Request, res: Response) => {
  const input = sendInput(req);
  const result = await sendExtensionEmail(String(req.orgId || ''), req.crmUser?._id, String(req.params.id || ''), input, req.ip);
  sendLog(req, 'email', result.duplicate);
  const status = result.duplicate ? 200 : 201;
  res.status(status).json(new ApiResponse(status, result, result.duplicate ? 'Email already sent' : 'Email sent'));
});

const aiControl = (action: 'pause' | 'resume') => asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const leadId = String(req.params.id || '');
  const channel = await getLeadAiControlChannel(String(req.orgId || ''), leadId);
  req.params.leadId = leadId;
  logger.info({ crmUserId: String(req.crmUser?._id || ''), organizationId: req.orgId, leadId, channel }, `[CrmExtension] AI ${action}`);
  AI_CONTROL_HANDLERS[action][channel](req, res, next);
});

export const aiPauseHandler = aiControl('pause');
export const aiResumeHandler = aiControl('resume');

export const notesHandler = asyncHandler(async (req: Request, res: Response) => {
  const notes = await getLeadNotes(String(req.orgId || ''), String(req.params.id || ''));
  res.json(new ApiResponse(200, notes, 'Lead notes'));
});
