// Tests from the November 4, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from customerVehicleLookup.test.ts
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => {
      mockFindOne(query);
      const chain: any = { select: () => chain, populate: () => Promise.resolve(mockFound(query)) };
      return chain;
    },
  },
}));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), invalidateByPrefix: jest.fn() } }));

// Used by the fakes from customerVehicleLookup.test.ts (above the imports, as in that file)
const mockFindOne = jest.fn();
let mockFound: (query: any) => unknown = () => null;

import { MARKETPLACE_MAX_LIMIT, containsText, exactText, marketplacePaging, marketplaceSearchClause, marketplaceSort, queryNumber } from '../../src/services/marketplaceQuery';
import vehicleController from '../../src/controllers/vehicle.controller';

describe('marketplaceQuery.test.ts', () => {
  /**
   * The customer marketplace's search, filters, sorting and paging: visitor
   * text is plain text (never a database pattern), partial words are found,
   * paging is capped and newest listings come first by default.
   */
  describe('search', () => {
    it('finds part of a word in the make, model, trim, VIN or stock number', () => {
      const clause: any = marketplaceSearchClause('cam');
      const fields = clause.$and[0].$or.map((entry: Record<string, unknown>) => Object.keys(entry)[0]);
      expect(fields).toEqual(['make', 'modelName', 'trim', 'vin', 'stockNumber']);
      expect(clause.$and[0].$or[1].modelName.test('Camry')).toBe(true);
    });

    it('needs every word, and a four-digit word can be the year', () => {
      const clause: any = marketplaceSearchClause('  2021   toyota ');
      expect(clause.$and).toHaveLength(2);
      expect(clause.$and[0].$or).toContainEqual({ year: 2021 });
      expect(clause.$and[1].$or).not.toContainEqual(expect.objectContaining({ year: expect.anything() }));
    });

    it('treats symbols as plain text and ignores empty searches', () => {
      const clause: any = marketplaceSearchClause('(a+)+$');
      const pattern: RegExp = clause.$and[0].$or[0].make;
      expect(pattern.test('(a+)+$')).toBe(true);
      expect(pattern.test('aaaa')).toBe(false);
      expect(marketplaceSearchClause('   ')).toBeNull();
      expect(marketplaceSearchClause(undefined)).toBeNull();
    });

    it('uses at most six words', () => {
      expect((marketplaceSearchClause('a b c d e f g h') as any).$and).toHaveLength(6);
    });
  });

  describe('filters', () => {
    it('matches dropdown values exactly, ignoring case, as plain text', () => {
      expect(exactText('Toyota')!.test('TOYOTA')).toBe(true);
      expect(exactText('Toyota')!.test('Toyota Camry')).toBe(false);
      expect(exactText('.*')!.test('anything')).toBe(false);
      expect(exactText('')).toBeNull();
      expect(exactText(['Honda', 'x'])!.test('honda')).toBe(true);
    });

    it('matches free text as plain text', () => {
      expect(containsText('suv')!.test('Compact SUV')).toBe(true);
      expect(containsText('[')!.test('a[b')).toBe(true);
    });

    it('reads numbers safely', () => {
      expect(queryNumber('2020')).toBe(2020);
      expect(queryNumber('abc')).toBeUndefined();
      expect(queryNumber('')).toBeUndefined();
    });
  });

  describe('paging and sorting', () => {
    it('keeps the page and page size within safe bounds', () => {
      expect(marketplacePaging('2', '12')).toEqual({ pageNum: 2, limitNum: 12, skip: 12 });
      expect(marketplacePaging('abc', '100000')).toEqual({ pageNum: 1, limitNum: MARKETPLACE_MAX_LIMIT, skip: 0 });
      expect(marketplacePaging('-3', '0')).toEqual({ pageNum: 1, limitNum: 1, skip: 0 });
      expect(marketplacePaging(undefined, undefined)).toEqual({ pageNum: 1, limitNum: 20, skip: 0 });
    });

    it('shows the newest listings first by default', () => {
      expect(marketplaceSort(undefined, undefined)).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
      expect(marketplaceSort('', '')).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
    });

    it('follows the chosen sort, low to high when no direction is given', () => {
      expect(marketplaceSort('price', 'asc').sort).toEqual({ price: 1, _id: 1 });
      expect(marketplaceSort('year', 'desc').sort).toEqual({ year: -1, _id: -1 });
      expect(marketplaceSort('mileage', undefined).sort).toEqual({ mileage: 1, _id: 1 });
      expect(marketplaceSort('demand', 'desc').key).toBe('demand');
    });

    it("doesn't offer the dealership's low-performing sort", () => {
      expect(marketplaceSort('low-performing', 'desc')).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
    });
  });
});

describe('customerVehicleLookup.test.ts', () => {
  /**
   * A customer opening a car by its id (Compare, financing) only gets cars on
   * the marketplace; staff lookups are unchanged. The model is a stand-in; no
   * database is used.
   */
  const CAR = '64b0000000000000000000a1';

  function lookUp(user: Record<string, unknown>) {
    return new Promise<{ status?: number; body?: any }>((resolve) => {
      const req: any = { params: { id: CAR }, user, orgId: 'org-1', query: {} };
      const res: any = { status() { return this; }, json(body: any) { resolve({ status: 200, body }); return this; } };
      (vehicleController as any).getVehicleById(req, res, (error: any) => resolve({ status: error?.statusCode }));
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFound = () => null;
  });

  it('limits a customer to cars that are for sale on the marketplace', async () => {
    expect((await lookUp({ _id: 'c1', role: 'customer' })).status).toBe(404);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
  });

  it("keeps staff lookups to their own dealership's cars, any status", async () => {
    await lookUp({ _id: 's1', role: 'admin' });
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, organizationId: 'org-1' });
  });

  it("lets staff open another dealership's for-sale car the way a customer does (2026-11-16)", async () => {
    await lookUp({ _id: 's1', role: 'employee' });
    expect(mockFindOne).toHaveBeenNthCalledWith(1, { _id: CAR, isDeleted: false, organizationId: 'org-1' });
    expect(mockFindOne).toHaveBeenNthCalledWith(2, { _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });

    // Found on the marketplace: shown without the other dealership's cost.
    mockFound = (query) => (query.status ? { _id: CAR, status: 'Ready for Sale', price: 20000, cost: 15000, notes: [] } : null);
    const { status, body } = await lookUp({ _id: 's1', role: 'employee' });
    expect(status).toBe(200);
    expect(body.data.price).toBe(20000);
    expect(body.data).not.toHaveProperty('cost');
    expect(body.data).not.toHaveProperty('notes');
  });

  it("treats employees as staff of their own dealership (2026-11-16)", async () => {
    await lookUp({ _id: 'e1', role: 'employee', organizationRole: 'member' });
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, organizationId: 'org-1' });
  });

  it('limits drivers and any other account to cars on the marketplace (2026-11-16)', async () => {
    await lookUp({ _id: 'd1', role: 'driver' });
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
    mockFindOne.mockClear();
    await lookUp({ _id: 'x1', role: 'something-else' });
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
  });
});
