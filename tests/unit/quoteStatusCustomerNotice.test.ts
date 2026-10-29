/**
 * When staff answer a customer's shipping request, the customer is told once,
 * and only for a real change. Models are stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockQuoteFindOneAndUpdate = jest.fn();
const mockNotifyCustomer = jest.fn();
const mockNotifyDeleted = jest.fn();
const mockQuoteFindOneAndDelete = jest.fn();
const mockLoadFindOne = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({
      select: () => ({ lean: () => Promise.resolve(mockQuoteFindOne(filter)) }),
    }),
    findOneAndDelete: (...args: unknown[]) => Promise.resolve(mockQuoteFindOneAndDelete(...args)),
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
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockLoadFindOne(filter)) }) }),
  },
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: (...args: unknown[]) => mockNotifyCustomer(...args),
  notifyCustomerOfDeletedRequest: (...args: unknown[]) => mockNotifyDeleted(...args),
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
      expect(mockNotifyCustomer).toHaveBeenCalledWith('org-1', QUOTE_ID, event, {});
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
      $unset: { closedReason: '', closedAt: '', declineReason: '' },
    });

    mockQuoteFindOneAndUpdate.mockClear();
    mockQuoteFindOneAndUpdate.mockReturnValue(quote('rejected'));
    await call(quoteController.updateQuoteStatus, { status: 'rejected' });
    expect(mockQuoteFindOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { status: 'rejected' }, $unset: { declineReason: '' } });
  });
});

describe('declining with a reason', () => {
  it('saves the reason and passes it to the customer', async () => {
    mockQuoteFindOne.mockReturnValue({ status: 'pending', source: 'customer_portal' });
    mockQuoteFindOneAndUpdate.mockReturnValue(quote('rejected'));
    await call(quoteController.updateQuoteStatus, { status: 'rejected', declineReason: "  We don't ship to Alaska.  " });
    await settle();
    expect(mockQuoteFindOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { status: 'rejected', declineReason: "We don't ship to Alaska." } });
    expect(mockNotifyCustomer).toHaveBeenCalledWith('org-1', QUOTE_ID, 'declined', { declineReason: "We don't ship to Alaska." });
  });

  it('refuses a reason over 300 characters, and ignores a reason when not declining', async () => {
    const tooLong = await call(quoteController.updateQuoteStatus, { status: 'rejected', declineReason: 'x'.repeat(301) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.error.message).toBe('Keep the reason under 300 characters, then decline again.');
    expect(mockQuoteFindOneAndUpdate).not.toHaveBeenCalled();

    mockQuoteFindOne.mockReturnValue({ status: 'pending', source: 'customer_portal' });
    mockQuoteFindOneAndUpdate.mockReturnValue(quote('accepted'));
    await call(quoteController.updateQuoteStatus, { status: 'accepted', declineReason: 'ignored' });
    expect(JSON.stringify(mockQuoteFindOneAndUpdate.mock.calls[0][1])).not.toMatch(/ignored/);
  });
});

describe("deleting a customer's request", () => {
  it('keeps a request linked to a load that is not cancelled', async () => {
    mockQuoteFindOne.mockReturnValue({ source: 'customer_portal' });
    mockLoadFindOne.mockReturnValue({ loadNumber: 'LD-9' });
    const result = await call(quoteController.deleteQuote, {});
    expect(result.status).toBe(409);
    expect(result.error.message).toBe(
      "This customer's request is linked to load LD-9, which they follow in My Shipments, so it can't be deleted. If that shipment isn't happening, cancel the load first, then delete the request.",
    );
    expect(mockLoadFindOne).toHaveBeenCalledWith({ quoteId: QUOTE_ID, organizationId: 'org-1', status: { $ne: 'Cancelled' } });
    expect(mockQuoteFindOneAndDelete).not.toHaveBeenCalled();
  });

  it('tells the customer when an open request is deleted, but not a closed one or a staff quote', async () => {
    for (const [deleted, told] of [
      [{ ...quote('pending'), source: 'customer_portal', requestedBy: 'c1' }, true],
      [{ ...quote('accepted'), source: 'customer_portal', requestedBy: 'c1' }, true],
      [{ ...quote('rejected'), source: 'customer_portal', requestedBy: 'c1' }, false],
      [quote('pending'), false],
    ] as const) {
      jest.clearAllMocks();
      mockQuoteFindOne.mockReturnValue({ source: (deleted as any).source });
      mockLoadFindOne.mockReturnValue(null);
      mockQuoteFindOneAndDelete.mockReturnValue(deleted);
      const result = await call(quoteController.deleteQuote, {});
      await settle();
      expect(result.status).toBe(200);
      if (told) expect(mockNotifyDeleted).toHaveBeenCalledWith('org-1', deleted);
      else expect(mockNotifyDeleted).not.toHaveBeenCalled();
    }
  });
});
