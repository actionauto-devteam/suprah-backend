/**
 * Who follows a shipment in the customer portal: the customer behind a portal
 * request, or the active customer account whose verified email is a staff
 * quote's email, unless staff unlinked it. The User model is a stand-in.
 */
const mockUserFindOne = jest.fn();
const mockUserFind = jest.fn();
const mockUserFindById = jest.fn();
const chain = (result: () => unknown) => {
  const self: any = { select: () => self, lean: () => Promise.resolve(result()) };
  return self;
};
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => chain(() => mockUserFindOne(filter)),
    find: (filter: unknown) => chain(() => mockUserFind(filter)),
    findById: (id: unknown) => chain(() => mockUserFindById(id)),
  },
}));

import {
  describePortalCustomer,
  findPortalCustomerByEmail,
  findPortalCustomersByEmail,
  findQuoteFollower,
  isStaffQuote,
} from '../../src/services/shipmentFollower';

const CUSTOMER = '64b0000000000000000000c9';
const maria = { _id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindOne.mockReturnValue(null);
  mockUserFind.mockReturnValue([]);
  mockUserFindById.mockReturnValue(null);
});

describe('findPortalCustomerByEmail', () => {
  it('matches only an active customer account with that verified email', async () => {
    mockUserFindOne.mockReturnValue(maria);
    expect(await findPortalCustomerByEmail('  Maria@Example.COM ')).toEqual({ id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com' });
    expect(mockUserFindOne).toHaveBeenCalledWith({ email: 'maria@example.com', role: 'customer', emailVerified: true, isActive: true });
  });

  it('never looks anything up for a missing or broken email', async () => {
    for (const email of ['', 'not-an-email', null, undefined, { $ne: null }]) {
      expect(await findPortalCustomerByEmail(email)).toBeNull();
    }
    expect(mockUserFindOne).not.toHaveBeenCalled();
  });

  it('looks up many emails in one query', async () => {
    mockUserFind.mockReturnValue([maria]);
    const found = await findPortalCustomersByEmail(['MARIA@example.com', 'maria@example.com', 'bad', null]);
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(mockUserFind).toHaveBeenCalledWith({ email: { $in: ['maria@example.com'] }, role: 'customer', emailVerified: true, isActive: true });
    expect(found.get('maria@example.com')?.name).toBe('Maria Lopez');
    expect((await findPortalCustomersByEmail([])).size).toBe(0);
  });
});

describe('findQuoteFollower', () => {
  it('follows the customer behind a portal request', async () => {
    mockUserFindById.mockReturnValue(maria);
    expect(isStaffQuote({ source: 'customer_portal' })).toBe(false);
    expect(await findQuoteFollower({ source: 'customer_portal', requestedBy: CUSTOMER, email: 'other@example.com' })).toMatchObject({
      id: CUSTOMER,
      kind: 'request',
    });
    expect(mockUserFindOne).not.toHaveBeenCalled();
    expect(await findQuoteFollower({ source: 'customer_portal', requestedBy: 'nope' })).toBeNull();
  });

  it("follows a staff quote's verified account, unless staff unlinked it", async () => {
    mockUserFindOne.mockReturnValue(maria);
    expect(isStaffQuote({})).toBe(true);
    expect(await findQuoteFollower({ email: 'maria@example.com' })).toMatchObject({ id: CUSTOMER, kind: 'shared' });
    expect(await findQuoteFollower({ email: 'maria@example.com', portalShareOff: true })).toBeNull();
    mockUserFindOne.mockReturnValue(null);
    expect(await findQuoteFollower({ email: 'unknown@example.com' })).toBeNull();
    expect(await findQuoteFollower(null)).toBeNull();
  });
});

describe('describePortalCustomer', () => {
  it('shows staff the account even while unlinked, so they can link it again', async () => {
    mockUserFindOne.mockReturnValue(maria);
    expect(await describePortalCustomer({ email: 'maria@example.com' })).toEqual({ name: 'Maria Lopez', shared: true, fromRequest: false });
    expect(await describePortalCustomer({ email: 'maria@example.com', portalShareOff: true })).toEqual({ name: 'Maria Lopez', shared: false, fromRequest: false });
    mockUserFindById.mockReturnValue(maria);
    expect(await describePortalCustomer({ source: 'customer_portal', requestedBy: CUSTOMER })).toEqual({ name: 'Maria Lopez', shared: true, fromRequest: true });
    mockUserFindOne.mockReturnValue(null);
    expect(await describePortalCustomer({ email: 'nobody@example.com' })).toBeNull();
  });
});
