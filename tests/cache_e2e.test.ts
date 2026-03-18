import { Request, Response } from 'express';
import dashboardController from '../src/controllers/dashboard.controller';
import cacheService from '../src/services/cache.service';
import mongoose from 'mongoose';

describe('E2E Cache Verification (Dashboard)', () => {
    const mockOrgId = '698f516abb63af8f6eb7be4c';
    const cacheKey = `dash:metrics:${mockOrgId}:1Y:all`;

    beforeAll(async () => {
        // Clear any existing cache for this org
        await cacheService.del(cacheKey);
    });

    it('should result in a CACHE MISS on the first hit and a CACHE HIT on the second', async () => {
        const mockRes = () => {
            const res: any = {};
            res.status = jest.fn().mockReturnValue(res);
            res.json = jest.fn().mockReturnValue(res);
            return res;
        };

        const req = {
            orgId: mockOrgId,
            query: { period: '1Y' }
        } as any;

        // 1. First call - Expect MISS
        const res1 = mockRes();
        await dashboardController.getDashboardMetrics(req, res1);

        expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Dashboard metrics fetched successfully'
        }));

        // 2. Second call - Expect HIT
        const res2 = mockRes();
        await dashboardController.getDashboardMetrics(req, res2);

        expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Dashboard metrics fetched from cache'
        }));

        // 3. Verify key exists in Redis
        const exists = await cacheService.get(cacheKey);
        expect(exists).not.toBeNull();
    });
});
