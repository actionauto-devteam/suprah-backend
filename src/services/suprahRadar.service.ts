import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import DealerWatch from '../models/DealerWatch.model';
import cacheService from './cache.service';

export type ScopeType = 'national' | 'state' | 'metro';
export type ConditionFilter = 'all' | 'new' | 'used';

export interface MarketScope {
    type: ScopeType;
    state?: string;
    city?: string;
    label: string;
    homeState?: string;
    homeCity?: string;
}

export interface ScopeRequest {
    scope?: string;
    state?: string;
    city?: string;
    condition?: string;
    days?: number;
}

export interface DealerRollup {
    id: string;
    name: string;
    logoUrl?: string;
    city?: string;
    state?: string;
    isYou: boolean;
    hasListings: boolean;
    active: number;
    sold: number;
    soldPrev: number;
    acquired: number;
    avgPrice: number;
    avgDaysOnLot: number;
    avgDaysToSell: number;
    freshPct: number;
    agedPct: number;
    sellThrough: number;
    momentum: number;
    newUnits: number;
    usedUnits: number;
    inventoryValue: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;
const CACHE_TTL = 600;
const MIN_COHORT = 3;
const MAX_COMPARE = 4;
const SEGMENT_LIMIT = 60;
const OWN_UNIT_SCAN_LIMIT = 1500;
const ORG_ROSTER_LIMIT = 5000;
const ROSTER_TTL = 3600;
const MEMO_TTL_MS = 30_000;
const MEMO_MAX_ENTRIES = 48;

const memoStore = new Map<string, { value: unknown; expiresAt: number }>();

function memoGet<T>(key: string): T | undefined {
    const hit = memoStore.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
        memoStore.delete(key);
        return undefined;
    }
    return hit.value as T;
}

function memoSet(key: string, value: unknown, ttlMs: number): void {
    if (memoStore.size >= MEMO_MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of memoStore) {
            if (v.expiresAt <= now) memoStore.delete(k);
        }
        if (memoStore.size >= MEMO_MAX_ENTRIES) {
            const oldest = memoStore.keys().next().value;
            if (oldest) memoStore.delete(oldest);
        }
    }
    memoStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const ALLOWED_DAYS = [7, 30, 90, 180, 365];

export function normalizeDays(raw: unknown): number {
    const n = Number(raw);
    return ALLOWED_DAYS.includes(n) ? n : 30;
}

export function normalizeCondition(raw: unknown): ConditionFilter {
    return raw === 'new' || raw === 'used' ? raw : 'all';
}

function sanitizeToken(raw: unknown, max = 60): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const cleaned = raw.replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim().slice(0, max);
    return cleaned.length ? cleaned : undefined;
}

export function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObjectId(value: unknown): value is string {
    return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value;
}

function round(value: number, decimals = 0): number {
    if (!Number.isFinite(value)) return 0;
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

function safeDiv(a: number, b: number): number {
    return b > 0 ? a / b : 0;
}

function conditionMatch(condition: ConditionFilter): Record<string, unknown> {
    if (condition === 'new') return { isNewVehicle: true };
    if (condition === 'used') return { isNewVehicle: { $ne: true } };
    return {};
}

function scopeMatch(scope: MarketScope): Record<string, unknown> {
    if (scope.type === 'state' && scope.state) return { dealerState: scope.state };
    if (scope.type === 'metro' && scope.city) {
        return scope.state ? { dealerCity: scope.city, dealerState: scope.state } : { dealerCity: scope.city };
    }
    return {};
}

async function resolveHomeLocation(orgId: string): Promise<{ state?: string; city?: string }> {
    const cacheKey = `mktiq:home:${orgId}`;
    const cached = await cacheService.get<{ state?: string; city?: string }>(cacheKey);
    if (cached) return cached;

    const rows = await Vehicle.aggregate([
        { $match: { organizationId: orgId, isDeleted: false } },
        {
            $group: {
                _id: { state: '$dealerState', city: '$dealerCity' },
                count: { $sum: 1 },
            },
        },
        { $sort: { count: -1 } },
        { $limit: 1 },
    ]);

    const home = {
        state: rows[0]?._id?.state || undefined,
        city: rows[0]?._id?.city || undefined,
    };
    await cacheService.set(cacheKey, home, 3600);
    return home;
}

export async function resolveScope(orgId: string, req: ScopeRequest): Promise<MarketScope> {
    const home = await resolveHomeLocation(orgId);
    const requestedState = sanitizeToken(req.state, 24) || home.state;
    const requestedCity = sanitizeToken(req.city, 60) || home.city;
    const requested = req.scope === 'state' || req.scope === 'metro' || req.scope === 'national' ? req.scope : undefined;

    const type: ScopeType = requested || (home.state ? 'state' : 'national');

    if (type === 'metro' && requestedCity) {
        return {
            type,
            city: requestedCity,
            state: requestedState,
            label: requestedState ? `${requestedCity}, ${requestedState}` : requestedCity,
            homeState: home.state,
            homeCity: home.city,
        };
    }
    if (type === 'state' && requestedState) {
        return { type, state: requestedState, label: requestedState, homeState: home.state, homeCity: home.city };
    }
    return { type: 'national', label: 'Nationwide', homeState: home.state, homeCity: home.city };
}

function cacheKeyFor(prefix: string, orgId: string, scope: MarketScope, condition: ConditionFilter, days: number, extra = ''): string {
    return `mktiq:${prefix}:${orgId}:${scope.type}:${scope.state || '-'}:${scope.city || '-'}:${condition}:${days}${extra ? `:${extra}` : ''}`;
}

async function aggregateDealerRollups(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
): Promise<DealerRollup[]> {
    const now = Date.now();
    const from = new Date(now - days * DAY_MS);
    const prevFrom = new Date(now - days * 2 * DAY_MS);
    const freshCutoff = new Date(now - 30 * DAY_MS);
    const agedCutoff = new Date(now - 60 * DAY_MS);

    const notSold = { $ne: ['$status', 'Sold'] };
    const isSold = { $eq: ['$status', 'Sold'] };
    const soldInPeriod = { $and: [isSold, { $gte: ['$dateSold', from] }] };
    const activePriced = { $and: [notSold, { $gt: ['$price', 0] }] };
    const daysToSell = {
        $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS],
    };

    const rows = await Vehicle.aggregate([
        {
            $match: {
                isDeleted: false,
                ...scopeMatch(scope),
                ...conditionMatch(condition),
                organizationId: { $nin: [null, ''] },
                $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: prevFrom } }],
            },
        },
        {
            $group: {
                _id: '$organizationId',
                active: { $sum: { $cond: [notSold, 1, 0] } },
                sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                soldPrev: {
                    $sum: {
                        $cond: [
                            { $and: [isSold, { $gte: ['$dateSold', prevFrom] }, { $lt: ['$dateSold', from] }] },
                            1,
                            0,
                        ],
                    },
                },
                acquired: {
                    $sum: { $cond: [{ $gte: ['$dateAdded', from] }, 1, 0] },
                },
                priceSum: { $sum: { $cond: [activePriced, '$price', 0] } },
                priceCount: { $sum: { $cond: [activePriced, 1, 0] } },
                inventoryValue: { $sum: { $cond: [activePriced, '$price', 0] } },
                dolSum: {
                    $sum: {
                        $cond: [
                            notSold,
                            { $max: [0, { $divide: [{ $subtract: [new Date(now), '$dateAdded'] }, DAY_MS] }] },
                            0,
                        ],
                    },
                },
                dolCount: { $sum: { $cond: [notSold, 1, 0] } },
                turnSum: {
                    $sum: {
                        $cond: [
                            { $and: [soldInPeriod, { $gt: [daysToSell, 0] }] },
                            daysToSell,
                            0,
                        ],
                    },
                },
                turnCount: {
                    $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] },
                },
                fresh: {
                    $sum: { $cond: [{ $and: [notSold, { $gte: ['$dateAdded', freshCutoff] }] }, 1, 0] },
                },
                aged: {
                    $sum: { $cond: [{ $and: [notSold, { $lt: ['$dateAdded', agedCutoff] }] }, 1, 0] },
                },
                newUnits: {
                    $sum: { $cond: [{ $and: [notSold, { $eq: ['$isNewVehicle', true] }] }, 1, 0] },
                },
                usedUnits: {
                    $sum: { $cond: [{ $and: [notSold, { $ne: ['$isNewVehicle', true] }] }, 1, 0] },
                },
                states: { $addToSet: '$dealerState' },
                cities: { $addToSet: '$dealerCity' },
            },
        },
        { $limit: 5000 },
    ]);

    const roster = await getOrgRoster();

    return rows
        .filter((r) => roster.has(String(r._id)))
        .map((r): DealerRollup => {
            const org = roster.get(String(r._id));
            const active = r.active || 0;
            const sold = r.sold || 0;
            return {
                id: String(r._id),
                name: org?.name || 'Unnamed dealership',
                logoUrl: org?.logoUrl || undefined,
                state: (r.states || []).filter(Boolean)[0] || undefined,
                city: (r.cities || []).filter(Boolean)[0] || undefined,
                isYou: String(r._id) === orgId,
                hasListings: active > 0 || sold > 0,
                active,
                sold,
                soldPrev: r.soldPrev || 0,
                acquired: r.acquired || 0,
                avgPrice: round(safeDiv(r.priceSum || 0, r.priceCount || 0)),
                avgDaysOnLot: round(safeDiv(r.dolSum || 0, r.dolCount || 0)),
                avgDaysToSell: round(safeDiv(r.turnSum || 0, r.turnCount || 0)),
                freshPct: round(safeDiv(r.fresh || 0, active) * 100),
                agedPct: round(safeDiv(r.aged || 0, active) * 100),
                sellThrough: round(safeDiv(sold, sold + active) * 100, 1),
                momentum: round(
                    r.soldPrev > 0 ? ((sold - r.soldPrev) / r.soldPrev) * 100 : sold > 0 ? 100 : 0,
                ),
                newUnits: r.newUnits || 0,
                usedUnits: r.usedUnits || 0,
                inventoryValue: round(r.inventoryValue || 0),
            };
        });
}

