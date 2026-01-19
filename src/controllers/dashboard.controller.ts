import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';

const getDashboardMetrics = asyncHandler(async (req: Request, res: Response) => {
    // 1. Inventory Overview
    const totalActive = await Vehicle.countDocuments({});
    const inRecon = await Vehicle.countDocuments({ status: 'In Recon' });
    const readyForSale = await Vehicle.countDocuments({ status: 'Ready for Sale' });

    // 2. Recon Status (Counts per step)
    const steps = ['Inspection', 'Mechanical', 'Body / Paint', 'Detail', 'Photography', 'Ready'];
    const reconStatus: Record<string, number> = {};

    for (const step of steps) {
        reconStatus[step] = await Vehicle.countDocuments({ currentStep: step });
    }

    // 3. Needs Attention (In step > 3 days)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const needsAttention = await Vehicle.find({
        status: 'In Recon',
        stepEnteredAt: { $lt: threeDaysAgo }
    }).populate('assignedTo', 'name');

    // 4. Recent Activity (Last 5 updated)
    const recentActivity = await Vehicle.find({})
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('year make model currentStep updatedAt');

    res.json(new ApiResponse(200, {
        inventoryOverview: { totalActive, inRecon, readyForSale },
        reconStatus,
        needsAttention,
        recentActivity
    }, 'Dashboard metrics fetched successfully'));
});

export default {
    getDashboardMetrics
};
