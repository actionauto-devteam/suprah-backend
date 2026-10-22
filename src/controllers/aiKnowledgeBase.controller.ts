import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import {
  approveKnowledgeEntry,
  archiveKnowledgeEntry,
  createKnowledgeEntry,
  disableKnowledgeEntry,
  enableKnowledgeEntry,
  getKnowledgeEntryDetail,
  getKnowledgeVersion,
  knowledgeBaseStatus,
  listKnowledgeAudit,
  listKnowledgeEntries,
  listKnowledgeEntryAudit,
  listKnowledgeLocations,
  listKnowledgeVersions,
  rejectKnowledgeEntry,
  requestKnowledgeChanges,
  requireKnowledgeBaseEnabled,
  requireKnowledgeBaseServer,
  restoreKnowledgeEntry,
  saveKnowledgeVersion,
  setOrganizationKnowledgeBaseEnabled,
  submitKnowledgeEntry,
} from '../services/aiKnowledgeBase.service';
import {
  approveVerifiedDetail,
  archiveVerifiedDetail,
  getVerifiedDetail,
  listVerifiedDetails,
  proposeVerifiedDetail,
  reapproveVerifiedDetail,
  revokeVerifiedDetail,
  serializeVerifiedDetail,
  updateVerifiedDetail,
} from '../services/aiKnowledgeVerifiedDetails.service';

function context(req: Request): { orgId: string; user: any } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  return { orgId, user };
}

async function guard(req: Request) {
  const ctx = context(req);
  await requireKnowledgeBaseEnabled(ctx.orgId);
  return ctx;
}

function pageParams(req: Request) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, 'page must be a whole number from 1 to 1000');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be a whole number from 1 to 100');
  return { page, limit };
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

export const getKnowledgeBaseStatus = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  res.json(new ApiResponse(200, await knowledgeBaseStatus(orgId, user), 'Knowledge Base status'));
});

export const updateKnowledgeBaseSettings = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  requireKnowledgeBaseServer();
  await setOrganizationKnowledgeBaseEnabled({ organizationId: orgId, user, enabled: body(req).enabled, reason: body(req).reason });
  res.json(new ApiResponse(200, await knowledgeBaseStatus(orgId, user), 'Knowledge Base setting saved'));
});

export const listLocations = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = await guard(req);
  res.json(new ApiResponse(200, await listKnowledgeLocations(orgId), 'Knowledge Base locations'));
});

export const listEntries = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const { page, limit } = pageParams(req);
  res.json(new ApiResponse(200, await listKnowledgeEntries({ organizationId: orgId, user, query: req.query as Record<string, unknown>, page, limit }), 'Knowledge Base entries'));
});

export const createEntry = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const entry = await createKnowledgeEntry({ organizationId: orgId, user, body: req.body });
  res.status(201).json(new ApiResponse(201, await getKnowledgeEntryDetail({ organizationId: orgId, entryId: String(entry._id), user }), 'Knowledge Base draft saved'));
});

export const getEntry = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await getKnowledgeEntryDetail({ organizationId: orgId, entryId: req.params.id, user }), 'Knowledge Base entry'));
});

export const saveEntryVersion = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  await saveKnowledgeVersion({ organizationId: orgId, entryId: req.params.id, user, body: req.body });
  res.json(new ApiResponse(200, await getKnowledgeEntryDetail({ organizationId: orgId, entryId: req.params.id, user }), 'Knowledge Base version saved'));
});

export const listEntryVersions = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await listKnowledgeVersions({ organizationId: orgId, entryId: req.params.id, user }), 'Knowledge Base versions'));
});

export const getEntryVersion = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await getKnowledgeVersion({ organizationId: orgId, entryId: req.params.id, user, version: req.params.version }), 'Knowledge Base version'));
});

export const getEntryAudit = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await listKnowledgeEntryAudit({ organizationId: orgId, entryId: req.params.id, user }), 'Knowledge Base entry history'));
});

export const getAudit = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const { page, limit } = pageParams(req);
  res.json(new ApiResponse(200, await listKnowledgeAudit({ organizationId: orgId, user, page, limit }), 'Knowledge Base history'));
});

function lifecycleHandler(run: (input: { organizationId: string; entryId: string; user: any; body: Record<string, unknown> }) => Promise<unknown>, message: string) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { orgId, user } = await guard(req);
    await run({ organizationId: orgId, entryId: req.params.id, user, body: body(req) });
    res.json(new ApiResponse(200, await getKnowledgeEntryDetail({ organizationId: orgId, entryId: req.params.id, user }), message));
  });
}

export const submitEntry = lifecycleHandler(
  (input) => submitKnowledgeEntry({ ...input, expectedVersion: input.body.expectedVersion }),
  'Knowledge Base entry submitted for review',
);
export const requestEntryChanges = lifecycleHandler(
  (input) => requestKnowledgeChanges({ ...input, expectedVersion: input.body.expectedVersion, note: input.body.note }),
  'Changes requested',
);
export const approveEntry = lifecycleHandler(
  (input) => approveKnowledgeEntry({ ...input, expectedVersion: input.body.expectedVersion, note: input.body.note }),
  'Knowledge Base entry approved',
);
export const rejectEntry = lifecycleHandler(
  (input) => rejectKnowledgeEntry({ ...input, expectedVersion: input.body.expectedVersion, note: input.body.note }),
  'Knowledge Base entry rejected',
);
export const disableEntry = lifecycleHandler(
  (input) => disableKnowledgeEntry({ ...input, note: input.body.note }),
  'Knowledge Base entry disabled',
);
export const enableEntry = lifecycleHandler(
  (input) => enableKnowledgeEntry({ ...input, note: input.body.note }),
  'Knowledge Base entry turned back on',
);
export const archiveEntry = lifecycleHandler(
  (input) => archiveKnowledgeEntry({ ...input, note: input.body.note }),
  'Knowledge Base entry archived',
);
export const restoreEntry = lifecycleHandler(
  (input) => restoreKnowledgeEntry({ ...input, note: input.body.note }),
  'Knowledge Base entry restored for review',
);

export const listDetails = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await listVerifiedDetails({ organizationId: orgId, user, query: req.query as Record<string, unknown> }), 'Verified business details'));
});

export const getDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  res.json(new ApiResponse(200, await getVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user }), 'Verified business detail'));
});

export const proposeDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await proposeVerifiedDetail({ organizationId: orgId, user, body: req.body });
  res.status(201).json(new ApiResponse(201, serializeVerifiedDetail(detail), 'Verified business detail proposed'));
});

export const updateDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await updateVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user, body: req.body });
  res.json(new ApiResponse(200, serializeVerifiedDetail(detail), 'Verified business detail updated'));
});

export const approveDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await approveVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user, expectedRevision: body(req).expectedRevision });
  res.json(new ApiResponse(200, serializeVerifiedDetail(detail), 'Verified business detail approved'));
});

export const reapproveDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await reapproveVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user, expectedRevision: body(req).expectedRevision });
  res.json(new ApiResponse(200, serializeVerifiedDetail(detail), 'Verified business detail re-approved for restored locations'));
});

export const revokeDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await revokeVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user, expectedRevision: body(req).expectedRevision, note: body(req).note });
  res.json(new ApiResponse(200, serializeVerifiedDetail(detail), 'Verified business detail revoked'));
});

export const archiveDetail = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = await guard(req);
  const detail = await archiveVerifiedDetail({ organizationId: orgId, detailId: req.params.id, user, expectedRevision: body(req).expectedRevision, note: body(req).note });
  res.json(new ApiResponse(200, serializeVerifiedDetail(detail), 'Verified business detail archived'));
});
