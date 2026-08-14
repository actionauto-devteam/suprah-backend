import {
    assembleTrendSeries,
    buildLeaderboards,
    buildMarketSummary,
    buildPerformanceBoard,
    buildSignals,
    escapeRegex,
    normalizeBoard,
    normalizeCondition,
    normalizeDays,
    reconstructSupplySeries,
    toCsv,
    type DealerRollup,
    type TrendBucketRow,
} from '../../src/services/suprahRadar.service';

const DAY = 86_400_000;
const WEEK = DAY * 7;

function seeded(seed: number) {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const dayFloor = (ts: number) => Date.parse(`${dayKey(ts)}T00:00:00.000Z`);

function dealer(over: Partial<DealerRollup> = {}): DealerRollup {
    return {
        id: 'x',
        name: 'Dealer',
        isYou: false,
        hasListings: true,
        active: 10,
        sold: 5,
        soldPrev: 4,
        acquired: 6,
        avgPrice: 20000,
        avgDaysOnLot: 40,
        avgDaysToSell: 30,
        freshPct: 50,
        agedPct: 20,
        sellThrough: 33.3,
        momentum: 25,
        newUnits: 2,
        usedUnits: 8,
        inventoryValue: 200000,
        ...over,
    };
}

describe('dealer analytics — trend reconstruction', () => {
    const WEEKS = 12;
    const todayMidnight = dayFloor(Date.now());
    const startTs = todayMidnight - WEEKS * WEEK;

    type SyntheticVehicle = { added: number; sold: number | null; price: number; own: boolean };

    const rand = seeded(42);
    const vehicles: SyntheticVehicle[] = [];
    for (let i = 0; i < 4000; i++) {
        const added = todayMidnight - Math.floor(rand() * 400) * DAY - Math.floor(rand() * DAY);
        const sellsAt = added + Math.floor(rand() * 160) * DAY + Math.floor(rand() * DAY);
        vehicles.push({
            added,
            sold: rand() < 0.55 && sellsAt <= todayMidnight + DAY ? sellsAt : null,
            price: rand() < 0.9 ? 8000 + Math.floor(rand() * 60000) : 0,
            own: rand() < 0.12,
        });
    }

    const bucketFor = (ts: number) => (ts < startTs ? 'PRE' : dayKey(ts));
    const addsAgg = new Map<string, TrendBucketRow>();
    const soldAgg = new Map<string, TrendBucketRow>();
    const bump = (map: Map<string, TrendBucketRow>, key: string) => {
        if (!map.has(key)) {
            map.set(key, {
                _id: key,
                count: 0,
                addedMs: 0,
                priceSum: 0,
                priceCount: 0,
                ownCount: 0,
                turnSum: 0,
                turnCount: 0,
            });
        }
        return map.get(key)!;
    };

    for (const v of vehicles) {
        const a = bump(addsAgg, bucketFor(v.added));
        a.count! += 1;
        a.addedMs! += v.added;
        a.ownCount! += v.own ? 1 : 0;
        if (v.price > 0) {
            a.priceSum! += v.price;
            a.priceCount! += 1;
        }
        if (v.sold != null) {
            const s = bump(soldAgg, bucketFor(v.sold));
            s.count! += 1;
            s.addedMs! += v.added;
            s.ownCount! += v.own ? 1 : 0;
            if (v.price > 0) {
                s.priceSum! += v.price;
                s.priceCount! += 1;
            }
            const turn = (v.sold - v.added) / DAY;
            s.turnSum! += Math.max(0, turn);
            s.turnCount! += turn > 0 ? 1 : 0;
        }
    }

    const series = assembleTrendSeries(
        [...addsAgg.values()],
        [...soldAgg.values()],
        WEEKS,
        todayMidnight,
        startTs,
    );

    it('produces one point per week', () => {
        expect(series).toHaveLength(WEEKS);
    });

    it.each(Array.from({ length: WEEKS }, (_, i) => i))(
        'matches brute-force ground truth for week %i',
        (i) => {
            const weekEnd = todayMidnight - (WEEKS - 1 - i) * WEEK;
            const weekStart = weekEnd - WEEK;

            const active = vehicles.filter(
                (v) => dayFloor(v.added) <= weekEnd && (v.sold == null || dayFloor(v.sold) > weekEnd),
            );
            const priced = active.filter((v) => v.price > 0);
            const soldThisWeek = vehicles.filter(
                (v) => v.sold != null && dayFloor(v.sold) > weekStart && dayFloor(v.sold) <= weekEnd,
            );
            const addedThisWeek = vehicles.filter(
                (v) => dayFloor(v.added) > weekStart && dayFloor(v.added) <= weekEnd,
            );
            const turns = soldThisWeek.map((v) => (v.sold! - v.added) / DAY).filter((t) => t > 0);

            const point = series[i];
            expect(point.listings).toBe(active.length);
            expect(point.yourListings).toBe(active.filter((v) => v.own).length);
            expect(point.sold).toBe(soldThisWeek.length);
            expect(point.yourSold).toBe(soldThisWeek.filter((v) => v.own).length);
            expect(point.acquired).toBe(addedThisWeek.length);

            const expectedAge = active.length
                ? active.reduce((sum, v) => sum + (weekEnd - v.added), 0) / active.length / DAY
                : 0;
            const expectedPrice = priced.length
                ? priced.reduce((sum, v) => sum + v.price, 0) / priced.length
                : 0;
            const expectedTurn = turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : 0;

            expect(Math.abs(point.avgDaysOnLot - expectedAge)).toBeLessThanOrEqual(1);
            expect(Math.abs(point.avgListPrice - expectedPrice)).toBeLessThanOrEqual(1);
            expect(Math.abs(point.avgDaysToSell - expectedTurn)).toBeLessThanOrEqual(1);
        },
    );
});

describe('dealer analytics — supply reconstruction', () => {
    const WEEKS = 7;
    const todayMidnight = dayFloor(Date.now());
    const rand = seeded(7);
    const vehicles: { added: number; sold: number | null }[] = [];

    for (let i = 0; i < 900; i++) {
        const added = todayMidnight - Math.floor(rand() * 120) * DAY;
        const sellsAt = added + Math.floor(rand() * 90) * DAY;
        vehicles.push({ added, sold: rand() < 0.6 && sellsAt <= todayMidnight ? sellsAt : null });
    }

    const weekIdx = (ts: number) => Math.max(0, Math.floor((todayMidnight - ts) / WEEK));
    const adds = Array.from({ length: WEEKS }, () => 0);
    const sold = Array.from({ length: WEEKS }, () => 0);
    for (const v of vehicles) {
        const wa = weekIdx(v.added);
        if (wa < WEEKS) adds[wa] += 1;
        if (v.sold != null) {
            const ws = weekIdx(v.sold);
            if (ws < WEEKS) sold[ws] += 1;
        }
    }

    const activeNow = vehicles.filter((v) => v.added <= todayMidnight && v.sold == null).length;
    const points = reconstructSupplySeries(activeNow, adds, sold, WEEKS, todayMidnight);

    it('returns oldest-to-newest points', () => {
        expect(points).toHaveLength(WEEKS);
        expect(points[WEEKS - 1].value).toBe(activeNow);
    });

    it.each(Array.from({ length: WEEKS }, (_, i) => i))('matches live count %i week(s) back', (w) => {
        const at = todayMidnight - w * WEEK;
        const expected = vehicles.filter((v) => v.added <= at && (v.sold == null || v.sold > at)).length;
        expect(points[WEEKS - 1 - w].value).toBe(expected);
    });
});

describe('dealer analytics — rankings and standings', () => {
    const rollups: DealerRollup[] = [
        dealer({ id: 'a', name: 'Alpha Auto', sold: 30, acquired: 20, avgDaysToSell: 22, freshPct: 70, sellThrough: 50, active: 30 }),
        dealer({ id: 'b', name: 'Bravo Motors', sold: 18, acquired: 25, avgDaysToSell: 15, freshPct: 40, sellThrough: 25, active: 54 }),
        dealer({ id: 'c', name: 'Charlie Cars', sold: 9, acquired: 4, avgDaysToSell: 55, freshPct: 20, sellThrough: 10, active: 81, isYou: true, soldPrev: 12 }),
        dealer({ id: 'd', name: 'Delta Drive', sold: 0, acquired: 1, avgDaysToSell: 0, freshPct: 5, sellThrough: 0, active: 12, soldPrev: 0 }),
    ];

    it('ranks sales descending', () => {
        const boards = buildLeaderboards(rollups, 10);
        expect(boards.sales.rows.map((r) => r.name)).toEqual([
            'Alpha Auto',
            'Bravo Motors',
            'Charlie Cars',
            'Delta Drive',
        ]);
        expect(boards.sales.rows[0].value).toBe(30);
    });

    it('ranks turn speed ascending and excludes thin sample sizes', () => {
        const boards = buildLeaderboards(rollups, 10);
        expect(boards.turn.rows.map((r) => r.name)).toEqual([
            'Bravo Motors',
            'Alpha Auto',
            'Charlie Cars',
        ]);
        expect(boards.turn.rows[0].value).toBe(15);
    });

    it('computes market totals and your standing', () => {
        const { market, you } = buildMarketSummary(rollups, 'c');
        expect(market.dealers).toBe(4);
        expect(market.activeListings).toBe(177);
        expect(market.soldInPeriod).toBe(57);
        expect(you?.ranks.sales).toBe(3);
        expect(you?.percentiles.sales).toBe(25);
        expect(you?.vsMarket.avgDaysToSell).toBe(24);
    });

    it('returns a null standing when the store is not in scope', () => {
        expect(buildMarketSummary(rollups, 'not-in-market').you).toBeNull();
    });

    it('reports rank movement against the prior period', () => {
        const { you } = buildMarketSummary(rollups, 'c');
        const priorRank =
            [...rollups].sort((a, b) => b.soldPrev - a.soldPrev).findIndex((d) => d.id === 'c') + 1;
        expect(you?.rankDelta).toBe(priorRank - (you?.ranks.sales ?? 0));
    });
});

describe('dealer analytics — dealerships with no listings', () => {
    const withRoster: DealerRollup[] = [
        dealer({ id: 'a', name: 'Alpha Auto', sold: 30, acquired: 20, active: 30 }),
        dealer({ id: 'b', name: 'Bravo Motors', sold: 4, acquired: 2, active: 12 }),
        dealer({
            id: 'z',
            name: 'Zulu Auto',
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
            inventoryValue: 0,
        }),
    ];

    it('keeps dormant dealerships on the sales and acquisition boards', () => {
        const boards = buildLeaderboards(withRoster, 10);
        expect(boards.sales.rows.map((r) => r.id)).toContain('z');
        expect(boards.acquisitions.rows.map((r) => r.id)).toContain('z');
        expect(boards.sales.rows.find((r) => r.id === 'z')?.rank).toBe(3);
        expect(boards.sales.rows.find((r) => r.id === 'z')?.hasListings).toBe(false);
    });

    it('keeps dormant dealerships out of statistical averages', () => {
        const { market } = buildMarketSummary(withRoster, 'a');
        expect(market.dealers).toBe(2);
        expect(market.totalDealers).toBe(3);
        expect(market.dormantDealers).toBe(1);
    });

    it('lists them last on the cars-on-lot board with a zero value', () => {
        const cars = buildPerformanceBoard(withRoster, 'cars', 1, 10);
        expect(cars.rows.map((r) => r.id)).toContain('z');
        expect(cars.rows.find((r) => r.id === 'z')?.value).toBe(0);
        expect(cars.rows[cars.rows.length - 1].id).toBe('z');
        expect(cars.total).toBe(3);
    });

    it('excludes them from the turn board, which needs a real sample', () => {
        const turn = buildPerformanceBoard(withRoster, 'turn', 1, 10);
        expect(turn.rows.map((r) => r.id)).not.toContain('z');
    });
});

describe('dealer analytics — market signals', () => {
    const pool: DealerRollup[] = [
        dealer({ id: 'up', name: 'Riser Auto', sold: 40, soldPrev: 10, acquired: 30 }),
        dealer({ id: 'down', name: 'Fader Motors', sold: 5, soldPrev: 25, acquired: 2 }),
        dealer({ id: 'flat', name: 'Steady Cars', sold: 10, soldPrev: 10, acquired: 8 }),
        dealer({ id: 'dormant', name: 'Idle Lot', hasListings: false, sold: 0, soldPrev: 0, acquired: 0 }),
    ];

    it('surfaces the biggest gainers and decliners', () => {
        const signals = buildSignals(pool);
        const gainer = signals.find((s) => s.kind === 'gainer');
        const decliner = signals.find((s) => s.kind === 'decliner');
        expect(gainer?.dealer).toBe('Riser Auto');
        expect(gainer?.change).toBe(30);
        expect(decliner?.dealer).toBe('Fader Motors');
        expect(decliner?.change).toBe(-20);
    });

    it('ignores dealerships with no activity either period', () => {
        const signals = buildSignals(pool);
        expect(signals.filter((s) => s.kind !== 'stocking').map((s) => s.dealerId)).not.toContain(
            'dormant',
        );
    });
});

describe('dealer analytics — performance board pagination', () => {
    const pool: DealerRollup[] = Array.from({ length: 47 }, (_, i) =>
        dealer({
            id: `d${i}`,
            name: `Dealer ${i}`,
            sold: 100 - i,
            active: 500 - i * 3,
            inventoryValue: (500 - i * 3) * 20000,
            avgDaysToSell: 5 + i,
            isYou: i === 20,
        }),
    );

    it('paginates without gaps or overlaps', () => {
        const page1 = buildPerformanceBoard(pool, 'active', 1, 10);
        const page3 = buildPerformanceBoard(pool, 'active', 3, 10);
        expect(page1.rows[0].rank).toBe(1);
        expect(page1.rows).toHaveLength(10);
        expect(page3.rows[0].rank).toBe(21);
        expect(page1.totalPages).toBe(5);
        expect(page1.total).toBe(47);
        expect(page1.yourRank).toBe(21);
    });

    it('clamps out-of-range pages to the last page', () => {
        const clamped = buildPerformanceBoard(pool, 'active', 99, 10);
        expect(clamped.page).toBe(5);
        expect(clamped.rows).toHaveLength(7);
    });

    it('sorts each board on its own metric', () => {
        expect(buildPerformanceBoard(pool, 'turn', 1, 10).rows[0].value).toBe(5);
        expect(buildPerformanceBoard(pool, 'value', 1, 10).rows[0].value).toBe(500 * 20000);
        expect(buildPerformanceBoard(pool, 'cars', 1, 10).rows[0].value).toBe(500);
    });
});

describe('dealer analytics — input hardening', () => {
    it('rejects unsupported period values', () => {
        expect(normalizeDays('90')).toBe(90);
        expect(normalizeDays(31)).toBe(30);
        expect(normalizeDays('drop table')).toBe(30);
    });

    it('rejects unsupported condition and board values', () => {
        expect(normalizeCondition('new')).toBe('new');
        expect(normalizeCondition('bogus')).toBe('all');
        expect(normalizeBoard('value')).toBe('value');
        expect(normalizeBoard({ $ne: null })).toBe('active');
    });

    it('escapes regex metacharacters in search terms', () => {
        expect(escapeRegex('a.*+?(b)[c]{d}|e^$')).toBe('a\\.\\*\\+\\?\\(b\\)\\[c\\]\\{d\\}\\|e\\^\\$');
    });

    it('neutralises CSV formula injection', () => {
        const csv = toCsv([{ name: '=cmd|calc', city: 'Salt Lake, UT' }], ['name', 'city']);
        expect(csv).toContain(`"'=cmd|calc"`);
        expect(csv).toContain('"Salt Lake, UT"');
    });
});
