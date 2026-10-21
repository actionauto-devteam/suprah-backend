import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import AiTrainingPolicy, { TRAINING_POLICY_STATUSES } from '../models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../models/AiTrainingAuditLog.model';
import AiDraftEvaluation from '../models/AiDraftEvaluation.model';
import {
  canReviewTraining,
  checkPolicyIntegrity,
  loadVisibleProposal,
  pendingAuditRows,
  proposalVisibilityFilter,
  requireTrainingEnabled,
  resolveTrainingAvailability,
  reviseProposal,
  saveDraftEvaluation,
  setOrganizationTrainingEnabled,
  titleSearchFilter,
  trainingRole,
  transitionProposal,
} from '../services/aiTraining.service';
import {
  createStructuredProposal,
  evaluateStructuredRule,
  previewStructuredRule,
  ruleFromSpec,
  saveStructuredVersion,
  submitStructuredProposal,
} from '../services/aiTrainingRules.service';

function context(req: Request): { orgId: string; user: any } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  return { orgId, user };
}

function pageParams(req: Request) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, 'page must be a whole number from 1 to 1000');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be a whole number from 1 to 100');
  return { page, limit };
}

function serializeProposal(policy: any, viewerId: string) {
  return {
    id: String(policy._id),
    title: policy.title,
    category: policy.category,
    channels: policy.channels || [],
    status: policy.status,
    source: policy.source,
    currentVersion: policy.currentVersion,
    ruleFormat: policy.ruleFormat || 'instruction',
    submittedVersion: policy.submittedVersion || undefined,
    lastEditedByName: policy.lastEditedBy?.name || undefined,
    createdBy: policy.createdBy ? { name: policy.createdBy.name, role: policy.createdBy.role } : null,
    isMine: policy.createdBy?.userId === viewerId,
    submittedAt: policy.submittedAt || undefined,
    lastReview: policy.lastReview?.action
      ? { action: policy.lastReview.action, note: policy.lastReview.note || undefined, byName: policy.lastReview.by?.name, at: policy.lastReview.at }
      : undefined,
    approvedByName: policy.approvedBy?.name || undefined,
    approvedAt: policy.approvedAt || undefined,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function serializeVersion(version: any, viewerId: string) {
  return {
    version: version.version,
    createdByMe: version.createdBy?.userId === viewerId,
    spec: version.spec,
    originalAiMessageSnapshot: version.originalAiMessageSnapshot || undefined,
    changeNote: version.changeNote || undefined,
    createdByName: version.createdBy?.name,
    createdAt: version.createdAt,
  };
}

function serializeAudit(row: any) {
  return {
    id: String(row._id),
    action: row.action,
    version: row.version,
    fromStatus: row.fromStatus || undefined,
    toStatus: row.toStatus || undefined,
    note: row.note || undefined,
    actorName: row.actor?.name,
    actorRole: row.actor?.role,
    createdAt: row.createdAt,
  };
}

async function proposalDetail(orgId: string, policyId: any, viewerId: string, includeAudit: boolean) {
  const policy: any = await AiTrainingPolicy.findOne({ _id: policyId, organizationId: orgId }).lean();
  const [versions, logged, pending] = await Promise.all([
    AiTrainingPolicyVersion.find({ organizationId: orgId, policyId }).sort({ version: -1 }).lean(),
    includeAudit ? AiTrainingAuditLog.find({ organizationId: orgId, policyId }).sort({ createdAt: 1, _id: 1 }).limit(200).lean() : Promise.resolve([]),
    includeAudit ? pendingAuditRows(orgId, policyId) : Promise.resolve([]),
  ]);
  const audit = [...(logged as any[]), ...pending].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || String(a._id).localeCompare(String(b._id)));
  const integrity = await checkPolicyIntegrity(orgId, policy);
  const adopted = new Set(integrity.adoptedVersions);
  const visible = versions.filter((row: any) => adopted.has(Number(row.version)));
  const current: any = visible.find((row: any) => row.version === policy.currentVersion);
  const evaluation = current?.spec?.format === 'structured_v1' ? evaluateStructuredRule(ruleFromSpec(current.spec, policy)) : undefined;
  return {
    ...serializeProposal(policy, viewerId),
    versions: visible.map((row) => serializeVersion(row, viewerId)),
    audit: audit.map(serializeAudit),
    evaluation,
    integrity: { ok: integrity.ok, issues: integrity.issues.map(({ code, severity, message }) => ({ code, severity, message })) },
  };
}

export const getTrainingStatus = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  const availability = await resolveTrainingAvailability(orgId);
  const role = trainingRole(user);
  const reviewer = canReviewTraining(role);
  const pendingReviewCount = reviewer
    ? await AiTrainingPolicy.countDocuments({ organizationId: orgId, status: 'in_review' })
    : undefined;
  res.json(new ApiResponse(200, {
    globalEnabled: availability.globalEnabled,
    orgEnabled: availability.orgEnabled,
    enabled: availability.enabled,
    role,
    canReview: reviewer,
    canManageSettings: role === 'admin',
    pendingReviewCount,
  }, 'AI training status'));
});

