import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';

const getDashboardMetrics = asyncHandler(async (req: Request, res: Response) => {
    // 1. Inventory Overview
    const totalActive = await Vehicle.countDocuments({});

    // 2. Recent Activity (Last 5 updated)
    const recentActivity = await Vehicle.find({})
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('year make modelName updatedAt');

    res.json(new ApiResponse(200, {
        inventoryOverview: { totalActive },
        recentActivity
    }, 'Dashboard metrics fetched successfully'));
});

export default {
    getDashboardMetrics
};