export interface RosterEntry {
    name: string;
    logoUrl?: string;
}

async function getOrgRoster(): Promise<Map<string, RosterEntry>> {
    const memoKey = 'roster';
    const memoized = memoGet<[string, RosterEntry][]>(memoKey);
    if (memoized) return new Map(memoized);

    const cacheKey = 'mktiq:roster:v1';
    let entries = await cacheService.get<[string, RosterEntry][]>(cacheKey);

    if (!entries) {
        const orgs = await Organization.find({ status: 'active' })
            .select('name logoUrl')
            .limit(ORG_ROSTER_LIMIT)
            .lean();
        entries = orgs.map((o: any) => [
            String(o._id),
            { name: o.name || 'Unnamed dealership', logoUrl: o.logoUrl || undefined },
        ]);
        await cacheService.set(cacheKey, entries, ROSTER_TTL);
    }

    memoSet(memoKey, entries, MEMO_TTL_MS);
    return new Map(entries);
}

function dormantRollup(id: string, entry: RosterEntry, orgId: string): DealerRollup {
    return {
        id,
        name: entry.name,
        logoUrl: entry.logoUrl,
        isYou: id === orgId,
        hasListings: false,
        active: 0,
        sold: 0,
        soldPrev: 0,
        acquired: 0,
        avgPrice: 0,
        avgDaysOnLot: 0,
        avgDaysToSell: 0,
        freshPct: 0,
        agedPct: 0,
        sellThrough: 0,
        momentum: 0,
        newUnits: 0,
        usedUnits: 0,
        inventoryValue: 0,
    };
}

export async function getDealerRollups(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
): Promise<DealerRollup[]> {
    const key = cacheKeyFor('rollups', 'market', scope, condition, days);

    let listed = memoGet<DealerRollup[]>(key);
    if (!listed) {
        listed = (await cacheService.get<DealerRollup[]>(key)) || undefined;
        if (!listed) {
            listed = await aggregateDealerRollups(orgId, scope, condition, days);
            await cacheService.set(key, listed, CACHE_TTL);
        }
        memoSet(key, listed, MEMO_TTL_MS);
    }

    const roster = await getOrgRoster();
    const seen = new Set(listed.map((d) => d.id));
    const merged: DealerRollup[] = listed.map((d) => ({ ...d, isYou: d.id === orgId }));

    for (const [id, entry] of roster) {
        if (!seen.has(id)) merged.push(dormantRollup(id, entry, orgId));
    }

    return merged;
}

function rankBy(rollups: DealerRollup[], metric: keyof DealerRollup, direction: 'desc' | 'asc' = 'desc') {
    const sorted = [...rollups].sort((a, b) => {
        const av = Number(a[metric]) || 0;
        const bv = Number(b[metric]) || 0;
        return direction === 'desc' ? bv - av : av - bv;
    });
    return sorted.map((d, i) => ({ ...d, rank: i + 1 }));
}

export function buildLeaderboards(rollups: DealerRollup[], limit = 10) {
    const priorSalesRank = new Map(
        [...rollups]
            .sort((a, b) => b.soldPrev - a.soldPrev)
            .map((d, i) => [d.id, i + 1] as const),
    );

    const turnEligible = rollups.filter((d) => d.avgDaysToSell > 0 && d.sold >= 2);
    const stocked = rollups.filter((d) => d.active > 0);

    const shape = (rows: (DealerRollup & { rank: number })[]) =>
        rows.slice(0, limit).map((d) => ({
            rank: d.rank,
            id: d.id,
            name: d.name,
            logoUrl: d.logoUrl,
            city: d.city,
            state: d.state,
            isYou: d.isYou,
            hasListings: d.hasListings,
            momentum: d.momentum,
            rankDelta: (priorSalesRank.get(d.id) ?? d.rank) - d.rank,
        }));

    const sales = rankBy(rollups, 'sold');
    const acquisitions = rankBy(rollups, 'acquired');
    const turn = rankBy(turnEligible, 'avgDaysToSell', 'asc');
    const freshness = rankBy(stocked, 'freshPct');
    const sellThrough = rankBy(rollups.filter((d) => d.active + d.sold > 0), 'sellThrough');

    const withValue = (
        rows: (DealerRollup & { rank: number })[],
        metric: keyof DealerRollup,
    ) =>
        shape(rows).map((row, i) => ({
            ...row,
            value: Number(rows[i][metric]) || 0,
        }));

    return {
        sales: {
            key: 'sales',
            label: 'Most Sales',
            hint: 'Units sold in the period',
            unit: 'units',
            total: rollups.length,
            rows: withValue(sales, 'sold'),
        },
        acquisitions: {
            key: 'acquisitions',
            label: 'Most Acquisitions',
            hint: 'Units taken into stock',
            unit: 'units',
            total: rollups.length,
            rows: withValue(acquisitions, 'acquired'),
        },
        turn: {
            key: 'turn',
            label: 'Fastest Turn',
            hint: 'Avg days to sell, 2+ sales required',
            unit: 'days',
            total: turnEligible.length,
            rows: withValue(turn, 'avgDaysToSell'),
        },
        freshness: {
            key: 'freshness',
            label: 'Freshest Inventory',
            hint: 'Share of stock under 30 days',
            unit: '%',
            total: stocked.length,
            rows: withValue(freshness, 'freshPct'),
        },
        sellThrough: {
            key: 'sellThrough',
            label: 'Best Sell-Through',
            hint: 'Sold vs sold plus live stock',
            unit: '%',
            total: rollups.filter((d) => d.active + d.sold > 0).length,
            rows: withValue(sellThrough, 'sellThrough'),
        },
    };
}

export interface MarketSignal {
    id: string;
    kind: 'gainer' | 'decliner' | 'stocking' | 'liquidating';
    dealerId: string;
    dealer: string;
    metric: string;
    change: number;
    detail: string;
}

export function buildSignals(rollups: DealerRollup[], limit = 6): MarketSignal[] {
    const moved = rollups
        .filter((d) => d.hasListings && (d.sold > 0 || d.soldPrev > 0))
        .map((d) => ({ ...d, delta: d.sold - d.soldPrev }));

    const gainers = [...moved]
        .filter((d) => d.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, limit)
        .map((d): MarketSignal => ({
            id: `gain-${d.id}`,
            kind: 'gainer',
            dealerId: d.id,
            dealer: d.name,
            metric: 'sales',
            change: d.delta,
            detail: `${d.sold} sold vs ${d.soldPrev} prior`,
        }));

    const decliners = [...moved]
        .filter((d) => d.delta < 0)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, limit)
        .map((d): MarketSignal => ({
            id: `drop-${d.id}`,
            kind: 'decliner',
            dealerId: d.id,
            dealer: d.name,
            metric: 'sales',
            change: d.delta,
            detail: `${d.sold} sold vs ${d.soldPrev} prior`,
        }));

    const stocking = [...rollups]
        .filter((d) => d.acquired > 0)
        .sort((a, b) => b.acquired - a.acquired)
        .slice(0, limit)
        .map((d): MarketSignal => ({
            id: `stock-${d.id}`,
            kind: 'stocking',
            dealerId: d.id,
            dealer: d.name,
            metric: 'acquisitions',
            change: d.acquired,
            detail: `${d.acquired} units in, ${d.active} on lot`,
        }));

    return [...gainers, ...decliners, ...stocking];
}

function percentile(rollups: DealerRollup[], metric: keyof DealerRollup, value: number, higherIsBetter: boolean): number {
    const values = rollups.map((d) => Number(d[metric]) || 0).filter((v) => Number.isFinite(v));
    if (!values.length) return 0;
    const beaten = values.filter((v) => (higherIsBetter ? value > v : value < v)).length;
    return round(safeDiv(beaten, values.length) * 100);
}

