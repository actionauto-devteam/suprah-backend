/**
 * Staff Unlink a staff quote from the customer's portal (it stops showing in
 * My Shipments and stops sending updates) or Link it again. Only staff quotes
 * of the staff member's own dealership; a portal request always shows. Models
 * are stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockQuoteUpdateOne = jest.fn();
const mockFindPortalCustomerByEmail = jest.fn();
const mockInvalidate = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({ select: () => Promise.resolve(mockQuoteFindOne(filter)) }),
    updateOne: (...args: unknown[]) => Promise.resolve(mockQuoteUpdateOne(...args)),
  },
}));
jest.mock('../../src/services/shipmentFollower', () => ({
  __esModule: true,
  isStaffQuote: (quote: { source?: string }) => quote.source !== 'customer_portal',
  findPortalCustomerByEmail: (email: unknown) => mockFindPortalCustomerByEmail(email),
  findPortalCustomersByEmail: jest.fn(),
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: jest.fn(),
  notifyCustomerOfDeletedRequest: jest.fn(),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: (...args: unknown[]) => mockInvalidate(...args) } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));

import quoteController from '../../src/controllers/quote.controller';

const ORG = '64b0000000000000000000a1';
const QUOTE_ID = '64b0000000000000000000f1';
const STAFF = '64b0000000000000000000f3';

function call(id: string, body: unknown) {
  return new Promise<{ status: number; body?: any; error?: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    const req: any = { params: { id }, body, orgId: ORG, user: { _id: STAFF, role: 'employee' } };
    quoteController.setPortalShare(req, res, (error: any) => resolve({ status: error?.statusCode, error }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindOne.mockReturnValue({ _id: QUOTE_ID, email: 'maria@example.com' });
  mockFindPortalCustomerByEmail.mockResolvedValue({ id: 'c1', name: 'Maria Lopez', email: 'maria@example.com' });
});

describe('sharing a staff quote with the customer portal', () => {
  it("unlinks a staff quote in the staff member's own dealership", async () => {
    const result = await call(QUOTE_ID, { share: false });
    expect(result.status).toBe(200);
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE_ID, organizationId: ORG });
    const [filter, update] = mockQuoteUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: QUOTE_ID, organizationId: ORG });
    expect(update.$set).toMatchObject({ portalShareOff: true, portalShareOffBy: STAFF });
    expect(result.body.data).toEqual({ portalCustomer: { name: 'Maria Lopez', shared: false } });
    expect(result.body.message).toBe('The customer no longer sees this shipment in their portal or gets its updates.');
    expect(mockInvalidate).toHaveBeenCalledWith(`quotes:${ORG}`);
  });

  it('links it again, and says so plainly when no account uses the email', async () => {
    const result = await call(QUOTE_ID, { share: true });
    expect(mockQuoteUpdateOne.mock.calls[0][1]).toEqual({ $unset: { portalShareOff: '', portalShareOffAt: '', portalShareOffBy: '' } });
    expect(result.body.message).toBe('Maria Lopez can follow this shipment in their portal again.');

    mockFindPortalCustomerByEmail.mockResolvedValue(null);
    const none = await call(QUOTE_ID, { share: true });
    expect(none.body.data).toEqual({ portalCustomer: null });
    expect(none.body.message).toMatch(/No verified customer account uses this email yet/);
  });

  it("refuses portal requests, other dealerships' quotes and unclear answers", async () => {
    mockQuoteFindOne.mockReturnValueOnce({ _id: QUOTE_ID, source: 'customer_portal', email: 'maria@example.com' });
    const request = await call(QUOTE_ID, { share: false });
    expect(request.status).toBe(409);
    expect(request.error.message).toMatch(/always shows there/);

    mockQuoteFindOne.mockReturnValueOnce(null);
    expect((await call(QUOTE_ID, { share: false })).status).toBe(404);
    expect((await call('not-an-id', { share: false })).status).toBe(404);
    expect((await call(QUOTE_ID, { share: 'no' })).status).toBe(400);
    expect((await call(QUOTE_ID, {})).status).toBe(400);
    expect(mockQuoteUpdateOne).not.toHaveBeenCalled();
  });
});
