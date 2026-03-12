import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { DashboardService } from '../services/dashboard.service';
import { ApiResponse } from '../utils/ApiResponse';

// Simple in-memory cache
const dashboardCache = new Map<string, { data: any, expiry: number }>();
const CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Get unified dashboard metrics with caching
 */
const getDashboardMetrics = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { period, month } = req.query;

    // Create a unique cache key based on org and filters
    const cacheKey = `${orgId}-${period}-${month}`;
    const now = Date.now();

    const cached = dashboardCache.get(cacheKey);
    if (cached && cached.expiry > now) {
        return res.json(new ApiResponse(200, cached.data, 'Dashboard metrics fetched from cache'));
    }

    // Fetch fresh data from service
    const metrics = await DashboardService.getDashboardMetrics(
        orgId,
        period as string || '1Y'
    );

    // Update cache
    dashboardCache.set(cacheKey, {
        data: metrics,
        expiry: now + CACHE_TTL
    });

    res.json(new ApiResponse(200, metrics, 'Dashboard metrics fetched successfully'));
});

export default {
    getDashboardMetrics
};
