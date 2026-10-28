/**
 * A quote links to the dealership's existing CRM lead for its customer: an
 * email match wins over a phone-only match, the newest lead wins among equal
 * matches, and the lead's customer record comes along. Leads are stand-ins;
 * no database is used.
 */
const mockLeadFindOne = jest.fn();
const mockSort = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({
      sort: (order: unknown) => {
        mockSort(order);
        return { select: () => ({ lean: () => Promise.resolve(mockLeadFindOne(filter)) }) };
      },
    }),
  },
}));

import { findQuoteLeadLink } from '../../src/services/quoteLeadLink.service';

const ORG = '64b0000000000000000000aa';

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
