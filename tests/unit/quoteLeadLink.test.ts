/**
 * A quote links to the dealership's existing CRM lead for its customer: an
 * email match wins over a phone-only match, the newest lead wins among equal
 * matches, and the lead's customer record comes along. A load made from a
 * quote shows the quote's customer and lead. Models are stand-ins; no
 * database is used.
 */
const mockLeadFindOne = jest.fn();
const mockSort = jest.fn();
const mockQuoteFindOne = jest.fn();
const mockPopulate = jest.fn();
const mockQuoteFind = jest.fn();
const mockLoadFind = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({
      sort: (order: unknown) => {
        mockSort(order);
        return { select: () => ({ lean: () => Promise.resolve(mockLeadFindOne(filter)) }) };
      },
      select: () => ({ lean: () => Promise.resolve(mockLeadFindOne(filter)) }),
    }),
  },
}));

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => {
      const self: any = {
        select: () => self,
        populate: (...args: unknown[]) => { mockPopulate(...args); return self; },
        lean: () => Promise.resolve(mockQuoteFindOne(filter)),
      };
      return self;
    },
    find: (filter: unknown) => {
      const self: any = { select: () => self, sort: () => self, limit: () => self, lean: () => Promise.resolve(mockQuoteFind(filter)) };
      return self;
    },
  },
}));

jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => {
      const self: any = { select: () => self, sort: () => self, lean: () => Promise.resolve(mockLoadFind(filter)) };
      return self;
    },
  },
}));

import { findLeadLinkById, findLoadQuoteOrigin, findQuoteLeadLink, listLeadShipments } from '../../src/services/quoteLeadLink.service';

const ORG = '64b0000000000000000000aa';
const QUOTE = '64b0000000000000000000ab';
const LEAD = '64b0000000000000000000ac';

beforeEach(() => {
  jest.clearAllMocks();
  mockLeadFindOne.mockReturnValue(null);
});

describe('findQuoteLeadLink', () => {
  it("links the dealership's lead with the same email, plus its customer record", async () => {
    mockLeadFindOne.mockImplementation((filter: any) =>
      filter.normalizedEmail ? { _id: 'lead-by-email', customerId: 'customer-1' } : { _id: 'lead-by-phone' },
    );
    const link = await findQuoteLeadLink(ORG, { email: '  Maria@Example.com ', phone: '(801) 555-0100' });
    expect(link).toEqual({ leadId: 'lead-by-email', customerRecordId: 'customer-1' });
    expect(mockLeadFindOne).toHaveBeenCalledTimes(1);
    expect(mockLeadFindOne.mock.calls[0][0]).toMatchObject({ normalizedEmail: 'maria@example.com' });
    expect(String(mockLeadFindOne.mock.calls[0][0].organizationId)).toBe(ORG);
  });

  it('falls back to the phone number when no lead has the email', async () => {
    mockLeadFindOne.mockImplementation((filter: any) => (filter.normalizedPhone ? { _id: 'lead-by-phone' } : null));
    const link = await findQuoteLeadLink(ORG, { email: 'new@example.com', phone: '(801) 555-0100' });
    expect(link).toEqual({ leadId: 'lead-by-phone' });
    expect(mockLeadFindOne.mock.calls[1][0]).toMatchObject({ normalizedPhone: '+18015550100' });
  });

  it('picks the most recently updated lead when several match', async () => {
    mockLeadFindOne.mockReturnValue({ _id: 'newest' });
    await findQuoteLeadLink(ORG, { email: 'maria@example.com' });
    expect(mockSort).toHaveBeenCalledWith({ updatedAt: -1 });
  });

  it('returns no link when nothing matches', async () => {
    expect(await findQuoteLeadLink(ORG, { email: 'nobody@example.com', phone: '(801) 555-0199' })).toBeNull();
  });

  it("doesn't search with a missing or invalid email and phone", async () => {
    expect(await findQuoteLeadLink(ORG, { email: 'not-an-email', phone: 'call me' })).toBeNull();
    expect(mockLeadFindOne).not.toHaveBeenCalled();
  });

  it('never searches outside a valid dealership', async () => {
    expect(await findQuoteLeadLink('not-an-org', { email: 'maria@example.com' })).toBeNull();
    expect(mockLeadFindOne).not.toHaveBeenCalled();
  });
});

