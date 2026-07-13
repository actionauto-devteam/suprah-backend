import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { DashboardService } from '../services/dashboard.service';
import { ApiResponse } from '../utils/ApiResponse';
import cacheService from '../services/cache.service';

const CACHE_TTL_SECONDS = 60 * 10;

const getDashboardMetrics = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const { period, month } = req.query;

    const cacheKey = `dash:metrics:${orgId}:${period || '1Y'}:${month || 'all'}`;

    // 1. Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
        return res.json(new ApiResponse(200, cached, 'Dashboard metrics fetched from cache'));
    }

    // 2. Cache miss — fetch from DB
    const metrics = await DashboardService.getDashboardMetrics(
        orgId,
        period as string || '1Y'
    );

    // 3. Store in Redis
    await cacheService.set(cacheKey, metrics, CACHE_TTL_SECONDS);

    res.json(new ApiResponse(200, metrics, 'Dashboard metrics fetched successfully'));
});

/**
 * Get paginated leaderboard data
 */
const getLeaderboard = asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId as string;
    const page = parseInt(req.query.page as string) || 0;
    const limit = parseInt(req.query.limit as string) || 10;

    const leaderboard = await DashboardService.getPaginatedLeaderboard(orgId, page, limit);

    res.json(new ApiResponse(200, leaderboard, 'Leaderboard data fetched successfully'));
});

export default {
    getDashboardMetrics,
    getLeaderboard
};