export function buildMarketSummary(rollups: DealerRollup[], orgId: string) {
    const listing = rollups.filter((d) => d.hasListings);
    const dealers = listing.length;
    const active = rollups.reduce((s, d) => s + d.active, 0);
    const sold = rollups.reduce((s, d) => s + d.sold, 0);
    const soldPrev = rollups.reduce((s, d) => s + d.soldPrev, 0);
    const acquired = rollups.reduce((s, d) => s + d.acquired, 0);
    const pricedDealers = rollups.filter((d) => d.avgPrice > 0);
    const dolDealers = rollups.filter((d) => d.avgDaysOnLot > 0);
    const turnDealers = rollups.filter((d) => d.avgDaysToSell > 0);

    const you = rollups.find((d) => d.id === orgId);

    const market = {
        dealers,
        totalDealers: rollups.length,
        dormantDealers: rollups.length - dealers,
        activeListings: active,
        soldInPeriod: sold,
        soldPrevPeriod: soldPrev,
        acquiredInPeriod: acquired,
        avgPrice: round(safeDiv(pricedDealers.reduce((s, d) => s + d.avgPrice, 0), pricedDealers.length)),
        avgDaysOnLot: round(safeDiv(dolDealers.reduce((s, d) => s + d.avgDaysOnLot, 0), dolDealers.length)),
        avgDaysToSell: round(safeDiv(turnDealers.reduce((s, d) => s + d.avgDaysToSell, 0), turnDealers.length)),
        avgInventoryPerDealer: round(safeDiv(active, dealers)),
        sellThrough: round(safeDiv(sold, sold + active) * 100, 1),
        salesDelta: round(soldPrev > 0 ? ((sold - soldPrev) / soldPrev) * 100 : sold > 0 ? 100 : 0),
        supplyDays: round(sold > 0 ? safeDiv(active, sold) * 30 : 0),
    };

    if (!you) return { market, you: null, signals: buildSignals(rollups) };

    const leaderboards = {
        sales: rankBy(rollups, 'sold').find((d) => d.id === orgId)?.rank || null,
        acquisitions: rankBy(rollups, 'acquired').find((d) => d.id === orgId)?.rank || null,
        turn: you.avgDaysToSell > 0
            ? rankBy(rollups.filter((d) => d.avgDaysToSell > 0), 'avgDaysToSell', 'asc').find((d) => d.id === orgId)?.rank || null
            : null,
        freshness: rankBy(rollups, 'freshPct').find((d) => d.id === orgId)?.rank || null,
        sellThrough: rankBy(rollups, 'sellThrough').find((d) => d.id === orgId)?.rank || null,
    };

    const priorSalesRank =
        [...rollups].sort((a, b) => b.soldPrev - a.soldPrev).findIndex((d) => d.id === orgId) + 1;

    return {
        market,
        signals: buildSignals(rollups),
        you: {
            ...you,
            ranks: leaderboards,
            rankDelta: priorSalesRank > 0 && leaderboards.sales ? priorSalesRank - leaderboards.sales : 0,
            percentiles: {
                sales: percentile(rollups, 'sold', you.sold, true),
                acquisitions: percentile(rollups, 'acquired', you.acquired, true),
                turn: you.avgDaysToSell > 0 ? percentile(rollups.filter((d) => d.avgDaysToSell > 0), 'avgDaysToSell', you.avgDaysToSell, false) : 0,
                freshness: percentile(rollups, 'freshPct', you.freshPct, true),
                sellThrough: percentile(rollups, 'sellThrough', you.sellThrough, true),
            },
            vsMarket: {
                avgPrice: round(you.avgPrice - market.avgPrice),
                avgDaysOnLot: round(you.avgDaysOnLot - market.avgDaysOnLot),
                avgDaysToSell: round(you.avgDaysToSell - market.avgDaysToSell),
                sellThrough: round(you.sellThrough - market.sellThrough, 1),
            },
        },
    };
}

export async function getPrivateOwnMetrics(orgId: string, days: number) {
    const from = new Date(Date.now() - days * DAY_MS);
    const rows = await Vehicle.aggregate([
        {
            $match: {
                organizationId: orgId,
                isDeleted: false,
                $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }],
            },
        },
        {
            $group: {
                _id: null,
                grossSum: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ['$status', 'Sold'] },
                                    { $gte: ['$dateSold', from] },
                                    { $gt: ['$cost', 0] },
                                    { $gt: ['$price', 0] },
                                ],
                            },
                            { $subtract: ['$price', '$cost'] },
                            0,
                        ],
                    },
                },
                grossCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ['$status', 'Sold'] },
                                    { $gte: ['$dateSold', from] },
                                    { $gt: ['$cost', 0] },
                                    { $gt: ['$price', 0] },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                costBasis: {
                    $sum: {
                        $cond: [{ $and: [{ $ne: ['$status', 'Sold'] }, { $gt: ['$cost', 0] }] }, '$cost', 0],
                    },
                },
                retailValue: {
                    $sum: {
                        $cond: [{ $and: [{ $ne: ['$status', 'Sold'] }, { $gt: ['$price', 0] }] }, '$price', 0],
                    },
                },
            },
        },
    ]);

    const r = rows[0];
    if (!r) return { avgGross: 0, totalGross: 0, unitsWithCost: 0, costBasis: 0, retailValue: 0, potentialGross: 0 };

    return {
        avgGross: round(safeDiv(r.grossSum || 0, r.grossCount || 0)),
        totalGross: round(r.grossSum || 0),
        unitsWithCost: r.grossCount || 0,
        costBasis: round(r.costBasis || 0),
        retailValue: round(r.retailValue || 0),
        potentialGross: round((r.retailValue || 0) - (r.costBasis || 0)),
    };
}

export interface TrendPoint {
    label: string;
    listings: number;
    yourListings: number;
    sold: number;
    yourSold: number;
    acquired: number;
    avgListPrice: number;
    avgDaysOnLot: number;
    avgDaysToSell: number;
}

function utcDayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function utcMidnight(ts: number): number {
    return Date.parse(`${utcDayKey(ts)}T00:00:00.000Z`);
}

export async function getTrends(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    weeks = 12,
): Promise<TrendPoint[]> {
    const key = cacheKeyFor('trends', orgId, scope, condition, weeks, 'v3');
    const cached = await cacheService.get<TrendPoint[]>(key);
    if (cached) return cached;

    const todayMidnight = utcMidnight(Date.now());
    const firstWeekEnd = todayMidnight - (weeks - 1) * WEEK_MS;
    const start = new Date(firstWeekEnd - WEEK_MS);

    const base = {
        isDeleted: false,
        ...scopeMatch(scope),
        ...conditionMatch(condition),
        dateAdded: { $type: 'date' },
    };
    const priced = { $gt: ['$price', 0] };
    const mine = { $eq: ['$organizationId', orgId] };
    const bucketOf = (field: string) => ({
        $cond: [
            { $lt: [`$${field}`, start] },
            'PRE',
            { $dateToString: { format: '%Y-%m-%d', date: `$${field}` } },
        ],
    });

    const [facets] = await Vehicle.aggregate([
        { $match: base },
        {
            $facet: {
                adds: [
                    { $match: { $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $type: 'date' } }] } },
                    {
                        $group: {
                            _id: bucketOf('dateAdded'),
                            count: { $sum: 1 },
                            addedMs: { $sum: { $toLong: '$dateAdded' } },
                            priceSum: { $sum: { $cond: [priced, '$price', 0] } },
                            priceCount: { $sum: { $cond: [priced, 1, 0] } },
                            ownCount: { $sum: { $cond: [mine, 1, 0] } },
                        },
                    },
                ],
                sold: [
                    { $match: { status: 'Sold', dateSold: { $type: 'date' } } },
                    {
                        $group: {
                            _id: bucketOf('dateSold'),
                            count: { $sum: 1 },
                            addedMs: { $sum: { $toLong: '$dateAdded' } },
                            priceSum: { $sum: { $cond: [priced, '$price', 0] } },
                            priceCount: { $sum: { $cond: [priced, 1, 0] } },
                            ownCount: { $sum: { $cond: [mine, 1, 0] } },
                            turnSum: {
                                $sum: {
                                    $max: [0, { $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS] }],
                                },
                            },
                            turnCount: {
                                $sum: {
                                    $cond: [{ $gt: [{ $subtract: ['$dateSold', '$dateAdded'] }, 0] }, 1, 0],
                                },
                            },
                        },
                    },
                ],
            },
        },
    ]);

    const series = assembleTrendSeries(facets?.adds || [], facets?.sold || [], weeks, todayMidnight, start.getTime());

    await cacheService.set(key, series, CACHE_TTL);
    return series;
}

export interface TrendBucketRow {
    _id: string;
    count?: number;
    addedMs?: number;
    priceSum?: number;
    priceCount?: number;
    ownCount?: number;
    turnSum?: number;
    turnCount?: number;
}

interface TrendBucket {
    count: number;
    addedMs: number;
    priceSum: number;
    priceCount: number;
    ownCount: number;
    turnSum: number;
    turnCount: number;
}

