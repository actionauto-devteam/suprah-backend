/**
 * A lead added to the CRM after a quote was made is linked when staff accept,
 * decline or convert the quote; an existing link is never changed. A converted
 * load's delivery stop gets the quote customer as its contact. Models are
 * stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockQuoteFindOneAndUpdate = jest.fn();
const mockFindLeadLink = jest.fn();
const mockLoadFindOne = jest.fn();
const mockLoadCreate = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => {
      const result = () => mockQuoteFindOne(filter);
      const self: any = {
        select: () => self,
        lean: () => Promise.resolve(result()),
        then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
      };
      return self;
    },
    findOneAndUpdate: (...args: unknown[]) => {
      const result = mockQuoteFindOneAndUpdate(...args);
      const populated: any = { populate: () => populated, then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return populated;
    },
  },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => Promise.resolve(mockLoadFindOne(filter)),
    create: (doc: unknown) => Promise.resolve(mockLoadCreate(doc)),
  },
}));
jest.mock('../../src/services/quoteLeadLink.service', () => ({
  findQuoteLeadLink: (...args: unknown[]) => mockFindLeadLink(...args),
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: jest.fn(),
  notifyCustomerOfDeletedRequest: jest.fn(),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/services/leadSalesperson.service', () => ({ notifyQuoteSalesperson: jest.fn() }));
jest.mock('../../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn(() => Promise.resolve()),
  safeCreateNotification: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));

import quoteController from '../../src/controllers/quote.controller';

const QUOTE_ID = '64b0000000000000000000d1';
const LEAD_ID = '64b0000000000000000000e1';
const CUSTOMER_RECORD_ID = '64b0000000000000000000f1';

function call(handler: any, body: Record<string, unknown>) {
  return new Promise<{ status: number; error?: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json() { resolve({ status: this.statusCode }); return this; },
    };
    const req: any = { body, params: { id: QUOTE_ID }, orgId: 'org-1', user: { _id: 'staff-1' }, auth: { userId: 'staff-1' }, ip: '127.0.0.1', get: () => 'jest' };
    handler(req, res, (error: any) => resolve({ status: error?.statusCode, error }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindLeadLink.mockResolvedValue({ leadId: LEAD_ID, customerRecordId: CUSTOMER_RECORD_ID });
  mockQuoteFindOneAndUpdate.mockReturnValue({ _id: QUOTE_ID, firstName: 'Maria', lastName: 'Santos', status: 'accepted' });
});

describe('linking a lead added later, on Accept and Decline', () => {
  it('links an unlinked quote when staff accept or decline it', async () => {
    for (const status of ['accepted', 'rejected']) {
      jest.clearAllMocks();
      mockQuoteFindOne.mockReturnValue({ status: 'pending', email: 'maria@example.com', phone: '8015550100' });
      await call(quoteController.updateQuoteStatus, { status });
      expect(mockFindLeadLink).toHaveBeenCalledWith('org-1', { email: 'maria@example.com', phone: '8015550100' });
      expect(mockQuoteFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
        status,
        leadId: LEAD_ID,
        customerRecordId: CUSTOMER_RECORD_ID,
      });
    }
  });

  it('never changes an existing link, and only looks on Accept and Decline', async () => {
    mockQuoteFindOne.mockReturnValue({ status: 'pending', leadId: 'existing-lead', email: 'maria@example.com' });
    await call(quoteController.updateQuoteStatus, { status: 'accepted' });
    mockQuoteFindOne.mockReturnValue({ status: 'rejected', email: 'maria@example.com' });
    await call(quoteController.updateQuoteStatus, { status: 'pending' });
    expect(mockFindLeadLink).not.toHaveBeenCalled();
    for (const [, update] of mockQuoteFindOneAndUpdate.mock.calls) {
      expect(update.$set).not.toHaveProperty('leadId');
    }
  });

  it('still saves the answer when no lead matches or the lookup fails', async () => {
    mockQuoteFindOne.mockReturnValue({ status: 'pending', email: 'maria@example.com' });
    mockFindLeadLink.mockResolvedValueOnce(null);
    expect((await call(quoteController.updateQuoteStatus, { status: 'accepted' })).status).toBe(200);
    mockFindLeadLink.mockRejectedValueOnce(new Error('down'));
    expect((await call(quoteController.updateQuoteStatus, { status: 'accepted' })).status).toBe(200);
    for (const [, update] of mockQuoteFindOneAndUpdate.mock.calls) {
      expect(update.$set).toEqual({ status: 'accepted' });
    }
  });
});

describe('converting a quote into a load', () => {
  const quoteDoc = (extra: Record<string, unknown> = {}) => ({
    _id: QUOTE_ID,
    firstName: 'Maria',
    lastName: 'Santos',
    email: 'maria@example.com',
    phone: '(801) 555-0100',
    status: 'accepted',
    fromAddress: '1 Main St, Orem, UT',
    fromZip: '84057',
    toAddress: '20 Oak Ave, Denver, CO',
    toZip: '80202',
    vehicleName: '2021 Toyota Camry',
    rate: 950,
    miles: 520,
    save: jest.fn(),
    ...extra,
  });

  beforeEach(() => {
    mockLoadFindOne.mockReturnValue(null);
    mockLoadCreate.mockImplementation((doc: any) => ({ _id: 'load-1', loadNumber: 'LD-1', ...doc }));
  });

  it("makes the quote's customer the delivery contact", async () => {
    mockQuoteFindOne.mockReturnValue(quoteDoc());
    expect((await call(quoteController.convertToLoad, {})).status).toBe(201);
    expect(mockLoadCreate.mock.calls[0][0].deliveryLocation).toMatchObject({
      city: 'Denver',
      state: 'CO',
      contactName: 'Maria Santos',
      phone: '(801) 555-0100',
      email: 'maria@example.com',
    });
    expect(mockLoadCreate.mock.calls[0][0].pickupLocation).not.toHaveProperty('contactName');
  });

  it('links a lead added later, and never changes an existing link', async () => {
    const unlinked = quoteDoc();
    mockQuoteFindOne.mockReturnValue(unlinked);
    await call(quoteController.convertToLoad, {});
    expect(unlinked).toMatchObject({ status: 'booked', leadId: LEAD_ID, customerRecordId: CUSTOMER_RECORD_ID });
    expect(unlinked.save).toHaveBeenCalled();

    mockFindLeadLink.mockClear();
    const linked = quoteDoc({ leadId: 'existing-lead' });
    mockQuoteFindOne.mockReturnValue(linked);
    await call(quoteController.convertToLoad, {});
    expect(mockFindLeadLink).not.toHaveBeenCalled();
    expect(linked.leadId).toBe('existing-lead');
  });
});
