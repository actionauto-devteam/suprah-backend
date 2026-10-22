import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { importTemplate } from '../services/aiTrainingImportParser';
import {
  commitImport,
  getImportBatchDetail,
  getImportItemDetail,
  listImportBatches,
  loadImportBatch,
  previewImport,
  purgeImportContent,
  requireImportAccess,
  requireImportEnabled,
} from '../services/aiTrainingImport.service';
import { saveImportBatchToKnowledge } from '../services/aiKnowledgeImport.service';
import logger from '../utils/logger';

function context(req: Request): { orgId: string; user: any } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  return { orgId, user };
}

async function guard(req: Request) {
  const ctx = context(req);
  requireImportAccess(ctx.user);
  await requireImportEnabled(ctx.orgId);
  return ctx;
}

function pageParams(req: Request, maxLimit: number) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, 'page must be a whole number from 1 to 1000');
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new ApiError(400, `limit must be a whole number from 1 to ${maxLimit}`);
  return { page, limit };
}

export const getImportTemplate = asyncHandler(async (req: Request, res: Response) => {
  await guard(req);
  const format = String(req.query.format || 'csv');
  if (format !== 'csv' && format !== 'json') throw new ApiError(400, 'format must be csv or json');
  res.json(new ApiResponse(200, importTemplate(format), 'Import template'));
});

export const previewImportHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = await guard(req);
  res.json(new ApiResponse(200, await previewImport({ organizationId: orgId, body: req.body }), 'Import preview'));
});

export const commitImportHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const result = await commitImport({ organizationId: orgId, user, body: req.body });
  let knowledge: any;
  try {
    knowledge = await saveImportBatchToKnowledge({ organizationId: orgId, user, batchId: result.batchId });
  } catch (err: any) {
    logger.error({ organizationId: orgId, batchId: result.batchId, errorName: err?.name }, '[KnowledgeImport] Saving imported items to the Knowledge Base failed');
    knowledge = { enabled: true, error: 'The import was saved, but its Knowledge Base drafts could not be created. Open the import details and save them again.' };
  }
  const detail = await getImportBatchDetail({ organizationId: orgId, user, batchId: result.batchId, page: 1, limit: 100 });
  res.status(201).json(new ApiResponse(201, { ...detail, knowledgeSave: knowledge }, 'Import saved as drafts'));
});

export const listImportsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const { page, limit } = pageParams(req, 50);
  res.json(new ApiResponse(200, await listImportBatches({ organizationId: orgId, user, page, limit }), 'Import history'));
});

export const getImportHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const { page, limit } = pageParams(req, 100);
  res.json(new ApiResponse(200, await getImportBatchDetail({
    organizationId: orgId, user, batchId: String(req.params.id), status: req.query.status, page, limit,
  }), 'Import'));
});

export const getImportItemHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = await guard(req);
  res.json(new ApiResponse(200, await getImportItemDetail({ organizationId: orgId, batchId: String(req.params.id), itemId: String(req.params.itemId) }), 'Import item'));
});

export const purgeImportHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const result = await purgeImportContent({ organizationId: orgId, user, batchId: String(req.params.id), confirmation: req.body?.confirmation });
  res.json(new ApiResponse(200, result, result.purged ? 'Stored originals removed' : 'Nothing left to remove'));
});

export const saveImportToKnowledgeHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const batch = await loadImportBatch(orgId, String(req.params.id));
  const result = await saveImportBatchToKnowledge({ organizationId: orgId, user, batchId: String(batch._id) });
  if (!result.enabled) throw new ApiError(409, result.message || 'The Knowledge Base is turned off for this organization.');
  res.json(new ApiResponse(200, result, result.created || result.updated ? 'Saved to the Knowledge Base' : 'Nothing new to save'));
});
