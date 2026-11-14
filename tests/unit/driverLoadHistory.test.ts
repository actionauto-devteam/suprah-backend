/**
 * The driver's delivered loads come a page at a time, with search on the server.
 */
import {
  DRIVER_CURRENT_LOAD_STATUSES,
  HISTORY_MAX_PAGE_SIZE,
  driverLoadHistoryFilter,
  driverLoadHistoryParams,
  historyPagination,
} from '../../src/utils/driverLoadHistory';

const DRIVER = '64b0000000000000000000d1';

describe('driverLoadHistoryParams', () => {
  it('defaults to the first page of 20', () => {
    expect(driverLoadHistoryParams({})).toEqual({ page: 1, limit: 20, q: '' });
  });

  it('keeps page and size within safe bounds', () => {
    expect(driverLoadHistoryParams({ page: '0', limit: '500' })).toMatchObject({ page: 1, limit: HISTORY_MAX_PAGE_SIZE });
    expect(driverLoadHistoryParams({ page: 'abc', limit: '-3' })).toMatchObject({ page: 1, limit: 1 });
    expect(driverLoadHistoryParams({ page: '3', limit: '10' })).toMatchObject({ page: 3, limit: 10 });
  });

  it('trims search text, caps its length and ignores non-text values', () => {
    expect(driverLoadHistoryParams({ q: '  camry  ' }).q).toBe('camry');
    expect(driverLoadHistoryParams({ q: 'x'.repeat(200) }).q).toHaveLength(60);
    expect(driverLoadHistoryParams({ q: ['a', 'b'] }).q).toBe('');
  });
});

describe('driverLoadHistoryFilter', () => {
  it("lists only this driver's delivered loads", () => {
    expect(driverLoadHistoryFilter(DRIVER, '')).toEqual({ assignedDriverId: DRIVER, status: 'Delivered' });
  });

  it('searches load number, cities and vehicle, treating the text literally', () => {
    const filter = driverLoadHistoryFilter(DRIVER, 'LD-2026.11 (a)') as { $or: Array<Record<string, RegExp>> };
    expect(filter.$or.map((part) => Object.keys(part)[0])).toEqual([
      'loadNumber', 'pickupLocation.city', 'deliveryLocation.city', 'vehicles.make', 'vehicles.model',
    ]);
    const pattern = filter.$or[0].loadNumber;
    expect(pattern.test('ld-2026.11 (a)')).toBe(true);
    expect(pattern.test('LD-2026x11 (a)')).toBe(false);
  });
});

describe('historyPagination', () => {
  it('says whether more pages exist', () => {
    expect(historyPagination(1, 20, 45)).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3, hasMore: true });
    expect(historyPagination(3, 20, 45)).toMatchObject({ hasMore: false });
    expect(historyPagination(1, 20, 0)).toMatchObject({ totalPages: 1, hasMore: false });
  });
});

describe('current loads', () => {
  it('are the loads a driver is carrying or about to carry', () => {
    expect(DRIVER_CURRENT_LOAD_STATUSES).toEqual(['Assigned', 'Accepted', 'Picked Up', 'In-Transit']);
  });
});
