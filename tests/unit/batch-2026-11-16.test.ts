// Tests from the November 16, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import { DRIVER_CURRENT_LOAD_STATUSES, HISTORY_MAX_PAGE_SIZE, driverLoadHistoryFilter, driverLoadHistoryParams, historyPagination } from '../../src/utils/driverLoadHistory';
import fs from 'fs';
import path from 'path';
import { previewLoadIds } from '../../src/utils/previewLoadIds';
import { QUOTE_VEHICLE_NOT_IN_INVENTORY, ownDealershipVehicleFilter } from '../../src/utils/quoteVehicle';

describe('driverLoadHistory.test.ts', () => {
  /**
   * The driver's delivered loads come a page at a time, with search on the server.
   */
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
});

describe('previewLoadIds.test.ts', () => {
  /**
   * The compatibility preview fetches its saved loads in one lookup.
   */
  const A = '64b0000000000000000000a1';
  const B = '64b0000000000000000000b2';

  describe('previewLoadIds', () => {
    it('keeps valid load IDs once each, in order', () => {
      expect(previewLoadIds([{ loadId: A }, { loadId: B }, { loadId: A }, { loadId: ` ${B} ` }])).toEqual([A, B]);
    });

    it('skips drafts without an ID and anything that is not a load ID', () => {
      expect(previewLoadIds([{}, null, { loadId: '' }, { loadId: 'not-an-id' }, { loadId: { $ne: null } }])).toEqual([]);
    });
  });

  describe('compatibility preview', () => {
    it('looks the saved loads up once, in this dealership only', () => {
      const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/driverTracking.controller.ts'), 'utf8');
      expect(controller).toContain('await Load.find({ _id: { $in: savedIds }, organizationId }).lean()');
      expect(controller).not.toMatch(/for \(const entry of entries\) \{[\s\S]{0,400}await Load\.findOne/);
    });
  });
});

describe('quoteVehicle.test.ts', () => {
  /**
   * A staff quote can only be linked to a car in the staff member's own dealership.
   */
  const CAR = '64b0000000000000000000a1';
  const ORG = '64b0000000000000000000f1';

  describe('ownDealershipVehicleFilter', () => {
    it('looks the car up in this dealership only', () => {
      expect(ownDealershipVehicleFilter(CAR, ORG)).toEqual({ _id: CAR, organizationId: ORG });
    });
  });

  describe('quote creation', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/quote.controller.ts'), 'utf8');

    it('uses the dealership-only lookup and refuses other cars with a plain message', () => {
      expect(controller).toContain('Vehicle.findOne(ownDealershipVehicleFilter(normalizedVehicleId, orgId))');
      expect(controller).toContain('throw new ApiError(400, QUOTE_VEHICLE_NOT_IN_INVENTORY)');
      expect(controller).not.toMatch(/Vehicle\.findById\(normalizedVehicleId\)/);
    });

    it('tells staff what to do instead', () => {
      expect(QUOTE_VEHICLE_NOT_IN_INVENTORY).toBe(
        "That vehicle isn't in your dealership's inventory. Pick it from your Inventory, or enter the vehicle details yourself.",
      );
    });
  });
});
