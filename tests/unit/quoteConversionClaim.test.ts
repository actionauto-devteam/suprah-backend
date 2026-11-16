/**
 * One "Convert to load" at a time per quote.
 */
import fs from 'fs';
import path from 'path';
import {
  QUOTE_CONVERSION_CLAIM_MS,
  quoteConversionClaimFilter,
  quoteConversionClaimUntil,
} from '../../src/utils/quoteConversionClaim';

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