describe('findLoadQuoteOrigin', () => {
  it("gives the load page the quote's customer and linked lead", async () => {
    mockQuoteFindOne.mockReturnValue({ _id: QUOTE, firstName: 'Maria', lastName: ' Santos ', leadId: { _id: LEAD, firstName: 'Maria', lastName: 'Santos' } });
    expect(await findLoadQuoteOrigin(ORG, QUOTE)).toEqual({
      quoteId: QUOTE,
      customerName: 'Maria Santos',
      lead: { _id: LEAD, firstName: 'Maria', lastName: 'Santos' },
    });
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG });
    expect(mockPopulate).toHaveBeenCalledWith('leadId', 'firstName lastName');
  });

  it('shows no lead when the quote has none or its lead was deleted', async () => {
    mockQuoteFindOne.mockReturnValue({ _id: QUOTE, firstName: 'Maria', lastName: 'Santos', leadId: null });
    expect((await findLoadQuoteOrigin(ORG, QUOTE))?.lead).toBeNull();
  });

  it('returns nothing when the quote is gone or the id is not valid', async () => {
    mockQuoteFindOne.mockReturnValue(null);
    expect(await findLoadQuoteOrigin(ORG, QUOTE)).toBeNull();
    expect(await findLoadQuoteOrigin(ORG, 'not-an-id')).toBeNull();
    expect(await findLoadQuoteOrigin('', QUOTE)).toBeNull();
  });
});

describe('findLeadLinkById', () => {
  it('links a quote made from a lead to that lead, with its customer record', async () => {
    mockLeadFindOne.mockReturnValue({ _id: LEAD, customerId: 'customer-9' });
    expect(await findLeadLinkById(ORG, LEAD)).toEqual({ leadId: LEAD, customerRecordId: 'customer-9' });
    const filter = mockLeadFindOne.mock.calls[0][0];
    expect(filter._id).toBe(LEAD);
    expect(String(filter.organizationId)).toBe(ORG);
  });

  it("never links another dealership's lead or an id that isn't valid", async () => {
    mockLeadFindOne.mockReturnValue(null);
    expect(await findLeadLinkById(ORG, LEAD)).toBeNull();
    expect(await findLeadLinkById(ORG, 'not-an-id')).toBeNull();
    expect(await findLeadLinkById('not-an-org', LEAD)).toBeNull();
  });
});

describe('listLeadShipments', () => {
  it("lists a lead's quotes in this dealership, newest first, with the load each became", async () => {
    mockQuoteFind.mockReturnValue([
      { _id: 'q2', status: 'booked', source: 'customer_portal', vehicleName: '2021 Toyota Camry', rate: 950, createdAt: new Date('2026-10-29T00:00:00Z') },
      { _id: 'q1', status: 'pending', vehicleName: ' Honda Civic ', createdAt: new Date('2026-10-20T00:00:00Z') },
    ]);
    mockLoadFind.mockReturnValue([
      { _id: 'l3', quoteId: 'q2', loadNumber: 'LD-3', status: 'Cancelled' },
      { _id: 'l2', quoteId: 'q2', loadNumber: 'LD-2', status: 'In-Transit' },
    ]);
    expect(await listLeadShipments(ORG, LEAD)).toEqual([
      { quoteId: 'q2', status: 'booked', source: 'customer_portal', vehicleName: '2021 Toyota Camry', rate: 950, createdAt: '2026-10-29T00:00:00.000Z', load: { _id: 'l2', loadNumber: 'LD-2', status: 'In-Transit' } },
      { quoteId: 'q1', status: 'pending', source: 'staff', vehicleName: 'Honda Civic', rate: null, createdAt: '2026-10-20T00:00:00.000Z', load: null },
    ]);
    expect(mockQuoteFind).toHaveBeenCalledWith({ organizationId: ORG, leadId: LEAD });
    expect(mockLoadFind.mock.calls[0][0]).toMatchObject({ organizationId: ORG });
  });

  it('shows a cancelled load only when there is nothing newer, and skips the load lookup when there are no quotes', async () => {
    mockQuoteFind.mockReturnValue([{ _id: 'q1', status: 'pending' }]);
    mockLoadFind.mockReturnValue([{ _id: 'l1', quoteId: 'q1', loadNumber: 'LD-1', status: 'Cancelled' }]);
    expect((await listLeadShipments(ORG, LEAD))[0].load).toEqual({ _id: 'l1', loadNumber: 'LD-1', status: 'Cancelled' });

    mockLoadFind.mockClear();
    mockQuoteFind.mockReturnValue([]);
    expect(await listLeadShipments(ORG, LEAD)).toEqual([]);
    expect(mockLoadFind).not.toHaveBeenCalled();
  });

  it('returns nothing for an id that is not valid or a missing dealership', async () => {
    mockQuoteFind.mockClear();
    expect(await listLeadShipments(ORG, 'not-an-id')).toEqual([]);
    expect(await listLeadShipments('', LEAD)).toEqual([]);
    expect(mockQuoteFind).not.toHaveBeenCalled();
  });
});