export const updateTrainingSettings = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  const result = await setOrganizationTrainingEnabled({ organizationId: orgId, user, enabled: req.body?.enabled, reason: req.body?.reason });
  const availability = await resolveTrainingAvailability(orgId);
  res.json(new ApiResponse(200, { ...availability, changed: result.changed }, result.changed ? 'AI training setting updated' : 'No changes'));
});

export const listTrainingProposals = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { page, limit } = pageParams(req);
  const filter: Record<string, unknown> = proposalVisibilityFilter(orgId, user);
  const status = req.query.status ? String(req.query.status) : '';
  if (status) {
    if (!(TRAINING_POLICY_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, 'Unknown status filter');
    filter.status = status;
  }
  if (req.query.mine === 'true') filter['createdBy.userId'] = String(user._id);
  Object.assign(filter, titleSearchFilter(req.query.q));
  const [rows, total] = await Promise.all([
    AiTrainingPolicy.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AiTrainingPolicy.countDocuments(filter),
  ]);
  const latest = rows.length
    ? await AiTrainingPolicyVersion.find({
      organizationId: orgId,
      $or: rows.map((row: any) => ({ policyId: row._id, version: row.currentVersion })),
    }).select('policyId spec.instruction spec.intent spec.handling').lean()
    : [];
  const instructionByPolicy = new Map(latest.map((row: any) => [String(row.policyId), row.spec?.instruction]));
  const specByPolicy = new Map(latest.map((row: any) => [String(row.policyId), row.spec]));
  res.json(new ApiResponse(200, {
    proposals: rows.map((row: any) => ({
      ...serializeProposal(row, String(user._id)),
      instruction: instructionByPolicy.get(String(row._id)),
      intent: specByPolicy.get(String(row._id))?.intent || undefined,
      handling: specByPolicy.get(String(row._id))?.handling || undefined,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  }, 'Training proposals'));
});

export const getTrainingProposal = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const policy = await loadVisibleProposal(orgId, String(req.params.id), user);
  res.json(new ApiResponse(200, await proposalDetail(orgId, policy._id, String(user._id), true), 'Training proposal'));
});

function lifecycle(action: 'withdraw' | 'request_changes' | 'approve' | 'reject') {
  return asyncHandler(async (req: Request, res: Response) => {
    const { orgId, user } = context(req);
    await requireTrainingEnabled(orgId);
    const updated = await transitionProposal({
      organizationId: orgId, policyId: String(req.params.id), user, action, note: req.body?.note, expectedVersion: req.body?.expectedVersion,
    });
    res.json(new ApiResponse(200, await proposalDetail(orgId, updated._id, String(user._id), true), 'Training proposal updated'));
  });
}

export const withdrawTrainingProposal = lifecycle('withdraw');
export const requestTrainingChanges = lifecycle('request_changes');
export const approveTrainingProposal = lifecycle('approve');
export const rejectTrainingProposal = lifecycle('reject');

export const reviseTrainingProposal = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const updated = await reviseProposal({ organizationId: orgId, policyId: String(req.params.id), user, instruction: req.body?.instruction, changeNote: req.body?.changeNote });
  res.json(new ApiResponse(200, await proposalDetail(orgId, updated._id, String(user._id), true), 'Training proposal revised'));
});

