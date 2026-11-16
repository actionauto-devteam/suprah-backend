// Tests from the November 17, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import fs from 'fs';
import path from 'path';
import { inspectionPhotoFilter } from '../../src/utils/inspectionPhotoReplace';
import { QUOTE_CONVERSION_CLAIM_MS, quoteConversionClaimFilter, quoteConversionClaimUntil } from '../../src/utils/quoteConversionClaim';
import { openedQuoteVersion, quoteStatusChangedMeanwhile } from '../../src/utils/quoteEditConflict';
import { quoteStatusCounts } from '../../src/utils/quoteStatusCounts';

describe('inspectionPhotoReplace.test.ts', () => {
  /**
   * Replacing a car's inspection photo on a load.
   */
  describe('inspectionPhotoFilter', () => {
    it('saves only for the same car, in the same place, with the same photo', () => {
      expect(inspectionPhotoFilter('l1', 'org-1', 1, { vin: '1HGCM82633A123456', inspectionPhotoUrl: 'load-inspection/old.jpg' })).toEqual({
        _id: 'l1',
        organizationId: 'org-1',
        'vehicles.1': { $exists: true },
        'vehicles.1.vin': '1HGCM82633A123456',
        'vehicles.1.inspectionPhotoUrl': 'load-inspection/old.jpg',
      });
    });

    it('matches a car with no photo yet, and one without a VIN', () => {
      expect(inspectionPhotoFilter('l1', 'org-1', 0, {})).toEqual({
        _id: 'l1',
        organizationId: 'org-1',
        'vehicles.0': { $exists: true },
        'vehicles.0.inspectionPhotoUrl': { $in: ['', null] },
      });
    });
  });

  describe('uploadInspectionPhoto', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/load.controller.ts'), 'utf8');
    const handler = controller.slice(controller.indexOf('const uploadInspectionPhoto'), controller.indexOf('const uploadInspectionPhoto') + 3000);

    it('stores the new photo before saving, and deletes the old one only after saving', () => {
      const upload = handler.indexOf('storageService.upload(file, "load-inspection"');
      const save = handler.indexOf('Load.findOneAndUpdate(');
      const deleteOld = handler.indexOf('storageService.delete(existing');
      expect(upload).toBeGreaterThan(-1);
      expect(upload).toBeLessThan(save);
      expect(save).toBeLessThan(deleteOld);
      expect(handler).not.toContain('load.save()');
    });

    it('removes its own upload when the car changed meanwhile', () => {
      expect(handler).toMatch(/if \(!updated\) \{\s+try \{ await storageService\.delete\(imageUrl, BucketType\.PRIVATE\); \}/);
    });
  });
});

