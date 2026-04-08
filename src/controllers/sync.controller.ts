import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import syncService from '../services/sync.service';
import { ApiResponse } from '../utils/ApiResponse';
import { notifyOrgAdmins } from '../utils/safeNotification';
import SyncLog from '../models/SyncLog.model';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { IUser } from '../models/User.model';

const triggerSync = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const userId = (req.user as IUser)?._id?.toString();

    logger.info({ userId, orgId }, 'Manual inventory sync triggered');

    const result = await syncService.syncInventory();
    
    if (orgId) {
        notifyOrgAdmins(orgId, 'inventory_sync', 'Inventory Synced', 'A manual inventory sync has been completed.');
        
        if (userId) {
            await activityService.createActivity({
                userId,
                organizationId: orgId,
                type: 'other',
                title: 'Manual Inventory Sync',
                description: 'Triggered a manual synchronization of vehicle inventory',
                metadata: { success: !!result }
            });
        }
    }

    res.json(new ApiResponse(200, result, 'Manual inventory sync completed'));
});

const getSyncStatus = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const recentLogs = await SyncLog.find({ organizationId: orgId })
        .sort({ startTime: -1 })
        .limit(10);

    res.json(new ApiResponse(200, recentLogs, 'Sync history fetched'));
});

export default {
    triggerSync,
    getSyncStatus
};
