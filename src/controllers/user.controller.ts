import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import User from '../models/User.model';
import Organization from '../models/Organization.model';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { invalidateUserCache } from '../utils/cache.util';

const searchUsers = asyncHandler(async (req: Request, res: Response) => {
    const { q, limit = 10, excludeSelf = 'true' } = req.query;
    const currentUserId = (req.user as IUser)._id.toString();

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
        return res.json(new ApiResponse(200, [], 'No search query provided'));
    }

    try {
        const searchQuery = q.trim();
        const searchRegex = new RegExp(searchQuery, 'i');
        const limitNum = parseInt(limit as string);

        const searchCriteria: any = {
            organizationId: req.orgId,
            $or: [
                { name: searchRegex },
                { email: searchRegex }
            ]
        };

        // Exclude current user if specified
        if (excludeSelf === 'true') {
            searchCriteria._id = { $ne: currentUserId };
        }

        const users = await User.find(searchCriteria)
            .select('_id name email avatar role')
            .limit(limitNum)
            .lean()
            .exec();

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
    const userId = req.params.id || (req.user as IUser)._id.toString();
    const orgId = req.orgId as string;

    const user = await User.findOne({ _id: userId, organizationId: orgId }).select('-password');

    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    res.json(new ApiResponse(200, user, 'User profile fetched successfully'));
});

const updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();

    // Don't allow updating sensitive fields through this method
    const sensitiveFields = [
        'password', 'email', 'role', 'googleId', 'emailVerified',
        'isApproved', 'onboardingCompleted', 'otpCode', 'otpExpiresAt',
        'organizationId', 'organizationRole', 'isActive', 'lastLogin',
        '_id', '__v', 'createdAt', 'updatedAt'
    ];

    const safeData = { ...req.body };
    sensitiveFields.forEach(field => delete safeData[field]);

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: safeData },
        { new: true, runValidators: true }
    ).select('-password');

    if (user) {
        await activityService.logProfileUpdate(
            user._id.toString(),
            user.organizationId?.toString(),
            Object.keys(safeData),
            req.ip,
            req.get('user-agent')
        );
        logger.info({ userId: user._id }, 'User profile updated');
    }

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

    // ← CACHE INVALIDATION FIX: Clear cache so next request fetches fresh user data
    invalidateUserCache(userId.toString());

    await activityService.createActivity({
        userId: user!._id.toString(),
        organizationId: organization._id.toString(),
        type: 'settings_change',
        title: 'Organization Selected',
        description: `Switched to organization: ${organization.name}`,
        metadata: { organizationId: organization._id, role },
        ipAddress: req.ip
    });

    logger.info({ userId: user!._id, orgId: organization._id }, 'Organization selected');

    res.json(new ApiResponse(200, user, `Selected organization: ${organization.name}`));
});

export default {
    searchUsers,
    getProfile,
    updateProfile,
    getUserOrganizations,
    selectOrganization
};