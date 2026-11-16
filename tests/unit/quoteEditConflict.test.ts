/**
 * Quote edits and answers when several staff work at once.
 */
import fs from 'fs';
import path from 'path';
import { openedQuoteVersion, quoteStatusChangedMeanwhile } from '../../src/utils/quoteEditConflict';

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
