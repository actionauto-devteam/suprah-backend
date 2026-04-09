import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import activityService from '../services/activity.service';
import { ApiError } from '../utils/ApiError';

/**
 * Get organization-wide activities with pagination
 * GET /api/activity/organization?limit=50&page=1
 */
export const getOrganizationActivity = asyncHandler(async (req: Request, res: Response) => {
    const { limit = 50, page = 1 } = req.query;
    
    // 1. Sanitize Inputs
    const limitNum = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page as string) || 1, 1);
    const skip = (pageNum - 1) * limitNum;

    // 2. Identify Organization Context
    const user = req.user as any;
    const isSuperAdmin = user?.role === 'super_admin';
    const organizationId = user?.organizationId?.toString();

    // 3. Fetch Activities
    let activities;
    
    if (isSuperAdmin) {
        // Super Admins can see global activity or filter by a specific orgId if provided
        const targetOrgId = req.query.orgId as string || organizationId;
        activities = await activityService.getOrganizationActivities(
            targetOrgId, // Can be undefined for global view
            limitNum,
            skip
        );
    } else {
        // Standard Admins MUST have an organization context
        if (!organizationId) {
            throw new ApiError(403, "User is not associated with an organization");
        }
        activities = await activityService.getOrganizationActivities(
            organizationId,
            limitNum,
            skip
        );
    }

    return res.status(200).json(
        new ApiResponse(200, activities, "Activity feed fetched successfully")
    );
});

export default {
    getOrganizationActivity
};