function serializeEvaluation(row: any, viewerId: string) {
  return {
    id: String(row._id),
    draftId: String(row.draftId),
    rating: row.rating,
    correctedReply: row.correctedReply || undefined,
    reasonTags: row.reasonTags || [],
    note: row.note || undefined,
    evaluatorName: row.evaluator?.name,
    isMine: row.evaluator?.userId === viewerId,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function requireReviewer(user: any) {
  if (!canReviewTraining(trainingRole(user))) throw new ApiError(403, 'Only managers or admins can view draft ratings');
}

export const listDraftEvaluations = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  requireReviewer(user);
  await requireTrainingEnabled(orgId);
  const draftId = String(req.query.draftId || '');
  if (!mongoose.isValidObjectId(draftId)) throw new ApiError(400, 'draftId must be a valid id');
  const rows = await AiDraftEvaluation.find({ organizationId: orgId, draftId }).sort({ updatedAt: -1 }).limit(50).lean();
  res.json(new ApiResponse(200, { evaluations: rows.map((row) => serializeEvaluation(row, String(user._id))) }, 'Draft ratings'));
});

export const saveDraftEvaluationHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  requireReviewer(user);
  await requireTrainingEnabled(orgId);
  const evaluation = await saveDraftEvaluation({
    organizationId: orgId,
    draftId: String(req.params.draftId),
    user,
    rating: req.body?.rating,
    correctedReply: req.body?.correctedReply,
    reasonTags: req.body?.reasonTags,
    note: req.body?.note,
  });
  res.json(new ApiResponse(200, serializeEvaluation(evaluation?.toObject ? evaluation.toObject() : evaluation, String(user._id)), 'Draft rating saved'));
});

export const listTrainingAudit = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  requireReviewer(user);
  await requireTrainingEnabled(orgId);
  const { page, limit } = pageParams(req);
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (req.query.policyId) {
    if (!mongoose.isValidObjectId(String(req.query.policyId))) throw new ApiError(400, 'policyId must be a valid id');
    filter.policyId = String(req.query.policyId);
  }
  const pending = await pendingAuditRows(orgId, filter.policyId);
  let rows: any[];
  let total: number;
  if (!pending.length) {
    [rows, total] = await Promise.all([
      AiTrainingAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AiTrainingAuditLog.countDocuments(filter),
    ]);
  } else {
    const [logged, loggedTotal] = await Promise.all([
      AiTrainingAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(page * limit).lean(),
      AiTrainingAuditLog.countDocuments(filter),
    ]);
    rows = [...logged, ...pending]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || String(b._id).localeCompare(String(a._id)))
      .slice((page - 1) * limit, page * limit);
    total = loggedTotal + pending.length;
  }
  res.json(new ApiResponse(200, { entries: rows.map(serializeAudit), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, 'Training audit'));
});


export const previewTrainingRule = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = context(req);
  await requireTrainingEnabled(orgId);
  const result = previewStructuredRule(req.body?.rule);
  res.json(new ApiResponse(200, {
    errors: result.errors,
    warnings: result.warnings,
    readyToSubmit: result.readyToSubmit,
    preview: result.preview,
  }, 'Training rule preview'));
});

export const createTrainingRule = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { policy } = await createStructuredProposal({ organizationId: orgId, user, rule: req.body?.rule, submit: req.body?.submit });
  res.status(201).json(new ApiResponse(201, await proposalDetail(orgId, policy._id, String(user._id), true), 'Training rule saved'));
});

export const saveTrainingRuleVersion = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { policy } = await saveStructuredVersion({
    organizationId: orgId,
    policyId: String(req.params.id),
    user,
    rule: req.body?.rule,
    expectedVersion: req.body?.expectedVersion,
    changeNote: req.body?.changeNote,
  });
  res.json(new ApiResponse(200, await proposalDetail(orgId, policy._id, String(user._id), true), 'New version saved'));
});

export const submitTrainingRule = asyncHandler(async (req: Request, res: Response) => {
  const { orgId, user } = context(req);
  await requireTrainingEnabled(orgId);
  const { policy } = await submitStructuredProposal({ organizationId: orgId, policyId: String(req.params.id), user, expectedVersion: req.body?.expectedVersion });
  res.json(new ApiResponse(200, await proposalDetail(orgId, policy._id, String(user._id), true), 'Submitted for review'));
});