const emptyTrendBucket = (): TrendBucket => ({
    count: 0,
    addedMs: 0,
    priceSum: 0,
    priceCount: 0,
    ownCount: 0,
    turnSum: 0,
    turnCount: 0,
});

export function assembleTrendSeries(
    addsRows: TrendBucketRow[],
    soldRows: TrendBucketRow[],
    weeks: number,
    todayMidnight: number,
    startTs: number,
): TrendPoint[] {
    const toMap = (rows: TrendBucketRow[]): Map<string, TrendBucket> =>
        new Map(
            (rows || []).map((r) => [
                String(r._id),
                {
                    count: r.count || 0,
                    addedMs: r.addedMs || 0,
                    priceSum: r.priceSum || 0,
                    priceCount: r.priceCount || 0,
                    ownCount: r.ownCount || 0,
                    turnSum: r.turnSum || 0,
                    turnCount: r.turnCount || 0,
                },
            ]),
        );

    const addsMap = toMap(addsRows);
    const soldMap = toMap(soldRows);

    const days: { ts: number; adds: TrendBucket; sold: TrendBucket }[] = [];
    for (let t = startTs; t <= todayMidnight; t += DAY_MS) {
        const k = utcDayKey(t);
        days.push({
            ts: t,
            adds: addsMap.get(k) || emptyTrendBucket(),
            sold: soldMap.get(k) || emptyTrendBucket(),
        });
    }

    const prevAdds = addsMap.get('PRE') || emptyTrendBucket();
    const prevSold = soldMap.get('PRE') || emptyTrendBucket();
    const series: TrendPoint[] = [];

    for (let i = 0; i < weeks; i++) {
        const weekEnd = todayMidnight - (weeks - 1 - i) * WEEK_MS;
        const weekStart = weekEnd - WEEK_MS;

        let addCount = prevAdds.count;
        let addOwn = prevAdds.ownCount;
        let addMs = prevAdds.addedMs;
        let addPrice = prevAdds.priceSum;
        let addPriceCount = prevAdds.priceCount;
        let sellCount = prevSold.count;
        let sellOwn = prevSold.ownCount;
        let sellMs = prevSold.addedMs;
        let sellPrice = prevSold.priceSum;
        let sellPriceCount = prevSold.priceCount;

        let weekSold = 0;
        let weekOwnSold = 0;
        let weekAdded = 0;
        let weekTurnSum = 0;
        let weekTurnCount = 0;

        for (const day of days) {
            if (day.ts > weekEnd) break;
            addCount += day.adds.count;
            addOwn += day.adds.ownCount;
            addMs += day.adds.addedMs;
            addPrice += day.adds.priceSum;
            addPriceCount += day.adds.priceCount;
            sellCount += day.sold.count;
            sellOwn += day.sold.ownCount;
            sellMs += day.sold.addedMs;
            sellPrice += day.sold.priceSum;
            sellPriceCount += day.sold.priceCount;

            if (day.ts > weekStart) {
                weekSold += day.sold.count;
                weekOwnSold += day.sold.ownCount;
                weekAdded += day.adds.count;
                weekTurnSum += day.sold.turnSum;
                weekTurnCount += day.sold.turnCount;
            }
        }

        const listings = Math.max(0, addCount - sellCount);
        const activeAddedMs = addMs - sellMs;
        const activePriceSum = addPrice - sellPrice;
        const activePriceCount = addPriceCount - sellPriceCount;

        series.push({
            label: `${new Date(weekEnd).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${new Date(weekEnd).getUTCDate()}`,
            listings,
            yourListings: Math.max(0, addOwn - sellOwn),
            sold: weekSold,
            yourSold: weekOwnSold,
            acquired: weekAdded,
            avgListPrice: round(safeDiv(activePriceSum, activePriceCount)),
            avgDaysOnLot:
                listings > 0
                    ? round(Math.max(0, (listings * weekEnd - activeAddedMs) / listings / DAY_MS))
                    : 0,
            avgDaysToSell: round(safeDiv(weekTurnSum, weekTurnCount)),
        });
    }

    return series;
}

export async function getPriceByModelYear(scope: MarketScope, condition: ConditionFilter) {
    const key = cacheKeyFor('modelyear', 'market', scope, condition, 0, 'v1');
    const cached = await cacheService.get<any>(key);
    if (cached) return cached;

    const maxYear = new Date().getUTCFullYear() + 2;
    const rows = await Vehicle.aggregate([
        {
            $match: {
                isDeleted: false,
                ...scopeMatch(scope),
                ...conditionMatch(condition),
                status: { $ne: 'Sold' },
                price: { $gt: 0 },
                year: { $gte: 1990, $lte: maxYear },
            },
        },
        { $group: { _id: '$year', avgPrice: { $avg: '$price' }, count: { $sum: 1 } } },
        { $match: { count: { $gte: MIN_COHORT } } },
        { $sort: { _id: 1 } },
    ]);

    const data = rows.map((r) => ({ year: r._id, avgPrice: round(r.avgPrice), count: r.count }));
    await cacheService.set(key, data, CACHE_TTL);
    return data;
}

