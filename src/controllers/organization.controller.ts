import { Request, Response } from 'express';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';

export const createOrganization = async (req: Request, res: Response) => {
    const { name, slug } = req.body;
    const userId = req.auth?.userId; // From Clerk (still used for Auth)
    const user = req.user; // Local user

    if (!userId || !user) {
        throw new ApiError(401, 'Unauthorized');
    }

    // Check if slug exists
    const existingOrg = await Organization.findOne({ slug });
    if (existingOrg) {
        throw new ApiError(400, 'Organization with this slug already exists');
    }

    const org = await Organization.create({
        name,
        slug,
        ownerId: user._id,
        // clerkId: ... // Optional, we can leave it empty or generate a placeholder if needed
    });

    // Update user's organization
    user.organizationId = org._id as mongoose.Types.ObjectId;
    user.organizationRole = 'admin';
    await user.save();

    res.status(201).json({
        success: true,
        data: org,
    });
};

export const getOrganization = async (req: Request, res: Response) => {
    const { id } = req.params;

    // Ensure user has access to this org
    // This check might be redundant if we use org.middleware, but good for direct ID access
    if (req.user?.organizationId?.toString() !== id && req.user?.role !== 'admin') {
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
};

export const updateOrganization = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, logoUrl, metadata } = req.body;

    // Verify ownership or admin role
    const org = await Organization.findById(id);
    if (!org) {
        throw new ApiError(404, 'Organization not found');
    }

    if (org.ownerId.toString() !== req.user?._id.toString() && req.user?.organizationRole !== 'admin') {
        throw new ApiError(403, 'Only the owner or admins can update the organization');
    }

    org.name = name || org.name;
    org.logoUrl = logoUrl || org.logoUrl;
    if (metadata) org.metadata = { ...org.metadata, ...metadata };

    await org.save();

    res.status(200).json({
        success: true,
        data: org,
    });
};

export const deleteOrganization = async (req: Request, res: Response) => {
    const { id } = req.params;

    const org = await Organization.findById(id);
    if (!org) {
        throw new ApiError(404, 'Organization not found');
    }

    if (org.ownerId.toString() !== req.user?._id.toString()) {
        throw new ApiError(403, 'Only the owner can delete the organization');
    }

    await Organization.findByIdAndDelete(id);

    // Detach all members
    await User.updateMany(
        { organizationId: id },
        { $unset: { organizationId: 1, organizationRole: 1 } }
    );

    res.status(200).json({
        success: true,
        message: 'Organization deleted',
    });
};

export const getMembers = async (req: Request, res: Response) => {
    const { id } = req.params;

    if (req.user?.organizationId?.toString() !== id) {
        throw new ApiError(403, 'Unauthorized');
    }

    const members = await User.find({ organizationId: id })
        .select('name email avatar role organizationRole createdAt')
        .sort({ createdAt: -1 });

    res.status(200).json({
        success: true,
        data: members,
    });
};

export const removeMember = async (req: Request, res: Response) => {
    const { id, userId } = req.params;

    const org = await Organization.findById(id);
    if (!org) {
        throw new ApiError(404, 'Organization not found');
    }

    // Only admin/owner can remove
    const isOwner = org.ownerId.toString() === req.user?._id.toString();
    const isAdmin = req.user?.organizationRole === 'admin';

    if (!isOwner && !isAdmin) {
        throw new ApiError(403, 'Unauthorized');
    }

    // Cannot remove owner
    if (org.ownerId.toString() === userId) {
        throw new ApiError(400, 'Cannot remove the owner of the organization');
    }

    await User.findByIdAndUpdate(userId, {
        $unset: { organizationId: 1, organizationRole: 1 }
    });

    res.status(200).json({
        success: true,
        message: 'Member removed',
    });
};
