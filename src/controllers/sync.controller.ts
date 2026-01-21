import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import syncService from '../services/sync.service';
import { ApiResponse } from '../utils/ApiResponse';
import SyncLog from '../models/SyncLog.model';

const triggerSync = asyncHandler(async (req: Request, res: Response) => {
    // Execute sync asynchronously or wait for it? 
    // For manual trigger, waiting is often preferred so user sees results.
    const result = await syncService.syncInventory();

    res.json(new ApiResponse(200, result, 'Manual inventory sync completed'));
});

const getSyncStatus = asyncHandler(async (req: Request, res: Response) => {
    const recentLogs = await SyncLog.find({})
        .sort({ startTime: -1 })
        .limit(10);

    res.json(new ApiResponse(200, recentLogs, 'Sync history fetched'));
});

export default {
    triggerSync,
    getSyncStatus
};