export function reconstructSupplySeries(
    activeNow: number,
    addsByWeek: number[],
    soldByWeek: number[],
    weeks: number,
    todayMidnight: number,
): { label: string; value: number }[] {
    const points: { label: string; value: number }[] = [];
    let running = activeNow;
    for (let w = 0; w < weeks; w++) {
        const ts = todayMidnight - w * WEEK_MS;
        const date = new Date(ts);
        points.push({
            label: `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
            value: Math.max(0, running),
        });
        running = running - (addsByWeek[w] || 0) + (soldByWeek[w] || 0);
    }
    return points.reverse();
}

export interface SupplyEntry {
    id: string;
    make: string;
    model: string;
    current: number;
    usual: number;
    yours: number;
    changePct: number;
    series: { label: string; value: number }[];
}

export async function getSupplyBoards(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    weeks = 7,
) {
    const key = cacheKeyFor('supply', orgId, scope, condition, weeks, 'v1');
    const cached = await cacheService.get<any>(key);
    if (cached) return cached;

    const todayMidnight = utcMidnight(Date.now());
    const start = new Date(todayMidnight - weeks * WEEK_MS);
    const base = {
        isDeleted: false,
        ...scopeMatch(scope),
        ...conditionMatch(condition),
        make: { $nin: [null, ''] },
        modelName: { $nin: [null, ''] },
    };
    const modelKey = { make: { $toUpper: '$make' }, model: { $toUpper: '$modelName' } };
    const weekIndex = (field: string) => ({
        $max: [0, { $floor: { $divide: [{ $subtract: [new Date(todayMidnight), `$${field}`] }, WEEK_MS] } }],
    });

    const [facets] = await Vehicle.aggregate([
        { $match: base },
        {
            $facet: {
                active: [
                    { $match: { status: { $ne: 'Sold' } } },
                    {
                        $group: {
                            _id: modelKey,
                            makeLabel: { $first: '$make' },
                            modelLabel: { $first: '$modelName' },
                            count: { $sum: 1 },
                            yours: { $sum: { $cond: [{ $eq: ['$organizationId', orgId] }, 1, 0] } },
                        },
                    },
                    { $match: { count: { $gte: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 400 },
                ],
                adds: [
                    { $match: { dateAdded: { $gte: start } } },
                    { $group: { _id: { ...modelKey, w: weekIndex('dateAdded') }, count: { $sum: 1 } } },
                ],
                sold: [
                    { $match: { status: 'Sold', dateSold: { $gte: start } } },
                    { $group: { _id: { ...modelKey, w: weekIndex('dateSold') }, count: { $sum: 1 } } },
                ],
            },
        },
    ]);

    const bucketKey = (make: string, model: string, w: number) => `${make}|${model}|${w}`;
    const addsMap = new Map<string, number>();
    const soldMap = new Map<string, number>();
    for (const r of facets?.adds || []) {
        addsMap.set(bucketKey(r._id.make, r._id.model, Number(r._id.w)), r.count);
    }
    for (const r of facets?.sold || []) {
        soldMap.set(bucketKey(r._id.make, r._id.model, Number(r._id.w)), r.count);
    }

    const entries: SupplyEntry[] = (facets?.active || []).map((row: any) => {
        const make = row._id.make;
        const model = row._id.model;
        const adds: number[] = [];
        const sold: number[] = [];
        for (let w = 0; w < weeks; w++) {
            adds.push(addsMap.get(bucketKey(make, model, w)) || 0);
            sold.push(soldMap.get(bucketKey(make, model, w)) || 0);
        }
        const points = reconstructSupplySeries(row.count, adds, sold, weeks, todayMidnight);
        const usual = points.reduce((s, p) => s + p.value, 0) / points.length;
        return {
            id: `${make}|${model}`,
            make: row.makeLabel,
            model: row.modelLabel,
            current: row.count,
            usual: round(usual),
            yours: row.yours || 0,
            changePct: usual > 0 ? round(((row.count - usual) / usual) * 100) : 0,
            series: points,
        };
    });

    const eligible = entries.filter((e) => e.usual >= MIN_COHORT);
    const data = {
        low: eligible
            .filter((e) => e.current < e.usual)
            .sort((a, b) => a.changePct - b.changePct)
            .slice(0, 30),
        high: eligible
            .filter((e) => e.current > e.usual)
            .sort((a, b) => b.changePct - a.changePct)
            .slice(0, 30),
    };

    await cacheService.set(key, data, CACHE_TTL);
    return data;
}

export type PerformanceBoardKey = 'active' | 'turn' | 'value' | 'cars';

const PERFORMANCE_BOARDS: Record<PerformanceBoardKey, { label: string; hint: string; unit: string }> = {
    active: { label: 'Most Active Dealers', hint: 'Highest sales activity in the period', unit: 'sold' },
    turn: { label: 'Lowest Days on Lot', hint: 'Quickest average sales turnover', unit: 'days' },
    value: { label: 'Inventory Value', hint: 'Total list value of live inventory', unit: 'currency' },
    cars: { label: 'Cars on Lot', hint: 'Units currently available for sale', unit: 'units' },
};

export function normalizeBoard(raw: unknown): PerformanceBoardKey {
    return raw === 'turn' || raw === 'value' || raw === 'cars' ? raw : 'active';
}

export function buildPerformanceBoard(
    rollups: DealerRollup[],
    board: PerformanceBoardKey,
    page: number,
    limit: number,
) {
    const meta = PERFORMANCE_BOARDS[board];
    let pool = rollups;
    let metric: keyof DealerRollup = 'sold';
    let direction: 'asc' | 'desc' = 'desc';

    if (board === 'turn') {
        pool = rollups.filter((d) => d.avgDaysToSell > 0 && d.sold >= 2);
        metric = 'avgDaysToSell';
        direction = 'asc';
    } else if (board === 'value') {
        metric = 'inventoryValue';
    } else if (board === 'cars') {
        metric = 'active';
    }

    const ranked = [...pool]
        .sort((a, b) => {
            const av = Number(a[metric]) || 0;
            const bv = Number(b[metric]) || 0;
            return direction === 'desc' ? bv - av : av - bv;
        })
        .map((d, i) => ({
            rank: i + 1,
            id: d.id,
            name: d.name,
            logoUrl: d.logoUrl,
            city: d.city,
            state: d.state,
            isYou: d.isYou,
            hasListings: d.hasListings,
            momentum: d.momentum,
            value: Number(d[metric]) || 0,
        }));

    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const yourRank = ranked.find((r) => r.isYou)?.rank ?? null;

    return {
        key: board,
        label: meta.label,
        hint: meta.hint,
        unit: meta.unit,
        page: safePage,
        totalPages,
        total,
        yourRank,
        rows: ranked.slice((safePage - 1) * limit, safePage * limit),
    };
}

export interface Recommendation {
    id: string;
    year: number;
    make: string;
    model: string;
    sold: number;
    active: number;
    avgDaysToSell: number;
    avgAge: number;
    avgPrice: number;
    marketSold: number;
    marketActive: number;
    marketDaysToSell: number;
    reason: string;
}

export async function getRecommendations(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days = 90,
) {
    const from = new Date(Date.now() - days * DAY_MS);
    const now = Date.now();
    const notSold = { $ne: ['$status', 'Sold'] };
    const soldInPeriod = { $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] };
    const daysToSell = { $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS] };

    const [ownRows, segments] = await Promise.all([
        Vehicle.aggregate([
            {
                $match: {
                    organizationId: orgId,
                    isDeleted: false,
                    make: { $nin: [null, ''] },
                    modelName: { $nin: [null, ''] },
                    $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }],
                },
            },
            {
                $group: {
                    _id: { year: '$year', make: { $toUpper: '$make' }, model: { $toUpper: '$modelName' } },
                    makeLabel: { $first: '$make' },
                    modelLabel: { $first: '$modelName' },
                    sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                    active: { $sum: { $cond: [notSold, 1, 0] } },
                    turnSum: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, daysToSell, 0] } },
                    turnCount: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] } },
                    ageSum: {
                        $sum: {
                            $cond: [
                                notSold,
                                { $max: [0, { $divide: [{ $subtract: [new Date(now), '$dateAdded'] }, DAY_MS] }] },
                                0,
                            ],
                        },
                    },
                    priceSum: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, '$price', 0] } },
                    priceCount: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, 1, 0] } },
                },
            },
            { $match: { $expr: { $gt: [{ $add: ['$sold', '$active'] }, 0] } } },
            { $sort: { sold: -1, active: -1 } },
            { $limit: 300 },
        ]),
        getSegments(orgId, scope, condition, days),
    ]);

    const marketMap = new Map<string, any>(
        (segments as any[]).map((s) => [`${String(s.make).toUpperCase()}|${String(s.model).toUpperCase()}`, s]),
    );

    const enriched = (ownRows as any[]).map((r) => {
        const market = marketMap.get(`${r._id.make}|${r._id.model}`);
        const avgDaysToSell = round(safeDiv(r.turnSum, r.turnCount));
        const avgAge = round(safeDiv(r.ageSum, r.active));
        return {
            id: `${r._id.year}|${r._id.make}|${r._id.model}`,
            year: r._id.year,
            make: r.makeLabel,
            model: r.modelLabel,
            sold: r.sold || 0,
            active: r.active || 0,
            avgDaysToSell,
            avgAge,
            avgPrice: round(safeDiv(r.priceSum, r.priceCount)),
            marketSold: market?.sold || 0,
            marketActive: market?.active || 0,
            marketDaysToSell: market?.avgDaysToSell || 0,
        };
    });

    const buy: Recommendation[] = enriched
        .filter((r) => r.sold >= 1)
        .map((r) => {
            const turnScore = r.avgDaysToSell > 0 ? Math.min(2.5, 90 / r.avgDaysToSell) : 1;
            const stockPenalty = r.active > r.sold * 2 ? 0.6 : 1;
            const marketBoost = r.marketSold > 0 ? 1 + Math.min(1, r.marketSold / 25) : 1;
            return {
                ...r,
                score: r.sold * turnScore * stockPenalty * marketBoost,
                reason: [
                    `Sold ${r.sold} unit${r.sold === 1 ? '' : 's'} in the last ${days} days`,
                    r.avgDaysToSell > 0 ? ` with an average ${r.avgDaysToSell}-day turn` : '',
                    `. You currently stock ${r.active} unit${r.active === 1 ? '' : 's'}`,
                    r.marketActive > 0
                        ? `, while the market lists ${r.marketActive} and has moved ${r.marketSold}`
                        : '',
                    r.active === 0
                        ? '. Restocking is the clearest opportunity here.'
                        : r.active <= r.sold
                            ? '. Supply is tight against demand, so it is worth buying more.'
                            : '. Inventory is balanced against demand.',
                ].join(''),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
        .map(({ score, ...rest }) => rest);

    const caution: Recommendation[] = enriched
        .filter((r) => r.active >= 1 && (r.avgAge >= 75 || (r.sold === 0 && r.avgAge >= 45)))
        .map((r) => {
            const benchmark = r.marketDaysToSell > 0 ? r.marketDaysToSell : 45;
            return {
                ...r,
                score: r.avgAge * Math.max(1, r.active),
                reason: [
                    `Your ${r.active} in stock average ${r.avgAge} days on lot`,
                    r.marketDaysToSell > 0
                        ? ` against a ${round(benchmark)}-day market turn`
                        : ' against a 45-day working benchmark',
                    `, with ${r.sold} sold in the last ${days} days`,
                    r.marketActive > r.marketSold * 3 && r.marketActive > 0
                        ? '. The wider market is oversupplied too, so price to move rather than waiting.'
                        : '. Consider a price correction or wholesale exit before it ages further.',
                ].join(''),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
        .map(({ score, ...rest }) => rest);

    return { buy, caution, days };
}

export function filterToCompetitors(
    rollups: DealerRollup[],
    watchedIds: string[],
    orgId: string,
): DealerRollup[] {
    if (!watchedIds.length) return rollups;
    const allow = new Set([...watchedIds, orgId]);
    const filtered = rollups.filter((d) => allow.has(d.id));
    return filtered.length ? filtered : rollups;
}

function hostnameOf(url?: string): string | undefined {
    if (!url || typeof url !== 'string') return undefined;
    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        const host = parsed.hostname.replace(/^www\./i, '');
        return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : undefined;
    } catch {
        return undefined;
    }
}

export interface DealerContact {
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    website?: string;
    active: number;
    avgPrice: number;
}

export async function getDealerContacts(ids: string[]): Promise<Map<string, DealerContact>> {
    const valid = ids.filter(isObjectId);
    if (!valid.length) return new Map();

    const rows = await Vehicle.aggregate([
        { $match: { isDeleted: false, organizationId: { $in: valid } } },
        {
            $group: {
                _id: '$organizationId',
                active: { $sum: { $cond: [{ $ne: ['$status', 'Sold'] }, 1, 0] } },
                priceSum: {
                    $sum: { $cond: [{ $and: [{ $ne: ['$status', 'Sold'] }, { $gt: ['$price', 0] }] }, '$price', 0] },
                },
                priceCount: {
                    $sum: { $cond: [{ $and: [{ $ne: ['$status', 'Sold'] }, { $gt: ['$price', 0] }] }, 1, 0] },
                },
                addresses: { $addToSet: '$dealerAddress' },
                cities: { $addToSet: '$dealerCity' },
                states: { $addToSet: '$dealerState' },
                zips: { $addToSet: '$dealerZip' },
                sampleUrl: { $min: '$vdpUrl' },
            },
        },
    ]);

    const firstOf = (values: unknown[]): string | undefined => {
        const found = (values || []).find((v) => typeof v === 'string' && v.trim().length > 0);
        return found ? String(found).trim().slice(0, 120) : undefined;
    };

    return new Map(
        rows.map((r) => [
            String(r._id),
            {
                address: firstOf(r.addresses),
                city: firstOf(r.cities),
                state: firstOf(r.states),
                zip: firstOf(r.zips),
                website: hostnameOf(r.sampleUrl),
                active: r.active || 0,
                avgPrice: round(safeDiv(r.priceSum, r.priceCount)),
            },
        ]),
    );
}

export async function getModelDetail(
    orgId: string,
    makeRaw: string,
    modelRaw: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
    weeks = 7,
) {
    const make = sanitizeToken(makeRaw, 40);
    const model = sanitizeToken(modelRaw, 60);
    if (!make || !model) return null;

    const makeKey = make.toUpperCase();
    const modelKey = model.toUpperCase();
    const todayMidnight = utcMidnight(Date.now());
    const supplyStart = new Date(todayMidnight - weeks * WEEK_MS);
    const from = new Date(Date.now() - days * DAY_MS);
    const now = Date.now();

    const notSold = { $ne: ['$status', 'Sold'] };
    const soldInPeriod = { $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] };
    const daysToSell = { $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS] };
    const priced = { $and: [notSold, { $gt: ['$price', 0] }] };
    const weekIndex = (field: string) => ({
        $max: [0, { $floor: { $divide: [{ $subtract: [new Date(todayMidnight), `$${field}`] }, WEEK_MS] } }],
    });

    const base = {
        isDeleted: false,
        ...scopeMatch(scope),
        ...conditionMatch(condition),
        make: { $regex: `^${escapeRegex(make)}$`, $options: 'i' },
        modelName: { $regex: `^${escapeRegex(model)}$`, $options: 'i' },
    };

    const [facets] = await Vehicle.aggregate([
        { $match: base },
        {
            $facet: {
                summary: [
                    { $match: { $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }] } },
                    {
                        $group: {
                            _id: null,
                            makeLabel: { $first: '$make' },
                            modelLabel: { $first: '$modelName' },
                            active: { $sum: { $cond: [notSold, 1, 0] } },
                            sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                            priceSum: { $sum: { $cond: [priced, '$price', 0] } },
                            priceCount: { $sum: { $cond: [priced, 1, 0] } },
                            mileageSum: {
                                $sum: { $cond: [{ $and: [notSold, { $gt: ['$mileage', 0] }] }, '$mileage', 0] },
                            },
                            mileageCount: {
                                $sum: { $cond: [{ $and: [notSold, { $gt: ['$mileage', 0] }] }, 1, 0] },
                            },
                            turnSum: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, daysToSell, 0] } },
                            turnCount: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] } },
                            ageSum: {
                                $sum: {
                                    $cond: [
                                        notSold,
                                        { $max: [0, { $divide: [{ $subtract: [new Date(now), '$dateAdded'] }, DAY_MS] }] },
                                        0,
                                    ],
                                },
                            },
                            yours: { $sum: { $cond: [{ $and: [notSold, { $eq: ['$organizationId', orgId] }] }, 1, 0] } },
                            yoursSold: { $sum: { $cond: [{ $and: [soldInPeriod, { $eq: ['$organizationId', orgId] }] }, 1, 0] } },
                            dealers: { $addToSet: '$organizationId' },
                        },
                    },
                ],
                byYear: [
                    { $match: { $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }] } },
                    {
                        $group: {
                            _id: '$year',
                            active: { $sum: { $cond: [notSold, 1, 0] } },
                            sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                            priceSum: { $sum: { $cond: [priced, '$price', 0] } },
                            priceCount: { $sum: { $cond: [priced, 1, 0] } },
                            turnSum: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, daysToSell, 0] } },
                            turnCount: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] } },
                            yours: { $sum: { $cond: [{ $and: [notSold, { $eq: ['$organizationId', orgId] }] }, 1, 0] } },
                        },
                    },
                    { $sort: { _id: -1 } },
                    { $limit: 15 },
                ],
                byDealer: [
                    { $match: { $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }] } },
                    {
                        $group: {
                            _id: '$organizationId',
                            active: { $sum: { $cond: [notSold, 1, 0] } },
                            sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                            priceSum: { $sum: { $cond: [priced, '$price', 0] } },
                            priceCount: { $sum: { $cond: [priced, 1, 0] } },
                        },
                    },
                    { $sort: { active: -1, sold: -1 } },
                    { $limit: 12 },
                ],
                adds: [
                    { $match: { dateAdded: { $gte: supplyStart } } },
                    { $group: { _id: weekIndex('dateAdded'), count: { $sum: 1 } } },
                ],
                sold: [
                    { $match: { status: 'Sold', dateSold: { $gte: supplyStart } } },
                    { $group: { _id: weekIndex('dateSold'), count: { $sum: 1 } } },
                ],
                bands: [
                    { $match: { status: { $ne: 'Sold' }, price: { $gt: 0 } } },
                    {
                        $bucket: {
                            groupBy: '$price',
                            boundaries: [0, 10000, 20000, 30000, 45000, 65000, 1000000],
                            default: 'other',
                            output: { count: { $sum: 1 } },
                        },
                    },
                ],
                yourUnits: [
                    { $match: { organizationId: orgId, status: { $ne: 'Sold' } } },
                    {
                        $project: {
                            vin: 1,
                            year: 1,
                            trim: 1,
                            price: 1,
                            mileage: 1,
                            currentStep: 1,
                            ageDays: {
                                $max: [0, { $divide: [{ $subtract: [new Date(now), '$dateAdded'] }, DAY_MS] }],
                            },
                        },
                    },
                    { $sort: { ageDays: -1 } },
                    { $limit: 25 },
                ],
            },
        },
    ]);

    const summary = facets?.summary?.[0];
    if (!summary) return null;

    const dealerRows = facets?.byDealer || [];
    const dealerIds = dealerRows.map((r: any) => String(r._id)).filter(isObjectId);
    const orgs = dealerIds.length
        ? await Organization.find({ _id: { $in: dealerIds.map((id: string) => new mongoose.Types.ObjectId(id)) } })
            .select('name logoUrl')
            .lean()
        : [];
    const orgMap = new Map(orgs.map((o: any) => [String(o._id), o]));

    const addsByWeek: number[] = Array.from({ length: weeks }, () => 0);
    const soldByWeek: number[] = Array.from({ length: weeks }, () => 0);
    for (const r of facets?.adds || []) {
        const w = Number(r._id);
        if (w >= 0 && w < weeks) addsByWeek[w] = r.count;
    }
    for (const r of facets?.sold || []) {
        const w = Number(r._id);
        if (w >= 0 && w < weeks) soldByWeek[w] = r.count;
    }

    const bandLabels: Record<string, string> = {
        '0': 'Under $10k',
        '10000': '$10k–20k',
        '20000': '$20k–30k',
        '30000': '$30k–45k',
        '45000': '$45k–65k',
        '65000': '$65k+',
    };

    const active = summary.active || 0;
    const sold = summary.sold || 0;

    return {
        id: `${makeKey}|${modelKey}`,
        make: summary.makeLabel || make,
        model: summary.modelLabel || model,
        scope,
        days,
        summary: {
            active,
            sold,
            dealers: (summary.dealers || []).length,
            avgPrice: round(safeDiv(summary.priceSum, summary.priceCount)),
            avgMileage: round(safeDiv(summary.mileageSum, summary.mileageCount)),
            avgDaysToSell: round(safeDiv(summary.turnSum, summary.turnCount)),
            avgDaysOnLot: round(safeDiv(summary.ageSum, active)),
            sellThrough: round(safeDiv(sold, sold + active) * 100, 1),
            demandIndex: round(safeDiv(sold, Math.max(1, active)) * 100),
            yours: summary.yours || 0,
            yoursSold: summary.yoursSold || 0,
        },
        supplySeries: reconstructSupplySeries(active, addsByWeek, soldByWeek, weeks, todayMidnight),
        byYear: (facets?.byYear || []).map((r: any) => ({
            year: r._id,
            active: r.active || 0,
            sold: r.sold || 0,
            avgPrice: round(safeDiv(r.priceSum, r.priceCount)),
            avgDaysToSell: round(safeDiv(r.turnSum, r.turnCount)),
            yours: r.yours || 0,
        })),
        topDealers: dealerRows
            .filter((r: any) => orgMap.has(String(r._id)))
            .map((r: any) => ({
                id: String(r._id),
                name: orgMap.get(String(r._id))?.name || 'Unnamed dealership',
                active: r.active || 0,
                sold: r.sold || 0,
                avgPrice: round(safeDiv(r.priceSum, r.priceCount)),
                isYou: String(r._id) === orgId,
            })),
        priceBands: (facets?.bands || []).map((b: any) => ({
            label: bandLabels[String(b._id)] || 'Other',
            count: b.count,
        })),
        yourUnits: (facets?.yourUnits || []).map((v: any) => ({
            id: String(v._id),
            vin: v.vin,
            year: v.year,
            trim: v.trim,
            price: v.price || 0,
            mileage: v.mileage || 0,
            ageDays: round(v.ageDays || 0),
            step: v.currentStep,
        })),
    };
}

export async function getStoreProfile(orgId: string) {
    const org = await Organization.findById(orgId).select('name logoUrl createdAt').lean();
    if (!org) return null;
    const contacts = await getDealerContacts([orgId]);
    const contact = contacts.get(orgId);
    return {
        id: orgId,
        name: (org as any).name,
        logoUrl: (org as any).logoUrl,
        memberSince: (org as any).createdAt,
        address: contact?.address,
        city: contact?.city,
        state: contact?.state,
        zip: contact?.zip,
        website: contact?.website,
    };
}

export async function getSegments(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
) {
    const key = cacheKeyFor('segments', orgId, scope, condition, days);
    const cached = await cacheService.get<any>(key);
    if (cached) return cached;

    const from = new Date(Date.now() - days * DAY_MS);
    const notSold = { $ne: ['$status', 'Sold'] };
    const soldInPeriod = { $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] };
    const daysToSell = { $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS] };

    const rows = await Vehicle.aggregate([
        {
            $match: {
                isDeleted: false,
                ...scopeMatch(scope),
                ...conditionMatch(condition),
                make: { $nin: [null, ''] },
                modelName: { $nin: [null, ''] },
                $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }],
            },
        },
        {
            $group: {
                _id: { make: { $toUpper: '$make' }, model: { $toUpper: '$modelName' } },
                makeLabel: { $first: '$make' },
                modelLabel: { $first: '$modelName' },
                active: { $sum: { $cond: [notSold, 1, 0] } },
                sold: { $sum: { $cond: [soldInPeriod, 1, 0] } },
                priceSum: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, '$price', 0] } },
                priceCount: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, 1, 0] } },
                turnSum: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, daysToSell, 0] } },
                turnCount: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] } },
                yours: { $sum: { $cond: [{ $and: [notSold, { $eq: ['$organizationId', orgId] }] }, 1, 0] } },
                yoursSold: { $sum: { $cond: [{ $and: [soldInPeriod, { $eq: ['$organizationId', orgId] }] }, 1, 0] } },
                dealers: { $addToSet: '$organizationId' },
            },
        },
        { $match: { $expr: { $gte: [{ $add: ['$active', '$sold'] }, MIN_COHORT] } } },
        { $sort: { sold: -1, active: -1 } },
        { $limit: SEGMENT_LIMIT },
    ]);

    const segments = rows.map((r) => {
        const active = r.active || 0;
        const sold = r.sold || 0;
        const sellThrough = round(safeDiv(sold, sold + active) * 100, 1);
        const demandIndex = round(safeDiv(sold, Math.max(1, active)) * 100);
        return {
            id: `${r._id.make}|${r._id.model}`,
            make: r.makeLabel,
            model: r.modelLabel,
            active,
            sold,
            dealers: (r.dealers || []).length,
            avgPrice: round(safeDiv(r.priceSum || 0, r.priceCount || 0)),
            avgDaysToSell: round(safeDiv(r.turnSum || 0, r.turnCount || 0)),
            sellThrough,
            demandIndex,
            yours: r.yours || 0,
            yoursSold: r.yoursSold || 0,
            temperature: demandIndex >= 60 ? 'hot' : demandIndex >= 25 ? 'balanced' : 'cold',
        };
    });

    await cacheService.set(key, segments, CACHE_TTL);
    return segments;
}

export async function getOpportunities(
    orgId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
) {
    const from = new Date(Date.now() - days * DAY_MS);
    const notSold = { $ne: ['$status', 'Sold'] };
    const soldInPeriod = { $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] };
    const daysToSell = { $divide: [{ $subtract: ['$dateSold', '$dateAdded'] }, DAY_MS] };

    const [segments, marketByTrim, ownUnits] = await Promise.all([
        getSegments(orgId, scope, condition, days),
        Vehicle.aggregate([
            {
                $match: {
                    isDeleted: false,
                    ...scopeMatch(scope),
                    make: { $nin: [null, ''] },
                    modelName: { $nin: [null, ''] },
                    $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }],
                },
            },
            {
                $group: {
                    _id: { year: '$year', make: { $toUpper: '$make' }, model: { $toUpper: '$modelName' } },
                    priceSum: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, '$price', 0] } },
                    priceCount: { $sum: { $cond: [{ $and: [notSold, { $gt: ['$price', 0] }] }, 1, 0] } },
                    turnSum: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, daysToSell, 0] } },
                    turnCount: { $sum: { $cond: [{ $and: [soldInPeriod, { $gt: [daysToSell, 0] }] }, 1, 0] } },
                    dealers: { $addToSet: '$organizationId' },
                },
            },
            { $match: { priceCount: { $gte: MIN_COHORT } } },
        ]),
        Vehicle.find({ organizationId: orgId, isDeleted: false, status: { $ne: 'Sold' } })
            .select('_id vin year make modelName trim price mileage dateAdded daysOnLot status currentStep')
            .limit(OWN_UNIT_SCAN_LIMIT)
            .lean(),
    ]);

    const trimMap = new Map<string, any>(
        marketByTrim.map((r) => [`${r._id.year}|${r._id.make}|${r._id.model}`, r]),
    );

    const now = Date.now();
    const priceMoves: any[] = [];
    const agedUnits: any[] = [];

    for (const v of ownUnits as any[]) {
        const ageDays = v.dateAdded
            ? Math.max(0, Math.round((now - new Date(v.dateAdded).getTime()) / DAY_MS))
            : v.daysOnLot || 0;
        const stat = trimMap.get(`${v.year}|${String(v.make || '').toUpperCase()}|${String(v.modelName || '').toUpperCase()}`);
        const marketPrice = stat ? round(safeDiv(stat.priceSum, stat.priceCount)) : 0;
        const marketTurn = stat && stat.turnCount ? round(safeDiv(stat.turnSum, stat.turnCount)) : 0;

        if (marketPrice > 0 && v.price > 0) {
            const gap = v.price - marketPrice;
            const gapPct = round((gap / marketPrice) * 100, 1);
            if (Math.abs(gapPct) >= 7) {
                priceMoves.push({
                    id: String(v._id),
                    vin: v.vin,
                    year: v.year,
                    make: v.make,
                    model: v.modelName,
                    trim: v.trim,
                    mileage: v.mileage,
                    yourPrice: v.price,
                    marketPrice,
                    gap: round(gap),
                    gapPct,
                    cohort: stat.priceCount,
                    ageDays,
                    direction: gap > 0 ? 'above' : 'below',
                    suggestedPrice: round(marketPrice * (gap > 0 ? 1.02 : 0.99)),
                });
            }
        }

        const turnBenchmark = marketTurn > 0 ? marketTurn : 45;
        if (ageDays > turnBenchmark * 1.4 && ageDays >= 30) {
            agedUnits.push({
                id: String(v._id),
                vin: v.vin,
                year: v.year,
                make: v.make,
                model: v.modelName,
                trim: v.trim,
                mileage: v.mileage,
                yourPrice: v.price || 0,
                marketPrice,
                ageDays,
                marketTurn: round(turnBenchmark),
                overBy: round(ageDays - turnBenchmark),
                step: v.currentStep,
            });
        }
    }

    priceMoves.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    agedUnits.sort((a, b) => b.overBy - a.overBy);

    const acquire = segments
        .filter((s: any) => s.sold >= 2 && s.dealers >= 2 && s.avgDaysToSell > 0)
        .map((s: any) => ({
            ...s,
            score: round(
                (s.demandIndex * 0.6 + s.sellThrough * 0.4) * (s.yours === 0 ? 1.25 : 1) * (s.avgDaysToSell > 0 ? Math.min(2, 45 / s.avgDaysToSell) : 1),
                1,
            ),
        }))
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 8);

    return {
        acquire,
        reprice: priceMoves.slice(0, 10),
        aged: agedUnits.slice(0, 10),
        scanned: ownUnits.length,
    };
}

export async function searchDealers(orgId: string, term: string, scope: MarketScope, limit = 20) {
    const clean = sanitizeToken(term, 60);
    const take = Math.min(50, Math.max(1, limit));
    const pattern = clean ? escapeRegex(clean) : '';

    const [byName, byLocation] = await Promise.all([
        Organization.find(clean ? { status: 'active', name: { $regex: pattern, $options: 'i' } } : { status: 'active' })
            .select('name logoUrl')
            .limit(take)
            .lean(),
        clean
            ? Vehicle.aggregate([
                {
                    $match: {
                        isDeleted: false,
                        $or: [
                            { dealerCity: { $regex: pattern, $options: 'i' } },
                            { dealerState: { $regex: pattern, $options: 'i' } },
                            { dealerAddress: { $regex: pattern, $options: 'i' } },
                            { dealerZip: { $regex: pattern, $options: 'i' } },
                            { vdpUrl: { $regex: pattern, $options: 'i' } },
                        ],
                    },
                },
                { $group: { _id: '$organizationId' } },
                { $limit: take },
            ])
            : Promise.resolve([] as any[]),
    ]);

    const ids = [
        ...new Set([
            ...byName.map((o: any) => String(o._id)),
            ...byLocation.map((r: any) => String(r._id)).filter(isObjectId),
        ]),
    ].slice(0, take);

    if (!ids.length) return [];

    const [orgs, contacts, watched] = await Promise.all([
        Organization.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, status: 'active' })
            .select('name logoUrl')
            .lean(),
        getDealerContacts(ids),
        DealerWatch.find({ organizationId: orgId }).select('targetOrganizationId').lean(),
    ]);

    const watchSet = new Set(watched.map((w: any) => String(w.targetOrganizationId)));

    return orgs
        .map((o: any) => {
            const contact = contacts.get(String(o._id));
            return {
                id: String(o._id),
                name: o.name,
                logoUrl: o.logoUrl,
                active: contact?.active || 0,
                avgPrice: contact?.avgPrice || 0,
                address: contact?.address,
                city: contact?.city,
                state: contact?.state,
                zip: contact?.zip,
                website: contact?.website,
                isYou: String(o._id) === orgId,
                hasListings: (contact?.active || 0) > 0,
                watched: watchSet.has(String(o._id)),
            };
        })
        .sort((a, b) => b.active - a.active);
}

export async function getDealerProfile(
    orgId: string,
    targetId: string,
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
) {
    if (!isObjectId(targetId)) return null;

    const rollups = await getDealerRollups(orgId, scope, condition, days);
    const national = rollups.find((d) => d.id === targetId);

    const org = await Organization.findById(targetId).select('name logoUrl status createdAt').lean();
    if (!org) return null;

    const from = new Date(Date.now() - days * DAY_MS);
    const [makeMix, topModels, priceBands, recentActivity] = await Promise.all([
        Vehicle.aggregate([
            { $match: { organizationId: targetId, isDeleted: false, status: { $ne: 'Sold' } } },
            { $group: { _id: '$make', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 8 },
        ]),
        Vehicle.aggregate([
            {
                $match: {
                    organizationId: targetId,
                    isDeleted: false,
                    make: { $nin: [null, ''] },
                    modelName: { $nin: [null, ''] },
                    $or: [{ status: { $ne: 'Sold' } }, { dateSold: { $gte: from } }],
                },
            },
            {
                $group: {
                    _id: { make: { $toUpper: '$make' }, model: { $toUpper: '$modelName' } },
                    make: { $first: '$make' },
                    model: { $first: '$modelName' },
                    active: { $sum: { $cond: [{ $ne: ['$status', 'Sold'] }, 1, 0] } },
                    sold: {
                        $sum: {
                            $cond: [
                                { $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
            { $sort: { active: -1, sold: -1 } },
            { $limit: 10 },
        ]),
        Vehicle.aggregate([
            { $match: { organizationId: targetId, isDeleted: false, status: { $ne: 'Sold' }, price: { $gt: 0 } } },
            {
                $bucket: {
                    groupBy: '$price',
                    boundaries: [0, 10000, 20000, 30000, 45000, 65000, 1000000],
                    default: 'other',
                    output: { count: { $sum: 1 } },
                },
            },
        ]),
        Vehicle.aggregate([
            {
                $match: {
                    organizationId: targetId,
                    isDeleted: false,
                    $or: [{ dateAdded: { $gte: from } }, { dateSold: { $gte: from } }],
                },
            },
            {
                $group: {
                    _id: null,
                    added: { $sum: { $cond: [{ $gte: ['$dateAdded', from] }, 1, 0] } },
                    sold: {
                        $sum: {
                            $cond: [{ $and: [{ $eq: ['$status', 'Sold'] }, { $gte: ['$dateSold', from] }] }, 1, 0],
                        },
                    },
                },
            },
        ]),
    ]);

    const bandLabels: Record<string, string> = {
        '0': 'Under $10k',
        '10000': '$10kâ€“20k',
        '20000': '$20kâ€“30k',
        '30000': '$30kâ€“45k',
        '45000': '$45kâ€“65k',
        '65000': '$65k+',
    };

    return {
        id: targetId,
        name: org.name,
        logoUrl: (org as any).logoUrl,
        memberSince: (org as any).createdAt,
        isYou: targetId === orgId,
        metrics: national || null,
        makeMix: makeMix.map((m) => ({ make: m._id || 'Unspecified', count: m.count })),
        topModels: topModels.map((m: any) => ({
            make: m.make,
            model: m.model,
            active: m.active || 0,
            sold: m.sold || 0,
        })),
        priceBands: priceBands.map((b: any) => ({
            label: bandLabels[String(b._id)] || 'Other',
            count: b.count,
        })),
        period: {
            added: recentActivity[0]?.added || 0,
            sold: recentActivity[0]?.sold || 0,
        },
    };
}

export async function compareDealers(
    orgId: string,
    ids: string[],
    scope: MarketScope,
    condition: ConditionFilter,
    days: number,
) {
    const valid = [...new Set(ids.filter(isObjectId))].slice(0, MAX_COMPARE);
    if (!valid.length) return [];
    const rollups = await getDealerRollups(orgId, scope, condition, days);
    const map = new Map(rollups.map((r) => [r.id, r]));

    const missing = valid.filter((id) => !map.has(id));
    if (missing.length) {
        const orgs = await Organization.find({ _id: { $in: missing } }).select('name logoUrl').lean();
        for (const o of orgs as any[]) {
            map.set(String(o._id), {
                id: String(o._id),
                name: o.name,
                logoUrl: o.logoUrl,
                isYou: String(o._id) === orgId,
                hasListings: false,
                active: 0,
                sold: 0,
                soldPrev: 0,
                acquired: 0,
                avgPrice: 0,
                avgDaysOnLot: 0,
                avgDaysToSell: 0,
                freshPct: 0,
                agedPct: 0,
                sellThrough: 0,
                momentum: 0,
                newUnits: 0,
                usedUnits: 0,
                inventoryValue: 0,
            });
        }
    }

    return valid.map((id) => map.get(id)).filter(Boolean) as DealerRollup[];
}

export async function getWatchlist(orgId: string) {
    return DealerWatch.find({ organizationId: orgId }).select('targetOrganizationId label createdAt').lean();
}

export async function addWatch(orgId: string, targetId: string, userId: mongoose.Types.ObjectId, label?: string) {
    if (!isObjectId(targetId)) return null;
    if (targetId === orgId) return null;
    const exists = await Organization.exists({ _id: targetId });
    if (!exists) return null;
    const count = await DealerWatch.countDocuments({ organizationId: orgId });
    if (count >= 25) return null;
    return DealerWatch.findOneAndUpdate(
        { organizationId: orgId, targetOrganizationId: targetId },
        { $setOnInsert: { createdBy: userId }, $set: { label: sanitizeToken(label, 80) } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
}

export async function removeWatch(orgId: string, targetId: string) {
    if (!isObjectId(targetId)) return;
    await DealerWatch.deleteOne({ organizationId: orgId, targetOrganizationId: targetId });
}

export async function getScopeOptions() {
    const key = `mktiq:scopes:v1`;
    const cached = await cacheService.get<any>(key);
    if (cached) return cached;

    const [states, cities] = await Promise.all([
        Vehicle.aggregate([
            { $match: { isDeleted: false, dealerState: { $nin: [null, ''] } } },
            { $group: { _id: '$dealerState', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 60 },
        ]),
        Vehicle.aggregate([
            { $match: { isDeleted: false, dealerCity: { $nin: [null, ''] } } },
            { $group: { _id: { city: '$dealerCity', state: '$dealerState' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 80 },
        ]),
    ]);

    const data = {
        states: states.map((s) => ({ value: s._id, count: s.count })),
        metros: cities.map((c) => ({ city: c._id.city, state: c._id.state, count: c.count })),
    };
    await cacheService.set(key, data, 3600);
    return data;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
    const escape = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@\t])/, "'$1")}"` : s;
    };
    const head = columns.map(escape).join(',');
    const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
    return `${head}\n${body}`;
}
