import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import User from '../models/User.model';

function requireAdmin(req: Request) {
  const user = (req as any).crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can manage lead groups');
  return user;
}

export const listGroups = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);

  const groups = await CrmLeadGroup.find({ organizationId: orgId, isActive: true })
    .sort({ name: 1 })
    .lean();

  res.json(new ApiResponse(200, groups, 'Lead groups fetched'));
});

export const createGroup = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const user = requireAdmin(req);

  const name = String(req.body?.name || '').trim();
  if (!name) throw new ApiError(400, 'Group name is required');

  const description = String(req.body?.description || '').trim();
  const color = req.body?.color ? String(req.body.color).trim() : undefined;
  const memberIds = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.map((id: unknown) => String(id))
    : [];

  if (memberIds.length > 0) {
    const validCount = await User.countDocuments({
      _id: { $in: memberIds },
      organizationId: orgId,
    });
    if (validCount !== memberIds.length) {
      throw new ApiError(400, 'One or more members do not belong to this organization');
    }
  }

  const group = await CrmLeadGroup.create({
    organizationId: orgId,
    name,
    description,
    color,
    memberIds,
    createdBy: user._id,
  });

  res.status(201).json(new ApiResponse(201, group, 'Lead group created'));
});

export const updateGroup = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  requireAdmin(req);
  const { id } = req.params;

  const group = await CrmLeadGroup.findOne({ _id: id, organizationId: orgId });
  if (!group) throw new ApiError(404, 'Lead group not found');

  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim();
    if (!name) throw new ApiError(400, 'Group name is required');
    group.name = name;
  }

  if (typeof req.body?.description === 'string') {
    group.description = req.body.description.trim();
  }

  if (typeof req.body?.color === 'string' || req.body?.color === null) {
    group.color = req.body.color || undefined;
  }

  if (Array.isArray(req.body?.memberIds)) {
    const memberIds = req.body.memberIds.map((memberId: unknown) => String(memberId));
    if (memberIds.length > 0) {
      const validCount = await User.countDocuments({
        _id: { $in: memberIds },
        organizationId: orgId,
      });
      if (validCount !== memberIds.length) {
        throw new ApiError(400, 'One or more members do not belong to this organization');
      }
    }
    group.memberIds = memberIds as any;
  }

  await group.save();

  res.json(new ApiResponse(200, group, 'Lead group updated'));
});

export const deleteGroup = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  requireAdmin(req);
  const { id } = req.params;

  const group = await CrmLeadGroup.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    { $set: { isActive: false } },
    { new: true },
  );
  if (!group) throw new ApiError(404, 'Lead group not found');

  res.json(new ApiResponse(200, group, 'Lead group removed'));
});