describe('quoteConversionClaim.test.ts', () => {
  /**
   * One "Convert to load" at a time per quote.
   */
  const NOW = new Date('2026-11-16T05:00:00.000Z');

  describe('quote conversion claim', () => {
    it('claims only this dealership\'s quote when no conversion is in progress', () => {
      expect(quoteConversionClaimFilter('q1', 'org-1', NOW)).toEqual({
        _id: 'q1',
        organizationId: 'org-1',
        $or: [{ convertingUntil: { $exists: false } }, { convertingUntil: null }, { convertingUntil: { $lte: NOW } }],
      });
    });

    it('lapses by itself after a minute', () => {
      expect(QUOTE_CONVERSION_CLAIM_MS).toBe(60_000);
      expect(quoteConversionClaimUntil(NOW).toISOString()).toBe('2026-11-16T05:01:00.000Z');
    });
  });

  describe('Convert to load', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/quote.controller.ts'), 'utf8');
    const start = controller.indexOf('const convertToLoad = asyncHandler');
    const claim = controller.indexOf('quoteConversionClaimFilter(quote._id, orgId, now)', start);
    const create = controller.indexOf('const load = await Load.create(', start);

    it('claims the quote before checking for and creating its load', () => {
      expect(claim).toBeGreaterThan(start);
      expect(claim).toBeLessThan(controller.indexOf('// One live load per quote.', start));
      expect(claim).toBeLessThan(create);
    });

    it('releases the claim when the request ends, whether it worked or not', () => {
      const handler = controller.slice(start, controller.indexOf('async function convertClaimedQuote'));
      expect(handler).toMatch(/try \{\s+return await convertClaimedQuote\(req, res, quote, orgId, userId\);\s+\} finally \{\s+await Quote\.updateOne\(\{ _id: quote\._id, organizationId: orgId \}, \{ \$unset: \{ convertingUntil: '' \} \}/);
    });
  });
});

describe('quoteEditConflict.test.ts', () => {
  /**
   * Quote edits and answers when several staff work at once.
   */
  describe('openedQuoteVersion', () => {
    it('turns the version the staff member opened into a filter', () => {
      expect(openedQuoteVersion('2026-11-16T05:00:00.000Z')).toEqual({ updatedAt: new Date('2026-11-16T05:00:00.000Z') });
    });

    it('adds nothing when no readable version was sent (older screens)', () => {
      expect(openedQuoteVersion(undefined)).toEqual({});
      expect(openedQuoteVersion('')).toEqual({});
      expect(openedQuoteVersion('not a date')).toEqual({});
      expect(openedQuoteVersion({ $gt: '' })).toEqual({});
    });
  });

  describe('quoteStatusChangedMeanwhile', () => {
    it('lets the answer through when the status is what the staff member saw, or none was sent', () => {
      expect(quoteStatusChangedMeanwhile('pending', 'pending')).toBeNull();
      expect(quoteStatusChangedMeanwhile('pending', undefined)).toBeNull();
    });

    it('says in plain words what someone else already did', () => {
      expect(quoteStatusChangedMeanwhile('rejected', 'pending')).toBe(
        'Someone else already marked this request Declined while you were deciding. Refresh to see it, then answer again if it still needs one.',
      );
      expect(quoteStatusChangedMeanwhile('accepted', 'pending')).toContain('marked this request Accepted');
    });
  });

  describe('quote handlers', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/quote.controller.ts'), 'utf8');

    it('saves an edit only if nobody changed the quote since it was opened', () => {
      expect(controller).toContain('{ _id: req.params.id, organizationId: orgId, ...openedQuoteVersion(expectedUpdatedAt) }');
      expect(controller).toContain('throw stillThere ? new ApiError(409, QUOTE_CHANGED_WHILE_EDITING) : new ApiError(404, QUOTE_NOT_FOUND);');
    });

    it('saves an answer only if the status is still the one checked', () => {
      expect(controller).toContain('{ _id: req.params.id, organizationId: orgId, status: before.status ?? null }');
    });
  });
});

describe('quoteStatusCounts.test.ts', () => {
  /**
   * The Quotes tab counts come from every quote of the dealership.
   */
  describe('quoteStatusCounts', () => {
    it('counts every status and the total', () => {
      expect(quoteStatusCounts([
        { _id: 'pending', count: 130 },
        { _id: 'accepted', count: 12 },
        { _id: 'booked', count: 300 },
        { _id: 'rejected', count: 8 },
      ])).toEqual({ all: 450, pending: 130, accepted: 12, booked: 300, rejected: 8 });
    });

    it('keeps quotes with an unknown status in the total only', () => {
      expect(quoteStatusCounts([{ _id: null, count: 2 }, { _id: 'pending', count: 1 }])).toEqual({ all: 3, pending: 1, accepted: 0, booked: 0, rejected: 0 });
      expect(quoteStatusCounts([])).toEqual({ all: 0, pending: 0, accepted: 0, booked: 0, rejected: 0 });
    });
  });

  describe('quote list', () => {
    it('counts the whole dealership on the first page', () => {
      const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/quote.controller.ts'), 'utf8');
      expect(controller).toContain("{ $match: { organizationId: orgId } },");
      expect(controller).toContain("{ $group: { _id: '$status', count: { $sum: 1 } } },");
      expect(controller).toContain('...(statusCounts ? { statusCounts } : {}),');
    });
  });
});
