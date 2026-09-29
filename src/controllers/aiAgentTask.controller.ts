import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import AiAgentTask from '../models/AiAgentTask.model';

const STATUSES = ['pending', 'resolved', 'dismissed'];

const serialize = (task: any) => ({
  ...task,
  id: String(task._id),
});

export const listAiAgentTasks = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { status, leadId } = req.query;

  const filter: Record<string, any> = { organizationId: orgId };
  filter.status = status && STATUSES.includes(status as string) ? status : 'pending';
  if (leadId) filter.leadId = leadId;

  const tasks = await AiAgentTask.find(filter)
    .sort({ waitingSince: 1 })
    .limit(200)
    .populate('assigneeIds', 'fullName name email')
    .lean();

  res.json(new ApiResponse(200, { data: tasks.map(serialize) }, 'AI agent tasks'));
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
