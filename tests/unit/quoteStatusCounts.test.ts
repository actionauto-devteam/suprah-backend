/**
 * The Quotes tab counts come from every quote of the dealership.
 */
import fs from 'fs';
import path from 'path';
import { quoteStatusCounts } from '../../src/utils/quoteStatusCounts';

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
