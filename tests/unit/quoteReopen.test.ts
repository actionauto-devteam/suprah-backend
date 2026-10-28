/**
 * When a load made from a quote is deleted or cancelled, the quote goes back
 * to Pending, unless another live load is still linked to it. Models are
 * stand-ins; no database is used.
 */
const mockLinkedQuoteIds = jest.fn();
const mockLoadFind = jest.fn();
const mockBookedQuoteIds = jest.fn();
const mockUpdateMany = jest.fn();
const mockInvalidate = jest.fn();
const mockEmit = jest.fn();

const distinctChain = (result: () => unknown) => ({
  distinct: () => ({ session: () => Promise.resolve(result()) }),
});

jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => {
      mockLoadFind(filter);
      return distinctChain(mockLinkedQuoteIds);
    },
  },
}));
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => distinctChain(() => mockBookedQuoteIds(filter)),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
  },
}));
jest.mock('../../src/services/cache.service', () => ({
  __esModule: true,
  default: { invalidateByPrefix: (...args: unknown[]) => mockInvalidate(...args) },
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  getSocketIO: () => ({ to: () => ({ emit: (...args: unknown[]) => mockEmit(...args) }) }),
}));

import { announceReopenedQuotes, reopenQuotesOfDeletedLoads } from '../../src/services/quoteReopen.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockLinkedQuoteIds.mockReturnValue([]);
  mockBookedQuoteIds.mockReturnValue([]);
});

describe('reopenQuotesOfDeletedLoads', () => {
  it('puts a booked quote back to Pending', async () => {
    mockBookedQuoteIds.mockReturnValue(['q1']);
    const reopened = await reopenQuotesOfDeletedLoads('org-1', ['q1']);
    expect(reopened).toEqual(['q1']);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['q1'] }, organizationId: 'org-1', status: 'booked' },
      { $set: { status: 'pending' } },
      { session: undefined },
    );
  });

  it("doesn't count a cancelled load as still linked", async () => {
    mockBookedQuoteIds.mockReturnValue(['q1']);
    expect(await reopenQuotesOfDeletedLoads('org-1', ['q1'])).toEqual(['q1']);
    expect(mockLoadFind).toHaveBeenCalledWith({
      organizationId: 'org-1',
      quoteId: { $in: ['q1'] },
      status: { $ne: 'Cancelled' },
    });
  });

  it('leaves a quote alone while another load is still linked to it', async () => {
    mockLinkedQuoteIds.mockReturnValue(['q1']);
    expect(await reopenQuotesOfDeletedLoads('org-1', ['q1'])).toEqual([]);
    expect(mockBookedQuoteIds).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('only changes quotes that are still booked', async () => {
    mockBookedQuoteIds.mockReturnValue([]);
    expect(await reopenQuotesOfDeletedLoads('org-1', ['q1'])).toEqual([]);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('ignores loads without a quote and repeated quotes', async () => {
    mockBookedQuoteIds.mockImplementation((filter: any) => filter._id.$in);
    const reopened = await reopenQuotesOfDeletedLoads('org-1', [undefined, null, '', 'q1', 'q1', 'q2']);
    expect(reopened).toEqual(['q1', 'q2']);
  });

  it('does nothing when no deleted load came from a quote', async () => {
    expect(await reopenQuotesOfDeletedLoads('org-1', [undefined, null])).toEqual([]);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe('announceReopenedQuotes', () => {
  it("refreshes the organization's Quotes tab once per reopened quote", async () => {
    await announceReopenedQuotes('org-1', ['q1', 'q2']);
    expect(mockInvalidate).toHaveBeenCalledWith('quotes:org-1');
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledWith('quote:change', { action: 'updated', quoteId: 'q1' });
  });

  it('does nothing when no quote was reopened', async () => {
    await announceReopenedQuotes('org-1', []);
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
