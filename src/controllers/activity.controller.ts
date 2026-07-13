import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import activityService from '../services/activity.service';
import { ApiError } from '../utils/ApiError';

export const getOrganizationActivity = asyncHandler(async (req: Request, res: Response) => {
    const { limit = 50, page = 1 } = req.query;
    
    const limitNum = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page as string) || 1, 1);
    const skip = (pageNum - 1) * limitNum;

    const user = req.user as any;
    const isSuperAdmin = user?.role === 'super_admin';
    const organizationId = user?.organizationId?.toString();

    let activities;
    
    if (isSuperAdmin) {
        const targetOrgId = req.query.orgId as string || organizationId;
        activities = await activityService.getOrganizationActivities(
            targetOrgId,
            limitNum,
            skip
        );
    } else {
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
