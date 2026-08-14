import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import * as svc from '../services/suprahRadar.service';

function requireOrgId(req: Request): string {
    const orgId = req.orgId as string;
    if (!orgId || orgId === 'global') {
        throw new ApiError(403, 'Select a dealership to view market intelligence.');
    }
    return orgId;
}

async function context(req: Request) {
    const orgId = requireOrgId(req);
    const condition = svc.normalizeCondition(req.query.condition);
    const days = svc.normalizeDays(req.query.days);
    const scope = await svc.resolveScope(orgId, {
        scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        city: typeof req.query.city === 'string' ? req.query.city : undefined,
    });
    return { orgId, condition, days, scope };
}

async function watchedIdsFor(orgId: string): Promise<string[]> {
    const watches = await svc.getWatchlist(orgId);
    return watches.map((w: any) => String(w.targetOrganizationId));
}

const getOverview = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const [rollups, privateMetrics, store] = await Promise.all([
        svc.getDealerRollups(orgId, scope, condition, days),
        svc.getPrivateOwnMetrics(orgId, days),
        svc.getStoreProfile(orgId),
    ]);
    const summary = svc.buildMarketSummary(rollups, orgId);

    res.json(
        new ApiResponse(
            200,
            { scope, condition, days, store, ...summary, private: privateMetrics },
            'Market overview fetched',
        ),
    );
});

const getLeaderboards = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
    const competitorsOnly = req.query.competitors === 'true' || req.query.competitors === '1';

    let rollups = await svc.getDealerRollups(orgId, scope, condition, days);
    let watched: string[] = [];
    if (competitorsOnly) {
        watched = await watchedIdsFor(orgId);
        rollups = svc.filterToCompetitors(rollups, watched, orgId);
    }

    res.json(
        new ApiResponse(
            200,
            {
                scope,
                competitorsOnly: competitorsOnly && watched.length > 0,
                watchedCount: watched.length,
                boards: svc.buildLeaderboards(rollups, limit),
            },
            'Leaderboards fetched',
        ),
    );
});

const getTrends = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, scope } = await context(req);
    const weeks = Math.min(26, Math.max(4, Number(req.query.weeks) || 12));
    const [series, priceByYear] = await Promise.all([
        svc.getTrends(orgId, scope, condition, weeks),
        svc.getPriceByModelYear(scope, condition),
    ]);
    res.json(new ApiResponse(200, { scope, weeks, series, priceByYear }, 'Trends fetched'));
});

const getSupply = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, scope } = await context(req);
    const weeks = Math.min(12, Math.max(4, Number(req.query.weeks) || 7));
    const data = await svc.getSupplyBoards(orgId, scope, condition, weeks);
    res.json(new ApiResponse(200, { scope, weeks, ...data }, 'Supply levels fetched'));
});

const getDealerPerformance = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const board = svc.normalizeBoard(req.query.board);
    const page = Math.min(500, Math.max(1, Number(req.query.page) || 1));
    const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
    const competitorsOnly = req.query.competitors === 'true' || req.query.competitors === '1';

    let rollups = await svc.getDealerRollups(orgId, scope, condition, days);
    if (competitorsOnly) {
        rollups = svc.filterToCompetitors(rollups, await watchedIdsFor(orgId), orgId);
    }

    res.json(
        new ApiResponse(
            200,
            { scope, days, ...svc.buildPerformanceBoard(rollups, board, page, limit) },
            'Dealer performance fetched',
        ),
    );
});

const getRecommendations = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, scope } = await context(req);
    const days = svc.normalizeDays(req.query.days ?? 90);
    const data = await svc.getRecommendations(orgId, scope, condition, days);
    res.json(new ApiResponse(200, { scope, ...data }, 'Recommendations fetched'));
});

const getSegments = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const segments = await svc.getSegments(orgId, scope, condition, days);
    res.json(new ApiResponse(200, { scope, days, segments }, 'Segments fetched'));
});

const getOpportunities = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const data = await svc.getOpportunities(orgId, scope, condition, days);
    res.json(new ApiResponse(200, { scope, days, ...data }, 'Opportunities fetched'));
});

const getModelDetail = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const detail = await svc.getModelDetail(
        orgId,
        String(req.query.make || ''),
        String(req.query.model || ''),
        scope,
        condition,
        days,
    );
    if (!detail) throw new ApiError(404, 'No market data for that model');
    res.json(new ApiResponse(200, detail, 'Model detail fetched'));
});

const getDealers = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, scope } = await context(req);
    const term = typeof req.query.search === 'string' ? req.query.search : '';
    const dealers = await svc.searchDealers(orgId, term, scope, Number(req.query.limit) || 20);
    res.json(new ApiResponse(200, dealers, 'Dealers fetched'));
});

const getDealerProfile = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const profile = await svc.getDealerProfile(orgId, String(req.params.id), scope, condition, days);
    if (!profile) throw new ApiError(404, 'Dealership not found');
    res.json(new ApiResponse(200, profile, 'Dealer profile fetched'));
});

const getComparison = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const dealers = await svc.compareDealers(orgId, ids, scope, condition, days);
    res.json(new ApiResponse(200, dealers, 'Comparison fetched'));
});

const getWatchlist = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const watches = await svc.getWatchlist(orgId);
    const ids = watches.map((w: any) => String(w.targetOrganizationId));
    const dealers = ids.length ? await svc.compareDealers(orgId, ids, scope, condition, days) : [];
    res.json(new ApiResponse(200, { watches, dealers }, 'Watchlist fetched'));
});

const addWatch = asyncHandler(async (req: Request, res: Response) => {
    const orgId = requireOrgId(req);
    const user = req.user as IUser;
    const created = await svc.addWatch(orgId, String(req.body?.dealerId || ''), user._id as any, req.body?.label);
    if (!created) throw new ApiError(400, 'Unable to watch that dealership.');
    res.status(201).json(new ApiResponse(201, created, 'Dealership added to watchlist'));
});

const removeWatch = asyncHandler(async (req: Request, res: Response) => {
    const orgId = requireOrgId(req);
    await svc.removeWatch(orgId, String(req.params.id));
    res.json(new ApiResponse(200, { removed: true }, 'Dealership removed from watchlist'));
});

const getScopeOptions = asyncHandler(async (req: Request, res: Response) => {
    requireOrgId(req);
    const options = await svc.getScopeOptions();
    res.json(new ApiResponse(200, options, 'Scope options fetched'));
});

const exportMarket = asyncHandler(async (req: Request, res: Response) => {
    const { orgId, condition, days, scope } = await context(req);
    const rollups = await svc.getDealerRollups(orgId, scope, condition, days);
    const columns = [
        'name', 'city', 'state', 'active', 'sold', 'acquired', 'avgPrice',
        'avgDaysOnLot', 'avgDaysToSell', 'freshPct', 'sellThrough', 'momentum',
    ];
    const csv = svc.toCsv(rollups as unknown as Record<string, unknown>[], columns);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="suprah-radar-${stamp}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
});

export default {
    getOverview,
    getLeaderboards,
    getTrends,
    getSupply,
    getDealerPerformance,
    getRecommendations,
    getSegments,
    getModelDetail,
    getOpportunities,
    getDealers,
    getDealerProfile,
    getComparison,
    getWatchlist,
    addWatch,
    removeWatch,
    getScopeOptions,
    exportMarket,
};
