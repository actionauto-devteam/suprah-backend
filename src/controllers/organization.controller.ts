import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import mongoose from 'mongoose';
import logger from '../utils/logger';
import activityService from '../services/activity.service';

export const createOrganization = asyncHandler(async (req: Request, res: Response) => {
    const { name, slug } = req.body;
    const user = req.user; // Local user

    if (!user) {
        throw new ApiError(401, 'Unauthorized');
    }

    // Check if slug exists
    const existingOrg = await Organization.findOne({ slug });
    if (existingOrg) {
        res.status(400).json({
            success: false,
            message: 'Organization with this name already exists',
        });
        return;
    }

    const org = await Organization.create({
        name,
        slug,
        ownerId: user._id,
    });

    await activityService.createActivity({
        userId: user._id.toString(),
        organizationId: org._id.toString(),
        type: 'other',
        title: 'Organization Created',
        description: `New organization registered: ${name}`,
        metadata: { slug }
    });

    logger.info({ orgId: org._id, ownerId: user._id }, 'New organization created');

    // Update user's organization
    user.organizationId = org._id as mongoose.Types.ObjectId;
    (user as any).organizationRole = 'admin';
    await user.save();

    res.status(201).json({
        success: true,
        data: org,
    });
});

export const getOrganization = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    // Ensure user has access to this org
    // This check might be redundant if we use org.middleware, but good for direct ID access
    // We check if the context (req.orgId) matches the requested ID, OR if the user is a super_admin
    if (req.orgId !== id && req.user?.role !== 'super_admin') {
        throw new ApiError(403, 'You do not have access to this organization');
    }

    const org = await Organization.findById(id);
    if (!org) {
        throw new ApiError(404, 'Organization not found');
    }

    res.status(200).json({
        success: true,
        data: org,
    });
});

export const updateOrganization = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, logoUrl, metadata } = req.body;

    // Verify ownership or admin role
    const org = await Organization.findById(id);
    if (!org) {
        res.status(404).json({
            success: false,
            message: 'Organization not found',
        });
        return;
    }

    // Allow if Super Admin OR (Org Admin of this specific org)
    // Note: req.orgRole is forced to 'admin' when proxying
    const isSuperAdmin = req.user?.role === 'super_admin';
    const isOrgAdmin = req.orgId === id && req.orgRole === 'admin';
    const isOwner = org.ownerId.toString() === req.user?._id.toString();

    if (!isSuperAdmin && !isOrgAdmin && !isOwner) {
        res.status(403).json({
            success: false,
            message: 'Only the owner or admins can update the organization',
        });
        return;
    }

    org.name = name || org.name;
    org.logoUrl = logoUrl || org.logoUrl;
    if (metadata) org.metadata = { ...org.metadata, ...metadata };

    await org.save();

    await activityService.createActivity({
        userId: (req.user?._id as any).toString(),
        organizationId: org._id.toString(),
        type: 'settings_change',
        title: 'Organization Settings Updated',
        description: `Settings modified for ${org.name}`,
        metadata: { name, logoUrl }
    });

    logger.info({ orgId: org._id }, 'Organization settings updated');

    res.status(200).json({
        success: true,
        data: org,
    });
});

export const deleteOrganization = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const org = await Organization.findById(id);
    if (!org) {
        res.status(404).json({
            success: false,
            message: 'Organization not found',
        });
        return;
    }

    if (org.ownerId.toString() !== req.user?._id.toString()) {
        res.status(403).json({
            success: false,
            message: 'Only the owner can delete the organization',
        });
        return;
    }

    await Organization.findByIdAndDelete(id);

    await activityService.createActivity({
        userId: (req.user?._id as any).toString(),
        organizationId: id,
        type: 'other',
        title: 'Organization Deleted',
        description: `Organization ${org.name} was removed from the system`
    });

    logger.warn({ orgId: id, performedBy: req.user?._id }, 'Organization deleted');

    // Detach all members
    await User.updateMany(
        { organizationId: id },
        { $unset: { organizationId: 1, organizationRole: 1 } }
    );

    res.status(200).json({
        success: true,
        message: 'Organization deleted',
    });
});

export const getMembers = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    // Check if the current context matches the requested ID (or super_admin)
    if (req.orgId !== id && req.user?.role !== 'super_admin') {
        res.status(403).json({
            success: false,
            message: 'Unauthorized',
        });
        return;
    }

    const members = await User.find({ organizationId: id })
        .select('name email avatar role organizationRole createdAt')
        .sort({ createdAt: -1 });

    // Ensure global admins are displayed as organization admins
    const results = members.map(m => {
        const member = m.toObject();
        if (member.role === 'admin') {
            member.organizationRole = 'admin';
        }
        return member;
    });

    res.status(200).json({
        success: true,
        data: results,
    });
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
    const { id, userId } = req.params;

    const org = await Organization.findById(id);
    if (!org) {
        res.status(404).json({
            success: false,
            message: 'Organization not found',
        });
        return;
    }

    // Only admin/owner can remove
    const isOwner = req.user?._id && org.ownerId.toString() === req.user._id.toString();
    const isAdmin = req.orgRole === 'admin'; // Proxy aware
    const isSuperAdmin = req.user?.role === 'super_admin';

    if (!isOwner && !isAdmin && !isSuperAdmin) {
        res.status(403).json({
            success: false,
            message: 'Unauthorized',
        });
        return;
    }

    // Cannot remove owner
    if (org.ownerId.toString() === userId) {
        res.status(400).json({
            success: false,
            message: 'Cannot remove the owner of the organization',
        });
        return;
    }

    await User.findByIdAndUpdate(userId, {
        $unset: { organizationId: 1, organizationRole: 1 }
    });

    await activityService.createActivity({
        userId: (req.user?._id as any).toString(),
        organizationId: id,
        type: 'other',
        title: 'Member Removed',
        description: 'Team member was removed from the organization',
        metadata: { removedUserId: userId }
    });

    logger.info({ orgId: id, removedUserId: userId }, 'Member removed from organization');

    const removedUser = await User.findById(userId);
    if (removedUser) {
        safeCreateNotification({ userId: removedUser._id.toString(), organizationId: id, type: 'team_member_left', title: 'Removed from Organization', message: `You have been removed from ${org.name}.` });
    }
    notifyOrgAdmins(id, 'team_member_left', 'Member Removed', `A member has been removed from the organization.`, { removedUserId: userId });

    res.status(200).json({
        success: true,
        message: 'Member removed',
    });
});
