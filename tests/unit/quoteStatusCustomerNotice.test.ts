/**
 * When staff answer a customer's shipping request, the customer is told once,
 * and only for a real change. Models are stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockQuoteFindOneAndUpdate = jest.fn();
const mockNotifyCustomer = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({
      select: () => ({ lean: () => Promise.resolve(mockQuoteFindOne(filter)) }),
    }),
    findOneAndUpdate: (...args: unknown[]) => {
      const result = mockQuoteFindOneAndUpdate(...args);
      const populated: any = { populate: () => populated, then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return populated;
    },
  },
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: (...args: unknown[]) => mockNotifyCustomer(...args),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/utils/safeNotification', () => ({ notifyOrgAdmins: jest.fn(), safeCreateNotification: jest.fn() }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));

import quoteController from '../../src/controllers/quote.controller';

const QUOTE_ID = '64b0000000000000000000d1';

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

const quote = (status: string) => ({ _id: QUOTE_ID, firstName: 'Maria', lastName: 'Santos', vehicleName: 'Camry', status });
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => jest.clearAllMocks());

describe('telling the customer about the answer', () => {
  it('tells a customer portal requester when staff accept or decline', async () => {
    for (const [status, event] of [['accepted', 'accepted'], ['rejected', 'declined']] as const) {
      jest.clearAllMocks();
      mockQuoteFindOne.mockReturnValue({ status: 'pending', source: 'customer_portal' });
      mockQuoteFindOneAndUpdate.mockReturnValue(quote(status));
      await call(quoteController.updateQuoteStatus, { status });
      await settle();
      expect(mockNotifyCustomer).toHaveBeenCalledWith('org-1', QUOTE_ID, event);
    }
  });

  it("doesn't tell anyone for staff quotes, unchanged statuses or other statuses", async () => {
    for (const [before, status] of [
      [{ status: 'pending' }, 'accepted'],
      [{ status: 'accepted', source: 'customer_portal' }, 'accepted'],
      [{ status: 'pending', source: 'customer_portal' }, 'booked'],
    ] as const) {
      mockQuoteFindOne.mockReturnValue(before);
      mockQuoteFindOneAndUpdate.mockReturnValue(quote(status));
      await call(quoteController.updateQuoteStatus, { status });
    }
    await settle();
    expect(mockNotifyCustomer).not.toHaveBeenCalled();
  });

  it('clears "no longer available" when staff give a closed request another status', async () => {
    mockQuoteFindOne.mockReturnValue({ status: 'rejected', source: 'customer_portal' });
    mockQuoteFindOneAndUpdate.mockReturnValue(quote('pending'));
    await call(quoteController.updateQuoteStatus, { status: 'pending' });
    expect(mockQuoteFindOneAndUpdate.mock.calls[0][1]).toEqual({
      $set: { status: 'pending' },
      $unset: { closedReason: '', closedAt: '' },
    });

    mockQuoteFindOneAndUpdate.mockClear();
    mockQuoteFindOneAndUpdate.mockReturnValue(quote('rejected'));
    await call(quoteController.updateQuoteStatus, { status: 'rejected' });
    expect(mockQuoteFindOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { status: 'rejected' } });
  });
});
