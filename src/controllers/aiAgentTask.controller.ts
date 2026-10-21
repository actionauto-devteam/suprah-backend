import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import AiAgentTask from '../models/AiAgentTask.model';
import { LEGACY_TECHNICAL_ATTENTION_REASON, attentionKindOf } from '../models/aiHumanAttention';
import { previewTechnicalRecovery, recoverTechnicalPause } from '../services/aiTechnicalRecovery.service';

const STATUSES = ['pending', 'resolved', 'dismissed'];
const KINDS = ['customer', 'technical'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const LEGACY_TECHNICAL = { attentionKind: { $exists: false }, question: LEGACY_TECHNICAL_ATTENTION_REASON };

const serialize = (task: any) => ({
  ...task,
  id: String(task._id),
  attentionKind: task.attentionKind || attentionKindOf({ reason: task.question }),
});

export const listAiAgentTasks = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { status, leadId, kind } = req.query;

  const filter: Record<string, any> = { organizationId: orgId };
  filter.status = status && STATUSES.includes(status as string) ? status : 'pending';
  if (leadId) {
    if (!mongoose.isValidObjectId(leadId)) throw new ApiError(400, 'Invalid lead id');
    filter.leadId = leadId;
  }
  if (kind && KINDS.includes(kind as string)) {
    filter.$or = kind === 'technical'
      ? [{ attentionKind: 'technical' }, LEGACY_TECHNICAL]
      : [{ attentionKind: 'customer' }, { attentionKind: { $exists: false }, question: { $ne: LEGACY_TECHNICAL_ATTENTION_REASON } }];
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(String(req.query.limit || ''), 10) || DEFAULT_LIMIT));
  const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || ''), 10) || 1);
  const total = await AiAgentTask.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);

  const tasks = await AiAgentTask.find(filter)
    .sort({ waitingSince: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('assigneeIds', 'fullName name email')
    .lean();

  res.json(new ApiResponse(200, { data: tasks.map(serialize), total, page, limit, totalPages }, 'AI agent tasks'));
});

export const previewTechnicalTaskRecovery = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser || (req as any).user;
  if (!user) throw new ApiError(401, 'Please authenticate');
  const preview = await previewTechnicalRecovery(orgId, String(req.params.id), user);
  res.json(new ApiResponse(200, preview, 'Technical recovery preview'));
});

export const recoverTechnicalTask = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser || (req as any).user;
  if (!user) throw new ApiError(401, 'Please authenticate');
  const result = await recoverTechnicalPause({
    organizationId: orgId,
    taskId: String(req.params.id),
    user,
    acknowledged: req.body?.acknowledged,
    acknowledgedMessageCount: req.body?.acknowledgedMessageCount,
    emailThreadReviewed: req.body?.emailThreadReviewed,
  });
  res.json(new ApiResponse(200, result, 'Conversation resumed'));
});

export const resolveAiAgentTask = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser || (req as any).user;
  if (!user) throw new ApiError(401, 'Please authenticate');

  const task = await AiAgentTask.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId, status: 'pending' },
    {
      $set: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: user._id,
        resolutionNote: String(req.body?.resolutionNote || '').trim() || undefined,
      },
    },
    { new: true },
  ).lean();
  if (!task) throw new ApiError(404, 'Task not found or already handled');

  res.json(new ApiResponse(200, serialize(task), 'Task resolved'));
});

export const dismissAiAgentTask = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = (req as any).crmUser || (req as any).user;
  if (!user) throw new ApiError(401, 'Please authenticate');

  const task = await AiAgentTask.findOneAndUpdate(
    { _id: req.params.id, organizationId: orgId, status: 'pending' },
    { $set: { status: 'dismissed', resolvedAt: new Date(), resolvedBy: user._id } },
    { new: true },
  ).lean();
  if (!task) throw new ApiError(404, 'Task not found or already handled');

  res.json(new ApiResponse(200, serialize(task), 'Task dismissed'));
});
