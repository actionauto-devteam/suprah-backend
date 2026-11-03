/**
 * A customer withdraws their own shipping request while it's still waiting:
 * it closes as withdrawn and the dealership is told. Someone else's request,
 * or one the dealership already answered, can't be withdrawn. Models are
 * stand-ins; no database is used.
 */
const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockNotifyOrgAdmins = jest.fn();
const mockNotifySalesperson = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => ({ lean: () => Promise.resolve(mockFindOneAndUpdate(...args)) }),
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockFindOne(filter)) }) }),
  },
}));
jest.mock('../../src/services/leadSalesperson.service', () => ({
  notifyQuoteSalesperson: (...args: unknown[]) => mockNotifySalesperson(...args),
}));
jest.mock('../../src/utils/safeNotification', () => ({
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
  safeCreateNotification: jest.fn(),
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: jest.fn(),
  notifyCustomerOfDeletedRequest: jest.fn(),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));

import quoteController from '../../src/controllers/quote.controller';

const QUOTE_ID = '64b0000000000000000000f1';
const CUSTOMER = '64b0000000000000000000f2';

function call(params: Record<string, string>) {
  return new Promise<{ status: number; body?: any; error?: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { resolve({ status: this.statusCode, body }); return this; },
    };
    const req: any = { params, user: { _id: CUSTOMER, role: 'customer' }, ip: '127.0.0.1', get: () => 'jest' };
    quoteController.withdrawCustomerQuoteRequest(req, res, (error: any) => resolve({ status: error?.statusCode, error }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOneAndUpdate.mockReturnValue({
    _id: QUOTE_ID, organizationId: 'org-1', firstName: 'Maria', lastName: 'Santos', vehicleName: '2021 Toyota Camry',
  });
});

describe('withdrawing a shipping request', () => {
  it("closes the customer's own waiting request and tells the dealership", async () => {
    const result = await call({ id: QUOTE_ID });
    expect(result.status).toBe(200);
    expect(result.body.message).toBe('Your request was withdrawn. The dealership has been told.');
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: QUOTE_ID, requestedBy: CUSTOMER, source: 'customer_portal', status: 'pending' });
    expect(update.$set).toMatchObject({ status: 'rejected', closedReason: 'customer_withdrew' });
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith(
      'org-1', 'quote_updated', 'Shipping Request Withdrawn',
      'Maria Santos withdrew their shipping request for 2021 Toyota Camry. No action is needed.',
      expect.objectContaining({ quoteId: QUOTE_ID }),
    );
    expect(mockNotifySalesperson).toHaveBeenCalledWith('org-1', QUOTE_ID, { skipAdmins: true }, 'withdrawn');
  });

  it('refuses a request the dealership already answered, in plain English', async () => {
    mockFindOneAndUpdate.mockReturnValue(null);
    mockFindOne.mockReturnValue({ status: 'accepted' });
    const result = await call({ id: QUOTE_ID });
    expect(result.status).toBe(409);
    expect(result.error.message).toBe("The dealership has already answered this request, so it can't be withdrawn here. Contact the dealership to cancel it.");
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it("can't touch someone else's request, and doesn't tell anyone twice", async () => {
    mockFindOneAndUpdate.mockReturnValue(null);
    mockFindOne.mockReturnValue(null);
    expect((await call({ id: QUOTE_ID })).status).toBe(404);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: QUOTE_ID, requestedBy: CUSTOMER, source: 'customer_portal' });

    mockFindOne.mockReturnValue({ status: 'rejected', closedReason: 'customer_withdrew' });
    const again = await call({ id: QUOTE_ID });
    expect(again.status).toBe(200);
    expect(again.body.message).toBe('You already withdrew this request.');
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('rejects a link that is not a real request id', async () => {
    expect((await call({ id: 'nope' })).status).toBe(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
