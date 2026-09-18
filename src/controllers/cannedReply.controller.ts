import { Request, Response } from 'express';
import CannedReply from '../models/cannedReply.model';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

export const getCannedReplies = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  const replies = await CannedReply.find({ organizationId: orgId })
    .sort({ sortOrder: 1, usageCount: -1, createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, replies));
});

export const createCannedReply = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const actingUser = req.user || req.crmUser;
  if (!actingUser) throw new ApiError(401, 'Please authenticate');
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  const { title, body, category, isShared } = req.body || {};

  const trimmedTitle = String(title || '').trim();
  const trimmedBody = String(body || '').trim();

  if (!trimmedTitle) throw new ApiError(400, 'Title is required');
  if (!trimmedBody) throw new ApiError(400, 'Reply text is required');

  const reply = await CannedReply.create({
    organizationId: orgId,
    title: trimmedTitle,
    body: trimmedBody,
    category: category ? String(category).trim() : undefined,
    createdBy: (actingUser as any)._id,
    isShared: isShared === false ? false : true,
  });

  res.status(201).json(new ApiResponse(201, reply, 'Canned reply created'));
});

export const updateCannedReply = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const { id } = req.params;
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  const setValues: Record<string, unknown> = {};
  const body = req.body || {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = String(body.title || '').trim();
    if (!title) throw new ApiError(400, 'Title is required');
    setValues.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'body')) {
    const replyBody = String(body.body || '').trim();
    if (!replyBody) throw new ApiError(400, 'Reply text is required');
    setValues.body = replyBody;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'category')) {
    setValues.category = String(body.category || '').trim() || undefined;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isShared')) {
    setValues.isShared = Boolean(body.isShared);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    setValues.sortOrder = Number(body.sortOrder) || 0;
  }

  const reply = await CannedReply.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    { $set: setValues },
    { new: true, runValidators: true },
  );

  if (!reply) throw new ApiError(404, 'Canned reply not found');

  res.json(new ApiResponse(200, reply, 'Canned reply updated'));
});

export const deleteCannedReply = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const { id } = req.params;
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  const reply = await CannedReply.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!reply) throw new ApiError(404, 'Canned reply not found');

  res.json(new ApiResponse(200, null, 'Canned reply deleted'));
});

/** Fire-and-forget usage counter — bumped when a rep inserts a template into a reply. */
export const useCannedReply = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const { id } = req.params;
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  await CannedReply.updateOne(
    { _id: id, organizationId: orgId },
    { $inc: { usageCount: 1 } },
  );

  res.json(new ApiResponse(200, null, 'Usage recorded'));
});
