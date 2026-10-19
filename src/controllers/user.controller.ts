import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import User from '../models/User.model';
import Organization from '../models/Organization.model';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { invalidateUserCache } from '../utils/cache.util';
import { ApiError } from '../utils/ApiError';

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

    const sensitiveFields = [
        'password', 'email', 'role', 'googleId', 'emailVerified',
        'isApproved', 'onboardingCompleted', 'otpCode', 'otpExpiresAt',
        'organizationId', 'organizationRole', 'dispatcherOrganizationIds', 'isActive', 'lastLogin',
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

/**
 * POST /api/users/me/select-org
 *
 * Used AFTER onboarding is complete to switch between orgs the user already
 * belongs to. Requires prior membership (owner or member).
 */
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

    // Verify prior membership — this route is for switching, not joining
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
            organizationRole: role,
            onboardingCompleted: true,
        },
        { new: true }
    ).select('-password');

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

/**
 * POST /api/users/me/join-org
 *
 * Used DURING onboarding (step 2) when a customer picks the dealership they
 * purchased from. No prior membership required — this IS the join action.
 * Sets onboardingCompleted: true so the user won't be redirected back here.
 */
const joinOnboardingOrg = asyncHandler(async (req: Request, res: Response) => {
    const { organizationId } = req.body;
    const userId = (req.user as IUser)._id;

    if (!organizationId) {
        return res.status(400).json(new ApiResponse(400, null, 'Organization ID is required'));
    }

    const organization = await Organization.findById(organizationId);

    if (!organization) {
        return res.status(404).json(new ApiResponse(404, null, 'Organization not found'));
    }

    const user = await User.findByIdAndUpdate(
        userId,
        {
            organizationId: organization._id,
            organizationRole: 'member',
            onboardingCompleted: true,
        },
        { new: true }
    ).select('-password');

    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }

    invalidateUserCache(userId.toString());

    await activityService.createActivity({
        userId: user._id.toString(),
        organizationId: organization._id.toString(),
        type: 'other',
        title: 'Joined Dealership',
        description: `Customer joined dealership during onboarding: ${organization.name}`,
        metadata: { organizationId: organization._id },
        ipAddress: req.ip,
    });

    logger.info({ userId: user._id, orgId: organization._id }, 'Customer joined org during onboarding');

    res.json(new ApiResponse(200, user, `Joined ${organization.name} successfully`));
});

/**
 * POST /api/users/me/complete-onboarding
 *
 * Step 1 of the onboarding flow. Sets the user's role:
 *   - 'customer'   → role stays 'customer', proceed to org selection (skipOrgSelect: false)
 *   - 'dealership' → role set to 'employee', onboarding marked complete (skipOrgSelect: true)
 */
const completeOnboarding = asyncHandler(async (req: Request, res: Response) => {
    const { role } = req.body;
    const userId = (req.user as IUser)._id;

    // This step only finishes a new customer's account (the role page offers
    // nothing else). It must never change any other kind of account: a driver
    // waiting for approval, staff or an admin could otherwise give themselves
    // another role and skip approval. Dealership accounts are invite-only
    // (same rule as authService.completeOnboarding).
    if (role === 'dealership') {
        throw new ApiError(403, 'Dealership accounts are created by invite only. Request one from the dealership sign-up page.');
    }
    if (role !== 'customer') {
        throw new ApiError(400, 'Choose "I am a Customer" to continue.');
    }

    const account = await User.findById(userId).select('role onboardingCompleted').lean<{ role?: string; onboardingCompleted?: boolean } | null>();
    if (!account) {
        throw new ApiError(404, "We couldn't find your account. Sign in again and try once more.");
    }
    if (account.onboardingCompleted) {
        throw new ApiError(400, 'Your account setup is already complete. Refresh the page to continue.');
    }
    if (account.role !== 'customer') {
        throw new ApiError(
            403,
            "This step is only for new customer accounts, so your account wasn't changed. If you need a different kind of account, contact support@suprahai.com.",
        );
    }

    const mappedRole = 'customer';
    const skipOrgSelect = false;

    // Conditional, so a role change made meanwhile can't be overwritten.
    const user = await User.findOneAndUpdate(
        { _id: userId, role: 'customer', onboardingCompleted: { $ne: true } },
        { role: mappedRole },
        { new: true }
    ).select('-password');

    if (!user) {
        throw new ApiError(409, 'Your account changed while this was being saved. Refresh the page and try again.');
    }

    invalidateUserCache(userId.toString());

    await activityService.createActivity({
        userId: user._id.toString(),
        organizationId: user.organizationId?.toString(),
        type: 'other',
        title: 'Onboarding Role Set',
        description: `User selected role: ${role}`,
        metadata: { role, mappedRole, skipOrgSelect },
        ipAddress: req.ip,
    });

    logger.info({ userId: user._id, role: mappedRole, skipOrgSelect }, 'Onboarding role set');

    res.json(new ApiResponse(200, { ...user.toObject(), skipOrgSelect }, 'Role set successfully'));
});

export default {
    searchUsers,
    getProfile,
    updateProfile,
    getUserOrganizations,
    selectOrganization,
    joinOnboardingOrg,
    completeOnboarding,
};