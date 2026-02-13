// controllers/user.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import User from '../models/User.model';

import Organization from '../models/Organization.model';

const searchUsers = asyncHandler(async (req: Request, res: Response) => {
    // ... (existing searchUsers logic unchanged)
    const { q, limit = 10, excludeSelf = 'true' } = req.query;
    const currentUserId = (req.user as IUser)._id.toString();

    console.log('[UserController] Search request:', { q, limit, excludeSelf, currentUserId });

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
        console.log('[UserController] Empty search query, returning empty array');
        return res.json(new ApiResponse(200, [], 'No search query provided'));
    }

    try {
        const searchQuery = q.trim();
        const searchRegex = new RegExp(searchQuery, 'i');
        const limitNum = parseInt(limit as string);

        const searchCriteria: any = {
            $or: [
                { name: searchRegex },
                { email: searchRegex }
            ]
        };

        // Exclude current user if specified
        if (excludeSelf === 'true') {
            searchCriteria._id = { $ne: currentUserId };
        }

        console.log('[UserController] Search criteria:', JSON.stringify(searchCriteria));

        const users = await User.find(searchCriteria)
            .select('_id name email avatar role')
            .limit(limitNum)
            .lean()
            .exec();

        console.log('[UserController] Found users:', users.length);

        // Transform to plain objects with proper typing
        const transformedUsers = users.map(user => ({
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role
        }));

        res.json(new ApiResponse(200, transformedUsers, `Found ${transformedUsers.length} users`));
    } catch (error) {
        console.error('[UserController] Search error:', error);
        throw error;
    }
});

const getProfile = asyncHandler(async (req: Request, res: Response) => {
    // ... (existing getProfile logic unchanged)
    const userId = req.params.id || (req.user as IUser)._id.toString();

    const user = await User.findById(userId).select('-password');

    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    res.json(new ApiResponse(200, user, 'User profile fetched successfully'));
});

const updateProfile = asyncHandler(async (req: Request, res: Response) => {
    // ... (existing updateProfile logic unchanged)
    const userId = (req.user as IUser)._id.toString();

    // Don't allow updating sensitive fields through this method
    const { password, email, role, ...safeData } = req.body;

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: safeData },
        { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    res.json(new ApiResponse(200, user, 'Profile updated successfully'));
});

const getUserOrganizations = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id;

    const organizations = await Organization.find({
        $or: [
            { ownerId: userId },
            { members: userId }
        ]
    }).sort({ createdAt: -1 });

    res.json(new ApiResponse(200, organizations, 'User organizations fetched successfully'));
});

const selectOrganization = asyncHandler(async (req: Request, res: Response) => {
    const { organizationId } = req.body;
    const userId = (req.user as IUser)._id;

    if (!organizationId) {
        return res.status(400).json(new ApiResponse(400, null, 'Organization ID is required'));
    }

    const organization = await Organization.findById(organizationId);

    if (!organization) {
        return res.status(404).json(new ApiResponse(404, null, 'Organization not found'));
    }

    // Verify membership
    const isOwner = organization.ownerId.toString() === userId.toString();
    const isMember = organization.members?.some((id: any) => id.toString() === userId.toString());

    if (!isOwner && !isMember) {
        return res.status(403).json(new ApiResponse(403, null, 'You are not a member of this organization'));
    }

    const role = isOwner ? 'admin' : 'member';

    const user = await User.findByIdAndUpdate(
        userId,
        {
            organizationId: organization._id,
            organizationRole: role
        },
        { new: true }
    ).select('-password');

    res.json(new ApiResponse(200, user, `Selected organization: ${organization.name}`));
});

export default {
    searchUsers,
    getProfile,
    updateProfile,
    getUserOrganizations,
    selectOrganization
};